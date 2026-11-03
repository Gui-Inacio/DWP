import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/Money';
import { LedgerDirection } from './LedgerDirection';
import { Wallet } from './Wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const T0 = new Date('2026-11-02T12:00:00Z');
const T1 = new Date('2026-11-02T12:01:00Z');

const openWallet = (balance = '100.00') =>
  Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(balance), at: T0 });

const move = (money: Money, n = 1) => ({ money, transactionId: `t-${n}`, entryId: `e-${n}`, at: T1 });

describe('Wallet.open', () => {
  it('abre com saldo inicial, moeda e version 1', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
  });

  it('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(), at: T0 }),
    ).toThrow(InvalidWalletOperationError);
  });
});

describe('Wallet.debit / credit', () => {
  it('debit reduz o saldo, incrementa version e devolve o lançamento', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(move(brl('80.00')));

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('credit aumenta o saldo', () => {
    const wallet = openWallet('20.00');
    const entry = wallet.credit(move(brl('5.50')));
    expect(wallet.balance.toJSON().amount).toBe('25.50');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('permite debitar exatamente o saldo', () => {
    const wallet = openWallet('10.00');
    wallet.debit(move(brl('10.00')));
    expect(wallet.balance.toJSON().amount).toBe('0.00');
  });

  it('cenário da seção 8: 100.00 com duas apostas de 80.00 → só a primeira passa', () => {
    const wallet = openWallet('100.00');
    wallet.debit(move(brl('80.00'), 1));
    expect(() => wallet.debit(move(brl('80.00'), 2))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2); // não incrementou na falha
  });

  it('não altera nada quando a operação falha', () => {
    const wallet = openWallet('10.00');
    expect(() => wallet.debit(move(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(move(brl('0.00')))).toThrow(InvalidWalletOperationError);
    expect(() => wallet.credit(move(brl('1.00').negate()))).toThrow(InvalidWalletOperationError);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  it('rehydrate reconstrói o estado persistido', () => {
    const wallet = Wallet.rehydrate({
      id: 'w-9',
      playerId: 'p-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});
