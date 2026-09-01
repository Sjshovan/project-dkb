<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { Clock3 } from '@lucide/vue';
import { getJson } from '../api.js';
import ConsolePagination from '../components/interface/ConsolePagination.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import type { ActivityPage } from '../types.js';

const page = ref(1);
const perPage = 25;
const query = useQuery({
  queryKey: computed(() => ['activity', page.value]),
  queryFn: () => getJson<ActivityPage>(`/api/v1/activity?page=${page.value}&perPage=${perPage}`),
  placeholderData: (previous) => previous,
  refetchInterval: 5_000,
});
const pagination = computed(() => query.data.value?.pagination);
const rangeStart = computed(() => pagination.value?.total ? ((pagination.value.page - 1) * pagination.value.perPage) + 1 : 0);
const rangeEnd = computed(() => pagination.value ? Math.min(pagination.value.page * pagination.value.perPage, pagination.value.total) : 0);
const paginationSummary = computed(() => pagination.value
  ? `Showing ${rangeStart.value}–${rangeEnd.value} of ${pagination.value.total} recent actions · ${pagination.value.retainedLimit} retained`
  : 'Activity pagination unavailable');
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

watch(pagination, (value) => {
  if (value && page.value > Math.max(1, value.totalPages)) page.value = Math.max(1, value.totalPages);
});
</script>

<template>
  <div class="page">
    <PageHeader title="Activity" description="Redacted command history from this Console. DKB resources remain the authoritative state." />
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 6" :key="n" /></div>
    <EmptyState v-else-if="!query.data.value?.activities.length" title="No Console activity yet" message="Operations started here will appear with their scope, status, and recovery summary." />
    <section v-else class="activity-list">
      <ConsolePagination v-if="pagination && pagination.totalPages > 1" :page="page" :total-pages="pagination.totalPages" :summary="paginationSummary" pagination-label="Activity pagination" placement="top" :disabled="query.isFetching.value" @update:page="page = $event" />
      <article v-for="item in query.data.value?.activities" :key="item.id"><Clock3 :size="18" /><div><strong>{{ item.commandId }}</strong><small>{{ item.resourceKey }} · {{ date(item.startedAt) }}</small><p v-if="item.summary">{{ item.summary }}</p></div><StatusBadge :status="item.status" /></article>
      <ConsolePagination v-if="pagination && pagination.totalPages > 1" :page="page" :total-pages="pagination.totalPages" :summary="paginationSummary" pagination-label="Activity pagination" :disabled="query.isFetching.value" @update:page="page = $event" />
    </section>
  </div>
</template>
