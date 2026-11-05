import { Inject, Injectable } from '@nestjs/common';
import { OutboxMessage } from '../../../messaging/domain/OutboxMessage';
import {
  type IOutboxRepository,
  OUTBOX_REPOSITORY,
} from '../../../messaging/repositories/IOutboxRepository';
import {
  TRANSACTION_MANAGER,
  type ITransactionManager,
} from '../../../shared/application/ITransactionManager';
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
} from '../../../shared/application/ports';
import {
  InvalidRequestError,
  WalletAlreadyExistsError,
} from '../../../shared/domain/errors';
import type { EventContext } from '../../../shared/domain/IntegrationEvent';
import { Money, type MoneyProps } from '../../../shared/domain/Money';
import { WagerTransaction } from '../../wagering/domain/WagerTransaction';
import { WagerTransactionProcessed } from '../../wagering/domain/events/WagerTransactionProcessed';
import {
  type IWagerTransactionRepository,
  WAGER_TRANSACTION_REPOSITORY,
} from '../../wagering/repositories/IWagerTransactionRepository';
import { LedgerDirection } from '../domain/LedgerDirection';
import { Wallet } from '../domain/Wallet';
import { WalletLedgerEntry } from '../domain/WalletLedgerEntry';
import { WalletBalanceChanged } from '../domain/events/WalletBalanceChanged';
import {
  type ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../repositories/ILedgerRepository';
import {
  type IWalletRepository,
  WALLET_REPOSITORY,
} from '../repositories/IWalletRepository';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txm: ITransactionManager,
    @Inject(WALLET_REPOSITORY) private readonly wallets: IWalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: IWagerTransactionRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: IOutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    if (
      typeof command.playerId !== 'string' ||
      !UUID_PATTERN.test(command.playerId)
    ) {
      throw new InvalidRequestError('playerId must be a UUID');
    }
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();

    return this.txm.run(async () => {
      const wallet = Wallet.open({
        id: this.ids.next(),
        playerId: command.playerId,
        initialBalance,
        at: now,
      });

      if (!(await this.wallets.insert(wallet))) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }

      // Saldo inicial > 0: OPENING + lançamento CREDIT na MESMA transação SQL da criação.
      if (initialBalance.isPositive()) {
        const opening = WagerTransaction.createOpening({
          id: this.ids.next(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initialBalance,
          createdAt: now,
        });
        await this.transactions.insertIfAbsent(opening);

        const entry = WalletLedgerEntry.create({
          id: this.ids.next(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          createdAt: now,
        });
        await this.ledger.append(entry);

        opening.markProcessed(undefined, now, wallet.balance);
        await this.transactions.save(opening);

        await this.outbox.add(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(
              wallet,
              entry,
              this.context(command, now, opening.id),
            ),
          ),
        );
        await this.outbox.add(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(
              opening,
              this.context(command, now, opening.id),
            ),
          ),
        );
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  private context(
    command: CreateWalletCommand,
    now: Date,
    causationId: string,
  ): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId,
      occurredAt: now,
    };
  }
}
