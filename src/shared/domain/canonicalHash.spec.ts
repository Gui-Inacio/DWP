import { describe, expect, it } from 'bun:test';
import { canonicalJson, hashPayload } from './canonicalHash';

describe('canonicalJson / hashPayload', () => {
  it('ordena as chaves em todos os níveis', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('a ordem das chaves não muda o hash', () => {
    const a = { kind: 'BET', money: { amount: '25.00', currency: 'BRL' }, roundId: 'r' };
    const b = { roundId: 'r', money: { currency: 'BRL', amount: '25.00' }, kind: 'BET' };
    expect(hashPayload(a)).toBe(hashPayload(b));
  });

  it('valor diferente muda o hash', () => {
    expect(hashPayload({ amount: '25.00' })).not.toBe(hashPayload({ amount: '25.01' }));
  });

  it('omite undefined, mas mantém null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: null })).toBe('{"a":1,"b":null}');
  });

  it('é um SHA-256 em hexadecimal (64 caracteres)', () => {
    expect(hashPayload({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
