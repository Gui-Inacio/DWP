import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/Money';
import { LedgerDirection } from './LedgerDirection';
import { WalletLedgerEntry } from './WalletLedgerEntry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  money: Money;
  transactionId: string;
  /** id do lançamento, gerado fora do domínio para mantê-lo determinístico */
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial (version = 1). Se o saldo for > 0, quem
   * chama grava o OPENING e o lançamento CREDIT (before = 0, after = saldo)
   * na mesma transação SQL.
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('initial balance cannot be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Altera o saldo e devolve o lançamento correspondente (saldo e ledger nunca divergem). */
  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, movement);
  }

  /** Lança InsufficientFundsError se o saldo não cobrir o valor. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, movement);
  }

  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidWalletOperationError('movement amount must be positive');
    }

    const before = this._balance;
    if (direction === LedgerDirection.Debit && before.isLessThan(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    const after =
      direction === LedgerDirection.Credit
        ? before.add(movement.money)
        : before.subtract(movement.money);

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });

    // O estado só muda depois de o lançamento ter sido criado com sucesso.
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
