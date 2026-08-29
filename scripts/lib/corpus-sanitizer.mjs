const SECRET_PATH_PATTERN = /(^|\/)(?:\.env(?:\.|$)|auth\.json$|[^/]*(?:credential|private[-_]?key|oauth[-_]?key)[^/]*$)|\.(?:pem|p12|pfx|key|crt|cer)$/iu;

const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  /\bgh[pousr]_[0-9A-Za-z]{30,}\b/u,
  /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/u,
  /(?:^|[,{(\s])["']?(?:access[_-]?token|auth[_-]?token|token|secret|password|api[_-]?key|client[_-]?secret)["']?\s*(?:=>|=|:)\s*["'][^"'$\s][^"']*["']/imu,
];

export function isSensitiveCorpusPath(relativePath) {
  return SECRET_PATH_PATTERN.test(relativePath.replace(/\\/gu, '/'));
}

export function containsSensitiveCorpusContent(text) {
  return text.includes('\uFFFD') || SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}
