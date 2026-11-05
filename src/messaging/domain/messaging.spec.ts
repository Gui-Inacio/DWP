import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError } from '../../shared/domain/errors';
import { WalletBalanceChanged } from '../../modules/wallets/domain/events/WalletBalanceChanged';
import { LedgerDirection } from '../../modules/wallets/domain/LedgerDirection';
import { Wallet } from '../../modules/wallets/domain/Wallet';
import { WalletLedgerEntry } from '../../modules/wallets/domain/WalletLedgerEntry';
import { Money } from '../../shared/domain/Money';
import { InboxMessage } from './InboxMessage';
import { OutboxMessage } from './OutboxMessage';

const T0 = new Date('2026-11-03T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function sampleEvent() {
  const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('100.00'), at: T0 });
  const entry = wallet.debit({ money: brl('30.00'), transactionId: 't-1', entryId: 'e-1', at: T0 });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'ev-1',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    occurredAt: T0,
  });
}

describe('IntegrationEvent', () => {
  it('serializa o envelope com eventType e version no tipo, e dinheiro como MoneyProps', () => {
    expect(sampleEvent().toJSON()).toEqual({
      eventId: 'ev-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'w-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: '2026-11-03T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'w-1',
        transactionId: 't-1',
        direction: LedgerDirection.Debit,
        money: { amount: '30.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '70.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('o payload é JSON puro (sobrevive a stringify/parse)', () => {
    const json = sampleEvent().toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('OutboxMessage', () => {
  it('enqueue usa o eventId como id, nasce pendente e vencida', () => {
    const msg = OutboxMessage.enqueue(sampleEvent());
    expect(msg.id).toBe('ev-1');
    expect(msg.aggregateId).toBe('w-1');
    expect(msg.eventType).toBe('WalletBalanceChanged');
    expect(msg.attempts).toBe(0);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
  });

  it('scheduleRetry incrementa attempts e aplica backoff exponencial com teto', () => {
    const msg = OutboxMessage.enqueue(sampleEvent());
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      msg.scheduleRetry(T0);
      delays.push((msg.nextAttemptAt as Date).getTime() - T0.getTime());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(msg.attempts).toBe(8);
    expect(msg.isDue(T0)).toBe(false);
    expect(msg.isDue(new Date(T0.getTime() + 60_000))).toBe(true);
  });

  it('markPublished encerra a mensagem e impede nova publicação ou retry', () => {
    const msg = OutboxMessage.enqueue(sampleEvent());
    msg.markPublished(T0);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(T0)).toBe(false);
    expect(() => msg.markPublished(T0)).toThrow(InvalidTransactionStateError);
    expect(() => msg.scheduleRetry(T0)).toThrow(InvalidTransactionStateError);
  });
});

describe('InboxMessage', () => {
  it('receive nasce não processada; markProcessed só funciona uma vez', () => {
    const msg = InboxMessage.receive({
      messageId: 'm-1',
      consumerName: 'wagering',
      payloadHash: 'h',
      receivedAt: T0,
    });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(T0);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(T0);
    expect(() => msg.markProcessed(T0)).toThrow(InvalidTransactionStateError);
  });
});

describe('WalletLedgerEntry usado pelo evento', () => {
  it('o lançamento do evento está balanceado', () => {
    const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('10.00'), at: T0 });
    const entry: WalletLedgerEntry = wallet.credit({ money: brl('5.00'), transactionId: 't', entryId: 'e', at: T0 });
    expect(entry.isBalanced()).toBe(true);
  });
});
