import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';
import { Money } from './Money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
  it('cria e serializa com escala fixa de 2 casas', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25').toJSON().amount).toBe('25.00');
    expect(brl('25.5').toJSON().amount).toBe('25.50');
    expect(brl('0').toJSON().amount).toBe('0.00');
  });

  it.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '1.234',
    '-5.00',
    '+5.00',
    ' 5.00',
    '5.00 ',
    '1,00',
    '.50',
    '5.',
    'abc',
  ])('rejeita amount inválido: "%s"', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejeita amount que não seja string (nada de number)', () => {
    expect(() =>
      Money.from({ amount: 25 as unknown as string, currency: 'BRL' }),
    ).toThrow(InvalidMoneyError);
  });

  it.each(['brl', 'BR', 'BRLL', '', '123'])(
    'rejeita currency inválida: "%s"',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );
});

describe('Money aritmética', () => {
  it('é exata (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
  });

  it('é imutável: operações retornam nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.00');
    expect(a).not.toBe(b);
  });

  it('subtract pode resultar em negativo (uso interno)', () => {
    const result = brl('5.00').subtract(brl('8.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-3.00');
  });

  it('negate inverte o sinal e zero nunca vira "-0.00"', () => {
    expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
    expect(brl('0.00').negate().toJSON().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).toJSON().amount).toBe('0.00');
  });
});

describe('Money consultas', () => {
  it('isZero / isPositive / isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('1.00').negate().isNegative()).toBe(true);
  });

  it('isLessThan e equals', () => {
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80').equals(brl('80.00'))).toBe(true);
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });

  it('toString', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});

describe('Money conflito de moeda', () => {
  it('add, subtract e isLessThan lançam erro de domínio', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(
      CurrencyMismatchError,
    );
  });
});
