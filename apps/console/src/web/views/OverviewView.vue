<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { AlertTriangle, ArrowRight, Boxes, Database, Library, Server } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import { getJson } from '../api.js';
import PageHeader from '../components/interface/PageHeader.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import AttentionDataTable from '../components/resource/AttentionDataTable.vue';
import type { ResourceListing, ResourceRow } from '../types.js';

interface Overview { libraries: ResourceListing; runtimes: ResourceListing; registries: ResourceListing; stacks: ResourceListing }
const query = useQuery({ queryKey: ['overview'], queryFn: () => getJson<Overview>('/api/v1/overview') });
const groups = computed(() => [
  { name: 'Libraries', route: '/libraries', icon: Library, rows: query.data.value?.libraries.libraries ?? [], default: query.data.value?.libraries.selected },
  { name: 'Runtimes', route: '/runtimes', icon: Server, rows: query.data.value?.runtimes.runtimes ?? [], default: query.data.value?.runtimes.selected },
  { name: 'Registries', route: '/registries', icon: Database, rows: query.data.value?.registries.registries ?? [], default: query.data.value?.registries.selected },
  { name: 'Stacks', route: '/stacks', icon: Boxes, rows: query.data.value?.stacks.stacks ?? [], default: query.data.value?.stacks.default },
]);
const attention = computed(() => groups.value.flatMap((group) => group.rows
  .filter((row: ResourceRow) => ['missing', 'invalid', 'offline', 'unavailable', 'degraded'].includes(row.status ?? ''))
  .map((row: ResourceRow) => ({ ...row, group: group.name as 'Libraries' | 'Runtimes' | 'Registries' | 'Stacks' }))));
</script>

<template>
  <div class="page">
    <PageHeader title="Host overview" description="Your known DKB resources, defaults, and attention states on this machine." />
    <div v-if="query.isPending.value" class="skeleton-stack" aria-label="Loading host overview"><span v-for="n in 5" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><AlertTriangle :size="20" /><div><h2>Host state could not be loaded</h2><p>{{ query.error.value?.message }}</p><button type="button" @click="query.refetch()">Retry loading</button></div></section>
    <template v-else>
      <section class="summary-ledger" aria-label="Host resource summary">
        <RouterLink v-for="group in groups" :key="group.name" :to="group.route">
          <component :is="group.icon" :size="19" aria-hidden="true" /><span><b>{{ group.name }}</b><small>{{ group.rows.length }} known · default {{ group.default ?? 'not set' }}</small></span><ArrowRight :size="17" aria-hidden="true" />
        </RouterLink>
      </section>
      <section class="page-section">
        <header><div><h2>Needs attention</h2><p>Checked failures and missing local resources stay visible until you resolve or forget them.</p></div><span class="count">{{ attention.length }}</span></header>
        <AttentionDataTable v-if="attention.length" :rows="attention" />
        <div v-else class="quiet-state">No checked resource currently needs attention.</div>
      </section>
    </template>
  </div>
</template>
