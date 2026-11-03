import { AppDataSource } from './data-source';

// bun src/shared/infra/database/migrate.ts        -> aplica as migrations pendentes
// bun src/shared/infra/database/migrate.ts down   -> reverte a última
const direction = process.argv[2] === 'down' ? 'down' : 'up';

await AppDataSource.initialize();
try {
  if (direction === 'down') {
    await AppDataSource.undoLastMigration();
    console.log('Última migration revertida.');
  } else {
    const applied = await AppDataSource.runMigrations();
    console.log(`Migrations aplicadas: ${applied.map((m) => m.name).join(', ') || 'nenhuma (já atualizado)'}`);
  }
} finally {
  await AppDataSource.destroy();
}
