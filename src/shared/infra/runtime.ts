import { Injectable } from '@nestjs/common';
import type { Clock, IdGenerator } from '../application/ports';

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: ordenável no tempo, bom para índices e para a paginação do ledger. */
@Injectable()
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
