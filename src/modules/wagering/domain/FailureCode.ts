/**
 * Taxonomia de códigos de falha: estáveis e legíveis por máquina.
 * REJECTED = violação de regra de negócio. FAILED = erro permanente de infraestrutura.
 * Falhas transitórias não viram código: o provedor recebe 503 e reenvia a mesma operação.
 */
export enum FailureCode {
  // ---- REJECTED
  InsufficientFunds = 'INSUFFICIENT_FUNDS', // BET sem saldo
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW', // REFUND/ROLLBACK deixaria saldo negativo
  ReferenceNotFound = 'REFERENCE_NOT_FOUND', // referência não chegou dentro do limite
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED', // referência terminou REJECTED/FAILED
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND', // ex.: REFUND referenciando WIN
  ReferenceMismatch = 'REFERENCE_MISMATCH', // provider/player/wallet/moeda/rodada diferentes
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH', // reversão com valor diferente da referência
  AlreadyReversed = 'ALREADY_REVERSED', // referência já revertida por este tipo
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH', // walletId não pertence ao playerId
  CurrencyMismatch = 'CURRENCY_MISMATCH', // moeda da operação != moeda da wallet
  // ---- FAILED
  PermanentFailure = 'PERMANENT_FAILURE',
}

/** O que o provedor deve fazer: corrigir e reenviar com novos ids, ou desistir. */
export type ProviderAction = 'FIX_PAYLOAD' | 'GIVE_UP';

export const FAILURE_CODE_PROVIDER_ACTION: Record<FailureCode, ProviderAction> = {
  [FailureCode.InsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReversalWouldOverdraw]: 'GIVE_UP',
  [FailureCode.ReferenceNotFound]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.InvalidReferenceKind]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReversalAmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.AlreadyReversed]: 'GIVE_UP',
  [FailureCode.WalletPlayerMismatch]: 'FIX_PAYLOAD',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.PermanentFailure]: 'GIVE_UP',
};
