import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from '../../../shared/application/ports';
import { TRANSACTION_MANAGER, type ITransactionManager } from '../../../shared/application/ITransactionManager';
import { hashPayload } from '../../../shared/domain/canonicalHash';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  WalletNotFoundError,
} from '../../../shared/domain/errors';
import { Money, type MoneyProps } from '../../../shared/domain/Money';
import { type IWalletRepository, WALLET_REPOSITORY } from '../../wallets/repositories/IWalletRepository';
import type { FailureCode } from '../domain/FailureCode';
import { WagerTransaction } from '../domain/WagerTransaction';
import { WagerTransactionKind } from '../domain/WagerTransactionKind';
import type { WagerTransactionStatus } from '../domain/WagerTransactionStatus';
import {
  type IWagerTransactionRepository,
  WAGER_TRANSACTION_REPOSITORY,
} from '../repositories/IWagerTransactionRepository';
import { WagerTransactionApplier } from './WagerTransactionApplier';

export interface ProcessWagerTransactionCommand {
  /** header Idempotency-Key (HTTP) ou data.idempotencyKey (SQS): fonte da verdade */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 255;

function requireText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new InvalidRequestError(`${name} must be a non-empty string up to ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function requireUuid(name: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidRequestError(`${name} must be a UUID`);
  }
  return value;
}

function parseKind(value: unknown): WagerTransactionKind {
  if (!Object.values(WagerTransactionKind).includes(value as WagerTransactionKind)) {
    throw new InvalidRequestError(`kind must be one of ${Object.values(WagerTransactionKind).join(', ')}`);
  }
  return value as WagerTransactionKind;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txm: ITransactionManager,
    @Inject(WALLET_REPOSITORY) private readonly wallets: IWalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: IWagerTransactionRepository,
    @Inject(WagerTransactionApplier) private readonly applier: WagerTransactionApplier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /**
   * Erros de validação (InvalidRequestError, InvalidMoneyError, InvalidWagerTransactionError) e de
   * idempotência (IdempotencyConflictError) são lançados; rejeições de negócio voltam como
   * resultado com status REJECTED. Pode ser chamado dentro de uma transação já aberta (consumer SQS + inbox).
   */
  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const candidate = this.buildCandidate(command);

    return this.txm.run(async () => {
      // A wallet é travada ANTES do INSERT da transação. O INSERT, por causa da FK, toma um lock leve
      // (FOR KEY SHARE) na linha da wallet; travar depois (FOR UPDATE) faria duas requisições
      // concorrentes se bloquearem mutuamente (deadlock). Wallet inexistente não vira transação (404).
      const wallet = await this.wallets.findByIdForUpdate(candidate.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(candidate.walletId);
      }

      // O banco decide quem é a primeira de várias requisições simultâneas.
      const inserted = await this.transactions.insertIfAbsent(candidate);
      if (!inserted) {
        return this.replay(candidate);
      }

      const outcome = await this.applier.apply(candidate, {
        correlationId: command.correlationId,
        causationId: command.causationId,
      });
      return { transactionId: candidate.id, ...outcome, idempotentReplay: false };
    });
  }

  private async replay(candidate: WagerTransaction): Promise<ProcessWagerTransactionResult> {
    const existing = await this.transactions.findByIdempotencyKey(candidate.idempotencyKey);
    if (!existing) {
      // Conflitou por (provider, externalTransactionId), mas com outra idempotency key.
      throw new IdempotencyConflictError(
        'externalTransactionId was already used with a different idempotency key',
      );
    }
    if (!existing.matchesPayload(candidate.payloadHash)) {
      throw new IdempotencyConflictError('idempotency key was already used with a different payload');
    }
    return {
      transactionId: existing.id,
      status: existing.status,
      balance: existing.observedBalance?.toJSON(),
      failureCode: existing.failureCode,
      idempotentReplay: true,
    };
  }

  private buildCandidate(command: ProcessWagerTransactionCommand): WagerTransaction {
    const idempotencyKey = requireText('idempotencyKey', command.idempotencyKey);
    const providerId = requireText('providerId', command.providerId);
    const externalTransactionId = requireText('externalTransactionId', command.externalTransactionId);
    const playerId = requireUuid('playerId', command.playerId);
    const walletId = requireUuid('walletId', command.walletId);
    const roundId = requireText('roundId', command.roundId);
    const gameId = requireText('gameId', command.gameId);
    const kind = parseKind(command.kind);
    const money = Money.from(command.money);
    const referenceExternalTransactionId =
      command.referenceExternalTransactionId === undefined
        ? undefined
        : requireText('referenceExternalTransactionId', command.referenceExternalTransactionId);

    // payloadHash: SHA-256 do JSON canônico (chaves ordenadas) dos campos de negócio, com o
    // dinheiro já normalizado. A idempotency key e os metadados de transporte NÃO entram.
    const payloadHash = hashPayload({
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId,
    });

    return WagerTransaction.create({
      id: this.ids.next(),
      providerId,
      externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId,
      playerId,
      roundId,
      gameId,
      kind,
      money,
      referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
  }
}
