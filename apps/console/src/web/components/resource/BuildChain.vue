<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue';
import { ChevronRight, FileStack } from '@lucide/vue';
import type { DkbInstalledBuildSummary, DkbInstalledEntryDetail } from '@sjshovan/dkb-protocol/packageInspection.js';
import StatusBadge from '../interface/StatusBadge.vue';

defineProps<{ detail: DkbInstalledEntryDetail }>();
const selectedBuild = ref<DkbInstalledBuildSummary>();
const BuildDetailsDrawer = defineAsyncComponent(() => import('./BuildDetailsDrawer.vue'));

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

function buildContents(build: DkbInstalledBuildSummary): string {
  if (build.kind === 'evidence') return 'Parsed records · source anchors · provenance catalog';
  return 'Embeddings · search index · Evidence ID mappings';
}

function buildMetrics(build: DkbInstalledBuildSummary): string[] {
  const metrics = [formatBytes(build.bytes), `${build.files.length} stored ${build.files.length === 1 ? 'file' : 'files'}`];
  if (build.kind === 'evidence') {
    metrics.unshift(`${build.recordCount ?? 0} records`, `${build.chunkCount ?? 0} chunks`);
  } else if (build.embedding) {
    metrics.unshift(`${build.embedding.dimensions} dimensions`, build.embedding.metric);
  }
  return metrics;
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
        <button type="button" :aria-label="`Inspect ${build.kind} Build ${shortDigest(build.buildDigest)}`" @click="selectedBuild = build">
          <span class="stored-build-main"><span><strong>{{ build.kind === 'evidence' ? 'Evidence Build' : build.target ?? 'Retrieval Build' }}</strong><small v-if="build.kind === 'retrieval'">Retrieval Build</small></span><StatusBadge status="stored" /></span>
          <span class="stored-build-purpose">{{ buildContents(build) }}</span>
          <span class="stored-build-meta"><span v-for="metric in buildMetrics(build)" :key="metric">{{ metric }}</span></span>
          <span class="stored-build-identity"><code>{{ shortDigest(build.buildDigest) }}</code><ChevronRight :size="17" aria-hidden="true" /></span>
        </button>
      </article>
    </div>
    <div v-else class="quiet-state">No stored builds were found.</div>
  </section>

  <BuildDetailsDrawer v-if="selectedBuild" :open="true" :build="selectedBuild" @update:open="!$event && (selectedBuild = undefined)" />
</template>
