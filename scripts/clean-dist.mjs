import fs from 'node:fs/promises';
import path from 'node:path';

await fs.rm(path.resolve('dist'), { recursive: true, force: true });
