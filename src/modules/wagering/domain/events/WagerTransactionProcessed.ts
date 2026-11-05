import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../../shared/domain/IntegrationEvent';
import type { MoneyProps } from '../../../../shared/domain/Money';
import type { WagerTransaction } from '../WagerTransaction';

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
  /** saldo da wallet no momento do processamento */
  balance: MoneyProps | null;
  processedAt: string | null;
}

/** Qualquer transação aplicada, inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        balance: tx.observedBalance?.toJSON() ?? null,
        processedAt: tx.processedAt?.toISOString() ?? null,
      },
    });
  }
}
