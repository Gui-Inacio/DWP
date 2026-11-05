import type { OutboxMessage } from '../domain/OutboxMessage';

export const OUTBOX_REPOSITORY = Symbol('IOutboxRepository');

export interface IOutboxRepository {
  /** Grava o evento na mesma transação da alteração financeira. */
  add(message: OutboxMessage): Promise<void>;

  /**
   * Mensagens pendentes e vencidas, travadas com FOR UPDATE SKIP LOCKED: vários
   * publishers concorrentes recebem lotes disjuntos. Exige transação ativa.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;

  /** Grava attempts, next_attempt_at e published_at. */
  save(message: OutboxMessage): Promise<void>;

  /** occurred_at da mensagem pendente mais antiga (para a métrica de outbox lag). */
  oldestPendingOccurredAt(): Promise<Date | null>;
}
