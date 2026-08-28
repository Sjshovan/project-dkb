import { spawnSync } from 'node:child_process';
import { distributableWorkspaces, findForbiddenPackagePaths } from './package-policy.mjs';
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error('npm_execpath is unavailable. Run this check through npm run package:check.');
}

for (const workspace of distributableWorkspaces) {
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--workspace', workspace, '--dry-run', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Unable to inspect ${workspace}: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout)[0];
  const paths = report.files.map((file) => file.path);
  const rejected = findForbiddenPackagePaths(paths);
  if (rejected.length > 0) throw new Error(`${workspace} package contains forbidden files: ${rejected.join(', ')}`);
  if (!paths.includes('package.json')) throw new Error(`${workspace} package has no package.json`);
  console.log(`${workspace}: ${report.entryCount} files, ${report.unpackedSize} bytes unpacked`);
}
