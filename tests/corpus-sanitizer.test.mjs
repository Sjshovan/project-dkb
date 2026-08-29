import assert from 'node:assert/strict';
import test from 'node:test';
import {
  containsSensitiveCorpusContent,
  isSensitiveCorpusPath,
} from '../scripts/lib/corpus-sanitizer.mjs';

test('real-corpus sanitizer rejects credential paths and quoted PHP secrets', () => {
  assert.equal(isSensitiveCorpusPath('config/oauth-private-key.pem'), true);
  assert.equal(isSensitiveCorpusPath('app/Services/Knowledge.php'), false);
  assert.equal(containsSensitiveCorpusContent("'client_secret' => 'literal-production-secret'"), true);
  assert.equal(containsSensitiveCorpusContent("'token' => 'short'"), true);
  assert.equal(containsSensitiveCorpusContent('api_key: "literal-api-key-value"'), true);
  assert.equal(containsSensitiveCorpusContent("'password' => env('DB_PASSWORD')"), false);
  assert.equal(containsSensitiveCorpusContent("'client_secret' => ''"), false);
});
