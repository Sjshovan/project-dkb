<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import ResourceLink from '../interface/ResourceLink.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

const props = defineProps<{ rows: Array<Record<string, unknown>>; library?: string; registry?: string }>();
const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'identity', title: 'Member', className: 'all', render: { _: identity, display: '#member-identity' }, columnControl: consoleTextFilter('Member') },
  { data: release, name: 'release', title: 'Release', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Release') },
  { data: null, name: 'status', title: 'Status', render: { _: (row: Record<string, unknown>) => String(row.status ?? 'pinned'), display: '#member-status' }, columnControl: consoleListFilter(props.rows.map((row) => String(row.status ?? 'pinned')), 'Status') },
  { data: (row: Record<string, unknown>) => row.direct === undefined ? 'Exact dependency' : row.direct ? 'Direct' : 'Transitive', name: 'relationship', title: 'Relationship', render: DataTablesCore.render.text(), columnControl: consoleListFilter(['Exact dependency', 'Direct', 'Transitive'], 'Relationship') },
  { data: (row: Record<string, unknown>) => short(String(row.digest ?? '')), name: 'digest', title: 'Release digest', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Release digest') },
]);
function identity(row: Record<string, unknown>): string { return String(row.identity ?? row.id ?? 'unknown'); }
function release(row: Record<string, unknown>): string { return String(row.resolved ?? row.version ?? row.requested ?? 'Unresolved'); }
function short(value: string): string { return value ? value.length > 28 ? `${value.slice(0, 25)}…` : value : 'Unavailable'; }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Collection members" noun="members" search-placeholder="Search member identity, release, or digest" empty-table="This Collection has no members.">
    <template #member-identity="{ rowData }"><ResourceLink v-if="library" kind="installed-entry" :name="identity(rowData)" :library="library" /><ResourceLink v-else-if="registry" kind="registry-dkb" :name="identity(rowData)" :registry="registry" /><span v-else>{{ identity(rowData) }}</span></template>
    <template #member-status="{ rowData }"><StatusBadge :status="String(rowData.status ?? 'pinned')" /></template>
  </ConsoleDataTable>
</template>
