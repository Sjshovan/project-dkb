<script setup lang="ts">
import { ArrowRight, Box, Database, FileStack } from '@lucide/vue';
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
  <div v-if="detail.activeBuild" class="build-chain" aria-label="Active package build chain">
    <article><FileStack :size="20" /><span><small>Package version</small><strong>{{ detail.identity }}@{{ detail.version }}</strong><code>{{ shortDigest(detail.provenance.sourceDigest ?? detail.digest) }}</code></span></article>
    <ArrowRight class="build-arrow" :size="18" aria-hidden="true" />
    <article><Database :size="20" /><span><small>Evidence Build</small><strong>{{ detail.sourceSummary.evidenceRecords }} records</strong><code>{{ shortDigest(detail.activeBuild.evidenceDigest) }}</code></span></article>
    <ArrowRight class="build-arrow" :size="18" aria-hidden="true" />
    <article><Box :size="20" /><span><small>Retrieval Build</small><strong>{{ detail.activeBuild.embeddingSpace }} · {{ detail.activeBuild.dimensions }}d</strong><code>{{ shortDigest(detail.activeBuild.retrievalBuildDigest) }}</code></span></article>
  </div>
  <div v-else class="quiet-state">No active build chain is available for this DKB.</div>

  <section v-if="detail.activeBuild" class="build-profile-summary">
    <dl>
      <div><dt>Pipeline</dt><dd>{{ detail.activeBuild.target }}</dd></div>
      <div><dt>Embedding</dt><dd>{{ detail.activeBuild.embeddingProvider }} · {{ detail.activeBuild.metric }}</dd></div>
      <div><dt>Index</dt><dd>{{ detail.activeBuild.indexProvider }} · {{ detail.activeBuild.indexFormat }}</dd></div>
      <div><dt>Retrieval</dt><dd>{{ detail.activeBuild.retrievalProvider }}</dd></div>
      <div><dt>Compatibility</dt><dd><code>{{ detail.activeBuild.compatibilityDigest }}</code></dd></div>
    </dl>
  </section>

  <section class="stored-builds">
    <header><div><h2>Stored builds</h2><p>Inactive builds remain reusable until you explicitly prune them.</p></div><span class="count">{{ detail.builds.length }}</span></header>
    <div v-if="detail.builds.length" class="stored-build-list">
      <article v-for="build in detail.builds" :key="`${build.kind}:${build.buildDigest}`">
        <div><strong>{{ build.kind === 'evidence' ? 'Evidence Build' : 'Retrieval Build' }}</strong><code>{{ shortDigest(build.buildDigest) }}</code></div>
        <div><span>{{ formatBytes(build.bytes) }}</span><span v-if="build.recordCount !== undefined">{{ build.recordCount }} records</span><StatusBadge :status="build.active ? 'active' : 'inactive'" /></div>
      </article>
    </div>
    <div v-else class="quiet-state">No stored builds were found.</div>
  </section>
</template>
