/** The read-only interoperability contract implemented by this release. */
export const DKB_PROTOCOL_VERSION = '2.0.0';
export const DKB_PROTOCOL_COMPATIBILITY = 'dkb.read.v1';

export const DKB_STABLE_MCP_TOOLS = [
  'search',
  'fetch',
] as const;

export type DkbStableMcpTool = typeof DKB_STABLE_MCP_TOOLS[number];
