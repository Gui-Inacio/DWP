export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function oppositeOf(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}
