import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packDistribution } from './package-distribution.mjs';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-package-inspection-'));
try {
  const { packages } = await packDistribution({ outputDirectory: output });
  for (const report of packages) {
    console.log(`${report.name}: ${report.paths.length} inspected files, ${report.unpackedSize} bytes unpacked`);
  }
} finally {
  await fs.rm(output, { recursive: true, force: true });
}
