import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { DataSource } from 'typeorm';
import { FailureCode } from '../../src/modules/wagering/domain/FailureCode';
import { WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/WagerTransactionKind';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/WagerTransactionStatus';
import { TypeOrmWagerTransactionRepository } from '../../src/modules/wagering/infra/typeorm/repositories/TypeOrmWagerTransactionRepository';
import type { TypeOrmTransactionManager } from '../../src/shared/infra/database/TypeOrmTransactionManager';
import {
  brl,
  buildTransaction,
  openTestDatabase,
  seedTransaction,
  seedWallet,
  sleep,
  T1,
  truncateAll,
  uuid,
} from './helpers';

let ds: DataSource;
let txm: TypeOrmTransactionManager;
let repo: TypeOrmWagerTransactionRepository;

beforeAll(async () => {
  ({ ds, txm } = await openTestDatabase());
  repo = new TypeOrmWagerTransactionRepository(txm);
});
afterAll(async () => {
  await ds.destroy();
});
beforeEach(async () => {
  await truncateAll(ds);
});

describe('TypeOrmWagerTransactionRepository', () => {
  it('insertIfAbsent grava uma vez e devolve false para idempotency key repetida', async () => {
    const wallet = await seedWallet(txm);
    const first = buildTransaction(wallet, { idempotencyKey: 'key-1' });
    const repeated = buildTransaction(wallet, { idempotencyKey: 'key-1' });

    expect(await repo.insertIfAbsent(first)).toBe(true);
    expect(await repo.insertIfAbsent(repeated)).toBe(false);
    expect((await repo.findByIdempotencyKey('key-1'))?.id).toBe(first.id);
  });

  it('insertIfAbsent devolve false para (provider, externalTransactionId) repetido com outra key', async () => {
    const wallet = await seedWallet(txm);
    await seedTransaction(txm, wallet, { externalTransactionId: 'ext-1', idempotencyKey: 'k1' });
    const other = buildTransaction(wallet, { externalTransactionId: 'ext-1', idempotencyKey: 'k2' });
    expect(await repo.insertIfAbsent(other)).toBe(false);
    expect(await repo.findByIdempotencyKey('k2')).toBeNull();
  });

  it('50 inserts simultâneos com a mesma key: exatamente um vence', async () => {
    const wallet = await seedWallet(txm);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        txm.run(() =>
          repo.insertIfAbsent(buildTransaction(wallet, { idempotencyKey: 'same-key' })),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const [{ n }] = await ds.query('SELECT count(*)::int AS n FROM wager_transactions');
    expect(n).toBe(1);
  });

  it('as buscas devolvem o estado completo', async () => {
    const wallet = await seedWallet(txm);
    const tx = await seedTransaction(txm, wallet, {
      providerId: 'provider-x',
      externalTransactionId: 'ext-77',
      money: brl('1234.56'),
    });

    for (const loaded of [
      await repo.findById(tx.id),
      await repo.findByIdempotencyKey(tx.idempotencyKey),
      await repo.findByExternalId('provider-x', 'ext-77'),
    ]) {
      expect(loaded?.id).toBe(tx.id);
      expect(loaded?.kind).toBe(Kind.Bet);
      expect(loaded?.status).toBe(Status.Pending);
      expect(loaded?.money.toJSON()).toEqual({ amount: '1234.56', currency: 'BRL' });
      expect(loaded?.referenceAttempts).toBe(0);
      expect(loaded?.observedBalance).toBeUndefined();
    }
    expect(await repo.findById(uuid())).toBeNull();
    expect(await repo.findByExternalId('provider-x', 'nope')).toBeNull();
  });

  it('save: PENDING_REFERENCE → PROCESSED persiste cada campo', async () => {
    const wallet = await seedWallet(txm);
    const bet = await seedTransaction(txm, wallet);
    const win = await seedTransaction(txm, wallet, {
      kind: Kind.Win,
      money: brl('50.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const next = new Date('2026-11-02T12:00:30.000Z');
    win.markPendingReference(next);
    await repo.save(win);
    let loaded = await repo.findById(win.id);
    expect(loaded?.status).toBe(Status.PendingReference);
    expect(loaded?.referenceAttempts).toBe(1);
    expect(loaded?.nextReferenceAttemptAt).toEqual(next);

    win.markProcessed(bet.id, T1, brl('75.00'));
    await repo.save(win);
    loaded = await repo.findById(win.id);
    expect(loaded?.status).toBe(Status.Processed);
    expect(loaded?.referenceTransactionId).toBe(bet.id);
    expect(loaded?.observedBalance?.toJSON().amount).toBe('75.00');
    expect(loaded?.processedAt).toEqual(T1);
    expect(loaded?.nextReferenceAttemptAt).toBeUndefined();
  });

  it('save: REJECTED guarda failureCode e saldo observado', async () => {
    const wallet = await seedWallet(txm);
    const bet = await seedTransaction(txm, wallet);
    bet.reject(FailureCode.InsufficientFunds, T1, brl('20.00'));
    await repo.save(bet);

    const loaded = await repo.findById(bet.id);
    expect(loaded?.status).toBe(Status.Rejected);
    expect(loaded?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(loaded?.observedBalance?.toJSON().amount).toBe('20.00');
  });

  it('save de transação inexistente falha', async () => {
    const wallet = await seedWallet(txm);
    await expect(repo.save(buildTransaction(wallet))).rejects.toThrow('not found');
  });

  it('findProcessedReversal só devolve reversão PROCESSED do mesmo kind', async () => {
    const wallet = await seedWallet(txm);
    const bet = await seedTransaction(txm, wallet);
    const refund = await seedTransaction(txm, wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    expect(await repo.findProcessedReversal(bet.id, Kind.Refund)).toBeNull(); // ainda PENDING

    refund.markProcessed(bet.id, T1, brl('100.00'));
    await repo.save(refund);
    expect((await repo.findProcessedReversal(bet.id, Kind.Refund))?.id).toBe(refund.id);
    expect(await repo.findProcessedReversal(bet.id, Kind.Rollback)).toBeNull();
  });

  it('findDuePendingReference: só as vencidas, e workers concorrentes recebem lotes disjuntos', async () => {
    const wallet = await seedWallet(txm);
    const now = new Date('2026-11-03T12:00:00.000Z');
    const dueIds: string[] = [];

    const seedPending = async (i: number, next: Date) => {
      const tx = buildTransaction(wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: `missing-${i}`,
      });
      tx.markPendingReference(next);
      await repo.insertIfAbsent(tx);
      return tx;
    };

    for (let i = 0; i < 10; i++) {
      dueIds.push((await seedPending(i, new Date(now.getTime() - 1000 - i))).id);
    }
    await seedPending(10, new Date(now.getTime() + 60_000)); // ainda não venceu
    await seedTransaction(txm, wallet); // PENDING comum, não é PENDING_REFERENCE

    const claim = () =>
      txm.run(async () => {
        const rows = await repo.findDuePendingReference(now, 5);
        await sleep(150); // segura o lock para forçar a sobreposição
        return rows.map((r) => r.id);
      });

    const [a, b] = await Promise.all([claim(), claim()]);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(a.filter((id) => b.includes(id))).toHaveLength(0);
    expect(new Set([...a, ...b])).toEqual(new Set(dueIds));
  });

  it('findDuePendingReference exige transação ativa', async () => {
    await expect(repo.findDuePendingReference(new Date(), 5)).rejects.toThrow('active transaction');
  });
});
