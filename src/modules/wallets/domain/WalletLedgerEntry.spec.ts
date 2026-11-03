import { describe, expect, it } from 'bun:test';
import { InvalidLedgerEntryError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/Money';
import { LedgerDirection } from './LedgerDirection';
import { WalletLedgerEntry } from './WalletLedgerEntry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-11-02T12:00:00Z');

const props = (over: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) => ({
  id: 'e-1',
  walletId: 'w-1',
  transactionId: 't-1',
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  createdAt: at,
  ...over,
});

describe('WalletLedgerEntry', () => {
  it('cria lançamento de débito e de crédito balanceados', () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('20.00'),
        balanceAfter: brl('30.00'),
      }),
    );
    expect(credit.isBalanced()).toBe(true);
  });

  it('rejeita aritmética inconsistente', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl('25.00') }))).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita valor zero e moedas diferentes', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl('0.00'), balanceBefore: brl('10.00'), balanceAfter: brl('10.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: usd('20.00') }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('é imutável: instância congelada', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'CREDIT';
    }).toThrow();
  });

  it('rehydrate não revalida, mas isBalanced detecta a inconsistência', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('25.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
