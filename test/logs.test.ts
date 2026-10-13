import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LogBook } from '../src/logs.ts';

test('calls and actions survive a restart, server output does not', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mcpyard-logs-')), 'activity.json');
  const before = new LogBook();
  before.persist(path);
  before.add({ kind: 'call', error: false, server: 'time', text: 'time-now', fields: { key: 'laptop', ms: 4 } });
  before.add({ kind: 'action', error: false, text: 'key_created', fields: { key: 'laptop' } });
  before.add({ kind: 'server', error: false, server: 'time', text: 'listening on stdio' });
  assert.ok(!existsSync(path), 'writes are grouped, not done on every line');
  before.flush();
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as unknown[]).length, 2);

  const after = new LogBook();
  after.add({ kind: 'hub', error: false, text: 'starting' });
  after.persist(path);
  assert.deepEqual(after.list().map((e) => e.text), ['starting', 'key_created', 'time-now'], 'saved lines come first, newest first in the list');
  assert.deepEqual(after.list().map((e) => e.id), [3, 2, 1]);
});
