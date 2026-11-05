export const CLOCK = Symbol('Clock');
export interface Clock {
  now(): Date;
}

export const ID_GENERATOR = Symbol('IdGenerator');
export interface IdGenerator {
  next(): string;
}
