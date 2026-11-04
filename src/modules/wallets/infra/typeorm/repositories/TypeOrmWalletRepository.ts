import { Inject, Injectable } from '@nestjs/common';
import { ConcurrencyConflictError } from '../../../../../shared/application/errors';
import { toMoney } from '../../../../../shared/infra/database/moneyMapper';
import { TypeOrmTransactionManager } from '../../../../../shared/infra/database/TypeOrmTransactionManager';
import { Wallet } from '../../../domain/Wallet';
import type { IWalletRepository } from '../../../repositories/IWalletRepository';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'id, player_id, currency, balance, version, created_at, updated_at';

function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: toMoney(row.balance, row.currency),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

@Injectable()
export class TypeOrmWalletRepository implements IWalletRepository {
  constructor(
    @Inject(TypeOrmTransactionManager)
    private readonly txm: TypeOrmTransactionManager,
  ) {}

  async insert(wallet: Wallet): Promise<boolean> {
    const rows: unknown[] = await this.txm.manager.query(
      `INSERT INTO wallets (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (player_id, currency) DO NOTHING
       RETURNING id`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
    return rows.length > 0;
  }

  async findById(id: string): Promise<Wallet | null> {
    const rows: WalletRow[] = await this.txm.manager.query(
      `SELECT ${COLUMNS} FROM wallets WHERE id = $1`,
      [id],
    );
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const rows: WalletRow[] = await this.txm
      .requireManager()
      .query(`SELECT ${COLUMNS} FROM wallets WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async save(wallet: Wallet, previousVersion: number): Promise<void> {
    const rows: Array<{ n: number }> = await this.txm.manager.query(
      `WITH updated AS (
         UPDATE wallets
            SET balance = $1, version = $2, updated_at = $3
          WHERE id = $4 AND version = $5
          RETURNING 1
       )
       SELECT count(*)::int AS n FROM updated`,
      [
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.updatedAt,
        wallet.id,
        previousVersion,
      ],
    );
    if (rows[0]?.n !== 1) {
      throw new ConcurrencyConflictError(
        `wallet ${wallet.id} was changed concurrently (expected version ${previousVersion})`,
      );
    }
  }
}
