import { Money } from '../../domain/Money';

/**
 * numeric(19,2) chega do driver como string ("100.00"), nunca como number:
 * a representação é exata e vira Money sem passar por ponto flutuante.
 */
export function toMoney(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}

/** Para somas que podem sair negativas (ex.: reconciliação com ledger divergente). */
export function toSignedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
