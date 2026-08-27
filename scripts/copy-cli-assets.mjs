import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'deploy', 'compose.yaml');
const target = path.join(root, 'apps', 'cli', 'dist', 'stack', 'compose.yaml');

await fs.mkdir(path.dirname(target), { recursive: true });
await fs.copyFile(source, target);
