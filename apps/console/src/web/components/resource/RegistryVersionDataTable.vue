<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

interface VersionRow { version: string; status: string; packageTreeHash?: string | null }
const props = defineProps<{ rows: VersionRow[]; selected: string }>();
const emit = defineEmits<{ select: [version: string] }>();
const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'version', title: 'Version', className: 'all', render: { _: 'version', display: '#version-name' }, columnControl: consoleTextFilter('Version') },
  { data: null, name: 'status', title: 'Status', render: { _: 'status', display: '#version-status' }, columnControl: consoleListFilter(props.rows.map((row) => row.status), 'Status') },
  { data: 'packageTreeHash', name: 'digest', title: 'Source tree', render: (value: string | null | undefined) => short(value), columnControl: consoleTextFilter('Source tree') },
  { data: null, name: 'actions', title: 'Actions', className: 'all dt-actions', orderable: false, searchable: false, render: '#version-actions' },
]);
function short(value?: string | null): string { return value ? value.length > 28 ? `${value.slice(0, 25)}…` : value : 'Unavailable'; }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Published package versions" noun="versions" search-placeholder="Search versions or source digests" empty-table="No published versions are available.">
    <template #version-name="{ rowData }"><button class="resource-reference resource-reference--button" type="button" @click="emit('select', rowData.version)">{{ rowData.version }}</button></template>
    <template #version-status="{ rowData }"><StatusBadge :status="rowData.status" /></template>
    <template #version-actions="{ rowData }"><button class="table-inspect-link" type="button" :disabled="rowData.version === selected" @click="emit('select', rowData.version)">{{ rowData.version === selected ? 'Selected' : 'Inspect' }}</button></template>
  </ConsoleDataTable>
</template>
