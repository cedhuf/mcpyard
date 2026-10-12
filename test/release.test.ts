import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNewer, ReleaseCheck } from '../src/release.ts';

test('versions compare numerically and dev builds never compare', () => {
  assert.equal(isNewer('0.10.0', '0.9.3'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.2.9', '0.3.0'), false);
  assert.equal(isNewer('0.3.0', 'dev'), false);
});

test('the release check reports the latest release, keeps errors, and forgets when turned off', async () => {
  let answer: () => Promise<{ version: string; url: string }> = async () => ({ version: '9.0.0', url: 'https://example.test/v9' });
  const check = new ReleaseCheck(() => answer());
  await check.check();
  assert.deepEqual(check.status().latest, { version: '9.0.0', url: 'https://example.test/v9' });
  assert.equal(check.status().error, undefined);

  answer = async () => {
    throw new Error('GitHub: HTTP 403');
  };
  await check.check();
  assert.equal(check.status().error, 'GitHub: HTTP 403');
  assert.equal(check.status().latest?.version, '9.0.0', 'a failed check keeps the last answer');

  check.start(0);
  assert.equal(check.status().latest, undefined);
  assert.equal(check.status().checkedAt, undefined);
});
