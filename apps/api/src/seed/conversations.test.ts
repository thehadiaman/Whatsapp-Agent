import { describe, expect, it } from 'vitest';
import { LONG_ORDER } from './conversations.js';

describe('seed content', () => {
  it('includes a message of at least 2,000 characters (a designed state)', () => {
    expect(LONG_ORDER.length).toBeGreaterThanOrEqual(2000);
  });
});
