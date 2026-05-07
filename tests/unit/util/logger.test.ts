import { describe, it, expect } from 'vitest';
import { redactString, addRedactedSecret, _resetForTests } from '../../../../src/util/logger';

describe('redactString', () => {
  it('replaces every registered secret with ***', () => {
    _resetForTests();
    addRedactedSecret('hunter2');
    addRedactedSecret('topsecret');
    expect(redactString('user pass=hunter2 token=topsecret done'))
      .toBe('user pass=*** token=*** done');
  });

  it('returns input unchanged when no secrets registered', () => {
    _resetForTests();
    expect(redactString('nothing to redact')).toBe('nothing to redact');
  });

  it('ignores empty / whitespace-only secrets', () => {
    _resetForTests();
    addRedactedSecret('');
    addRedactedSecret('   ');
    expect(redactString('hello')).toBe('hello');
  });

  it('handles regex special chars in the secret', () => {
    _resetForTests();
    addRedactedSecret('a.b*c');
    expect(redactString('value=a.b*c!')).toBe('value=***!');
  });
});
