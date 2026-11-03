export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super('CURRENCY_MISMATCH', `Currency mismatch: ${expected} vs ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(walletId: string) {
    super('INSUFFICIENT_FUNDS', `Insufficient funds in wallet ${walletId}`);
  }
}

export class InvalidWalletOperationError extends DomainError {
  constructor(message: string) {
    super('INVALID_WALLET_OPERATION', message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super('INVALID_LEDGER_ENTRY', message);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  constructor(message: string) {
    super('INVALID_WAGER_TRANSACTION', message);
  }
}

/** Erro de programação: tentativa de transição inválida (ex.: sair de um estado terminal). */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super('INVALID_TRANSACTION_STATE', message);
  }
}
