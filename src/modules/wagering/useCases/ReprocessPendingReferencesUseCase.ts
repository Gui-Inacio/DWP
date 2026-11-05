import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '../../../shared/application/ITransactionManager';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from '../../../shared/application/ports';
import {
  type IWagerTransactionRepository,
  WAGER_TRANSACTION_REPOSITORY,
} from '../repositories/IWagerTransactionRepository';
import { WagerTransactionApplier } from './WagerTransactionApplier';

@Injectable()
export class ReprocessPendingReferencesUseCase {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txm: ITransactionManager,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: IWagerTransactionRepository,
    @Inject(WagerTransactionApplier) private readonly applier: WagerTransactionApplier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /**
   * Reprocessa até `limit` transações PENDING_REFERENCE vencidas. Cada uma roda na PRÓPRIA transação
   * (trava uma linha de transação com SKIP LOCKED e uma wallet), o que evita deadlock entre workers
   * que disputam wallets em ordens diferentes. Seguro com vários workers e várias instâncias.
   */
  async execute(limit = 20): Promise<{ handled: number }> {
    let handled = 0;
    for (let i = 0; i < limit; i++) {
      const didWork = await this.txm.run(async () => {
        const [tx] = await this.transactions.findDuePendingReference(this.clock.now(), 1);
        if (!tx) return false;
        await this.applier.apply(tx, { correlationId: this.ids.next(), causationId: tx.id });
        return true;
      });
      if (!didWork) break;
      handled++;
    }
    return { handled };
  }
}
