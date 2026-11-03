import { describe, expect, it } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/Money';
import { LedgerDirection } from '../../wallets/domain/LedgerDirection';
import { FailureCode } from './FailureCode';
import { type CreateWagerTransactionProps, WagerTransaction } from './WagerTransaction';
import { WagerTransactionKind as Kind } from './WagerTransactionKind';
import { WagerTransactionStatus as Status } from './WagerTransactionStatus';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const T0 = new Date('2026-11-02T12:00:00Z');
const T1 = new Date('2026-11-02T12:01:00Z');

const props = (over: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 't-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'provider-a:ext-1',
  payloadHash: 'hash-1',
  walletId: 'w-1',
  playerId: 'p-1',
  roundId: 'r-1',
  gameId: 'g-1',
  kind: Kind.Bet,
  money: brl('25.00'),
  referenceExternalTransactionId: undefined,
  createdAt: T0,
  ...over,
});

const bet = (over: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(over));

/** Cria uma transação dependente apontando para `ref`. */
const dependent = (
  kind: Kind,
  ref: WagerTransaction,
  over: Partial<CreateWagerTransactionProps> = {},
) =>
  WagerTransaction.create(
    props({
      id: 't-2',
      externalTransactionId: 'ext-2',
      idempotencyKey: 'provider-a:ext-2',
      kind,
      money: ref.money,
      referenceExternalTransactionId: ref.externalTransactionId,
      ...over,
    }),
  );

describe('WagerTransaction.create', () => {
  it('nasce PENDING', () => {
    const tx = bet();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  it('não aceita OPENING pela factory pública', () => {
    expect(() => bet({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  it('createOpening gera uma transação interna de crédito', () => {
    const tx = WagerTransaction.createOpening({
      id: 't-open',
      walletId: 'w-1',
      playerId: 'p-1',
      money: brl('1000.00'),
      createdAt: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.idempotencyKey).toBe('opening:w-1');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('REFUND e ROLLBACK exigem referência', () => {
    expect(() => bet({ kind: Kind.Refund })).toThrow(InvalidWagerTransactionError);
    expect(() => bet({ kind: Kind.Rollback })).toThrow(InvalidWagerTransactionError);
  });

  it('BET e LOSS não aceitam referência; WIN aceita (opcional)', () => {
    expect(() => bet({ referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
    expect(() => bet({ kind: Kind.Loss, referenceExternalTransactionId: 'x' })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(bet({ kind: Kind.Win, referenceExternalTransactionId: 'x' }).hasReference()).toBe(true);
    expect(bet({ kind: Kind.Win }).hasReference()).toBe(false);
  });

  it('valor deve ser > 0, exceto LOSS que aceita 0.00; negativo nunca', () => {
    expect(() => bet({ money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(() => bet({ kind: Kind.Win, money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(bet({ kind: Kind.Loss, money: brl('0.00') }).status).toBe(Status.Pending);
    expect(() => bet({ kind: Kind.Loss, money: brl('1.00').negate() })).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('consultas de domínio', () => {
  it('affectsBalance é false só para LOSS', () => {
    expect(bet({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    expect(bet({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(bet({ kind: Kind.Win }).affectsBalance()).toBe(true);
  });

  it('requiresReference é true só para REFUND e ROLLBACK', () => {
    const b = bet();
    expect(b.requiresReference()).toBe(false);
    expect(dependent(Kind.Refund, b).requiresReference()).toBe(true);
    expect(dependent(Kind.Rollback, b).requiresReference()).toBe(true);
  });

  it('matchesPayload compara o hash', () => {
    const tx = bet({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });
});

describe('transições de estado', () => {
  it('PENDING → PROCESSED grava tudo de uma vez', () => {
    const tx = bet();
    tx.markProcessed(undefined, T1, brl('75.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(T1);
    expect(tx.observedBalance?.toJSON().amount).toBe('75.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING → REJECTED guarda o failureCode e o saldo observado', () => {
    const tx = bet();
    tx.reject(FailureCode.InsufficientFunds, T1, brl('20.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.observedBalance?.toJSON().amount).toBe('20.00');
  });

  it('PENDING → FAILED', () => {
    const tx = bet();
    tx.fail(FailureCode.PermanentFailure, T1);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.PermanentFailure);
  });

  it('PENDING_REFERENCE pode ser reagendada várias vezes e depois processada', () => {
    const tx = dependent(Kind.Refund, bet());
    tx.markPendingReference(new Date('2026-11-02T12:00:05Z'));
    tx.markPendingReference(new Date('2026-11-02T12:00:15Z'));
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceAttemptAt).toEqual(new Date('2026-11-02T12:00:15Z'));

    tx.markProcessed('t-1', T1, brl('100.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('t-1');
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  it('estados terminais não aceitam nenhuma transição', () => {
    const makers: Array<() => WagerTransaction> = [
      () => {
        const tx = bet();
        tx.markProcessed(undefined, T1, brl('1.00'));
        return tx;
      },
      () => {
        const tx = bet();
        tx.reject(FailureCode.InsufficientFunds, T1);
        return tx;
      },
      () => {
        const tx = bet();
        tx.fail(FailureCode.PermanentFailure, T1);
        return tx;
      },
    ];
    for (const make of makers) {
      const tx = make();
      expect(() => tx.markProcessed(undefined, T1, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds, T1)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.PermanentFailure, T1)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference(T1)).toThrow(InvalidTransactionStateError);
    }
  });

  it('markPendingReference exige uma referência; markProcessed exige a referência resolvida', () => {
    expect(() => bet().markPendingReference(T1)).toThrow(InvalidTransactionStateError);
    const refund = dependent(Kind.Refund, bet());
    expect(() => refund.markProcessed(undefined, T1, brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('ledgerDirectionFor', () => {
  it('BET debita; WIN e REFUND creditam', () => {
    const b = bet();
    expect(b.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(bet({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(dependent(Kind.Refund, b).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('LOSS não tem direção', () => {
    expect(() => bet({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  it('ROLLBACK inverte o sentido da referência', () => {
    const b = bet();
    const win = bet({ id: 't-w', externalTransactionId: 'ext-w', kind: Kind.Win });
    const refund = dependent(Kind.Refund, b);

    expect(dependent(Kind.Rollback, b).ledgerDirectionFor(b)).toBe(LedgerDirection.Credit);
    expect(dependent(Kind.Rollback, win).ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(dependent(Kind.Rollback, refund).ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK sem a referência lança erro', () => {
    expect(() => dependent(Kind.Rollback, bet()).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('validateReference', () => {
  it('aceita REFUND de BET e ROLLBACK de BET, WIN e REFUND com mesmo valor', () => {
    const b = bet();
    const win = bet({ id: 't-w', externalTransactionId: 'ext-w', kind: Kind.Win });
    const refund = dependent(Kind.Refund, b);

    expect(dependent(Kind.Refund, b).validateReference(b)).toBeUndefined();
    expect(dependent(Kind.Rollback, b).validateReference(b)).toBeUndefined();
    expect(dependent(Kind.Rollback, win).validateReference(win)).toBeUndefined();
    expect(dependent(Kind.Rollback, refund, { externalTransactionId: 'ext-3' }).validateReference(refund)).toBeUndefined();
  });

  it('WIN pode referenciar BET com valor diferente', () => {
    const b = bet({ money: brl('10.00') });
    const win = dependent(Kind.Win, b, { money: brl('50.00') });
    expect(win.validateReference(b)).toBeUndefined();
  });

  it('REFUND só referencia BET', () => {
    const win = bet({ kind: Kind.Win });
    expect(dependent(Kind.Refund, win).validateReference(win)).toBe(FailureCode.InvalidReferenceKind);
  });

  it('exige mesmo provider, player, wallet, rodada e moeda', () => {
    const b = bet();
    for (const over of [
      { providerId: 'provider-b' },
      { playerId: 'p-2' },
      { walletId: 'w-2' },
      { roundId: 'r-2' },
    ] as Array<Partial<CreateWagerTransactionProps>>) {
      expect(dependent(Kind.Refund, b, over).validateReference(b)).toBe(FailureCode.ReferenceMismatch);
    }
    expect(dependent(Kind.Refund, b, { money: usd('25.00') }).validateReference(b)).toBe(
      FailureCode.ReferenceMismatch,
    );
  });

  it('referência resolvida com outro externalTransactionId é inconsistente', () => {
    const b = bet();
    const other = bet({ id: 't-9', externalTransactionId: 'ext-9' });
    expect(dependent(Kind.Refund, b).validateReference(other)).toBe(FailureCode.ReferenceMismatch);
  });

  it('REFUND/ROLLBACK precisam ter valor igual ao da referência', () => {
    const b = bet({ money: brl('25.00') });
    expect(dependent(Kind.Refund, b, { money: brl('10.00') }).validateReference(b)).toBe(
      FailureCode.ReversalAmountMismatch,
    );
    expect(dependent(Kind.Rollback, b, { money: brl('30.00') }).validateReference(b)).toBe(
      FailureCode.ReversalAmountMismatch,
    );
  });
});
