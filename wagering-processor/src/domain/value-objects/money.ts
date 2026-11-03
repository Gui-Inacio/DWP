import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props.amount || typeof props.amount !== 'string') {
      throw new Error('Amount must be a decimal string');
    }

    const decimal = new Decimal(props.amount);

    // Validações
    if (decimal.isNaN() || !decimal.isFinite()) {
      throw new Error(`Invalid monetary amount: ${props.amount}`);
    }

    if (decimal.decimalPlaces() > 2) {
      throw new Error(
        `Amount cannot have more than 2 decimal places: ${props.amount}`,
      );
    }

    if (decimal.isNegative()) {
      throw new Error('Monetary amount cannot be negative in this context');
    }

    return new Money(decimal, props.currency || 'BRL');
  }

  static zero(currency: string = 'BRL'): Money {
    return new Money(new Decimal('0.00'), currency);
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
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} vs ${other.currency}`,
      );
    }
  }
}
