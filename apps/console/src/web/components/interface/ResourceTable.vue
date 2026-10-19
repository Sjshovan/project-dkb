<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import { ChevronRight } from '@lucide/vue';
import type { ResourceKind, ResourceRow } from '../../types.js';
import ConsoleDataTable from './ConsoleDataTable.vue';
import ResourceLink from './ResourceLink.vue';
import StatusBadge from './StatusBadge.vue';
import { consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from './consoleDataTable.js';
import { isHostDefault } from '../../selectOptions.js';

const props = defineProps<{ rows: ResourceRow[]; kind: ResourceKind }>();
const emit = defineEmits<{ details: [row: ResourceRow] }>();

const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'name', title: 'Name', className: 'all', render: { _: 'name', display: '#resource-name' }, columnControl: consoleTextFilter('Name') },
  { data: null, name: 'status', title: 'Status', className: 'all', render: { _: 'status', display: '#resource-status' }, columnControl: consoleListFilter(props.rows.map((row) => row.status ?? 'known'), 'Status') },
  { data: associationText, name: 'association', title: associationLabel(props.kind), render: { _: associationText, display: '#resource-association' }, columnControl: consoleTextFilter(associationLabel(props.kind)) },
  { data: resourceLocation, name: 'location', title: 'Location', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Location') },
  { data: null, name: 'actions', title: 'Actions', className: 'all dt-actions', orderable: false, searchable: false, render: '#resource-actions' },
]);

function singular(kind: ResourceKind): 'library' | 'runtime' | 'registry' | 'stack' {
  return ({ libraries: 'library', runtimes: 'runtime', registries: 'registry', stacks: 'stack' } as const)[kind];
}
function resourceLocation(row: ResourceRow): string { return row.location ?? row.path ?? row.url ?? row.stateRoot ?? '—'; }
function resourceSubtitle(row: ResourceRow): string | undefined {
  return row.displayName && row.displayName !== row.name && row.displayName.toLowerCase() !== 'state' ? row.displayName : undefined;
}
function associationText(row: ResourceRow): string {
  if (props.kind === 'registries') {
    const access = row.authenticated ? [row.credential?.user, row.credential?.team].filter(Boolean).join(' · ') || 'Signed in' : 'Anonymous';
    return [access, ...(row.usedBy ?? [])].join(' · ');
  }
  return [row.library, row.registry, row.runtime, row.target, row.kind].filter(Boolean).join(' · ') || '—';
}
function associationLabel(kind: ResourceKind): string { return kind === 'libraries' ? 'Registry' : kind === 'runtimes' ? 'Library / Pipeline' : kind === 'registries' ? 'Access / used by' : 'Connections / target'; }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" :caption="`${props.kind} registered on this host`" :noun="props.kind" :search-placeholder="`Search ${props.kind}`" :empty-table="`No ${props.kind} are registered on this host.`" :pin-row="isHostDefault">
    <template #resource-name="{ rowData }"><div class="primary-cell"><ResourceLink :kind="singular(props.kind)" :name="rowData.name" /><small v-if="resourceSubtitle(rowData)">{{ resourceSubtitle(rowData) }}</small></div></template>
    <template #resource-status="{ rowData }"><button v-if="rowData.checks?.length" class="status-detail-trigger" type="button" :aria-label="`View status details for ${rowData.name}`" @click="emit('details', rowData)"><StatusBadge :status="rowData.status" /><ChevronRight :size="14" aria-hidden="true" /></button><StatusBadge v-else :status="rowData.status" /></template>
    <template #resource-association="{ rowData }">
      <div class="resource-reference-list">
        <template v-if="props.kind === 'libraries'"><ResourceLink v-if="rowData.registry" kind="registry" :name="rowData.registry" /><span v-else>—</span></template>
        <template v-else-if="props.kind === 'runtimes'"><ResourceLink v-if="rowData.library" kind="library" :name="rowData.library" /><ResourceLink v-if="rowData.target" kind="pipeline" :name="rowData.target" :runtime="rowData.name" /><span v-if="!rowData.library && !rowData.target">—</span></template>
        <template v-else-if="props.kind === 'registries'"><span>{{ rowData.authenticated ? [rowData.credential?.user, rowData.credential?.team].filter(Boolean).join(' · ') || 'Signed in' : 'Anonymous' }}</span><ResourceLink v-for="library in rowData.usedBy ?? []" :key="library" kind="library" :name="library" /></template>
        <template v-else><ResourceLink v-if="rowData.library" kind="library" :name="rowData.library" /><ResourceLink v-if="rowData.runtime" kind="runtime" :name="rowData.runtime" /><ResourceLink v-if="rowData.registry" kind="registry" :name="rowData.registry" /><span v-if="rowData.target">{{ rowData.target }}</span><span v-if="!rowData.library && !rowData.runtime && !rowData.registry && !rowData.target">—</span></template>
      </div>
    </template>
    <template #resource-actions="{ rowData }"><slot name="actions" :row="rowData" /></template>
  </ConsoleDataTable>
</template>
