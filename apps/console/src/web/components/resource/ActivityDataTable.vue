<script setup lang="ts">
import DataTablesCore from 'datatables.net-dt';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import { consoleDateFilter, consoleListFilter, consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';
import StatusBadge from '../interface/StatusBadge.vue';
import type { ActivityRecord } from '../../types.js';

defineProps<{ rows: ActivityRecord[] }>();

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const statuses = ['running', 'succeeded', 'failed', 'cancelled'];

const columns: ConsoleDataTableColumn[] = [
  {
    data: 'commandId',
    name: 'commandId',
    title: 'Action',
    className: 'all',
    render: DataTablesCore.render.text(),
    columnControl: consoleTextFilter('Action'),
  },
  {
    data: 'resourceKey',
    name: 'resourceKey',
    title: 'Scope',
    render: DataTablesCore.render.text(),
    columnControl: consoleTextFilter('Scope'),
  },
  {
    data: 'startedAt',
    name: 'startedAt',
    title: 'Started',
    type: 'date',
    render: (value: string, type: string) => type === 'display' ? dateFormatter.format(new Date(value)) : value,
    columnControl: consoleDateFilter('Started'),
  },
  {
    data: null,
    name: 'status',
    title: 'Status',
    className: 'all',
    render: { _: 'status', display: '#activity-status' },
    columnControl: consoleListFilter(statuses, 'Status'),
  },
  {
    data: 'summary',
    name: 'summary',
    title: 'Result',
    defaultContent: '—',
    render: DataTablesCore.render.text(),
    columnControl: consoleTextFilter('Result'),
  },
];
</script>

<template>
  <ConsoleDataTable :rows="rows" :columns="columns" caption="Console activity history" noun="actions" search-placeholder="Search all activity" empty-table="No Console activity yet." zero-records="No activity matches the current filters." :order="[[2, 'desc']]" :page-length="25" scroll-y="min(52vh, 34rem)" table-class="activity-data-table">
    <template #activity-status="{ rowData }"><StatusBadge :status="String(rowData.status)" /></template>
  </ConsoleDataTable>
</template>
