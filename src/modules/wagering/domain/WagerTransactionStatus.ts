/**
 * Transições válidas:
 *   PENDING           -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE -> PROCESSED | PENDING_REFERENCE (reagendamento) | REJECTED | FAILED
 *   PROCESSED | REJECTED | FAILED -> (terminais: nenhuma)
 */
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}
