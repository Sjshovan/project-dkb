export const distributableWorkspaces = [
  '@sjshovan/dkb-protocol',
  '@sjshovan/dkb-library',
  '@sjshovan/dkb-pipeline',
  '@sjshovan/dkb-registry-client',
  '@sjshovan/dkb-providers-bundled',
  '@sjshovan/dkb-compiler',
  '@sjshovan/dkb-runtime',
  '@sjshovan/dkb-cli',
];

const forbiddenPackagePaths = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.dkb(\/|$)/i,
  /(^|\/)testing(\/|$)/i,
  /graphify-out/i,
  /\.tsbuildinfo$/i,
  /(?:credential|password|secret).*(?:\.json|\.ya?ml|\.txt|\.pem|\.key)$/i,
  /private[-_.]?key/i,
  /\.dkbpkg$|\.faiss$/i,
];

export function findForbiddenPackagePaths(paths) {
  return paths.filter((file) => forbiddenPackagePaths.some((pattern) => pattern.test(file)));
}
