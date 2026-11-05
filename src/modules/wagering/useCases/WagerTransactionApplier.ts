import { Inject, Injectable } from '@nestjs/common';
import { OutboxMessage } from '../../../messaging/domain/OutboxMessage';
import {
  type IOutboxRepository,
  OUTBOX_REPOSITORY,
} from '../../../messaging/repositories/IOutboxRepository';
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
} from '../../../shared/application/ports';
import { InsufficientFundsError } from '../../../shared/domain/errors';
import type { EventContext } from '../../../shared/domain/IntegrationEvent';
import type { MoneyProps } from '../../../shared/domain/Money';
import { LedgerDirection } from '../../wallets/domain/LedgerDirection';
import { WalletBalanceChanged } from '../../wallets/domain/events/WalletBalanceChanged';
import type { Wallet } from '../../wallets/domain/Wallet';
import type { WalletLedgerEntry } from '../../wallets/domain/WalletLedgerEntry';
import {
  type ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../../wallets/repositories/ILedgerRepository';
import {
  type IWalletRepository,
  WALLET_REPOSITORY,
} from '../../wallets/repositories/IWalletRepository';
import { FailureCode } from '../domain/FailureCode';
import type { WagerTransaction } from '../domain/WagerTransaction';
import { WagerTransactionKind as Kind } from '../domain/WagerTransactionKind';
import { WagerTransactionStatus as Status } from '../domain/WagerTransactionStatus';
import { WagerTransactionPendingReference } from '../domain/events/WagerTransactionPendingReference';
import { WagerTransactionProcessed } from '../domain/events/WagerTransactionProcessed';
import { WagerTransactionRejected } from '../domain/events/WagerTransactionRejected';
import {
  type IWagerTransactionRepository,
  WAGER_TRANSACTION_REPOSITORY,
} from '../repositories/IWagerTransactionRepository';
import {
  REFERENCE_POLICY,
  type ReferencePolicy,
  referenceDelayMs,
} from './ReferencePolicy';

export interface ProcessingContext {
  correlationId: string;
  causationId?: string;
}

export interface ApplyOutcome {
  status: Status;
  /** saldo observado (ausente em PENDING_REFERENCE) */
  balance?: MoneyProps;
  failureCode?: FailureCode;
}

/**
 * Aplica uma transação já persistida (PENDING ou PENDING_REFERENCE) à wallet.
 * PRECISA rodar dentro de uma transação SQL: trava a wallet (FOR UPDATE) e grava,
 * juntos, saldo, ledger, estado da transação e eventos da outbox.
 * Usado pela entrada (HTTP/SQS) e pelo worker de referências pendentes.
 */
@Injectable()
export class WagerTransactionApplier {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: IWalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: IWagerTransactionRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: IOutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(REFERENCE_POLICY) private readonly policy: ReferencePolicy,
  ) {}

  async apply(
    tx: WagerTransaction,
    ctx: ProcessingContext,
  ): Promise<ApplyOutcome> {
    const now = this.clock.now();

    // A unidade de concorrência é a wallet: a partir daqui ninguém mais a altera.
    const wallet = await this.wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) {
      throw new Error(
        `wallet ${tx.walletId} not found while applying transaction ${tx.id}`,
      );
    }
    const previousVersion = wallet.version;

    // Nestes dois casos o saldo NÃO é exposto: a wallet não pertence ao player informado
    // (vazaria o saldo de outra pessoa) ou está em outra moeda (o saldo sairia com a moeda errada).
    if (wallet.playerId !== tx.playerId) {
      return this.reject(
        tx,
        wallet,
        FailureCode.WalletPlayerMismatch,
        now,
        ctx,
        false,
      );
    }
    if (wallet.currency !== tx.money.currency) {
      return this.reject(
        tx,
        wallet,
        FailureCode.CurrencyMismatch,
        now,
        ctx,
        false,
      );
    }

    // ---- referência
    let reference: WagerTransaction | undefined;
    const referenceExternalId = tx.referenceExternalTransactionId;
    if (referenceExternalId !== undefined) {
      const found = await this.transactions.findByExternalId(
        tx.providerId,
        referenceExternalId,
      );
      if (!found) {
        return this.waitForReference(tx, wallet, now, ctx);
      }
      const invalid = tx.validateReference(found);
      if (invalid) {
        return this.reject(tx, wallet, invalid, now, ctx);
      }
      if (!found.isTerminal()) {
        return this.waitForReference(tx, wallet, now, ctx);
      }
      if (found.status !== Status.Processed) {
        return this.reject(
          tx,
          wallet,
          FailureCode.ReferenceNotProcessed,
          now,
          ctx,
        );
      }
      if (tx.requiresReference() && (await this.isAlreadyReversed(found))) {
        return this.reject(tx, wallet, FailureCode.AlreadyReversed, now, ctx);
      }
      reference = found;
    }

    // ---- LOSS: registra o resultado, sem mover saldo nem gerar lançamento
    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      await this.transactions.save(tx);
      await this.enqueue(
        WagerTransactionProcessed.from(tx, this.eventContext(ctx, now)),
      );
      return { status: Status.Processed, balance: wallet.balance.toJSON() };
    }

    // ---- movimentação: wallet e ledger andam juntos
    const direction = tx.ledgerDirectionFor(reference);
    const movement = {
      money: tx.money,
      transactionId: tx.id,
      entryId: this.ids.next(),
      at: now,
    };
    let entry: WalletLedgerEntry;
    try {
      entry =
        direction === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // Aposta sem saldo e reversão que deixaria saldo negativo são casos operacionais distintos.
        const code = tx.requiresReference()
          ? FailureCode.ReversalWouldOverdraw
          : FailureCode.InsufficientFunds;
        return this.reject(tx, wallet, code, now, ctx);
      }
      throw error;
    }

    await this.ledger.append(entry);
    await this.wallets.save(wallet, previousVersion);
    tx.markProcessed(reference?.id, now, wallet.balance);
    await this.transactions.save(tx);
    await this.enqueue(
      WalletBalanceChanged.from(wallet, entry, this.eventContext(ctx, now)),
    );
    await this.enqueue(
      WagerTransactionProcessed.from(tx, this.eventContext(ctx, now)),
    );
    return { status: Status.Processed, balance: wallet.balance.toJSON() };
  }

  /** Regra 4 (interpretação estrita): uma referência tem no máximo uma reversão processada, de qualquer tipo. */
  private async isAlreadyReversed(
    reference: WagerTransaction,
  ): Promise<boolean> {
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      if (await this.transactions.findProcessedReversal(reference.id, kind))
        return true;
    }
    return false;
  }

  private async waitForReference(
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
    ctx: ProcessingContext,
  ): Promise<ApplyOutcome> {
    if (tx.referenceAttempts >= this.policy.maxAttempts) {
      // Esgotou o limite: rejeição auditável + evento.
      return this.reject(tx, wallet, FailureCode.ReferenceNotFound, now, ctx);
    }
    const firstTime = tx.status === Status.Pending;
    const next = new Date(
      now.getTime() + referenceDelayMs(this.policy, tx.referenceAttempts + 1),
    );
    tx.markPendingReference(next);
    await this.transactions.save(tx);
    if (firstTime) {
      await this.enqueue(
        WagerTransactionPendingReference.from(tx, this.eventContext(ctx, now)),
      );
    }
    return { status: Status.PendingReference };
  }

  private async reject(
    tx: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    now: Date,
    ctx: ProcessingContext,
    exposeBalance = true,
  ): Promise<ApplyOutcome> {
    tx.reject(code, now, exposeBalance ? wallet.balance : undefined);
    await this.transactions.save(tx);
    await this.enqueue(
      WagerTransactionRejected.from(tx, this.eventContext(ctx, now)),
    );
    return {
      status: Status.Rejected,
      balance: exposeBalance ? wallet.balance.toJSON() : undefined,
      failureCode: code,
    };
  }

  private enqueue(
    event: Parameters<typeof OutboxMessage.enqueue>[0],
  ): Promise<void> {
    return this.outbox.add(OutboxMessage.enqueue(event));
  }

  private eventContext(ctx: ProcessingContext, now: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: now,
    };
  }
}
