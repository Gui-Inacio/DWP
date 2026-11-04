import { Inject, Injectable } from '@nestjs/common';
import { toMoney } from '../../../../../shared/infra/database/moneyMapper';
import { TypeOrmTransactionManager } from '../../../../../shared/infra/database/TypeOrmTransactionManager';
import type { FailureCode } from '../../../domain/FailureCode';
import { WagerTransaction } from '../../../domain/WagerTransaction';
import type { WagerTransactionKind } from '../../../domain/WagerTransactionKind';
import type { WagerTransactionStatus } from '../../../domain/WagerTransactionStatus';
import type { IWagerTransactionRepository } from '../../../repositories/IWagerTransactionRepository';

interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  observed_balance: string | null;
  reference_attempts: number;
  next_reference_attempt_at: Date | null;
  created_at: Date;
  processed_at: Date | null;
}

const COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
  player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, observed_balance, reference_attempts,
  next_reference_attempt_at, created_at, processed_at`;

const PLACEHOLDERS = Array.from({ length: 21 }, (_, i) => `$${i + 1}`).join(', ');

function toTransaction(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: toMoney(row.amount, row.currency),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: row.created_at,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: (row.failure_code as FailureCode | null) ?? undefined,
    processedAt: row.processed_at ?? undefined,
    observedBalance:
      row.observed_balance === null ? undefined : toMoney(row.observed_balance, row.currency),
    referenceAttempts: row.reference_attempts,
    nextReferenceAttemptAt: row.next_reference_attempt_at ?? undefined,
  });
}

@Injectable()
export class TypeOrmWagerTransactionRepository implements IWagerTransactionRepository {
  constructor(@Inject(TypeOrmTransactionManager) private readonly txm: TypeOrmTransactionManager) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    // ON CONFLICT sem alvo cobre idempotency_key E (provider_id, external_transaction_id).
    const rows: unknown[] = await this.txm.manager.query(
      `INSERT INTO wager_transactions (${COLUMNS})
       VALUES (${PLACEHOLDERS})
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toJSON().amount,
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.observedBalance?.toJSON().amount ?? null,
        tx.referenceAttempts,
        tx.nextReferenceAttemptAt ?? null,
        tx.createdAt,
        tx.processedAt ?? null,
      ],
    );
    return rows.length > 0;
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.findOne('id = $1', [id]);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.findOne('idempotency_key = $1', [idempotencyKey]);
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne('provider_id = $1 AND external_transaction_id = $2', [
      providerId,
      externalTransactionId,
    ]);
  }

  async findProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    return this.findOne("reference_transaction_id = $1 AND kind = $2 AND status = 'PROCESSED'", [
      referenceTransactionId,
      kind,
    ]);
  }

  async save(tx: WagerTransaction): Promise<void> {
    const rows: Array<{ n: number }> = await this.txm.manager.query(
      `WITH updated AS (
         UPDATE wager_transactions
            SET reference_transaction_id = $2,
                status = $3,
                failure_code = $4,
                observed_balance = $5,
                reference_attempts = $6,
                next_reference_attempt_at = $7,
                processed_at = $8
          WHERE id = $1
          RETURNING 1
       )
       SELECT count(*)::int AS n FROM updated`,
      [
        tx.id,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.observedBalance?.toJSON().amount ?? null,
        tx.referenceAttempts,
        tx.nextReferenceAttemptAt ?? null,
        tx.processedAt ?? null,
      ],
    );
    if (rows[0]?.n !== 1) {
      throw new Error(`wager transaction ${tx.id} not found`);
    }
  }

  async findDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows: WagerTransactionRow[] = await this.txm.requireManager().query(
      `SELECT ${COLUMNS}
         FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= $1
        ORDER BY next_reference_attempt_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toTransaction);
  }

  private async findOne(where: string, params: unknown[]): Promise<WagerTransaction | null> {
    const rows: WagerTransactionRow[] = await this.txm.manager.query(
      `SELECT ${COLUMNS} FROM wager_transactions WHERE ${where} LIMIT 1`,
      params,
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }
}
