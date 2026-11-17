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

  it('drops lines below the configured level', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'worker', level: 'warn', destination });
    logger.info('hidden');
    logger.warn('shown');

    expect(lines.map((line) => line['msg'])).toEqual(['shown']);
  });
});
