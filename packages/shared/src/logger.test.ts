import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { lines, destination };
}

describe('createLogger', () => {
  it('writes one JSON object per line with service, level label and ISO time', () => {
    const { lines, destination } = capture();
    createLogger({ service: 'api', level: 'info', destination }).info({ port: 4000 }, 'listening');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ service: 'api', level: 'info', msg: 'listening', port: 4000 });
    expect(String(lines[0]?.['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('masks phone numbers, customer identifiers and message text', () => {
    const { lines, destination } = capture();
    createLogger({ service: 'worker', level: 'info', destination }).info(
      {
        waId: '971500000101',
        bsuid: 'AE.40000000000000000001',
        message: { body: 'My order number is KB-2291', to: '971500000101' },
        messageId: 'kept',
      },
      'processing',
    );
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('971500000101');
    expect(line).not.toContain('AE.4000');
    expect(line).not.toContain('KB-2291');
    expect(line).toContain('kept');
  });

  it('drops lines below the configured level', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'worker', level: 'warn', destination });
    logger.info('hidden');
    logger.warn('shown');

    expect(lines.map((line) => line['msg'])).toEqual(['shown']);
  });
});
