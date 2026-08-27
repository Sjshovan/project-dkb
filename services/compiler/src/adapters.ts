export interface CompilerTextChunk {
  text: string;
  start: number;
  end: number;
  heading?: string;
}

export interface CompilerTextSplitterInput {
  text: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface CompilerTextSplitterAdapter {
  id: string;
  version: number;
  splitText(input: CompilerTextSplitterInput): Promise<CompilerTextChunk[]>;
}

export interface CompilerAdapterDescription {
  id: string;
  version: number;
  optionalDependencies: Array<{
    package: string;
    available: boolean;
  }>;
}

const LANGCHAIN_TEXT_SPLITTER_PACKAGE = '@langchain/textsplitters';

export async function createOptionalLangChainTextSplitter(): Promise<CompilerTextSplitterAdapter | null> {
  try {
    const packageName = LANGCHAIN_TEXT_SPLITTER_PACKAGE;
    const module = await import(packageName) as {
      RecursiveCharacterTextSplitter?: new (options: {
        chunkSize: number;
        chunkOverlap: number;
        separators: string[];
      }) => {
        splitText(text: string): Promise<string[]>;
      };
    };
    const Splitter = module.RecursiveCharacterTextSplitter;

    if (!Splitter) {
      return null;
    }

    return {
      id: 'langchain.recursive-character-text-splitter',
      version: 1,
      async splitText(input) {
        const splitter = new Splitter({
          chunkSize: input.chunkSize ?? 1800,
          chunkOverlap: input.chunkOverlap ?? 220,
          separators: ['\n\n', '\n', ' ', ''],
        });
        const chunks = await splitter.splitText(input.text);
        let cursor = 0;

        return chunks.map((chunk) => {
          const start = Math.max(0, input.text.indexOf(chunk, cursor));
          const resolvedStart = start >= 0 ? start : cursor;
          const end = resolvedStart + chunk.length;
          cursor = Math.max(cursor, end);

          return {
            text: chunk.trim(),
            start: resolvedStart,
            end,
          };
        }).filter((chunk) => chunk.text.length > 0);
      },
    };
  } catch {
    return null;
  }
}

export async function describeCompilerAdapter(): Promise<CompilerAdapterDescription> {
  const langChain = await createOptionalLangChainTextSplitter();

  return {
    id: langChain ? langChain.id : 'dkb.structure-aware-text-splitter',
    version: 1,
    optionalDependencies: [
      {
        package: LANGCHAIN_TEXT_SPLITTER_PACKAGE,
        available: Boolean(langChain),
      },
    ],
  };
}
