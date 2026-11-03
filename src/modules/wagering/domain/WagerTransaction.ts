import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/Money';
import { LedgerDirection, oppositeOf } from '../../wallets/domain/LedgerDirection';
import { FailureCode } from './FailureCode';
import { WagerTransactionKind as Kind } from './WagerTransactionKind';
import { WagerTransactionStatus as Status } from './WagerTransactionStatus';

/** Quais kinds podem ser referenciados por cada kind (seção 7, regra 3). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<Kind, readonly Kind[]>> = {
  [Kind.Win]: [Kind.Bet], // referência opcional
  [Kind.Refund]: [Kind.Bet], // obrigatória
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund], // obrigatória
};

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  /** id no provedor — não o id interno */
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: Status;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** saldo da wallet no momento do processamento (usado para responder replays) */
  observedBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

export type CreateWagerTransactionProps = Pick<
  WagerTransactionState,
  | 'id'
  | 'providerId'
  | 'externalTransactionId'
  | 'idempotencyKey'
  | 'payloadHash'
  | 'walletId'
  | 'playerId'
  | 'roundId'
  | 'gameId'
  | 'kind'
  | 'money'
  | 'referenceExternalTransactionId'
  | 'createdAt'
>;

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: Kind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: Status;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._observedBalance = state.observedBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
  }

  /** Nasce em PENDING. OPENING é interno e não pode ser criado por aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    return WagerTransaction.build(props);
  }

  /** Crédito de abertura da wallet (interno). Ids derivados do walletId garantem idempotência. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    createdAt: Date;
  }): WagerTransaction {
    return WagerTransaction.build({
      id: props.id,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash: `opening:${props.money.toString()}`,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'internal',
      kind: Kind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.createdAt,
    });
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId: reference } = props;

    if (!Object.values(Kind).includes(kind)) {
      throw new InvalidWagerTransactionError(`unknown kind: ${String(kind)}`);
    }
    if (money.isNegative()) {
      throw new InvalidWagerTransactionError('amount cannot be negative');
    }
    // Operações que movem saldo precisam de valor > 0; LOSS pode ter 0.00.
    if (kind !== Kind.Loss && !money.isPositive()) {
      throw new InvalidWagerTransactionError(`${kind} amount must be greater than zero`);
    }
    if ((kind === Kind.Refund || kind === Kind.Rollback) && !reference) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if (reference !== undefined && !ALLOWED_REFERENCE_KINDS[kind]) {
      throw new InvalidWagerTransactionError(`${kind} does not accept a reference`);
    }

    return new WagerTransaction({ ...props, status: Status.Pending, referenceAttempts: 0 });
  }

  // ------------------------------------------------------------------ getters
  get status(): Status {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // -------------------------------------------------------------- transições
  /** Grava tudo de uma vez: depois de terminal, nada mais pode mudar (nem no banco). */
  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal('markProcessed');
    if (this.hasReference() && !referenceTransactionId) {
      throw new InvalidTransactionStateError(
        `${this.kind} with a reference needs the resolved referenceTransactionId to be processed`,
      );
    }
    this._status = Status.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Referência ainda não chegou. Pode ser chamado de novo a cada tentativa (reagenda o backoff). */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertNotTerminal('markPendingReference');
    if (!this.hasReference()) {
      throw new InvalidTransactionStateError(`${this.kind} has no reference to wait for`);
    }
    this._status = Status.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('reject');
    this._status = Status.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = Status.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ------------------------------------------------------ consultas de domínio
  isTerminal(): boolean {
    return (
      this._status === Status.Processed ||
      this._status === Status.Rejected ||
      this._status === Status.Failed
    );
  }

  /** false para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Sentido do lançamento no ledger. ROLLBACK inverte o sentido da referência.
   * LOSS não move saldo e portanto não tem direção.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Win:
      case Kind.Refund:
      case Kind.Opening:
        return LedgerDirection.Credit;
      case Kind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK needs its reference to define the direction');
        }
        return oppositeOf(reference.ledgerDirectionFor());
      case Kind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not move balance');
    }
  }

  /**
   * Regras 2 a 5 da seção 7, sobre a referência já resolvida. Devolve o FailureCode
   * se ela é inválida para esta transação, ou undefined se está tudo certo.
   * O estado da referência (PROCESSED, ainda pendente, já revertida) é tratado pelo use case.
   */
  validateReference(reference: WagerTransaction): FailureCode | undefined {
    const allowedKinds = ALLOWED_REFERENCE_KINDS[this.kind];
    if (!allowedKinds || !allowedKinds.includes(reference.kind)) {
      return FailureCode.InvalidReferenceKind;
    }
    if (
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (this.requiresReference() && !reference.money.equals(this.money)) {
      return FailureCode.ReversalAmountMismatch;
    }
    return undefined;
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${operation}: transaction ${this.id} is already ${this._status}`,
      );
    }
  }
}
