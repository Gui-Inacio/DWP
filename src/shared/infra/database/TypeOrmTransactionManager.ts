import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { ITransactionManager } from '../../application/ITransactionManager';

@Injectable()
export class TypeOrmTransactionManager implements ITransactionManager {
  private readonly storage = new AsyncLocalStorage<EntityManager>();

  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /** Há uma transação ativa neste contexto assíncrono? */
  get isActive(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /** Manager da transação ativa; fora de transação, o manager padrão (autocommit). */
  get manager(): EntityManager {
    return this.storage.getStore() ?? this.dataSource.manager;
  }

  /** Para operações que só fazem sentido dentro de uma transação (ex.: SELECT ... FOR UPDATE). */
  requireManager(): EntityManager {
    const manager = this.storage.getStore();
    if (!manager) {
      throw new Error('This operation requires an active transaction (use TransactionManager.run)');
    }
    return manager;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    // Aninhado: participa da transação já aberta.
    if (this.isActive) {
      return work();
    }
    // READ COMMITTED + lock de linha por wallet (SELECT ... FOR UPDATE) nos repositórios.
    return this.dataSource.transaction('READ COMMITTED', (manager) =>
      this.storage.run(manager, work),
    );
  }
}
