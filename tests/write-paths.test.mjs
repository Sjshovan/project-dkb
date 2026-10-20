import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSourceWritePath, assertSupportedWritePolicy, permitsSourceWrite, writePattern } from '@sjshovan/dkb-protocol/writePaths.js';

test('write glob subset distinguishes basename, root, folder, exact path and recursive segments', () => {
  const cases = [
    ['*.md', ['a.md','folder/a.md','Folder/A.MD'], ['a.txt']],
    ['/*.md', ['a.md'], ['folder/a.md']],
    ['/*', ['a.md'], ['folder/a.md']],
    ['/folder/', ['folder/a.md','folder/nested/a.txt'], ['other/folder/a.md','folder.md']],
    ['/folder', ['folder'], ['folder/a.md']],
    ['folder/*.md', ['folder/a.md'], ['other/folder/a.md','folder/nested/a.md']],
    ['**/*.txt', ['a.txt','a/b/c.txt'], ['a.md']],
    ['/notes/**/fact?.md', ['notes/fact1.md','notes/a/b/fact2.md'], ['notes/fact12.md']],
  ];
  for (const [pattern, yes, no] of cases) {
    for (const value of yes) assert.ok(writePattern(pattern).test(value), pattern + ': ' + value);
    for (const value of no) assert.ok(!writePattern(pattern).test(value), pattern + ': ' + value);
  }
});

test('write policy defaults deny, separates create/append and excludes always win', () => {
  const policy = { mode: 'direct', operations: ['append','create'], paths: { append: ['*.md'], create: ['/new/'], exclude: ['/private/','secret.md'] } };
  assert.equal(permitsSourceWrite(policy,'append','existing.md'),true);
  assert.equal(permitsSourceWrite(policy,'append','private/fact.md'),false);
  assert.equal(permitsSourceWrite(policy,'append','deep/SECRET.md'),false);
  assert.equal(permitsSourceWrite(policy,'create','existing.md'),false);
  assert.equal(permitsSourceWrite(policy,'create','new/fact.txt'),true);
  assert.equal(permitsSourceWrite({mode:'direct',operations:['append']},'append','existing.md'),false);
});

test('unsupported pattern syntax and constraints fail closed', () => {
  for (const pattern of ['!private/', '[ab].md', '{a,b}.md', 'foo\\bar', 'a/**b', '../*.md', 'a//b', '#comment', '', ' *.md']) {
    assert.throws(() => writePattern(pattern), {code:'write_policy_invalid'},pattern);
  }
  for (const patch of [{schema:'facts.schema.json'}, {dedupe:'required'}, {accepts:{lanes:['personal']}}]) {
    assert.throws(() => assertSupportedWritePolicy({mode:'direct',operations:['append'],...patch}), {code:'write_policy_invalid'});
  }
});

test('broad rules cannot authorize control files, generated paths or nonportable sources', () => {
  for (const value of ['../x.md','/x.md','C:/x.md','x\\y.md','x/../y.md','.dkb/x.md','x/.git/y.md','node_modules/x.md','vendor/x.md','dist/x.md','AGENTS.md','SKILL.md','dkb.json','notes.pdf','nul.txt','x./y.md','x/a.md:stream','a?.md']) {
    assert.throws(() => assertSourceWritePath(value), {code:'write_policy_invalid'},value);
  }
});
