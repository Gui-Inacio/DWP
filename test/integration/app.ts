import { expect } from 'bun:test';
import type { DataSource } from 'typeorm';
import type { IOutboxRepository } from '../../src/messaging/repositories/IOutboxRepository';
import { TypeOrmOutboxRepository } from '../../src/messaging/infra/typeorm/TypeOrmOutboxRepository';
import { TypeOrmWagerTransactionRepository } from '../../src/modules/wagering/infra/typeorm/repositories/TypeOrmWagerTransactionRepository';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/modules/wagering/useCases/ProcessWagerTransactionUseCase';
import { ReprocessPendingReferencesUseCase } from '../../src/modules/wagering/useCases/ReprocessPendingReferencesUseCase';
import type { ReferencePolicy } from '../../src/modules/wagering/useCases/ReferencePolicy';
import { WagerTransactionApplier } from '../../src/modules/wagering/useCases/WagerTransactionApplier';
import { TypeOrmLedgerRepository } from '../../src/modules/wallets/infra/typeorm/repositories/TypeOrmLedgerRepository';
import { TypeOrmWalletRepository } from '../../src/modules/wallets/infra/typeorm/repositories/TypeOrmWalletRepository';
import { CreateWalletUseCase } from '../../src/modules/wallets/useCases/CreateWalletUseCase';
import type { Clock } from '../../src/shared/application/ports';
import type { TypeOrmTransactionManager } from '../../src/shared/infra/database/TypeOrmTransactionManager';
import { uuid } from './helpers';

export class MutableClock implements Clock {
  constructor(public current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface AppOverrides {
  policy?: ReferencePolicy;
  outbox?: IOutboxRepository;
}

export function buildApp(txm: TypeOrmTransactionManager, overrides: AppOverrides = {}) {
  const wallets = new TypeOrmWalletRepository(txm);
  const ledger = new TypeOrmLedgerRepository(txm);
  const transactions = new TypeOrmWagerTransactionRepository(txm);
  const outbox = overrides.outbox ?? new TypeOrmOutboxRepository(txm);
  const clock = new MutableClock(new Date('2026-11-03T12:00:00.000Z'));
  const ids = { next: () => uuid() };
  const policy = overrides.policy ?? { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 };

  const applier = new WagerTransactionApplier(wallets, ledger, transactions, outbox, clock, ids, policy);
  return {
    txm,
    wallets,
    ledger,
    transactions,
    outbox,
    clock,
    createWallet: new CreateWalletUseCase(txm, wallets, ledger, transactions, outbox, clock, ids),
    process: new ProcessWagerTransactionUseCase(txm, wallets, transactions, applier, clock, ids),
    reprocess: new ReprocessPendingReferencesUseCase(txm, transactions, applier, clock, ids),
  };
}
export type App = ReturnType<typeof buildApp>;

export async function createWallet(app: App, balance = '1000.00', playerId = uuid()) {
  return app.createWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
    correlationId: uuid(),
  });
}

export function command(
  wallet: { id: string; playerId: string },
  over: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const external = over.externalTransactionId ?? uuid();
  return {
    idempotencyKey: `provider-a:${external}`,
    providerId: 'provider-a',
    externalTransactionId: external,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: uuid(),
    ...over,
  };
}

/** Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectConsistent(app: App, walletId: string): Promise<void> {
  const wallet = await app.wallets.findById(walletId);
  const calculated = await app.ledger.calculateBalance(walletId, 'BRL');
  expect(wallet?.balance.toJSON()).toEqual(calculated.balance.toJSON());
}

export async function ledgerCount(ds: DataSource, walletId: string, direction?: string): Promise<number> {
  const rows = await ds.query(
    `SELECT count(*)::int AS n FROM wallet_ledger_entries
      WHERE wallet_id = $1 AND ($2::text IS NULL OR direction = $2)`,
    [walletId, direction ?? null],
  );
  return rows[0].n;
}

export async function outboxTypes(ds: DataSource, walletId: string): Promise<string[]> {
  const rows = await ds.query(
    'SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY event_type',
    [walletId],
  );
  return rows.map((r: { event_type: string }) => r.event_type);
}
