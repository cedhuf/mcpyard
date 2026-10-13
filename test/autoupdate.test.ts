import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Hub } from '../src/front.ts';

test('automatic updates run once at the chosen hour', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 0, 1, 1, 58) });
  const hub = new Hub({});
  let runs = 0;
  hub.checkUpdates = async () => void runs++;
  hub.startAutoUpdates(2);
  mock.timers.tick(60_000);
  assert.equal(runs, 0, 'not before the hour');
  mock.timers.tick(60_000);
  assert.equal(runs, 1, 'at the hour');
  mock.timers.tick(30 * 60_000);
  assert.equal(runs, 1, 'once a day');
  mock.timers.tick(24 * 3_600_000);
  assert.equal(runs, 2, 'again the next day');
  hub.startAutoUpdates(undefined);
  mock.timers.tick(24 * 3_600_000);
  assert.equal(runs, 2, 'off stops it');
  mock.timers.reset();
});
