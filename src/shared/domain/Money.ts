import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

// Clone isolado: não depende de config global do Decimal.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

// Só dígitos, com ponto e no máximo 2 casas. Rejeita: vazio, NaN, Infinity,
// notação científica, sinal (+/-), espaços, vírgula e mais de 2 casas.
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string; // string decimal, ex.: "25.00"
  currency: string; // ISO-4217
}

export class Money {
  private readonly value: Decimal;

  private constructor(
    value: Decimal,
    public readonly currency: string,
  ) {
    // evita "-0.00" na serialização
    this.value = value.isZero() ? new D(0) : value;
  }

  /**
   * Entrada de contrato (HTTP/SQS/DB): rejeita negativos e formatos inválidos.
   * Valores negativos só existem como resultado interno de subtract()/negate().
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object');
    }
    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with at most 2 decimal places',
      );
    }
    Money.assertValidCurrency(props.currency);
    return new Money(new D(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new D(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: unknown): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        'currency must be a 3-letter uppercase ISO-4217 code',
      );
    }
  }
}
