<script setup lang="ts">
import { computed } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import type { DkbRegistryCatalogEntry } from '@sjshovan/dkb-protocol/registryCatalog.js';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import ResourceLink from '../interface/ResourceLink.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { consoleDateFilter, consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';

const props = defineProps<{ rows: DkbRegistryCatalogEntry[]; registry: string }>();
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const columns = computed<ConsoleDataTableColumn[]>(() => [
  { data: null, name: 'id', title: 'Knowledge', className: 'all', render: { _: 'id', display: '#catalog-entry' }, columnControl: consoleTextFilter('Knowledge') },
  { data: null, name: 'type', title: 'Type', render: { _: 'type', display: '#catalog-type' }, columnControl: consoleListFilter(['dkb', 'collection'], 'Type') },
  { data: releaseLabel, name: 'release', title: 'Latest release', render: DataTablesCore.render.text(), columnControl: consoleTextFilter('Latest release') },
  { data: null, name: 'visibility', title: 'Visibility', render: { _: 'visibility', display: '#catalog-visibility' }, columnControl: consoleListFilter(props.rows.map((row) => row.visibility), 'Visibility') },
  { data: 'publishedAt', name: 'publishedAt', title: 'Published', type: 'date', render: (value: string | null, type: string) => type === 'display' ? formatDate(value) : value ?? '', columnControl: consoleDateFilter('Published') },
]);
function releaseLabel(entry: DkbRegistryCatalogEntry): string { return entry.type === 'dkb' ? entry.latestVersion ?? 'No release' : entry.latestRevision ? `Revision ${entry.latestRevision}` : 'No revision'; }
function formatDate(value?: string | null): string { return value ? dateFormatter.format(new Date(value)) : 'Not published'; }
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Signed knowledge available from this Registry" noun="entries" search-placeholder="Search identity, namespace, or description" empty-table="This Registry has no visible DKBs or Collections.">
    <template #catalog-entry="{ rowData }"><div class="primary-cell"><ResourceLink :kind="rowData.type === 'dkb' ? 'registry-dkb' : 'registry-collection'" :name="rowData.id" :registry="registry" /><small>{{ rowData.description || 'No description provided.' }}</small></div></template>
    <template #catalog-type="{ rowData }"><StatusBadge :status="rowData.type" /></template>
    <template #catalog-visibility="{ rowData }"><StatusBadge :status="rowData.visibility" /></template>
  </ConsoleDataTable>
</template>
