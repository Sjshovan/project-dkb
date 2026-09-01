<script setup lang="ts">
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from '@lucide/vue';
import {
  PaginationEllipsis,
  PaginationFirst,
  PaginationLast,
  PaginationList,
  PaginationListItem,
  PaginationNext,
  PaginationPrev,
  PaginationRoot,
} from 'reka-ui';

const props = withDefaults(defineProps<{
  page: number;
  totalPages: number;
  summary: string;
  paginationLabel: string;
  disabled?: boolean;
}>(), { disabled: false });

const emit = defineEmits<{ 'update:page': [page: number] }>();

function selectPage(page: number): void {
  const normalized = Math.min(Math.max(1, page), Math.max(1, props.totalPages));
  if (normalized !== props.page) emit('update:page', normalized);
}
</script>

<template>
  <PaginationRoot
    :page="props.page"
    :total="Math.max(1, props.totalPages)"
    :items-per-page="1"
    :sibling-count="0"
    show-edges
    :disabled="props.disabled"
    :aria-label="props.paginationLabel"
    class="console-pagination console-pagination--bottom"
    @update:page="selectPage"
  >
    <p class="console-pagination__summary" aria-live="polite">{{ props.summary }}</p>
    <PaginationList v-slot="{ items }" as="div" class="console-pagination__controls">
      <PaginationFirst class="console-pagination__button console-pagination__edge"><ChevronsLeft :size="16" aria-hidden="true" /></PaginationFirst>
      <PaginationPrev class="console-pagination__button"><ChevronLeft :size="16" aria-hidden="true" /></PaginationPrev>
      <template v-for="(item, index) in items" :key="item.type === 'page' ? item.value : `ellipsis-${index}`">
        <PaginationListItem v-if="item.type === 'page'" class="console-pagination__button console-pagination__page" :value="item.value">{{ item.value }}</PaginationListItem>
        <PaginationEllipsis v-else class="console-pagination__ellipsis" aria-hidden="true" />
      </template>
      <PaginationNext class="console-pagination__button"><ChevronRight :size="16" aria-hidden="true" /></PaginationNext>
      <PaginationLast class="console-pagination__button console-pagination__edge"><ChevronsRight :size="16" aria-hidden="true" /></PaginationLast>
    </PaginationList>
  </PaginationRoot>
</template>
