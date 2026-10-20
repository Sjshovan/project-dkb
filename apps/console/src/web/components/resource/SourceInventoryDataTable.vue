<script setup lang="ts">
import DataTablesCore from 'datatables.net-dt';
import type { DkbSourceInventoryEntry } from '@sjshovan/dkb-protocol/registryCatalog.js';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import { consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

defineProps<{ rows: DkbSourceInventoryEntry[] }>();
const columns: ConsoleDataTableColumn[] = [
  { data: 'path', name: 'path', title: 'Portable path', className: 'all', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Portable path') },
  { data: (row: DkbSourceInventoryEntry) => formatBytes(row.bytes), name: 'size', title: 'Size' },
  { data: 'hash', name: 'hash', title: 'SHA-256', render: (value: string) => short(value), columnControl: consoleTextFilter('SHA-256') },
];
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(1)} MiB`; }
function short(value: string): string { return value.length > 28 ? `${value.slice(0, 25)}…` : value; }
</script>

<template><ConsoleDataTable :rows="rows" :columns="columns" caption="Signed portable source inventory" noun="files" search-placeholder="Search source paths or hashes" empty-table="This release has no portable source files." /></template>
