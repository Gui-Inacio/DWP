import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../../shared/domain/IntegrationEvent';
import type { MoneyProps } from '../../../../shared/domain/Money';
import type { WagerTransaction } from '../WagerTransaction';

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
  failureCode: string | null;
  balance: MoneyProps | null;
  rejectedAt: string | null;
}

/** Rejeição por regra de negócio (inclui referência que nunca chegou). Não altera saldo. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
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
        failureCode: tx.failureCode ?? null,
        balance: tx.observedBalance?.toJSON() ?? null,
        rejectedAt: tx.processedAt?.toISOString() ?? null,
      },
    });
  }
}
