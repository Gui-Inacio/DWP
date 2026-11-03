import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/shared/infra/database/data-source';

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://wagering:wagering@localhost:5432/wagering_test';

let ds: DataSource;
const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  ds = createDataSource(TEST_URL);
  await ds.initialize();
  await ds.runMigrations();
});

afterAll(async () => {
  await ds.destroy();
});

beforeEach(async () => {
  await ds.query(
    'TRUNCATE wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages CASCADE',
  );
});

async function insertWallet(
  balance = '100.00',
  currency = 'BRL',
  playerId = uuid(),
) {
  const id = uuid();
  await ds.query(
    `INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1, $2, $3, $4)`,
    [id, playerId, currency, balance],
  );
  return { id, playerId };
}

interface TxInput {
  walletId: string;
  playerId: string;
  kind?: string;
  amount?: string;
  status?: string;
  failureCode?: string | null;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  referenceExternalId?: string | null;
  referenceTransactionId?: string | null;
}

async function insertTx(i: TxInput) {
  const id = uuid();
  const externalId = i.externalId ?? uuid();
  await ds.query(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        reference_transaction_id, status, failure_code)
     VALUES ($1, $2, $3, $4, 'hash', $5, $6, 'round-1', 'game-1', $7, $8, 'BRL', $9, $10, $11, $12)`,
    [
      id,
      i.providerId ?? 'provider-a',
      externalId,
      i.idempotencyKey ?? uuid(),
      i.walletId,
      i.playerId,
      i.kind ?? 'BET',
      i.amount ?? '10.00',
      i.referenceExternalId ?? null,
      i.referenceTransactionId ?? null,
      i.status ?? 'PROCESSED',
      i.failureCode ?? null,
    ],
  );
  return { id, externalId };
}

async function insertLedger(o: {
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  before: string;
  after: string;
}) {
  await ds.query(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
     VALUES ($1, $2, $3, $4, $5, 'BRL', $6, $7)`,
    [
      uuid(),
      o.walletId,
      o.transactionId,
      o.direction,
      o.amount,
      o.before,
      o.after,
    ],
  );
}

describe('wallets', () => {
  it('rejeita saldo negativo', async () => {
    const w = await insertWallet('10.00');
    await expect(
      ds.query(`UPDATE wallets SET balance = -0.01 WHERE id = $1`, [w.id]),
    ).rejects.toThrow('wallets_balance_non_negative');
  });

  it('permite só uma wallet por player + moeda', async () => {
    const w = await insertWallet('0.00', 'BRL');
    await expect(insertWallet('0.00', 'BRL', w.playerId)).rejects.toThrow(
      'wallets_player_currency_unique',
    );
    await insertWallet('0.00', 'USD', w.playerId); // outra moeda é permitida
  });
});

describe('wager_transactions', () => {
  it('rejeita idempotency key duplicada', async () => {
    const w = await insertWallet();
    await insertTx({
      walletId: w.id,
      playerId: w.playerId,
      idempotencyKey: 'key-1',
    });
    await expect(
      insertTx({
        walletId: w.id,
        playerId: w.playerId,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toThrow('wager_tx_idempotency_key_unique');
  });

  it('rejeita (provider, externalTransactionId) duplicado', async () => {
    const w = await insertWallet();
    await insertTx({
      walletId: w.id,
      playerId: w.playerId,
      externalId: 'ext-1',
    });
    await expect(
      insertTx({ walletId: w.id, playerId: w.playerId, externalId: 'ext-1' }),
    ).rejects.toThrow('wager_tx_provider_external_unique');
  });

  it('exige referência em REFUND/ROLLBACK (opcional nas demais, ex.: WIN)', async () => {
    const w = await insertWallet();
    await expect(
      insertTx({ walletId: w.id, playerId: w.playerId, kind: 'REFUND' }),
    ).rejects.toThrow('wager_tx_reference_required');
    await insertTx({
      walletId: w.id,
      playerId: w.playerId,
      kind: 'WIN',
      referenceExternalId: 'x',
    });
  });

  it('exige failure_code em REJECTED/FAILED', async () => {
    const w = await insertWallet();
    await expect(
      insertTx({ walletId: w.id, playerId: w.playerId, status: 'REJECTED' }),
    ).rejects.toThrow('wager_tx_failure_code_required');
    await insertTx({
      walletId: w.id,
      playerId: w.playerId,
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('impede reverter a mesma referência duas vezes com o mesmo tipo', async () => {
    const w = await insertWallet();
    const bet = await insertTx({
      walletId: w.id,
      playerId: w.playerId,
      kind: 'BET',
    });
    const refund = (status = 'PROCESSED', failureCode: string | null = null) =>
      insertTx({
        walletId: w.id,
        playerId: w.playerId,
        kind: 'REFUND',
        referenceExternalId: bet.externalId,
        referenceTransactionId: bet.id,
        status,
        failureCode,
      });

    await refund();
    await expect(refund()).rejects.toThrow(
      'wager_tx_one_reversal_per_reference',
    );
    await refund('REJECTED', 'ALREADY_REVERSED'); // rejeitada não conta
  });

  it('estado terminal não pode mudar', async () => {
    const w = await insertWallet();
    const done = await insertTx({
      walletId: w.id,
      playerId: w.playerId,
      status: 'PROCESSED',
    });
    await expect(
      ds.query(
        `UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1`,
        [done.id],
      ),
    ).rejects.toThrow('is terminal');

    const pending = await insertTx({
      walletId: w.id,
      playerId: w.playerId,
      status: 'PENDING',
    });
    await ds.query(
      `UPDATE wager_transactions SET status = 'PROCESSED' WHERE id = $1`,
      [pending.id],
    );
  });
});

describe('wallet_ledger_entries', () => {
  async function ledgerFixture() {
    const w = await insertWallet('110.00');
    const tx = await insertTx({
      walletId: w.id,
      playerId: w.playerId,
      kind: 'WIN',
      amount: '10.00',
    });
    return { w, tx };
  }

  it('aceita lançamento com aritmética correta', async () => {
    const { w, tx } = await ledgerFixture();
    await insertLedger({
      walletId: w.id,
      transactionId: tx.id,
      direction: 'CREDIT',
      amount: '10.00',
      before: '100.00',
      after: '110.00',
    });
  });

  it('rejeita lançamento com aritmética errada', async () => {
    const { w, tx } = await ledgerFixture();
    await expect(
      insertLedger({
        walletId: w.id,
        transactionId: tx.id,
        direction: 'CREDIT',
        amount: '10.00',
        before: '100.00',
        after: '999.00',
      }),
    ).rejects.toThrow('ledger_arithmetic');
  });

  it('permite no máximo um lançamento por (wallet, transação)', async () => {
    const { w, tx } = await ledgerFixture();
    const entry = {
      walletId: w.id,
      transactionId: tx.id,
      direction: 'CREDIT',
      amount: '10.00',
      before: '100.00',
      after: '110.00',
    };
    await insertLedger(entry);
    await expect(insertLedger(entry)).rejects.toThrow(
      'ledger_wallet_transaction_unique',
    );
  });

  it('é append-only: UPDATE e DELETE são bloqueados', async () => {
    const { w, tx } = await ledgerFixture();
    await insertLedger({
      walletId: w.id,
      transactionId: tx.id,
      direction: 'CREDIT',
      amount: '10.00',
      before: '100.00',
      after: '110.00',
    });
    await expect(
      ds.query(`UPDATE wallet_ledger_entries SET amount = 1.00`),
    ).rejects.toThrow('append-only');
    await expect(ds.query(`DELETE FROM wallet_ledger_entries`)).rejects.toThrow(
      'append-only',
    );
  });
});

describe('inbox', () => {
  it('deduplica por (consumer_name, message_id)', async () => {
    const insert = () =>
      ds.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c', 'm-1', 'h')`,
      );
    await insert();
    await expect(insert()).rejects.toThrow('inbox_messages_pkey');
  });
});
