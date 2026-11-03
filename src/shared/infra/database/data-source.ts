import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1793577600000 } from './migrations/1793577600000-InitialSchema';

const DEFAULT_URL = 'postgres://wagering:wagering@localhost:5432/wagering';

export function createDataSource(
  url: string = process.env.DATABASE_URL ?? DEFAULT_URL,
): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    migrations: [InitialSchema1793577600000],
    logging: false,
  });
}

export const AppDataSource = createDataSource();
