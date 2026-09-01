<script setup lang="ts">
import DataTable from 'datatables.net-vue3';
import DataTablesCore from 'datatables.net-dt';
import 'datatables.net-columncontrol-dt';
import 'datatables.net-responsive-dt';
import type { Config, ColumnsConfig } from 'datatables.net';
import type {} from 'datatables.net-responsive';
import StatusBadge from '../interface/StatusBadge.vue';
import type { ActivityRecord } from '../../types.js';

DataTable.use(DataTablesCore);

defineProps<{ rows: ActivityRecord[] }>();

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const statuses = ['running', 'succeeded', 'failed', 'cancelled'].map((status) => ({
  label: `${status[0]?.toUpperCase()}${status.slice(1)}`,
  value: status,
}));

type ActivityColumn = ColumnsConfig & { columnControl?: Config['columnControl'] };
const textFilter: NonNullable<Config['columnControl']> = [{ extend: 'searchDropdown', text: 'Filter [title]' }];
const dateFilter: NonNullable<Config['columnControl']> = [[{
  extend: 'searchDateTime',
  mask: 'YYYY-MM-DD',
  title: 'Filter [title]',
  titleAttr: 'Filter [title]',
}]];
const statusFilter: NonNullable<Config['columnControl']> = [[{
  extend: 'searchList',
  options: statuses,
  ajaxOnly: false,
  search: false,
  select: false,
  title: 'Filter [title]',
}]];
const columns: ActivityColumn[] = [
  {
    data: 'commandId',
    name: 'commandId',
    title: 'Action',
    className: 'all',
    render: DataTablesCore.render.text(),
    columnControl: textFilter,
  },
  {
    data: 'resourceKey',
    name: 'resourceKey',
    title: 'Scope',
    render: DataTablesCore.render.text(),
    columnControl: textFilter,
  },
  {
    data: 'startedAt',
    name: 'startedAt',
    title: 'Started',
    type: 'date',
    render: (value: string, type: string) => type === 'display' ? dateFormatter.format(new Date(value)) : value,
    columnControl: dateFilter,
  },
  {
    data: null,
    name: 'status',
    title: 'Status',
    className: 'all',
    render: { _: 'status', display: '#activity-status' },
    columnControl: statusFilter,
  },
  {
    data: 'summary',
    name: 'summary',
    title: 'Result',
    defaultContent: '—',
    render: DataTablesCore.render.text(),
    columnControl: textFilter,
  },
];

const options: Config = {
  autoWidth: false,
  deferRender: true,
  layout: {
    topStart: { pageLength: { menu: [10, 25, 50, 100], text: 'Rows per page _MENU_' } },
    topEnd: { search: { placeholder: 'Search all activity', text: 'Search activity: _INPUT_' } },
    bottomStart: 'info',
    bottomEnd: { paging: { type: 'full_numbers', buttons: 7, boundaryNumbers: true, firstLast: true, previousNext: true, numbers: true } },
  },
  language: {
    emptyTable: 'No Console activity yet.',
    info: 'Showing _START_–_END_ of _TOTAL_ actions',
    infoEmpty: 'Showing 0 actions',
    infoFiltered: 'filtered from _MAX_ retained actions',
    zeroRecords: 'No activity matches the current filters.',
  },
  lengthMenu: [10, 25, 50, 100],
  order: [[2, 'desc']],
  ordering: {
    indicators: true,
    handler: true,
  },
  pageLength: 25,
  paging: true,
  responsive: true,
  scrollCollapse: true,
  scrollY: 'min(52vh, 34rem)',
};
</script>

<template>
  <DataTable :data="rows" :options="{ ...options, columns }" class="display compact activity-data-table">
    <caption class="sr-only">Console activity history</caption>
    <thead><tr><th>Action</th><th>Scope</th><th>Started</th><th>Status</th><th>Result</th></tr></thead>
    <template #activity-status="{ rowData }"><StatusBadge :status="String(rowData.status)" /></template>
  </DataTable>
</template>
