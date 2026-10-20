import fs from 'node:fs/promises';
import path from 'node:path';

export const DENSE_CORPUS_TIERS = Object.freeze({
  smoke: { sourceBytes: 128 * 1024, files: 8 },
  small: { sourceBytes: 1024 ** 2, files: 24 },
  medium: { sourceBytes: 8 * 1024 ** 2, files: 80 },
  large: { sourceBytes: 32 * 1024 ** 2, files: 160 },
});

/** Same substantive prose/table/code corpus used by the original scale proof. */
export async function generateDenseCorpus(root, tierName, tier) {
  await fs.mkdir(path.join(root, 'sources'), { recursive: true });
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1, type: 'dkb', name: `@benchmark/dense-${tierName}`,
    displayName: `Dense ${tierName} scale corpus`, version: '1.0.0',
    permissions: { read: true, write: false },
  }, null, 2)}\n`);
  const perFile = Math.ceil(tier.sourceBytes / tier.files);
  let bytes = 0;
  for (let index = 0; index < tier.files; index += 1) {
    const content = denseDocument(index, perFile);
    await fs.writeFile(path.join(root, 'sources', `document-${String(index + 1).padStart(4, '0')}.md`), content);
    bytes += Buffer.byteLength(content);
  }
  return { files: tier.files, bytes };
}

function denseDocument(documentIndex, targetBytes) {
  const sections = [];
  let section = 0;
  while (Buffer.byteLength(sections.join('\n'), 'utf8') < targetBytes) {
    const marker = `DENSE-${documentIndex}-${section}`;
    sections.push(`## Operational section ${section}\n\n`
      + `The ${marker} workflow validates an immutable package receipt before activation. `
      + `Operators compare source identity, Evidence identity, and Retrieval compatibility so a dense document remains attributable after chunking. `
      + `This paragraph is deliberately substantive and unique to prevent an embedding cache from collapsing the scale test.\n\n`
      + `| Field | Value | Meaning |\n|---|---:|---|\n`
      + `| source | ${documentIndex} | Original document identity |\n`
      + `| section | ${section} | Dense table row and locator |\n`
      + `| checksum | ${documentIndex * 100_003 + section} | Deterministic synthetic provenance |\n\n`
      + '```ts\n'
      + `export const record_${documentIndex}_${section} = { marker: '${marker}', active: true, revision: ${section} };\n`
      + '```\n\n'
      + `- ${marker} preserves citations.\n- ${marker} rejects incompatible vectors.\n- ${marker} remains searchable after installation.\n`);
    section += 1;
  }
  return `# Dense benchmark document ${documentIndex}\n\n${sections.join('\n')}`;
}
