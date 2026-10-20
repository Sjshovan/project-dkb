<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import type { ResourceRow, RuntimeStatus } from '../../types.js';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import ResourceLink from '../interface/ResourceLink.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

type ServingRuntime = ResourceRow & { runtime?: RuntimeStatus };
const props = defineProps<{ rows: ServingRuntime[] }>();
const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'name', title: 'Runtime', className: 'all', render: { _: 'name', display: '#runtime-name' }, columnControl: consoleTextFilter('Runtime') },
  { data: null, name: 'pipeline', title: 'Pipeline', render: { _: pipelineName, display: '#runtime-pipeline' }, columnControl: consoleTextFilter('Pipeline') },
  { data: null, name: 'status', title: 'Status', className: 'all', render: { _: runtimeStatus, display: '#runtime-status' }, columnControl: consoleListFilter(props.rows.map(runtimeStatus), 'Status') },
  { data: (row: ServingRuntime) => row.url ?? row.stateRoot ?? '—', name: 'endpoint', title: 'Endpoint', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Endpoint') },
]);
function pipelineName(row: ServingRuntime): string { return row.runtime?.target ?? row.target ?? 'Unavailable'; }
function runtimeStatus(row: ServingRuntime): string { return row.runtime?.stale ? 'stale' : row.runtime ? 'ready' : row.status ?? 'known'; }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Runtimes serving this Library" noun="runtimes" search-placeholder="Search serving Runtimes" empty-table="No Runtime serves this Library.">
    <template #runtime-name="{ rowData }"><ResourceLink kind="runtime" :name="rowData.name" /></template>
    <template #runtime-pipeline="{ rowData }"><ResourceLink v-if="pipelineName(rowData) !== 'Unavailable'" kind="pipeline" :name="pipelineName(rowData)" :runtime="rowData.name" /><span v-else>Unavailable</span></template>
    <template #runtime-status="{ rowData }"><StatusBadge :status="runtimeStatus(rowData)" /></template>
  </ConsoleDataTable>
</template>
