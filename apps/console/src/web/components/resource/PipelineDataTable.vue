<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import { AlertTriangle, CheckCircle2, ChevronRight } from '@lucide/vue';
import type { PipelineTarget } from '../../types.js';
import AppButton from '../interface/AppButton.vue';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import ResourceLink from '../interface/ResourceLink.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

const props = defineProps<{ rows: PipelineTarget[]; runtime: string; runtimeIsRemote: boolean; busyTarget?: string }>();
const emit = defineEmits<{ details: [target: PipelineTarget]; activate: [target: PipelineTarget] }>();

const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'name', title: 'Pipeline', className: 'all', render: { _: 'name', display: '#pipeline-name' }, columnControl: consoleTextFilter('Pipeline') },
  { data: null, name: 'health', title: 'Availability', className: 'all', render: { _: 'health', display: '#pipeline-health' }, columnControl: consoleListFilter(props.rows.map((row) => row.health), 'Availability') },
  { data: (row: PipelineTarget) => row.providers.join(' → '), name: 'providers', title: 'Provider chain', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Provider chain') },
  { data: (row: PipelineTarget) => row.dimensions === null ? 'Unavailable' : `${row.dimensions} · ${row.metric ?? 'unknown'}`, name: 'embedding', title: 'Embedding', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Embedding') },
  { data: (row: PipelineTarget) => `${row.coverage.ready}/${row.coverage.total}`, name: 'coverage', title: 'Coverage', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Coverage') },
  { data: (row: PipelineTarget) => row.requiredServices.join(', ') || 'None', name: 'services', title: 'Required services', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Required services') },
  { data: null, name: 'actions', title: 'Actions', className: 'all dt-actions', orderable: false, searchable: false, render: '#pipeline-actions' },
]);

function failedHealth(target: PipelineTarget): number { return target.healthDetails.filter((item) => !item.ok).length; }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Pipelines available to the selected Runtime" noun="pipelines" search-placeholder="Search name, provider, or service" empty-table="No Pipelines are available in this Runtime context.">
    <template #pipeline-name="{ rowData }"><div class="primary-cell"><ResourceLink kind="pipeline" :name="rowData.name" :runtime="runtime" /><small>{{ rowData.origin }} definition</small></div></template>
    <template #pipeline-health="{ rowData }"><button class="status-detail-trigger" type="button" :aria-label="`View availability details for ${rowData.name}`" @click="emit('details', rowData)"><StatusBadge :status="rowData.health" /><ChevronRight :size="14" aria-hidden="true" /></button></template>
    <template #pipeline-actions="{ rowData }">
      <div class="table-actions">
        <span v-if="rowData.active" class="pipeline-active-badge"><CheckCircle2 :size="14" />Active</span>
        <button v-else-if="rowData.health !== 'ready'" class="pipeline-unavailable-link" type="button" @click="emit('details', rowData)"><AlertTriangle :size="15" /><span>{{ failedHealth(rowData) }} unavailable</span></button>
        <span v-else-if="runtimeIsRemote" class="remote-admin-note">Operator required</span>
        <AppButton v-else size="sm" variant="secondary" :disabled="Boolean(busyTarget)" :loading="busyTarget === rowData.name" @click="emit('activate', rowData)">Activate</AppButton>
      </div>
    </template>
  </ConsoleDataTable>
</template>
