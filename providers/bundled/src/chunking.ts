import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { DkbStoreType, KnowledgeSourceUnit } from '@sjshovan/dkb-protocol/types.js';

export interface ChunkSourceInput {
  dkbId: string;
  storeId: string;
  type: DkbStoreType;
  unit: KnowledgeSourceUnit & {
    id?: string;
    text?: string;
  };
  fallbackTitle: string;
  fallbackUpdatedAt: string;
}

export interface ChunkedSourceUnit {
  id: string;
  assetId: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
  heading?: string;
  locator: Record<string, unknown>;
  title: string;
  text: string;
  keywords: string[];
  hash: string;
  updatedAt: string;
}

const TARGET_CHARS = 1800;
const MAX_CHARS = 2600;
const OVERLAP_CHARS = 220;

export function chunkSourceUnit(input: ChunkSourceInput): ChunkedSourceUnit[] {
  const text = normalizeChunkText(input.unit.text ?? '');
  const title = input.unit.title ?? input.fallbackTitle;
  const updatedAt = input.unit.updatedAt ?? input.fallbackUpdatedAt;
  const baseKeywords = input.unit.keywords ?? [];
  const assetId = sourceAssetId({
    dkbId: input.dkbId,
    storeId: input.storeId,
    type: input.type,
    locator: input.unit.locator,
  });

  if (text.length === 0) {
    return [chunkFor({
      input,
      assetId,
      title,
      text: title,
      baseKeywords,
      updatedAt,
      ordinal: 0,
      start: 0,
      end: 0,
    })];
  }

  const chunks = structureAwareChunks(text);

  return chunks.map((chunk, index) => chunkFor({
    input,
    assetId,
    title,
    text: chunk.text,
    baseKeywords,
    updatedAt,
    ordinal: index,
    start: chunk.start,
    end: chunk.end,
    heading: chunk.heading,
  }));
}

export function sourceAssetId(input: {
  dkbId: string;
  storeId: string;
  type: DkbStoreType;
  locator: Record<string, unknown>;
}): string {
  return stableHash({
    type: 'source-unit',
    dkbId: input.dkbId,
    storeId: input.storeId,
    sourceType: input.type,
    locator: input.locator,
  });
}

function chunkFor(input: {
  input: ChunkSourceInput;
  assetId: string;
  title: string;
  text: string;
  baseKeywords: string[];
  updatedAt: string;
  ordinal: number;
  start: number;
  end: number;
  heading?: string;
}): ChunkedSourceUnit {
  const chunkLocator = {
    ...input.input.unit.locator,
    chunk: {
      ordinal: input.ordinal,
      start: input.start,
      end: input.end,
    },
  };
  const hash = stableHash({
    type: 'source-chunk',
    dkbId: input.input.dkbId,
    assetId: input.assetId,
    ordinal: input.ordinal,
    text: input.text,
    locator: chunkLocator,
  });

  return {
    id: hash,
    assetId: input.assetId,
    chunkOrdinal: input.ordinal,
    chunkStart: input.start,
    chunkEnd: input.end,
    heading: input.heading,
    locator: chunkLocator,
    title: input.heading ? `${input.title} - ${input.heading}` : input.title,
    text: input.text,
    keywords: [...new Set([
      ...input.baseKeywords,
      ...keywordsFor(input.title),
      ...keywordsFor(input.heading ?? ''),
      ...keywordsFor(input.text),
    ])].slice(0, 32),
    hash,
    updatedAt: input.updatedAt,
  };
}

function structureAwareChunks(text: string): Array<{ text: string; start: number; end: number; heading?: string }> {
  const blocks = textBlocks(text);
  const chunks: Array<{ text: string; start: number; end: number; heading?: string }> = [];
  let current: Array<{ text: string; start: number; end: number; heading?: string }> = [];
  let currentLength = 0;
  let heading: string | undefined;

  for (const block of blocks) {
    if (block.heading) {
      heading = block.heading;
    }

    if (block.text.length > MAX_CHARS) {
      flush();
      chunks.push(...splitOversizedBlock(block.text, block.start, block.heading ?? heading));
      continue;
    }

    if (currentLength > 0 && currentLength + block.text.length > TARGET_CHARS) {
      flush();
    }

    current.push({
      ...block,
      heading: block.heading ?? heading,
    });
    currentLength += block.text.length + 2;
  }

  flush();

  return chunks.length > 0 ? chunks : [{ text, start: 0, end: text.length }];

  function flush(): void {
    if (current.length === 0) {
      return;
    }

    chunks.push({
      text: current.map((block) => block.text).join('\n\n').trim(),
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      heading: current.find((block) => block.heading)?.heading,
    });
    current = [];
    currentLength = 0;
  }
}

function textBlocks(text: string): Array<{ text: string; start: number; end: number; heading?: string }> {
  const blocks: Array<{ text: string; start: number; end: number; heading?: string }> = [];
  const pattern = /(?:^|\n)([ \t]*#{1,6}[^\n]+|```[\s\S]*?```|[^\n](?:[\s\S]*?)(?=\n{2,}|\n[ \t]*#{1,6}|\n```|$))/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1] ?? match[0];
    const start = match.index + match[0].indexOf(raw);
    const value = raw.trim();

    if (!value) {
      continue;
    }

    const heading = headingFor(value);

    blocks.push({
      text: value,
      start,
      end: start + raw.length,
      ...(heading ? { heading } : {}),
    });
  }

  if (blocks.length === 0) {
    return [{ text, start: 0, end: text.length }];
  }

  return blocks;
}

function splitOversizedBlock(text: string, offset: number, heading?: string): Array<{ text: string; start: number; end: number; heading?: string }> {
  const chunks: Array<{ text: string; start: number; end: number; heading?: string }> = [];
  let start = 0;

  while (start < text.length) {
    const targetEnd = Math.min(text.length, start + MAX_CHARS);
    const sentenceEnd = lastBoundary(text, start, targetEnd);
    const end = sentenceEnd > start + TARGET_CHARS * 0.5 ? sentenceEnd : targetEnd;
    const chunkText = text.slice(start, end).trim();

    if (chunkText) {
      chunks.push({
        text: chunkText,
        start: offset + start,
        end: offset + end,
        heading: lastHeadingIn(chunkText) ?? heading,
      });
    }

    if (end >= text.length) {
      break;
    }

    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }

  return chunks;
}

function lastBoundary(text: string, start: number, end: number): number {
  const window = text.slice(start, end);
  const boundary = Math.max(
    window.lastIndexOf('\n\n'),
    window.lastIndexOf('. '),
    window.lastIndexOf('; '),
  );

  return boundary > 0 ? start + boundary + 1 : end;
}

function headingFor(value: string): string | undefined {
  const match = value.match(/^#{1,6}\s+(.+)$/);

  return match?.[1]?.trim();
}

function lastHeadingIn(value: string): string | undefined {
  const matches = [...value.matchAll(/^#{1,6}\s+(.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((match): match is string => Boolean(match));

  return matches.at(-1);
}

function normalizeChunkText(value: string): string {
  return value
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function keywordsFor(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .flatMap((token) => token.includes('-') ? [token, ...token.split('-')] : [token])
    .filter((token) => token.length > 2 && !GENERIC_KEYWORDS.has(token));
}

const GENERIC_KEYWORDS = new Set([
  'and',
  'are',
  'for',
  'from',
  'into',
  'source',
  'sources',
  'that',
  'the',
  'this',
  'with',
]);
