<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';
import type { RegistryPipeline } from '../../types.js';

const props = defineProps<{ rows: RegistryPipeline[] }>();
const emit = defineEmits<{ inspect: [pipeline: RegistryPipeline] }>();
const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'name', title: 'Pipeline', className: 'all', render: { _: 'name', display: '#registry-pipeline-name' }, columnControl: consoleTextFilter('Pipeline') },
  { data: null, name: 'availability', title: 'Status', className: 'all', render: { _: (row: RegistryPipeline) => row.available ? 'available' : 'unavailable', display: '#registry-pipeline-status' }, columnControl: consoleListFilter(['available', 'unavailable'], 'Status') },
  { data: providerChain, name: 'providers', title: 'Provider chain', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Provider') },
  { data: services, name: 'services', title: 'Required services', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Service') },
  { data: 'compatibilityDigest', name: 'compatibility', title: 'Compatibility', render: (value: string | null, type: string) => value === null ? 'Not resolved' : type === 'display' ? short(value) : value, columnControl: consoleTextFilter('Digest') },
  { data: null, name: 'actions', title: 'Actions', className: 'all dt-actions', orderable: false, searchable: false, render: '#registry-pipeline-actions' },
]);
function providerChain(row: RegistryPipeline): string { return row.resolutionError ? 'Not resolved' : row.providers.map((provider) => provider.id).join(' → ') || 'Not reported'; }
function services(row: RegistryPipeline): string { return row.resolutionError ? 'Not resolved' : row.requiredServices.join(', ') || 'None'; }
function short(value: string): string { return value.length > 26 ? `${value.slice(0, 23)}…` : value; }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Trusted compiler Pipelines advertised by this Registry" noun="Pipelines" search-placeholder="Search Pipelines, providers, or services" empty-table="This Registry does not advertise any trusted Pipelines." :pin-row="(row) => Boolean(row.default)">
    <template #registry-pipeline-name="{ rowData }"><button class="resource-reference resource-reference--button" type="button" @click="emit('inspect', rowData)">{{ rowData.name }}</button><StatusBadge v-if="rowData.default" status="default" /></template>
    <template #registry-pipeline-status="{ rowData }"><StatusBadge :status="rowData.available ? 'available' : 'unavailable'" /></template>
    <template #registry-pipeline-actions="{ rowData }"><button class="table-inspect-link" type="button" @click="emit('inspect', rowData)">Inspect</button></template>
  </ConsoleDataTable>
</template>
