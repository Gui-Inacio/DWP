import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { DataSource } from 'typeorm';
import { InboxMessage } from '../../src/messaging/domain/InboxMessage';
import { OutboxMessage } from '../../src/messaging/domain/OutboxMessage';
import { TypeOrmInboxRepository } from '../../src/messaging/infra/typeorm/TypeOrmInboxRepository';
import { TypeOrmOutboxRepository } from '../../src/messaging/infra/typeorm/TypeOrmOutboxRepository';
import type { TypeOrmTransactionManager } from '../../src/shared/infra/database/TypeOrmTransactionManager';
import { openTestDatabase, sleep, T0, T1, truncateAll, uuid } from './helpers';

let ds: DataSource;
let txm: TypeOrmTransactionManager;
let inbox: TypeOrmInboxRepository;
let outbox: TypeOrmOutboxRepository;

beforeAll(async () => {
  ({ ds, txm } = await openTestDatabase());
  inbox = new TypeOrmInboxRepository(txm);
  outbox = new TypeOrmOutboxRepository(txm);
});
afterAll(async () => {
  await ds.destroy();
});
beforeEach(async () => {
  await truncateAll(ds);
});

const message = (messageId: string, consumerName = 'wagering') =>
  InboxMessage.receive({ messageId, consumerName, payloadHash: 'hash', receivedAt: T0 });

function outboxMessage(occurredAt = T0, aggregateId = uuid()): OutboxMessage {
  const id = uuid();
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WalletBalanceChanged',
    payload: { eventId: id, version: 1, data: { amount: '10.00' } },
    occurredAt,
    attempts: 0,
    nextAttemptAt: occurredAt,
  });
}

describe('TypeOrmInboxRepository', () => {
  it('insertIfAbsent deduplica por (consumer, messageId)', async () => {
    expect(await inbox.insertIfAbsent(message('m-1'))).toBe(true);
    expect(await inbox.insertIfAbsent(message('m-1'))).toBe(false);
    expect(await inbox.insertIfAbsent(message('m-1', 'outro-consumer'))).toBe(true); // outro consumer
  });

  it('50 recebimentos simultâneos da mesma mensagem: exatamente um vence', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => txm.run(() => inbox.insertIfAbsent(message('m-race')))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('find + save gravam o processed_at', async () => {
    await inbox.insertIfAbsent(message('m-2'));
    const loaded = await inbox.find('wagering', 'm-2');
    expect(loaded?.isProcessed()).toBe(false);
    loaded?.markProcessed(T1);
    if (loaded) await inbox.save(loaded);
    expect((await inbox.find('wagering', 'm-2'))?.processedAt).toEqual(T1);
    expect(await inbox.find('wagering', 'nao-existe')).toBeNull();
  });

  it('rollback desfaz o recebimento: a redelivery poderá reprocessar', async () => {
    await expect(
      txm.run(async () => {
        await inbox.insertIfAbsent(message('m-3'));
        throw new Error('falha no meio do processamento');
      }),
    ).rejects.toThrow('falha no meio');
    expect(await inbox.find('wagering', 'm-3')).toBeNull();
    expect(await inbox.insertIfAbsent(message('m-3'))).toBe(true);
  });
});

describe('TypeOrmOutboxRepository', () => {
  it('add + claimDue preservam o payload JSON e ordenam por occurredAt', async () => {
    const late = outboxMessage(new Date(T0.getTime() + 2000));
    const early = outboxMessage(T0);
    await outbox.add(late);
    await outbox.add(early);

    const claimed = await txm.run(() => outbox.claimDue(new Date(T0.getTime() + 5000), 10));
    expect(claimed.map((m) => m.id)).toEqual([early.id, late.id]);
    expect(claimed[0]?.payload).toEqual(early.payload);
  });

  it('não devolve mensagens ainda não vencidas nem já publicadas', async () => {
    const due = outboxMessage(T0);
    const future = outboxMessage(T0);
    future.scheduleRetry(new Date(T0.getTime() + 60_000)); // próxima tentativa em +61s
    const published = outboxMessage(T0);
    await outbox.add(due);
    await outbox.add(future);
    await outbox.add(published);
    published.markPublished(T1);
    await outbox.save(published);

    const claimed = await txm.run(() => outbox.claimDue(T1, 10));
    expect(claimed.map((m) => m.id)).toEqual([due.id]);
  });

  it('save grava tentativas, backoff e publicação', async () => {
    const msg = outboxMessage(T0);
    await outbox.add(msg);

    await txm.run(async () => {
      const [claimed] = await outbox.claimDue(T0, 1);
      if (!claimed) throw new Error('nothing claimed');
      claimed.scheduleRetry(T1);
      await outbox.save(claimed);
    });
    const [row] = await ds.query('SELECT attempts, next_attempt_at, published_at FROM outbox_messages WHERE id = $1', [msg.id]);
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at)).toEqual(new Date(T1.getTime() + 1000));
    expect(row.published_at).toBeNull();
  });

  it('dois publishers concorrentes recebem lotes disjuntos (SKIP LOCKED)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const msg = outboxMessage(new Date(T0.getTime() + i));
      ids.push(msg.id);
      await outbox.add(msg);
    }
    const publisher = () =>
      txm.run(async () => {
        const batch = await outbox.claimDue(T1, 5);
        await sleep(150); // segura o lock, como um publisher no meio do envio
        return batch.map((m) => m.id);
      });

    const [a, b] = await Promise.all([publisher(), publisher()]);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(a.filter((id) => b.includes(id))).toHaveLength(0);
    expect(new Set([...a, ...b])).toEqual(new Set(ids));
  });

  it('claimDue exige transação ativa', async () => {
    await expect(outbox.claimDue(T0, 5)).rejects.toThrow('active transaction');
  });

  it('oldestPendingOccurredAt alimenta a métrica de lag', async () => {
    expect(await outbox.oldestPendingOccurredAt()).toBeNull();
    await outbox.add(outboxMessage(new Date(T0.getTime() + 5000)));
    await outbox.add(outboxMessage(T0));
    expect(await outbox.oldestPendingOccurredAt()).toEqual(T0);
  });
});
