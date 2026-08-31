<script setup lang="ts">
import { FileStack } from '@lucide/vue';
import type { DkbInstalledEntryDetail } from '@sjshovan/dkb-protocol/packageInspection.js';
import StatusBadge from '../interface/StatusBadge.vue';

defineProps<{ detail: DkbInstalledEntryDetail }>();

function shortDigest(value?: string): string {
  if (!value) return 'Unavailable';
  return value.length > 24 ? `${value.slice(0, 21)}…` : value;
}

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}
</script>

<template>
  <div class="build-chain build-chain--library" aria-label="Library package build storage">
    <article><FileStack :size="20" /><span><small>Package version</small><strong>{{ detail.identity }}@{{ detail.version }}</strong><code>{{ shortDigest(detail.provenance.sourceDigest ?? detail.digest) }}</code></span></article>
  </div>

  <section class="stored-builds">
    <header><div><h2>Stored builds</h2><p>Immutable Evidence and Retrieval Builds are shared by Runtime activations and remain reusable until explicitly pruned.</p></div><span class="count">{{ detail.builds.length }}</span></header>
    <div v-if="detail.builds.length" class="stored-build-list">
      <article v-for="build in detail.builds" :key="`${build.kind}:${build.buildDigest}`">
        <div><strong>{{ build.kind === 'evidence' ? 'Evidence Build' : 'Retrieval Build' }}</strong><code>{{ shortDigest(build.buildDigest) }}</code></div>
        <div><span>{{ formatBytes(build.bytes) }}</span><span v-if="build.recordCount !== undefined">{{ build.recordCount }} records</span><StatusBadge status="stored" /></div>
      </article>
    </div>
    <div v-else class="quiet-state">No stored builds were found.</div>
  </section>
</template>
