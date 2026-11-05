import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../../shared/domain/IntegrationEvent';
import type { WagerTransaction } from '../WagerTransaction';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  referenceExternalTransactionId: string | null;
  nextAttemptAt: string | null;
}

/** Publicado uma vez, quando a transação passa a aguardar a referência. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
        nextAttemptAt: tx.nextReferenceAttemptAt?.toISOString() ?? null,
      },
    });
  }
}
