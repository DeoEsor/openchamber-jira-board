import { describe, expect, test } from 'bun:test';
import { SerialQueue } from './serial-queue.ts';

describe('SerialQueue', () => {
  test('serializes captured writes and recovers after a failure', async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = queue.run(() => new Promise<void>((resolve) => {
      events.push('first-start');
      releaseFirst = () => {
        events.push('first-end');
        resolve();
      };
    }));
    const second = queue.run(async () => {
      events.push('second');
      return 'newer';
    });
    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    releaseFirst();
    await first;
    expect(await second).toBe('newer');
    expect(events).toEqual(['first-start', 'first-end', 'second']);

    await expect(queue.run(() => Promise.reject(new Error('failed write')))).rejects.toThrow('failed write');
    expect(await queue.run(async () => 'recovered')).toBe('recovered');
  });
});
