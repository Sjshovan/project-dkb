import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerResultReader } from '../apps/cli/dist/host/libraryOwnerResult.js';
import { parseDkbCommandEvent } from '../packages/protocol/dist/command-events.js';

const event = (sequence, fields) => JSON.stringify({ format: 'dkb.command-event.v1', sequence, timestamp: new Date().toISOString(), ...fields });

test('owner events preserve split UTF-8 and progress, returning exactly one final value', () => {
  const progress = [], reader = ownerResultReader(value => progress.push(value));
  const stream = Buffer.from([
    event(0, { event: 'start', label: 'Inspecting' }),
    event(1, { event: 'stage', phase: 'read', label: 'Reading', status: 'start' }),
    event(2, { event: 'progress', phase: 'read', label: 'Reading', value: 0, total: 1, unit: 'steps' }),
    event(3, { event: 'result', value: { name: 'Library 日本', warning: 'Retained warning' } }),
    event(4, { event: 'completion', status: 'succeeded' }),
  ].join('\n') + '\n');
  for (const byte of stream) reader.output('stdout', Buffer.from([byte]));
  reader.output('stderr', Buffer.from('diagnostic, not a result'));
  assert.deepEqual(reader.finish(0), { name: 'Library 日本', warning: 'Retained warning' });
  assert.equal(progress[0].status, 'start');
});

test('owner stream rejects protocol drift, ordering, duplicate results and missing completion', () => {
  for (const lines of [
    ['not JSON'],
    [event(1, { event: 'start', label: 'Wrong sequence' })],
    [event(0, { event: 'result', value: {} })],
    [event(0, { event: 'start', label: 'Reading' }), event(1, { event: 'result', value: {} })],
    [event(0, { event: 'start', label: 'Reading' }), event(1, { event: 'result', value: {} }), event(2, { event: 'result', value: {} })],
    [event(0, { event: 'completion', status: 'succeeded' }), event(1, { event: 'start', label: 'Too late' })],
  ]) {
    const reader = ownerResultReader();
    assert.throws(() => { reader.output('stdout', Buffer.from(lines.join('\n') + '\n')); reader.finish(0); }, { code: 'library_owner_invalid_output' });
  }
});

test('owner failures retain the existing actionable error, never raw stderr', () => {
  const reader = ownerResultReader();
  reader.output('stdout', Buffer.from(event(0, { event: 'failure', error: { code: 'library_recovery_required', message: 'Run dkb library recover.' } }) + '\n'
    + event(1, { event: 'completion', status: 'failed' }) + '\n'));
  reader.output('stderr', Buffer.from('synthetic-private-diagnostic'));
  assert.throws(() => reader.finish(1), { code: 'library_recovery_required', message: 'Run dkb library recover.' });
});

test('shared command protocol validates fields before Console or owner consumers use them', () => {
  for (const fields of [
    { event: 'stage', phase: 'p', label: 'Stage', status: 'invented' },
    { event: 'progress', phase: 'p', label: 'Progress', value: -1, total: 10, unit: 'steps' },
    { event: 'progress', phase: 'p', label: 'Progress', value: 1, total: 10, unit: 'invented' },
    { event: 'start', label: null }, { event: 'failure', error: null },
    { event: 'completion', status: 'maybe' }, { event: 'warning', message: {} },
  ]) assert.equal(parseDkbCommandEvent(event(0, fields)), null);
});

test('owner recovery guidance targets the host Library name, never its Linux-only mount path', () => {
  for (const message of ['An unfinished Library mutation requires recovery. Run dkb library recover --library "/library".', 'Invalid Library mutation fence.']) {
    const reader = ownerResultReader(undefined, 'volume-library');
    reader.output('stdout', Buffer.from(event(0, { event: 'failure', error: { code: 'library_recovery_required', message } }) + '\n'
      + event(1, { event: 'completion', status: 'failed' }) + '\n'));
    assert.throws(() => reader.finish(1), error => {
      assert.equal(error.code, 'library_recovery_required');
      assert.ok(error.message.includes('dkb library recover --library "volume-library"'));
      assert.doesNotMatch(error.message, /--library "\/library"/u);
      return true;
    });
  }
});
