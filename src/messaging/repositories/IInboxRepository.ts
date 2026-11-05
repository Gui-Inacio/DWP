import type { InboxMessage } from '../domain/InboxMessage';

export const INBOX_REPOSITORY = Symbol('IInboxRepository');

export interface IInboxRepository {
  /**
   * INSERT ... ON CONFLICT (consumer_name, message_id) DO NOTHING. false = duplicata
   * (já recebida). Roda na mesma transação do efeito financeiro: se ela der rollback,
   * a linha do inbox some junto e a redelivery reprocessa.
   */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;

  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;

  /** Grava o processed_at. */
  save(message: InboxMessage): Promise<void>;
}
