export const distributableWorkspaces = [
  '@sjshovan/dkb-protocol',
  '@sjshovan/dkb-library',
  '@sjshovan/dkb-pipeline',
  '@sjshovan/dkb-registry-client',
  '@sjshovan/dkb-evidence-docling-llamaindex',
  '@sjshovan/dkb-embedding-fastembed',
  '@sjshovan/dkb-embedding-tei',
  '@sjshovan/dkb-index-faiss',
  '@sjshovan/dkb-index-meilisearch',
  '@sjshovan/dkb-retrieval-hybrid',
  '@sjshovan/dkb-distribution-default',
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
