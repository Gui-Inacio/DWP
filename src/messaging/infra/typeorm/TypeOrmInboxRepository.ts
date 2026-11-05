import { Inject, Injectable } from '@nestjs/common';
import { TypeOrmTransactionManager } from '../../../shared/infra/database/TypeOrmTransactionManager';
import { InboxMessage } from '../../domain/InboxMessage';
import type { IInboxRepository } from '../../repositories/IInboxRepository';

interface InboxRow {
  consumer_name: string;
  message_id: string;
  payload_hash: string;
  received_at: Date;
  processed_at: Date | null;
}

@Injectable()
export class TypeOrmInboxRepository implements IInboxRepository {
  constructor(@Inject(TypeOrmTransactionManager) private readonly txm: TypeOrmTransactionManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const rows: unknown[] = await this.txm.manager.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
    );
    return rows.length > 0;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const rows: InboxRow[] = await this.txm.manager.query(
      `SELECT consumer_name, message_id, payload_hash, received_at, processed_at
         FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2`,
      [consumerName, messageId],
    );
    const row = rows[0];
    if (!row) return null;
    return InboxMessage.rehydrate({
      consumerName: row.consumer_name,
      messageId: row.message_id,
      payloadHash: row.payload_hash,
      receivedAt: row.received_at,
      processedAt: row.processed_at ?? undefined,
    });
  }

  async save(message: InboxMessage): Promise<void> {
    await this.txm.manager.query(
      `UPDATE inbox_messages SET processed_at = $3 WHERE consumer_name = $1 AND message_id = $2`,
      [message.consumerName, message.messageId, message.processedAt ?? null],
    );
  }
}
