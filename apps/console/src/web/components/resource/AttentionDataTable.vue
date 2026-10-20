<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import type { ResourceRow } from '../../types.js';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import ResourceLink from '../interface/ResourceLink.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

type AttentionRow = ResourceRow & { group: 'Libraries' | 'Runtimes' | 'Registries' | 'Stacks' };

const props = defineProps<{ rows: AttentionRow[] }>();

const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'resource', title: 'Resource', className: 'all', render: { _: 'name', display: '#attention-resource' }, columnControl: consoleTextFilter('Resource') },
  { data: 'group', name: 'kind', title: 'Type', render: DataTablesCore.render.text(), columnControl: consoleListFilter(props.rows.map((row) => row.group), 'Type') },
  { data: null, name: 'status', title: 'Status', className: 'all', render: { _: 'status', display: '#attention-status' }, columnControl: consoleListFilter(props.rows.map((row) => row.status ?? 'unknown'), 'Status') },
  { data: (row: AttentionRow) => row.message ?? 'Run a health check for details.', name: 'message', title: 'Details', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Details') },
]);

function kind(group: AttentionRow['group']): 'library' | 'runtime' | 'registry' | 'stack' {
  return ({ Libraries: 'library', Runtimes: 'runtime', Registries: 'registry', Stacks: 'stack' } as const)[group];
}
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Host resources that need attention" noun="resources" search-placeholder="Search resources needing attention" empty-table="No checked resource currently needs attention.">
    <template #attention-resource="{ rowData }"><ResourceLink :kind="kind(rowData.group)" :name="rowData.name" /></template>
    <template #attention-status="{ rowData }"><StatusBadge :status="rowData.status ?? 'unknown'" /></template>
  </ConsoleDataTable>
</template>
