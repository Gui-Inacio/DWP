import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { DataSource } from 'typeorm';
import { Wallet } from '../../src/modules/wallets/domain/Wallet';
import { TypeOrmWalletRepository } from '../../src/modules/wallets/infra/typeorm/repositories/TypeOrmWalletRepository';
import { ConcurrencyConflictError } from '../../src/shared/application/errors';
import { InsufficientFundsError } from '../../src/shared/domain/errors';
import type { TypeOrmTransactionManager } from '../../src/shared/infra/database/TypeOrmTransactionManager';
import {
  brl,
  openTestDatabase,
  seedWallet,
  sleep,
  T0,
  T1,
  truncateAll,
  uuid,
} from './helpers';

let ds: DataSource;
let txm: TypeOrmTransactionManager;
let repo: TypeOrmWalletRepository;

beforeAll(async () => {
  ({ ds, txm } = await openTestDatabase());
  repo = new TypeOrmWalletRepository(txm);
});
afterAll(async () => {
  await ds.destroy();
});
beforeEach(async () => {
  await truncateAll(ds);
});

const movement = (amount: string, n = 1) => ({
  money: brl(amount),
  transactionId: `t-${n}`,
  entryId: `e-${n}`,
  at: T1,
});

describe('TypeOrmWalletRepository', () => {
  it('insert + findById preservam o estado (Money exato, version, datas)', async () => {
    const wallet = await seedWallet(txm, '1234.50');
    const loaded = await repo.findById(wallet.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.playerId).toBe(wallet.playerId);
    expect(loaded?.currency).toBe('BRL');
    expect(loaded?.balance.toJSON()).toEqual({
      amount: '1234.50',
      currency: 'BRL',
    });
    expect(loaded?.version).toBe(1);
    expect(loaded?.createdAt).toEqual(T0);
  });

  it('findById devolve null quando não existe', async () => {
    expect(await repo.findById(uuid())).toBeNull();
  });

  it('insert devolve false para (player, moeda) duplicado', async () => {
    const first = await seedWallet(txm, '10.00');
    const duplicate = Wallet.open({
      id: uuid(),
      playerId: first.playerId,
      initialBalance: brl('5.00'),
      at: T0,
    });
    expect(await repo.insert(duplicate)).toBe(false);
  });

  it('findByIdForUpdate exige transação ativa', async () => {
    const wallet = await seedWallet(txm);
    await expect(repo.findByIdForUpdate(wallet.id)).rejects.toThrow(
      'active transaction',
    );
  });

  it('save grava saldo, version e updatedAt', async () => {
    const wallet = await seedWallet(txm, '100.00');
    await txm.run(async () => {
      const locked = await repo.findByIdForUpdate(wallet.id);
      if (!locked) throw new Error('wallet not found');
      const previous = locked.version;
      locked.debit(movement('30.00'));
      await repo.save(locked, previous);
    });

    const reloaded = await repo.findById(wallet.id);
    expect(reloaded?.balance.toJSON().amount).toBe('70.00');
    expect(reloaded?.version).toBe(2);
    expect(reloaded?.updatedAt).toEqual(T1);
  });

  it('save com version velha lança ConcurrencyConflictError e não grava', async () => {
    const wallet = await seedWallet(txm, '100.00');
    const a = await repo.findById(wallet.id);
    const b = await repo.findById(wallet.id);
    if (!a || !b) throw new Error('wallet not found');

    a.debit(movement('10.00', 1));
    await repo.save(a, 1);

    b.debit(movement('20.00', 2));
    await expect(repo.save(b, 1)).rejects.toThrow(ConcurrencyConflictError);

    const reloaded = await repo.findById(wallet.id);
    expect(reloaded?.balance.toJSON().amount).toBe('90.00');
    expect(reloaded?.version).toBe(2);
  });

  it('50 débitos de 10.00 em paralelo sobre 100.00: exatamente 10 passam, saldo 0.00', async () => {
    const wallet = await seedWallet(txm, '100.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        txm.run(async () => {
          const locked = await repo.findByIdForUpdate(wallet.id);
          if (!locked) throw new Error('wallet not found');
          const previous = locked.version;
          try {
            locked.debit(movement('10.00', i));
          } catch (error) {
            if (error instanceof InsufficientFundsError) return 'rejected';
            throw error;
          }
          await repo.save(locked, previous);
          return 'processed';
        }),
      ),
    );

    expect(results.filter((r) => r === 'processed')).toHaveLength(10);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(40);
    const reloaded = await repo.findById(wallet.id);
    expect(reloaded?.balance.toJSON().amount).toBe('0.00');
    expect(reloaded?.version).toBe(11);
  });

  it('wallets diferentes não se bloqueiam (não há lock global)', async () => {
    const slow = await seedWallet(txm);
    const fast = await seedWallet(txm);
    const events: string[] = [];

    const holder = txm.run(async () => {
      await repo.findByIdForUpdate(slow.id);
      events.push('slow locked');
      await sleep(250);
      events.push('slow done');
    });
    await sleep(40);
    const other = txm.run(async () => {
      await repo.findByIdForUpdate(fast.id);
      events.push('fast locked');
    });

    await Promise.all([holder, other]);
    expect(events).toEqual(['slow locked', 'fast locked', 'slow done']);
  });
});
