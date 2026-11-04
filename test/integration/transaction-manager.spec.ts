import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { DataSource, EntityManager } from 'typeorm';
import { createDataSource } from '../../src/shared/infra/database/data-source';
import { TypeOrmTransactionManager } from '../../src/shared/infra/database/TypeOrmTransactionManager';

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://wagering:wagering@localhost:5432/wagering_test';

let ds: DataSource;
let txm: TypeOrmTransactionManager;
const uuid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  ds = createDataSource(TEST_URL);
  await ds.initialize();
  await ds.runMigrations();
  txm = new TypeOrmTransactionManager(ds);
});

afterAll(async () => {
  await ds.destroy();
});

beforeEach(async () => {
  await ds.query(
    'TRUNCATE wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages CASCADE',
  );
});

const insertWallet = (
  manager: EntityManager,
  id = uuid(),
  balance = '100.00',
) =>
  manager.query(
    `INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1, $2, 'BRL', $3)`,
    [id, uuid(), balance],
  );

const countWallets = async () =>
  Number((await ds.query('SELECT count(*)::int AS n FROM wallets'))[0].n);

describe('TypeOrmTransactionManager', () => {
  it('fora de transação usa o manager padrão', () => {
    expect(txm.isActive).toBe(false);
    expect(txm.manager).toBe(ds.manager);
    expect(() => txm.requireManager()).toThrow();
  });

  it('commit: grava tudo ao terminar sem erro', async () => {
    await txm.run(async () => {
      expect(txm.isActive).toBe(true);
      await insertWallet(txm.manager);
      await insertWallet(txm.manager);
    });
    expect(await countWallets()).toBe(2);
    expect(txm.isActive).toBe(false);
  });

  it('rollback: não grava nada e propaga o erro', async () => {
    await expect(
      txm.run(async () => {
        await insertWallet(txm.manager);
        await insertWallet(txm.manager);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await countWallets()).toBe(0);
  });

  it('a gravação só fica visível para os outros depois do commit', async () => {
    let seenInside = -1;
    await txm.run(async () => {
      await insertWallet(txm.manager);
      seenInside = await countWallets(); // outra conexão (autocommit) não enxerga ainda
    });
    expect(seenInside).toBe(0);
    expect(await countWallets()).toBe(1);
  });

  it('chamadas aninhadas participam da mesma transação (erro interno desfaz tudo)', async () => {
    await expect(
      txm.run(async () => {
        const outer = txm.manager;
        await insertWallet(outer);
        await txm.run(async () => {
          expect(txm.manager).toBe(outer);
          await insertWallet(txm.manager);
          throw new Error('inner failed');
        });
      }),
    ).rejects.toThrow('inner failed');
    expect(await countWallets()).toBe(0);
  });

  it('transações paralelas não misturam contexto', async () => {
    const managers = await Promise.all(
      Array.from({ length: 20 }, () =>
        txm.run(async () => {
          const mine = txm.manager;
          await sleep(Math.random() * 15);
          expect(txm.manager).toBe(mine);
          await insertWallet(mine);
          await sleep(Math.random() * 15);
          expect(txm.manager).toBe(mine);
          return mine;
        }),
      ),
    );
    expect(new Set(managers).size).toBe(20);
    expect(await countWallets()).toBe(20);
  });

  it('SELECT ... FOR UPDATE serializa duas transações na mesma wallet (sem lost update)', async () => {
    const walletId = uuid();
    await insertWallet(ds.manager, walletId, '100.00');
    const events: string[] = [];
    let balanceSeenByB = '';

    const debit80 = (label: 'A' | 'B', hold: number) =>
      txm.run(async () => {
        const [row] = await txm
          .requireManager()
          .query('SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [
            walletId,
          ]);
        events.push(`${label} locked`);
        if (label === 'B') balanceSeenByB = row.balance;
        await sleep(hold);
        await txm.manager.query(
          'UPDATE wallets SET balance = balance - 80 WHERE id = $1',
          [walletId],
        );
        events.push(`${label} done`);
      });

    const a = debit80('A', 150);
    await sleep(30); // B começa enquanto A segura o lock
    const b = debit80('B', 0).catch((error: Error) => error); // 20.00 - 80 viola o CHECK
    await Promise.all([a, b]);

    expect(events.slice(0, 3)).toEqual(['A locked', 'A done', 'B locked']);
    expect(balanceSeenByB).toBe('20.00'); // B leu o saldo já atualizado por A
    const [final] = await ds.query(
      'SELECT balance FROM wallets WHERE id = $1',
      [walletId],
    );
    expect(final.balance).toBe('20.00'); // o CHECK de saldo >= 0 barrou o segundo débito
  });
});
