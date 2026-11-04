import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { DataSource } from 'typeorm';
import { LedgerDirection } from '../../src/modules/wallets/domain/LedgerDirection';
import type { Wallet } from '../../src/modules/wallets/domain/Wallet';
import { WalletLedgerEntry } from '../../src/modules/wallets/domain/WalletLedgerEntry';
import { TypeOrmLedgerRepository } from '../../src/modules/wallets/infra/typeorm/repositories/TypeOrmLedgerRepository';
import { InvalidCursorError } from '../../src/shared/application/errors';
import type { TypeOrmTransactionManager } from '../../src/shared/infra/database/TypeOrmTransactionManager';
import {
  brl,
  openTestDatabase,
  seedTransaction,
  seedWallet,
  T0,
  truncateAll,
  uuid,
} from './helpers';

let ds: DataSource;
let txm: TypeOrmTransactionManager;
let ledger: TypeOrmLedgerRepository;

beforeAll(async () => {
  ({ ds, txm } = await openTestDatabase());
  ledger = new TypeOrmLedgerRepository(txm);
});
afterAll(async () => {
  await ds.destroy();
});
beforeEach(async () => {
  await truncateAll(ds);
});

/** Cria a transação (FK) e o lançamento correspondente. */
async function appendEntry(
  wallet: Wallet,
  props: {
    direction: LedgerDirection;
    amount: string;
    before: string;
    after: string;
    createdAt?: Date;
  },
): Promise<WalletLedgerEntry> {
  const tx = await seedTransaction(txm, wallet);
  const entry = WalletLedgerEntry.create({
    id: uuid(),
    walletId: wallet.id,
    transactionId: tx.id,
    direction: props.direction,
    money: brl(props.amount),
    balanceBefore: brl(props.before),
    balanceAfter: brl(props.after),
    createdAt: props.createdAt ?? T0,
  });
  await ledger.append(entry);
  return entry;
}

describe('TypeOrmLedgerRepository', () => {
  it('append + findPageByWallet preservam o lançamento', async () => {
    const wallet = await seedWallet(txm);
    const entry = await appendEntry(wallet, {
      direction: LedgerDirection.Debit,
      amount: '80.00',
      before: '100.00',
      after: '20.00',
    });

    const page = await ledger.findPageByWallet(wallet.id, { limit: 10 });
    expect(page.nextCursor).toBeNull();
    expect(page.entries).toHaveLength(1);
    const loaded = page.entries[0];
    expect(loaded?.id).toBe(entry.id);
    expect(loaded?.direction).toBe(LedgerDirection.Debit);
    expect(loaded?.money.toJSON().amount).toBe('80.00');
    expect(loaded?.balanceBefore.toJSON().amount).toBe('100.00');
    expect(loaded?.balanceAfter.toJSON().amount).toBe('20.00');
    expect(loaded?.isBalanced()).toBe(true);
  });

  it('o cursor percorre tudo sem repetir nem pular, mesmo com created_at igual', async () => {
    const wallet = await seedWallet(txm);
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      // pares de lançamentos com o mesmo created_at: o desempate é pelo id
      const createdAt = new Date(T0.getTime() + Math.floor(i / 2) * 1000);
      const entry = await appendEntry(wallet, {
        direction: LedgerDirection.Credit,
        amount: '10.00',
        before: `${i * 10}.00`,
        after: `${(i + 1) * 10}.00`,
        createdAt,
      });
      created.push(entry.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await ledger.findPageByWallet(wallet.id, {
        cursor,
        limit: 2,
      });
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(new Set(seen)).toEqual(new Set(created));

    const all = await ledger.findPageByWallet(wallet.id, { limit: 50 });
    const times = all.entries.map((e) => e.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('cursor inválido lança InvalidCursorError', async () => {
    const wallet = await seedWallet(txm);
    for (const cursor of [
      'lixo',
      Buffer.from('{"c":"x","i":"y"}').toString('base64url'),
    ]) {
      await expect(
        ledger.findPageByWallet(wallet.id, { cursor, limit: 10 }),
      ).rejects.toThrow(InvalidCursorError);
    }
  });

  it('calculateBalance reconstrói o saldo: créditos − débitos', async () => {
    const wallet = await seedWallet(txm);
    await appendEntry(wallet, {
      direction: LedgerDirection.Credit,
      amount: '50.00',
      before: '0.00',
      after: '50.00',
    });
    await appendEntry(wallet, {
      direction: LedgerDirection.Debit,
      amount: '20.00',
      before: '50.00',
      after: '30.00',
    });

    const result = await ledger.calculateBalance(wallet.id, 'BRL');
    expect(result.balance.toJSON()).toEqual({
      amount: '30.00',
      currency: 'BRL',
    });
    expect(result.entries).toBe(2);
  });

  it('calculateBalance de wallet sem lançamentos é 0.00', async () => {
    const wallet = await seedWallet(txm);
    const result = await ledger.calculateBalance(wallet.id, 'BRL');
    expect(result.balance.toJSON().amount).toBe('0.00');
    expect(result.entries).toBe(0);
  });

  it('calculateBalance expõe ledger divergente com valor negativo (para a reconciliação)', async () => {
    const wallet = await seedWallet(txm);
    await appendEntry(wallet, {
      direction: LedgerDirection.Debit,
      amount: '20.00',
      before: '50.00',
      after: '30.00',
    });
    const result = await ledger.calculateBalance(wallet.id, 'BRL');
    expect(result.balance.isNegative()).toBe(true);
    expect(result.balance.toJSON().amount).toBe('-20.00');
  });
});
