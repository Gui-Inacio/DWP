import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TRANSACTION_MANAGER } from '../../application/ITransactionManager';
import { createDataSource } from './data-source';
import { TypeOrmTransactionManager } from './TypeOrmTransactionManager';

@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      useFactory: async () => {
        const dataSource = createDataSource();
        await dataSource.initialize();
        return dataSource;
      },
    },
    TypeOrmTransactionManager,
    { provide: TRANSACTION_MANAGER, useExisting: TypeOrmTransactionManager },
  ],
  exports: [DataSource, TypeOrmTransactionManager, TRANSACTION_MANAGER],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}
