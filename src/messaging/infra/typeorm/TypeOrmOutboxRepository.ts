import { Inject, Injectable } from '@nestjs/common';
import { TypeOrmTransactionManager } from '../../../shared/infra/database/TypeOrmTransactionManager';
import { OutboxMessage } from '../../domain/OutboxMessage';
import type { IOutboxRepository } from '../../repositories/IOutboxRepository';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

const COLUMNS =
  'id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at';

function toMessage(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    publishedAt: row.published_at ?? undefined,
  });
}

@Injectable()
export class TypeOrmOutboxRepository implements IOutboxRepository {
  constructor(@Inject(TypeOrmTransactionManager) private readonly txm: TypeOrmTransactionManager) {}

  async add(message: OutboxMessage): Promise<void> {
    await this.txm.manager.query(
      `INSERT INTO outbox_messages (${COLUMNS})
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt ?? message.occurredAt,
        message.publishedAt ?? null,
      ],
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows: OutboxRow[] = await this.txm.requireManager().query(
      `SELECT ${COLUMNS}
         FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= $1
        ORDER BY occurred_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toMessage);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.txm.manager.query(
      `UPDATE outbox_messages
          SET attempts = $2, next_attempt_at = $3, published_at = $4
        WHERE id = $1`,
      [
        message.id,
        message.attempts,
        message.nextAttemptAt ?? message.occurredAt,
        message.publishedAt ?? null,
      ],
    );
  }

  async oldestPendingOccurredAt(): Promise<Date | null> {
    const rows: Array<{ oldest: Date | null }> = await this.txm.manager.query(
      `SELECT min(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
    );
    return rows[0]?.oldest ?? null;
  }
}
