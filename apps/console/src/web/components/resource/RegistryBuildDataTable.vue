<script setup lang="ts">
import { computed } from 'vue';
import type { DkbRegistryBuildSummary } from '@sjshovan/dkb-protocol/registryCatalog.js';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleDateFilter, consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

const props = defineProps<{ rows: DkbRegistryBuildSummary[] }>();
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: evidenceLabel, name: 'evidenceGroup', title: 'Parent Evidence', className: 'all', columnControl: consoleTextFilter('Evidence Build') },
  { data: 'target', name: 'target', title: 'Target', className: 'all', columnControl: consoleTextFilter('Target') },
  { data: () => 'Registry signed', name: 'trust', title: 'Trust', render: '#build-trust', columnControl: consoleListFilter(['Registry signed'], 'Trust') },
  { data: null, name: 'status', title: 'Status', className: 'all', render: { _: 'status', display: '#build-status' }, columnControl: consoleListFilter(props.rows.map((row) => row.status), 'Status') },
  { data: providerChain, name: 'providers', title: 'Provider chain', columnControl: consoleTextFilter('Provider chain') },
  { data: 'evidenceDigest', name: 'evidence', title: 'Evidence', render: (value: string, type: string) => type === 'display' ? short(value) : value, columnControl: consoleTextFilter('Evidence digest') },
  { data: 'retrievalBuildDigest', name: 'retrieval', title: 'Retrieval', render: (value: string, type: string) => type === 'display' ? short(value) : value, columnControl: consoleTextFilter('Retrieval digest') },
  { data: totalBytes, name: 'size', title: 'Stored size', type: 'num', render: (value: number, type: string) => type === 'display' ? formatBytes(value) : value },
  { data: 'retrievalBuiltAt', name: 'builtAt', title: 'Built', type: 'date', render: (value: string | null, type: string) => type === 'display' ? formatDate(value) : value ?? '', columnControl: consoleDateFilter('Built') },
]);
function evidenceLabel(build: DkbRegistryBuildSummary): string {
  const unique = [...new Set(props.rows.map((row) => row.evidenceDigest))];
  return `Evidence ${unique.indexOf(build.evidenceDigest) + 1}`;
}
function providerChain(build: DkbRegistryBuildSummary): string {
  const ids = [...build.evidenceProviders, ...build.retrievalProviders].map((item) => isRecord(item) ? String(item.id ?? item.providerId ?? '') : '').filter(Boolean);
  return ids.length ? ids.join(' → ') : 'Not reported';
}
function totalBytes(build: DkbRegistryBuildSummary): number { return (build.evidenceSize ?? 0) + (build.retrievalSize ?? 0); }
function formatBytes(value: number): string { return value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(1)} MiB`; }
function formatDate(value?: string | null): string { return value ? dateFormatter.format(new Date(value)) : 'Unavailable'; }
function short(value: string): string { return value.length > 28 ? `${value.slice(0, 25)}…` : value; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
</script>

<template><ConsoleDataTable :rows="rows" :columns="columns" caption="Retrieval builds grouped by parent Evidence Build" noun="builds" search-placeholder="Search targets, providers, or digests" empty-table="No retrieval builds are available." :order="[[0, 'asc'], [1, 'asc']]"><template #build-trust><StatusBadge status="registry signed" /></template><template #build-status="{ rowData }"><StatusBadge :status="rowData.status" /></template></ConsoleDataTable></template>
