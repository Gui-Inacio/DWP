import type { Money } from '../../../shared/domain/Money';
import type { WalletLedgerEntry } from '../domain/WalletLedgerEntry';

export const LEDGER_REPOSITORY = Symbol('ILedgerRepository');

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** cursor opaco para a próxima página; null quando acabou */
  nextCursor: string | null;
}

/** Append-only: só existe `append`, não há update nem delete (e o banco também bloqueia). */
export interface ILedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;

  /** Paginação estável por cursor sobre (created_at, id). */
  findPageByWallet(walletId: string, options: { cursor?: string; limit: number }): Promise<LedgerPage>;

  /** Saldo reconstruído pelo ledger (créditos − débitos), para a reconciliação. */
  calculateBalance(walletId: string, currency: string): Promise<{ balance: Money; entries: number }>;
}
