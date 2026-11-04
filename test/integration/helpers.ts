import type { DataSource } from 'typeorm';
import { TypeOrmWagerTransactionRepository } from '../../src/modules/wagering/infra/typeorm/repositories/TypeOrmWagerTransactionRepository';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../src/modules/wagering/domain/WagerTransaction';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/WagerTransactionKind';
import { TypeOrmWalletRepository } from '../../src/modules/wallets/infra/typeorm/repositories/TypeOrmWalletRepository';
import { Wallet } from '../../src/modules/wallets/domain/Wallet';
import { Money } from '../../src/shared/domain/Money';
import { createDataSource } from '../../src/shared/infra/database/data-source';
import { TypeOrmTransactionManager } from '../../src/shared/infra/database/TypeOrmTransactionManager';

export const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://wagering:wagering@localhost:5432/wagering_test';

export const T0 = new Date('2026-11-02T12:00:00.000Z');
export const T1 = new Date('2026-11-02T12:01:00.000Z');

export const uuid = () => crypto.randomUUID();
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export async function openTestDatabase(): Promise<{
  ds: DataSource;
  txm: TypeOrmTransactionManager;
}> {
  const ds = createDataSource(TEST_URL);
  await ds.initialize();
  await ds.runMigrations();
  return { ds, txm: new TypeOrmTransactionManager(ds) };
}

export function truncateAll(ds: DataSource): Promise<unknown> {
  return ds.query(
    'TRUNCATE wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages CASCADE',
  );
}

/** Insere uma wallet pelo repositório e devolve o domínio. */
export async function seedWallet(
  txm: TypeOrmTransactionManager,
  balance = '100.00',
  playerId = uuid(),
): Promise<Wallet> {
  const wallet = Wallet.open({
    id: uuid(),
    playerId,
    initialBalance: brl(balance),
    at: T0,
  });
  const inserted = await new TypeOrmWalletRepository(txm).insert(wallet);
  if (!inserted) throw new Error('seedWallet: wallet already exists');
  return wallet;
}

/** Monta (sem gravar) uma transação com ids únicos; `over` sobrescreve qualquer campo. */
export function buildTransaction(
  wallet: Wallet,
  over: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: uuid(),
    providerId: 'provider-a',
    externalTransactionId: uuid(),
    idempotencyKey: uuid(),
    payloadHash: 'hash',
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: T0,
    ...over,
  });
}

/** Monta e grava uma transação PENDING. */
export async function seedTransaction(
  txm: TypeOrmTransactionManager,
  wallet: Wallet,
  over: Partial<CreateWagerTransactionProps> = {},
): Promise<WagerTransaction> {
  const tx = buildTransaction(wallet, over);
  const inserted = await new TypeOrmWagerTransactionRepository(
    txm,
  ).insertIfAbsent(tx);
  if (!inserted) throw new Error('seedTransaction: transaction already exists');
  return tx;
}
