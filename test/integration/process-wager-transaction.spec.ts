import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { DataSource } from 'typeorm';
import type { OutboxMessage } from '../../src/messaging/domain/OutboxMessage';
import type { IOutboxRepository } from '../../src/messaging/repositories/IOutboxRepository';
import { FailureCode } from '../../src/modules/wagering/domain/FailureCode';
import {
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidRequestError,
  InvalidWagerTransactionError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/shared/domain/errors';
import type { TypeOrmTransactionManager } from '../../src/shared/infra/database/TypeOrmTransactionManager';
import {
  type App,
  buildApp,
  command,
  createWallet,
  expectConsistent,
  ledgerCount,
  outboxTypes,
} from './app';
import { openTestDatabase, truncateAll, uuid } from './helpers';

let ds: DataSource;
let txm: TypeOrmTransactionManager;
let app: App;

beforeAll(async () => {
  ({ ds, txm } = await openTestDatabase());
});
afterAll(async () => {
  await ds.destroy();
});
beforeEach(async () => {
  await truncateAll(ds);
  app = buildApp(txm);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
type Wallet = { id: string; playerId: string };
const run = (w: Wallet, over: Parameters<typeof command>[1] = {}) =>
  app.process.execute(command(w, over));
const clearOutbox = () => ds.query('DELETE FROM outbox_messages');
const walletBalance = async (id: string) =>
  (await app.wallets.findById(id))?.balance.toJSON().amount;

describe('CreateWallet', () => {
  it('cria a wallet com OPENING, lançamento CREDIT e eventos na mesma transação', async () => {
    const w = await createWallet(app, '1000.00');
    expect(w.balance).toEqual(brl('1000.00'));
    expect(w.version).toBe(1);
    expect(await ledgerCount(ds, w.id, 'CREDIT')).toBe(1);
    expect(await outboxTypes(ds, w.id)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectConsistent(app, w.id);
  });

  it('saldo inicial zero não gera OPENING, ledger nem eventos', async () => {
    const w = await createWallet(app, '0.00');
    expect(await ledgerCount(ds, w.id)).toBe(0);
    expect(await outboxTypes(ds, w.id)).toEqual([]);
  });

  it('wallet duplicada para o mesmo player + moeda é conflito', async () => {
    const playerId = uuid();
    await createWallet(app, '10.00', playerId);
    await expect(createWallet(app, '10.00', playerId)).rejects.toThrow(
      WalletAlreadyExistsError,
    );
  });
});

describe('BET e idempotência', () => {
  it('BET debita, gera 1 lançamento DEBIT e publica os eventos', async () => {
    const w = await createWallet(app, '1000.00');
    await clearOutbox();

    const result = await run(w, { externalTransactionId: 'bet-1' });

    expect(result).toMatchObject({
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
    expect(await ledgerCount(ds, w.id, 'DEBIT')).toBe(1);
    expect(await outboxTypes(ds, w.id)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect((await app.wallets.findById(w.id))?.version).toBe(2);
    await expectConsistent(app, w.id);
  });

  it('replay devolve o resultado original (inclusive o saldo observado) sem debitar de novo', async () => {
    const w = await createWallet(app, '1000.00');
    const cmd = command(w, { externalTransactionId: 'bet-1' });
    const first = await app.process.execute(cmd);
    await run(w, { externalTransactionId: 'bet-2' }); // o saldo muda depois do primeiro

    const replay = await app.process.execute(cmd);
    expect(replay).toMatchObject({
      transactionId: first.transactionId,
      status: 'PROCESSED',
      balance: brl('975.00'), // saldo daquele momento, não o atual (950.00)
      idempotentReplay: true,
    });
    expect(await ledgerCount(ds, w.id, 'DEBIT')).toBe(2);
    expect(await walletBalance(w.id)).toBe('950.00');
  });

  it('mesma key com payload diferente é conflito e não altera nada', async () => {
    const w = await createWallet(app, '1000.00');
    const cmd = command(w, { externalTransactionId: 'bet-1' });
    await app.process.execute(cmd);

    await expect(
      app.process.execute({ ...cmd, money: brl('26.00') }),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(await walletBalance(w.id)).toBe('975.00');
  });

  it('o mesmo payload com amount "25" e "25.00" é o mesmo payload (hash normalizado)', async () => {
    const w = await createWallet(app, '1000.00');
    const cmd = command(w, { externalTransactionId: 'bet-1' });
    await app.process.execute(cmd);
    const replay = await app.process.execute({ ...cmd, money: brl('25') });
    expect(replay.idempotentReplay).toBe(true);
  });

  it('externalTransactionId já usado com outra idempotency key é conflito', async () => {
    const w = await createWallet(app, '1000.00');
    const cmd = command(w, { externalTransactionId: 'bet-1' });
    await app.process.execute(cmd);
    await expect(
      app.process.execute({ ...cmd, idempotencyKey: 'outra-key' }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('saldo insuficiente: REJECTED, sem lançamento, evento Rejected, e o replay devolve a rejeição', async () => {
    const w = await createWallet(app, '100.00');
    await clearOutbox();
    const cmd = command(w, {
      externalTransactionId: 'bet-1',
      money: brl('150.00'),
    });

    const result = await app.process.execute(cmd);
    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.InsufficientFunds,
      balance: brl('100.00'),
      idempotentReplay: false,
    });
    expect(await ledgerCount(ds, w.id, 'DEBIT')).toBe(0);
    expect(await outboxTypes(ds, w.id)).toEqual(['WagerTransactionRejected']);

    const replay = await app.process.execute(cmd);
    expect(replay).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.InsufficientFunds,
      idempotentReplay: true,
    });
    await expectConsistent(app, w.id);
  });
});

describe('WIN e LOSS', () => {
  it('WIN credita (referenciando a BET); LOSS não move saldo nem gera lançamento, mas publica Processed', async () => {
    const w = await createWallet(app, '1000.00');
    await run(w, { externalTransactionId: 'bet-1' }); // 975.00
    const win = await run(w, {
      kind: 'WIN',
      externalTransactionId: 'win-1',
      referenceExternalTransactionId: 'bet-1',
      money: brl('100.00'),
    });
    expect(win).toMatchObject({ status: 'PROCESSED', balance: brl('1075.00') });

    await clearOutbox();
    const loss = await run(w, {
      kind: 'LOSS',
      externalTransactionId: 'loss-1',
      money: brl('10.00'),
    });
    expect(loss).toMatchObject({
      status: 'PROCESSED',
      balance: brl('1075.00'),
    });
    expect(await outboxTypes(ds, w.id)).toEqual(['WagerTransactionProcessed']); // sem WalletBalanceChanged
    expect(await ledgerCount(ds, w.id)).toBe(3); // OPENING + BET + WIN
    expect((await app.wallets.findById(w.id))?.version).toBe(3); // LOSS não incrementa version
    await expectConsistent(app, w.id);
  });

  it('WIN que referencia uma BET rejeitada é rejeitada', async () => {
    const w = await createWallet(app, '10.00');
    await run(w, { externalTransactionId: 'bet-1', money: brl('50.00') }); // REJECTED
    const win = await run(w, {
      kind: 'WIN',
      externalTransactionId: 'win-1',
      referenceExternalTransactionId: 'bet-1',
      money: brl('100.00'),
    });
    expect(win).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(await walletBalance(w.id)).toBe('10.00');
  });
});

describe('REFUND e ROLLBACK', () => {
  it('uma referência é revertida uma única vez; ROLLBACK de um REFUND é permitido', async () => {
    const w = await createWallet(app, '1000.00');
    await run(w, { externalTransactionId: 'bet-1' }); // 975.00

    const refund = await run(w, {
      kind: 'REFUND',
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-1',
    });
    expect(refund).toMatchObject({
      status: 'PROCESSED',
      balance: brl('1000.00'),
    });

    const again = await run(w, {
      kind: 'REFUND',
      externalTransactionId: 'refund-2',
      referenceExternalTransactionId: 'bet-1',
    });
    expect(again).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.AlreadyReversed,
    });

    // ROLLBACK da mesma BET já estornada duplicaria o crédito: rejeitado
    const rollbackBet = await run(w, {
      kind: 'ROLLBACK',
      externalTransactionId: 'rb-1',
      referenceExternalTransactionId: 'bet-1',
    });
    expect(rollbackBet).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.AlreadyReversed,
    });

    // ROLLBACK do próprio REFUND desfaz o crédito (sentido invertido: DEBIT)
    const rollbackRefund = await run(w, {
      kind: 'ROLLBACK',
      externalTransactionId: 'rb-2',
      referenceExternalTransactionId: 'refund-1',
    });
    expect(rollbackRefund).toMatchObject({
      status: 'PROCESSED',
      balance: brl('975.00'),
    });
    const twice = await run(w, {
      kind: 'ROLLBACK',
      externalTransactionId: 'rb-3',
      referenceExternalTransactionId: 'refund-1',
    });
    expect(twice).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.AlreadyReversed,
    });

    await expectConsistent(app, w.id);
  });

  it('reversão que deixaria saldo negativo tem failureCode distinto de aposta sem saldo', async () => {
    const w = await createWallet(app, '100.00');
    await run(w, { externalTransactionId: 'b1', money: brl('100.00') }); // 0.00
    await run(w, {
      kind: 'WIN',
      externalTransactionId: 'w1',
      money: brl('50.00'),
    }); // 50.00
    await run(w, { externalTransactionId: 'b2', money: brl('50.00') }); // 0.00

    const rollback = await run(w, {
      kind: 'ROLLBACK',
      externalTransactionId: 'rb-1',
      referenceExternalTransactionId: 'w1',
      money: brl('50.00'),
    });
    const bet = await run(w, {
      externalTransactionId: 'b3',
      money: brl('10.00'),
    });

    expect(rollback).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.ReversalWouldOverdraw,
    });
    expect(bet).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(await walletBalance(w.id)).toBe('0.00');
    await expectConsistent(app, w.id);
  });

  it('valida a referência: valor, tipo, rodada e status', async () => {
    const w = await createWallet(app, '1000.00');
    await run(w, { externalTransactionId: 'bet-1' });
    await run(w, {
      kind: 'WIN',
      externalTransactionId: 'win-1',
      money: brl('10.00'),
    });

    const amount = await run(w, {
      kind: 'REFUND',
      externalTransactionId: 'r1',
      referenceExternalTransactionId: 'bet-1',
      money: brl('10.00'),
    });
    const kind = await run(w, {
      kind: 'REFUND',
      externalTransactionId: 'r2',
      referenceExternalTransactionId: 'win-1',
      money: brl('10.00'),
    });
    const round = await run(w, {
      kind: 'REFUND',
      externalTransactionId: 'r3',
      referenceExternalTransactionId: 'bet-1',
      roundId: 'round-2',
    });

    expect(amount.failureCode).toBe(FailureCode.ReversalAmountMismatch);
    expect(kind.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect(round.failureCode).toBe(FailureCode.ReferenceMismatch);

    const poor = await createWallet(app, '10.00');
    await run(poor, { externalTransactionId: 'bet-x', money: brl('50.00') }); // REJECTED
    const notProcessed = await run(poor, {
      kind: 'REFUND',
      externalTransactionId: 'r4',
      referenceExternalTransactionId: 'bet-x',
      money: brl('50.00'),
    });
    expect(notProcessed.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('validação e wallet', () => {
  it('moeda diferente da wallet e player diferente do dono viram REJECTED auditáveis', async () => {
    const w = await createWallet(app, '100.00');
    const currency = await run(w, {
      externalTransactionId: 'bet-usd',
      money: { amount: '10.00', currency: 'USD' },
    });
    const player = await run(w, {
      externalTransactionId: 'bet-other',
      playerId: uuid(),
    });

    expect(currency).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.CurrencyMismatch,
    });
    expect(player).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.WalletPlayerMismatch,
    });
    expect(currency.balance).toBeUndefined(); // não expõe saldo de wallet de outra moeda...
    expect(player.balance).toBeUndefined(); // ...nem de wallet que não pertence ao player informado
    expect(await walletBalance(w.id)).toBe('100.00');
  });

  it('payload inválido é erro de validação, não rejeição persistida', async () => {
    const w = await createWallet(app, '100.00');
    await expect(run(w, { walletId: 'nao-e-uuid' })).rejects.toThrow(
      InvalidRequestError,
    );
    await expect(run(w, { kind: 'XYZ' })).rejects.toThrow(InvalidRequestError);
    await expect(run(w, { idempotencyKey: '' })).rejects.toThrow(
      InvalidRequestError,
    );
    await expect(run(w, { money: brl('1.234') })).rejects.toThrow(
      InvalidMoneyError,
    );
    await expect(run(w, { kind: 'OPENING' })).rejects.toThrow(
      InvalidWagerTransactionError,
    );
    await expect(run(w, { kind: 'REFUND' })).rejects.toThrow(
      InvalidWagerTransactionError,
    ); // sem referência
    await expect(run({ id: uuid(), playerId: w.playerId })).rejects.toThrow(
      WalletNotFoundError,
    );
    const [{ n }] = await ds.query(
      'SELECT count(*)::int AS n FROM wager_transactions',
    );
    expect(n).toBe(1); // só o OPENING
  });
});

describe('referências fora de ordem', () => {
  it('REFUND antes da BET fica PENDING_REFERENCE e é concluído pelo worker', async () => {
    const w = await createWallet(app, '1000.00');
    await clearOutbox();
    const refundCmd = command(w, {
      kind: 'REFUND',
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-1',
    });

    const pending = await app.process.execute(refundCmd);
    expect(pending.status).toBe('PENDING_REFERENCE');
    expect(pending.balance).toBeUndefined();
    expect(await outboxTypes(ds, w.id)).toEqual([
      'WagerTransactionPendingReference',
    ]);

    const replay = await app.process.execute(refundCmd);
    expect(replay).toMatchObject({
      status: 'PENDING_REFERENCE',
      idempotentReplay: true,
    });
    expect(await app.reprocess.execute()).toEqual({ handled: 0 }); // ainda não venceu

    await run(w, { externalTransactionId: 'bet-1' }); // a referência chega
    expect(await walletBalance(w.id)).toBe('975.00');

    app.clock.advance(1000);
    expect(await app.reprocess.execute()).toEqual({ handled: 1 });

    const [row] = await ds.query(
      'SELECT status FROM wager_transactions WHERE id = $1',
      [pending.transactionId],
    );
    expect(row.status).toBe('PROCESSED');
    expect(await walletBalance(w.id)).toBe('1000.00');
    expect(await app.reprocess.execute()).toEqual({ handled: 0 });
    expect(await outboxTypes(ds, w.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    await expectConsistent(app, w.id);
  });

  it('esgotado o limite de tentativas: REJECTED com REFERENCE_NOT_FOUND e evento Rejected', async () => {
    app = buildApp(txm, {
      policy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 8000 },
    });
    const w = await createWallet(app, '1000.00');
    await clearOutbox();
    const cmd = command(w, {
      kind: 'REFUND',
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'nunca-chega',
    });
    const pending = await app.process.execute(cmd);

    app.clock.advance(1000);
    expect(await app.reprocess.execute()).toEqual({ handled: 1 }); // reagenda (tentativa 2)
    app.clock.advance(2000);
    expect(await app.reprocess.execute()).toEqual({ handled: 1 }); // esgotou

    const [row] = await ds.query(
      'SELECT status, failure_code FROM wager_transactions WHERE id = $1',
      [pending.transactionId],
    );
    expect(row).toEqual({
      status: 'REJECTED',
      failure_code: FailureCode.ReferenceNotFound,
    });
    expect(await outboxTypes(ds, w.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await app.process.execute(cmd)).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.ReferenceNotFound,
      idempotentReplay: true,
    });
    expect(await walletBalance(w.id)).toBe('1000.00');
  });

  it('dois workers concorrentes reprocessam 10 pendências sem processar nenhuma duas vezes', async () => {
    const w = await createWallet(app, '1000.00');
    for (let i = 0; i < 10; i++) {
      await run(w, {
        kind: 'REFUND',
        externalTransactionId: `refund-${i}`,
        referenceExternalTransactionId: `bet-${i}`,
        money: brl('10.00'),
      });
    }
    for (let i = 0; i < 10; i++) {
      await run(w, { externalTransactionId: `bet-${i}`, money: brl('10.00') });
    }
    expect(await walletBalance(w.id)).toBe('900.00');

    app.clock.advance(1000);
    const [a, b] = await Promise.all([
      app.reprocess.execute(20),
      app.reprocess.execute(20),
    ]);
    expect(a.handled + b.handled).toBe(10);
    expect(await walletBalance(w.id)).toBe('1000.00');
    expect(await ledgerCount(ds, w.id, 'CREDIT')).toBe(11); // OPENING + 10 REFUND
    await expectConsistent(app, w.id);
  });
});

describe('atomicidade', () => {
  it('se a outbox falha, NADA é gravado (wallet, ledger, transação) e o retry funciona', async () => {
    class FailingOutbox implements IOutboxRepository {
      add(_message: OutboxMessage): Promise<void> {
        return Promise.reject(new Error('outbox down'));
      }
      claimDue(): Promise<OutboxMessage[]> {
        return Promise.resolve([]);
      }
      save(): Promise<void> {
        return Promise.resolve();
      }
      oldestPendingOccurredAt(): Promise<Date | null> {
        return Promise.resolve(null);
      }
    }
    const w = await createWallet(app, '1000.00');
    const broken = buildApp(txm, { outbox: new FailingOutbox() });
    const cmd = command(w, { externalTransactionId: 'bet-1' });

    await expect(broken.process.execute(cmd)).rejects.toThrow('outbox down');

    expect(await walletBalance(w.id)).toBe('1000.00');
    expect((await app.wallets.findById(w.id))?.version).toBe(1);
    expect(await ledgerCount(ds, w.id)).toBe(1); // só o OPENING
    const [{ n }] = await ds.query(
      'SELECT count(*)::int AS n FROM wager_transactions',
    );
    expect(n).toBe(1);

    // sem resíduos de idempotência: o retry processa normalmente
    expect(await app.process.execute(cmd)).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: false,
    });
    await expectConsistent(app, w.id);
  });
});

describe('concorrência', () => {
  it('a mesma aposta 50 vezes em paralelo gera um único débito', async () => {
    const w = await createWallet(app, '1000.00');
    const cmd = command(w, { externalTransactionId: 'bet-dup' });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => app.process.execute(cmd)),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(
      results.every(
        (r) => r.status === 'PROCESSED' && r.balance?.amount === '975.00',
      ),
    ).toBe(true);
    expect(await ledgerCount(ds, w.id, 'DEBIT')).toBe(1);
    expect(await walletBalance(w.id)).toBe('975.00');
    await expectConsistent(app, w.id);
  });

  it('cenário obrigatório: 100.00 com duas apostas de 80.00 simultâneas', async () => {
    const w = await createWallet(app, '100.00');
    const cmds = ['a', 'b'].map((id) =>
      command(w, { externalTransactionId: id, money: brl('80.00') }),
    );

    const results = await Promise.all(cmds.map((c) => app.process.execute(c)));

    expect(results.map((r) => r.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );
    expect(await walletBalance(w.id)).toBe('20.00');
    expect(await ledgerCount(ds, w.id, 'DEBIT')).toBe(1);

    // nenhum retry duplica o débito
    const retries = await Promise.all(cmds.map((c) => app.process.execute(c)));
    expect(retries.every((r) => r.idempotentReplay)).toBe(true);
    expect(await ledgerCount(ds, w.id, 'DEBIT')).toBe(1);
    await expectConsistent(app, w.id);
  });

  it('hot wallet: 100 apostas de 10.00 sobre 500.00, exatamente 50 passam', async () => {
    const w = await createWallet(app, '500.00');
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        run(w, { externalTransactionId: `hot-${i}`, money: brl('10.00') }),
      ),
    );
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(50);
    expect(
      results.filter((r) => r.failureCode === FailureCode.InsufficientFunds),
    ).toHaveLength(50);
    expect(await walletBalance(w.id)).toBe('0.00');
    expect(await ledgerCount(ds, w.id, 'DEBIT')).toBe(50);
    await expectConsistent(app, w.id);
  });

  it('20 wallets diferentes em paralelo, 5 apostas cada', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 20 }, () => createWallet(app, '100.00')),
    );
    await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 5 }, (_, i) =>
          run(w, {
            externalTransactionId: `bet-${w.id}-${i}`,
            money: brl('10.00'),
          }),
        ),
      ),
    );
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe('50.00');
      await expectConsistent(app, w.id);
    }
  });
});
