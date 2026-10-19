import os from 'node:os';
import { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { runtimeTokensForUrl } from '../stack/context.js';
import { readHostInventory } from './inventory.js';
import { loadRuntimeHttpCredentials } from './runtimeCredentials.js';
import { nativeRuntimeStateRoot } from './runtimeLocation.js';

/** Resolve credentials for exactly one selected endpoint; inventory never carries secrets. */
export async function runtimeClientForUrl(baseUrl: string, timeoutMs?: number): Promise<DkbRuntimeClient> {
  let { adminToken, readToken } = await runtimeTokensForUrl(baseUrl);
  const url = new URL(baseUrl);
  const localAddresses = Object.values(os.networkInterfaces()).flatMap(addresses => addresses?.map(address => address.address) ?? []);
  if (['127.0.0.1', 'localhost', '::1', ...localAddresses].includes(url.hostname.replace(/^\[|\]$/gu, ''))) {
    const inventory = await readHostInventory();
    const known = Object.values(inventory.runtimes).find((entry) =>
      nativeRuntimeStateRoot(entry) && endpointIdentity(entry.url) === endpointIdentity(baseUrl));
    const root = known && nativeRuntimeStateRoot(known);
    if (root) {
      const saved = await loadRuntimeHttpCredentials(root);
      adminToken ??= saved?.adminToken;
      readToken ??= saved?.readToken;
    }
  }
  return new DkbRuntimeClient({ baseUrl, adminToken, readToken, ...(timeoutMs ? { timeoutMs } : {}) });
}

function endpointIdentity(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}
