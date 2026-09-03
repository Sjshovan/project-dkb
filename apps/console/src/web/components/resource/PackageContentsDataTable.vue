<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import type { DkbPackageContents } from '@sjshovan/dkb-protocol/packageInspection.js';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

type ContentEntry = DkbPackageContents['entries'][number];
const props = defineProps<{ rows: ContentEntry[] }>();
const emit = defineEmits<{ openDirectory: [path: string]; openFile: [path: string] }>();
const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'name', title: 'Name', className: 'all', render: { _: 'name', display: '#content-name' }, columnControl: consoleTextFilter('Name') },
  { data: (row: ContentEntry) => row.kind === 'directory' ? 'Directory' : row.contentKind ?? 'File', name: 'type', title: 'Type', render: DataTablesCore.render.text(), columnControl: consoleListFilter(props.rows.map((row) => row.kind === 'directory' ? 'Directory' : row.contentKind ?? 'File'), 'Type') },
  { data: (row: ContentEntry) => row.kind === 'file' ? formatBytes(row.bytes) : '—', name: 'size', title: 'Size' },
  { data: (row: ContentEntry) => row.kind === 'file' ? String(row.evidenceRecords ?? 0) : '—', name: 'evidence', title: 'Evidence records' },
  { data: null, name: 'actions', title: 'Actions', className: 'all dt-actions', orderable: false, searchable: false, render: '#content-actions' },
]);
function formatBytes(value?: number): string { if (value === undefined) return '—'; const units = ['B', 'KiB', 'MiB', 'GiB']; let size = value; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size.toFixed(unit === 0 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`; }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Portable files in this package directory" noun="items" search-placeholder="Search this directory" empty-table="This directory contains no portable package files.">
    <template #content-name="{ rowData }"><button class="resource-reference resource-reference--button" type="button" :disabled="rowData.kind === 'file' && !rowData.previewable" @click="rowData.kind === 'directory' ? emit('openDirectory', rowData.path) : emit('openFile', rowData.path)">{{ rowData.name }}</button></template>
    <template #content-actions="{ rowData }"><StatusBadge v-if="rowData.kind === 'file' && !rowData.previewable" status="binary" /><button v-else class="table-inspect-link" type="button" @click="rowData.kind === 'directory' ? emit('openDirectory', rowData.path) : emit('openFile', rowData.path)">{{ rowData.kind === 'directory' ? 'Open' : 'Preview' }}</button></template>
  </ConsoleDataTable>
</template>
