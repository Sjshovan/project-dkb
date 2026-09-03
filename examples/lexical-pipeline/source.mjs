import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** @type {import('@sjshovan/dkb-pipeline').DkbParserProvider['parse']} */
export async function parseSources({ dkb, options, signal }) {
  /** @type {import('@sjshovan/dkb-pipeline').DkbParsedDocument[]} */
  const documents = [];
  /** @param {string} relative */
  async function visit(relative) {
    signal?.throwIfAborted();
    const entries = await fs.readdir(path.join(dkb.root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name.startsWith('.') || ['node_modules', 'vendor', 'dist', 'build'].includes(entry.name)) continue;
      const sourcePath = [relative, entry.name].filter(Boolean).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Source links are not accepted: ${sourcePath}`);
      if (entry.isDirectory()) { await visit(sourcePath); continue; }
      if (!entry.isFile() || !/\.(md|txt)$/iu.test(entry.name)) continue;
      const sourceFile = path.join(dkb.root, sourcePath);
      const stat = await fs.stat(sourceFile);
      if (stat.size > Number(options.maxSourceBytes)) throw new Error(`Source exceeds maxSourceBytes: ${sourcePath}`);
      const bytes = await fs.readFile(sourceFile, { signal });
      if (bytes.length > Number(options.maxSourceBytes)) throw new Error(`Source changed beyond maxSourceBytes: ${sourcePath}`);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.trim()) continue;
      documents.push({
        id: sourcePath, path: sourcePath, mediaType: entry.name.endsWith('.md') ? 'text/markdown' : 'text/plain', text,
        provenance: {
          assetId: sourcePath, storeId: 'filesystem', sourceType: 'filesystem',
          assetLocator: { path: sourcePath }, title: entry.name,
          sourceHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          updatedAt: '1970-01-01T00:00:00.000Z',
        }, metadata: {},
      });
    }
  }
  await visit('');
  return documents;
}

/** @type {import('@sjshovan/dkb-pipeline').DkbChunkerProvider['chunk']} */
export async function chunkHeadings({ documents, options, signal }) {
  /** @type {import('@sjshovan/dkb-pipeline').DkbLocatedChunk[]} */
  const chunks = [];
  const size = Number(options.maxChunkChars);
  for (const document of documents) {
    const text = document.text ?? '';
    const boundaries = [...new Set([0, ...[...text.matchAll(/^#{1,6} +.+$/gmu)].map((match) => match.index), text.length])].sort((a, b) => a - b);
    let ordinal = 0;
    for (let section = 0; section < boundaries.length - 1; section++) {
      const stop = boundaries[section + 1];
      for (let start = boundaries[section]; start < stop; start += size) {
        signal?.throwIfAborted();
        const end = Math.min(stop, start + size);
        if (!text.slice(start, end).trim()) continue;
        chunks.push({
          id: `${document.id}:${ordinal}`, documentId: document.id, text: text.slice(start, end),
          provenance: { locator: { path: document.path, chunk: ordinal }, chunkOrdinal: ordinal, chunkStart: start, chunkEnd: end },
          metadata: {},
        });
        ordinal++;
      }
    }
  }
  return chunks;
}
