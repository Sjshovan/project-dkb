/** The read-only interoperability contract implemented by this release. */
export const DKB_PROTOCOL_VERSION = '1.0.0';
export const DKB_PROTOCOL_COMPATIBILITY = 'dkb.read.v1';

export const DKB_STABLE_MCP_TOOLS = [
  'dkb.health',
  'dkb.describe_registry',
  'dkb.describe_collection',
  'dkb.retrieve_knowledge',
  'dkb.trace_query',
  'dkb.trace_latest',
  'dkb.trace_list',
  'dkb.trace_get',
] as const;

export type DkbStableMcpTool = typeof DKB_STABLE_MCP_TOOLS[number];
