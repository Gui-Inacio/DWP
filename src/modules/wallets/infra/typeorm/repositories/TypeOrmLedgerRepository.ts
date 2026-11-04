import { Inject, Injectable } from '@nestjs/common';
import { InvalidCursorError } from '../../../../../shared/application/errors';
import type { Money } from '../../../../../shared/domain/Money';
import { toMoney, toSignedMoney } from '../../../../../shared/infra/database/moneyMapper';
import { TypeOrmTransactionManager } from '../../../../../shared/infra/database/TypeOrmTransactionManager';
import type { LedgerDirection } from '../../../domain/LedgerDirection';
import { WalletLedgerEntry } from '../../../domain/WalletLedgerEntry';
import type { ILedgerRepository, LedgerPage } from '../../../repositories/ILedgerRepository';

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
  created_at_cursor: string;
}

const COLUMNS =
  'id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at';

// created_at em texto UTC com microssegundos: o Date do JS perderia precisão e
// repetiria/pularia linhas na paginação por cursor.
const CURSOR_TS = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_LIMIT = 200;

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id })).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const { c, i } = parsed as { c?: unknown; i?: unknown };
      if (
        typeof c === 'string' &&
        typeof i === 'string' &&
        CURSOR_TS_PATTERN.test(c) &&
        UUID_PATTERN.test(i)
      ) {
        return { createdAt: c, id: i };
      }
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidCursorError();
}

function toEntry(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: toMoney(row.amount, row.currency),
    balanceBefore: toMoney(row.balance_before, row.currency),
    balanceAfter: toMoney(row.balance_after, row.currency),
    createdAt: row.created_at,
  });
}

@Injectable()
export class TypeOrmLedgerRepository implements ILedgerRepository {
  constructor(@Inject(TypeOrmTransactionManager) private readonly txm: TypeOrmTransactionManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.txm.manager.query(
      `INSERT INTO wallet_ledger_entries (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toJSON().amount,
        entry.money.currency,
        entry.balanceBefore.toJSON().amount,
        entry.balanceAfter.toJSON().amount,
        entry.createdAt,
      ],
    );
  }

  async findPageByWallet(
    walletId: string,
    options: { cursor?: string; limit: number },
  ): Promise<LedgerPage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit), 1), MAX_LIMIT);
    const after = options.cursor ? decodeCursor(options.cursor) : undefined;

    const rows: LedgerRow[] = await this.txm.manager.query(
      `SELECT ${COLUMNS}, ${CURSOR_TS} AS created_at_cursor
         FROM wallet_ledger_entries
        WHERE wallet_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
        ORDER BY created_at, id
        LIMIT $4`,
      [walletId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
    );

    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      entries: pageRows.map(toEntry),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at_cursor, last.id) : null,
    };
  }

  async calculateBalance(
    walletId: string,
    currency: string,
  ): Promise<{ balance: Money; entries: number }> {
    const rows: Array<{ net: string; entries: number }> = await this.txm.manager.query(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19,2)::text AS net,
              COUNT(*)::int AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = $1`,
      [walletId],
    );
    const row = rows[0] ?? { net: '0.00', entries: 0 };
    return { balance: toSignedMoney(row.net, currency), entries: row.entries };
  }
}
