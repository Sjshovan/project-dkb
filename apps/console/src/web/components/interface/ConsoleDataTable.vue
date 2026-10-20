<script setup lang="ts">
import { computed, useSlots } from 'vue';
import DataTable from 'datatables.net-vue3';
import DataTablesCore from 'datatables.net-dt';
import 'datatables.net-columncontrol-dt';
import 'datatables.net-responsive-dt';
import type { Config } from 'datatables.net';
import type {} from 'datatables.net-responsive';
import { consoleDataTableOptions, type ConsoleDataTableColumn } from './consoleDataTable.js';

DataTable.use(DataTablesCore);
DataTablesCore.ext.errMode = 'throw';

const props = withDefaults(defineProps<{
  rows: unknown[];
  columns: ConsoleDataTableColumn[];
  caption: string;
  noun: string;
  searchPlaceholder: string;
  emptyTable: string;
  zeroRecords?: string;
  order?: Config['order'];
  pageLength?: number;
  scrollY?: string;
  tableClass?: string;
  pinRow?: (row: any) => boolean;
}>(), { pageLength: 10, zeroRecords: undefined, order: undefined, scrollY: undefined, tableClass: undefined, pinRow: undefined });

const slots = useSlots();
const columns = computed<ConsoleDataTableColumn[]>(() => props.pinRow
  ? [
      ...props.columns,
      {
        data: (row: unknown) => props.pinRow?.(row) ? 1 : 0,
        name: 'pinned-row-priority',
        title: '',
        visible: false,
        searchable: false,
      },
    ]
  : props.columns);
const options = computed(() => consoleDataTableOptions({
  searchPlaceholder: props.searchPlaceholder,
  emptyTable: props.emptyTable,
  zeroRecords: props.zeroRecords,
  noun: props.noun,
  order: props.order,
  pageLength: props.pageLength,
  scrollY: props.scrollY,
  orderFixed: props.pinRow ? { pre: [[props.columns.length, 'desc']] } : undefined,
  rowCallback: props.pinRow
    ? (row, data) => row.classList.toggle('console-data-table-row--pinned', Boolean(props.pinRow?.(data)))
    : undefined,
}));
</script>

<template>
  <section class="console-data-table-shell">
    <DataTable :data="rows" :options="{ ...options, columns }" :class="['display', 'compact', 'console-data-table', tableClass]">
      <caption class="sr-only">{{ caption }}</caption>
      <thead><tr><th v-for="column in columns" :key="String(column.name ?? column.data ?? column.title)">{{ column.title }}</th></tr></thead>
      <template v-for="(_, name) in slots" #[name]="slotProps"><slot :name="name" v-bind="slotProps" /></template>
    </DataTable>
  </section>
</template>
