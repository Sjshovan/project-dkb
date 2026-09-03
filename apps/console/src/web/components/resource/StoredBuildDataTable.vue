<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import type { DkbInstalledBuildSummary } from '@sjshovan/dkb-protocol/packageInspection.js';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleDateFilter, consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

const props = defineProps<{ rows: DkbInstalledBuildSummary[]; trust: (build: DkbInstalledBuildSummary) => string }>();
const emit = defineEmits<{ inspect: [build: DkbInstalledBuildSummary] }>();
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'build', title: 'Build', className: 'all', render: { _: label, display: '#stored-build-name' }, columnControl: consoleTextFilter('Build') },
  { data: null, name: 'kind', title: 'Kind', render: { _: 'kind', display: '#stored-build-kind' }, columnControl: consoleListFilter(['evidence', 'retrieval'], 'Kind') },
  { data: (row: DkbInstalledBuildSummary) => props.trust(row), name: 'trust', title: 'Trust', render: '#stored-build-trust', columnControl: consoleListFilter([...new Set(props.rows.map(props.trust))], 'Trust') },
  { data: providerChain, name: 'providers', title: 'Providers', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Providers') },
  { data: metrics, name: 'shape', title: 'Contents', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Contents') },
  { data: (row: DkbInstalledBuildSummary) => formatBytes(row.bytes), name: 'size', title: 'Stored size' },
  { data: 'generatedAt', name: 'generatedAt', title: 'Generated', type: 'date', render: (value: string | undefined, type: string) => type === 'display' ? formatDate(value) : value ?? '', columnControl: consoleDateFilter('Generated') },
  { data: null, name: 'actions', title: 'Actions', className: 'all dt-actions', orderable: false, searchable: false, render: '#stored-build-actions' },
]);
function label(build: DkbInstalledBuildSummary): string { return build.kind === 'evidence' ? 'Evidence Build' : build.target ?? 'Retrieval Build'; }
function providerChain(build: DkbInstalledBuildSummary): string { return build.providers.map((provider) => provider.id).join(' → ') || 'Not reported'; }
function metrics(build: DkbInstalledBuildSummary): string {
  if (build.kind === 'evidence') return `${build.recordCount ?? 0} records · ${build.chunkCount ?? 0} chunks`;
  return build.embedding ? `${build.embedding.dimensions} dimensions · ${build.embedding.metric}` : 'Retrieval artifacts';
}
function formatBytes(value: number): string { const units = ['B', 'KiB', 'MiB', 'GiB']; let size = value; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size.toFixed(unit === 0 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`; }
function formatDate(value?: string): string { return value ? dateFormatter.format(new Date(value)) : 'Unavailable'; }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Immutable builds stored for this package" noun="builds" search-placeholder="Search builds, targets, providers, or digests" empty-table="No stored builds were found.">
    <template #stored-build-name="{ rowData }"><button class="resource-reference resource-reference--button" type="button" @click="emit('inspect', rowData)">{{ label(rowData) }}</button></template>
    <template #stored-build-kind="{ rowData }"><StatusBadge :status="rowData.kind" /></template>
    <template #stored-build-trust="{ rowData }"><StatusBadge :status="trust(rowData)" /></template>
    <template #stored-build-actions="{ rowData }"><button class="table-inspect-link" type="button" @click="emit('inspect', rowData)">Inspect</button></template>
  </ConsoleDataTable>
</template>
