import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONSOLE_ACTIVITY_DEFAULT_PAGE_SIZE,
  CONSOLE_ACTIVITY_RETENTION_LIMIT,
  ConsoleActivityStore,
} from '../apps/console/dist/server/activity.js';

test('Console activity is newest-first, paginated, and bounded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-console-activity-test-'));
  const store = new ConsoleActivityStore(path.join(root, 'activity.sqlite'));
  try {
    for (let index = 0; index < CONSOLE_ACTIVITY_RETENTION_LIMIT + 5; index += 1) {
      store.begin(`operation-${index}`, 'library.use', `library-${index}`);
    }

    const firstPage = store.list();
    assert.equal(firstPage.activities.length, CONSOLE_ACTIVITY_DEFAULT_PAGE_SIZE);
    assert.equal(firstPage.activities[0].id, `operation-${CONSOLE_ACTIVITY_RETENTION_LIMIT + 4}`);
    assert.deepEqual(firstPage.pagination, {
      page: 1,
      perPage: CONSOLE_ACTIVITY_DEFAULT_PAGE_SIZE,
      total: CONSOLE_ACTIVITY_RETENTION_LIMIT,
      totalPages: CONSOLE_ACTIVITY_RETENTION_LIMIT / CONSOLE_ACTIVITY_DEFAULT_PAGE_SIZE,
      retainedLimit: CONSOLE_ACTIVITY_RETENTION_LIMIT,
    });

    const finalPage = store.list(999);
    assert.equal(finalPage.pagination.page, finalPage.pagination.totalPages);
    assert.equal(finalPage.activities.at(-1).id, 'operation-5');
    assert.equal(finalPage.activities.some((activity) => activity.id === 'operation-4'), false);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
