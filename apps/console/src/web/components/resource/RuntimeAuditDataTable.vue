<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import ResourceLink from '../interface/ResourceLink.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleDateFilter, consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';
import { auditAdmissionLabel, auditDate, auditLibraryReference, auditSlotRender } from './runtimeAuditPresentation.js';
import type { ResourceRow, RuntimeAuditEvent } from '../../types.js';

const props = defineProps<{ rows: RuntimeAuditEvent[]; libraries: ResourceRow[] }>();
const emit = defineEmits<{ inspect: [event: RuntimeAuditEvent] }>();
const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: 'query', name: 'query', title: 'Query', className: 'all', render: auditSlotRender('#audit-query'), columnControl: consoleTextFilter('Query') },
  { data: auditAdmissionLabel, name: 'admission', title: 'Admission', render: DataTablesCore.render.text(), columnControl: consoleListFilter(['Admitted', 'Not admitted'], 'Admission') },
  { data: 'outcome', name: 'outcome', title: 'Outcome', className: 'all', render: auditSlotRender('#audit-outcome'), columnControl: consoleListFilter(['success', 'insufficient', 'cancelled', 'failed'], 'Outcome') },
  { data: 'channel', name: 'channel', title: 'Channel', render: DataTablesCore.render.text(), columnControl: consoleListFilter(['cli', 'runtime-http', 'mcp'], 'Channel') },
  { data: (row: RuntimeAuditEvent) => row.library?.id ?? 'Not admitted', name: 'library', title: 'Library', render: auditSlotRender('#audit-library'), columnControl: consoleTextFilter('Library') },
  { data: (row: RuntimeAuditEvent) => row.pipeline?.target ?? 'Not admitted', name: 'pipeline', title: 'Pipeline', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Pipeline') },
  { data: 'resultCount', name: 'results', title: 'Results' },
  { data: 'recordedAt', name: 'recordedAt', title: 'Recorded', type: 'date', render: (value: string, type: string) => type === 'display' ? auditDate(value) : value, columnControl: consoleDateFilter('Recorded') },
  { data: null, name: 'actions', title: 'Actions', className: 'all dt-actions', orderable: false, searchable: false, render: '#audit-actions' },
]);
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Canonical Runtime retrieval audit" noun="queries" search-placeholder="Search queries, Libraries, or Pipelines" empty-table="This Runtime has not recorded any retrieval activity." zero-records="No audited query matches the current filters." :order="[[7, 'desc']]" :page-length="10">
    <template #audit-query="{ rowData }"><button class="resource-reference resource-reference--button audit-query-link" type="button" @click="emit('inspect', rowData)">{{ rowData.query }}</button></template>
    <template #audit-outcome="{ rowData }"><StatusBadge :status="rowData.outcome === 'success' ? 'succeeded' : rowData.outcome" /></template>
    <template #audit-library="{ rowData }"><ResourceLink v-if="auditLibraryReference(rowData, props.libraries).name" kind="library" :name="auditLibraryReference(rowData, props.libraries).name!" :label="rowData.library.id" /><span v-else :title="auditLibraryReference(rowData, props.libraries).detail">{{ rowData.library?.id ?? 'Not admitted' }}</span></template>
    <template #audit-actions="{ rowData }"><button class="table-inspect-link" type="button" @click="emit('inspect', rowData)">Inspect</button></template>
  </ConsoleDataTable>
</template>
