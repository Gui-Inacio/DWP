import type { WagerTransaction } from '../domain/WagerTransaction';
import type { WagerTransactionKind } from '../domain/WagerTransactionKind';

export const WAGER_TRANSACTION_REPOSITORY = Symbol('IWagerTransactionRepository');

export interface IWagerTransactionRepository {
  /**
   * INSERT ... ON CONFLICT DO NOTHING (cobre idempotency_key E (provider, external_id)).
   * false = já existia. Com duas requisições simultâneas, a segunda espera o commit da
   * primeira e então recebe false: é o banco quem decide quem é a primeira.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;

  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;

  /** Resolve a referência por (providerId, externalTransactionId). */
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;

  /** Reversão PROCESSED já existente para esta referência e este kind (regra 4). */
  findProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null>;

  /** UPDATE do estado (status, failure_code, observed_balance, tentativas, ...). */
  save(transaction: WagerTransaction): Promise<void>;

  /**
   * PENDING_REFERENCE com next_reference_attempt_at <= now, travadas com
   * FOR UPDATE SKIP LOCKED: vários workers pegam lotes diferentes sem se bloquear.
   */
  findDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]>;
}
