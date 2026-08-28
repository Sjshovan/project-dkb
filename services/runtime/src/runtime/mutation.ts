import path from 'node:path';

interface RuntimeGate {
  activeReaders: number;
  pendingWriters: number;
  writerActive: boolean;
  writerTail: Promise<void>;
  readersDrained: Promise<void> | null;
  releaseReaders: (() => void) | null;
}

const gates = new Map<string, RuntimeGate>();

/**
 * Serialize mutations for one Runtime and wait for every in-flight query to
 * release its snapshot before package files or managed indexes are changed.
 */
export async function withRuntimeMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const gate = runtimeGate(root);
  gate.pendingWriters += 1;
  const previous = gate.writerTail;
  let releaseWriter!: () => void;
  const writer = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  gate.writerTail = previous.then(() => writer, () => writer);
  await previous;
  gate.pendingWriters -= 1;
  gate.writerActive = true;

  try {
    if (gate.activeReaders > 0) {
      gate.readersDrained ??= new Promise<void>((resolve) => {
        gate.releaseReaders = resolve;
      });
      await gate.readersDrained;
    }
    return await operation();
  } finally {
    gate.writerActive = false;
    releaseWriter();
  }
}

/** Hold a stable Runtime snapshot for the complete query operation. */
export async function withRuntimeQuery<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const gate = runtimeGate(root);

  while (gate.writerActive || gate.pendingWriters > 0) {
    await gate.writerTail;
  }
  gate.activeReaders += 1;

  try {
    return await operation();
  } finally {
    gate.activeReaders -= 1;
    if (gate.activeReaders === 0 && gate.releaseReaders) {
      const release = gate.releaseReaders;
      gate.releaseReaders = null;
      gate.readersDrained = null;
      release();
    }
  }
}

/** Keep direct snapshot consumers outside an active or queued mutation. */
export async function waitForRuntimeMutation(root: string): Promise<void> {
  const gate = runtimeGate(root);
  while (gate.writerActive || gate.pendingWriters > 0) {
    await gate.writerTail;
  }
}

function runtimeGate(root: string): RuntimeGate {
  const key = path.resolve(root);
  const existing = gates.get(key);
  if (existing) return existing;
  const created: RuntimeGate = {
    activeReaders: 0,
    pendingWriters: 0,
    writerActive: false,
    writerTail: Promise.resolve(),
    readersDrained: null,
    releaseReaders: null,
  };
  gates.set(key, created);
  return created;
}
