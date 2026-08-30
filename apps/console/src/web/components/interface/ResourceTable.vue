<script setup lang="ts">
import { toRef } from 'vue';
import { FlexRender, useTable } from '@tanstack/vue-table';
import type { ResourceRow } from '../../types.js';
import { resourceTableFeatures, type ResourceColumn, type ResourceTableFeatures } from './resourceTableModel.js';

const props = defineProps<{ rows: ResourceRow[]; columns: ResourceColumn[] }>();
const table = useTable<ResourceTableFeatures, ResourceRow>({ features: resourceTableFeatures, data: toRef(props, 'rows'), columns: toRef(props, 'columns') });
</script>

<template>
  <div class="resource-table-wrap">
    <table class="resource-table">
      <thead><tr v-for="group in table.getHeaderGroups()" :key="group.id"><th v-for="header in group.headers" :key="header.id"><FlexRender v-if="!header.isPlaceholder" :header="header" /></th></tr></thead>
      <tbody><tr v-for="row in table.getRowModel().rows" :key="row.id"><td v-for="cell in row.getAllCells()" :key="cell.id"><FlexRender :cell="cell" /></td></tr></tbody>
    </table>
  </div>
</template>
