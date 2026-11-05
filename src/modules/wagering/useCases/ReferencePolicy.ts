export const REFERENCE_POLICY = Symbol('ReferencePolicy');

/**
 * Backoff exponencial para referências fora de ordem. O padrão espera ~4 minutos
 * (2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s): provedores reais entregam a referência em
 * segundos, então passar disso indica uma referência perdida, não atraso.
 */
export interface ReferencePolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_REFERENCE_POLICY: ReferencePolicy = {
  maxAttempts: 8,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
};

export function referenceDelayMs(policy: ReferencePolicy, attempt: number): number {
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}
