import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export async function registryTokenInput(options: {
  token?: string;
  tokenStdin?: boolean;
}): Promise<string> {
  if (options.token?.trim()) return options.token.trim();
  if (process.env.DKB_REGISTRY_TOKEN?.trim()) return process.env.DKB_REGISTRY_TOKEN.trim();

  if (options.tokenStdin) {
    let value = '';
    for await (const chunk of process.stdin) value += String(chunk);
    if (value.trim()) return value.trim();
    throw new DkbError('No Registry token was received on standard input.');
  }

  if (!process.stdin.isTTY) {
    throw new DkbError('A Registry token is required. Use --token-stdin or set DKB_REGISTRY_TOKEN.');
  }

  return maskedPrompt('Registry token: ');
}

async function maskedPrompt(label: string): Promise<string> {
  const input = process.stdin;
  const wasRaw = input.isRaw;
  process.stderr.write(label);
  input.resume();
  input.setRawMode?.(true);

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode?.(Boolean(wasRaw));
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else if (!value.trim()) reject(new DkbError('Registry token cannot be empty.'));
      else resolve(value.trim());
    };

    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          finish(new DkbError('Registry login cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        if (character >= ' ') {
          value += character;
          process.stderr.write('*');
        }
      }
    };

    input.on('data', onData);
  });
}
