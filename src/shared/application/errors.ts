/** O UPDATE com `WHERE version = $anterior` não afetou nenhuma linha: leitura velha. É transitório (retry). */
export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid pagination cursor');
    this.name = 'InvalidCursorError';
  }
}
