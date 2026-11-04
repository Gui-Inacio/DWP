export const TRANSACTION_MANAGER = Symbol('ITransactionManager');

/**
 * Porta de transação. Tudo o que roda dentro de `run` (inclusive os repositórios,
 * que descobrem a transação ativa sozinhos) participa da MESMA transação SQL:
 * ou tudo é confirmado junto, ou nada é.
 */
export interface ITransactionManager {
  /**
   * Executa `work` numa transação: commit se resolver, rollback se lançar erro
   * (o erro é propagado). Chamadas aninhadas participam da transação em curso.
   */
  run<T>(work: () => Promise<T>): Promise<T>;
}
