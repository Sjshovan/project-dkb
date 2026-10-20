<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import { RefreshCw } from '@lucide/vue';
import AppButton from '../interface/AppButton.vue';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import ResourceLink from '../interface/ResourceLink.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

const props = defineProps<{ rows: Array<Record<string, unknown>>; library: string }>();
const emit = defineEmits<{ upgrade: [identity: string]; uninstall: [identity: string] }>();

const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'identity', title: 'Knowledge', className: 'all', render: { _: identity, display: '#knowledge-identity' }, columnControl: consoleTextFilter('Knowledge') },
  { data: release, name: 'release', title: 'Release', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Release') },
  { data: null, name: 'status', title: 'Status', className: 'all', render: { _: (row: Record<string, unknown>) => String(row.status ?? 'installed'), display: '#knowledge-status' }, columnControl: consoleListFilter(props.rows.map((row) => String(row.status ?? 'installed')), 'Status') },
  { data: null, name: 'origin', title: 'Origin', render: { _: origin, display: '#knowledge-origin' }, columnControl: consoleTextFilter('Origin') },
  { data: null, name: 'actions', title: 'Actions', className: 'all dt-actions', orderable: false, searchable: false, render: '#knowledge-actions' },
]);

function identity(row: Record<string, unknown>): string { return String(row.id ?? row.identity ?? 'unknown'); }
function release(row: Record<string, unknown>): string { return String(row.version ?? (row.revision ? `Revision ${row.revision}` : 'Editable')); }
function origin(row: Record<string, unknown>): string { return String(row.registry ?? row.origin ?? 'Local'); }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Knowledge installed in this Library" noun="packages" search-placeholder="Search installed knowledge" empty-table="No knowledge is installed in this Library.">
    <template #knowledge-identity="{ rowData }"><div class="primary-cell"><ResourceLink kind="installed-entry" :name="identity(rowData)" :library="library" /><small>{{ rowData.kind ?? 'DKB' }}</small></div></template>
    <template #knowledge-status="{ rowData }"><StatusBadge :status="String(rowData.status ?? 'installed')" /></template>
    <template #knowledge-origin="{ rowData }"><ResourceLink v-if="rowData.registry" kind="registry" :name="String(rowData.registry)" /><span v-else>{{ origin(rowData) }}</span></template>
    <template #knowledge-actions="{ rowData }"><div class="table-actions"><AppButton size="sm" variant="quiet" @click="emit('upgrade', identity(rowData))"><RefreshCw :size="14" />Upgrade</AppButton><AppButton size="sm" variant="quiet" @click="emit('uninstall', identity(rowData))">Uninstall</AppButton></div></template>
  </ConsoleDataTable>
</template>
