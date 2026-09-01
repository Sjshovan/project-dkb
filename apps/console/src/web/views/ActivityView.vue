<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ChevronLeft, ChevronRight, Clock3 } from '@lucide/vue';
import { getJson } from '../api.js';
import AppButton from '../components/interface/AppButton.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import type { ActivityPage } from '../types.js';

const page = ref(1);
const perPage = 25;
const query = useQuery({
  queryKey: computed(() => ['activity', page.value]),
  queryFn: () => getJson<ActivityPage>(`/api/v1/activity?page=${page.value}&perPage=${perPage}`),
  refetchInterval: 5_000,
});
const pagination = computed(() => query.data.value?.pagination);
const rangeStart = computed(() => pagination.value?.total ? ((pagination.value.page - 1) * pagination.value.perPage) + 1 : 0);
const rangeEnd = computed(() => pagination.value ? Math.min(pagination.value.page * pagination.value.perPage, pagination.value.total) : 0);
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
</script>

<template>
  <div class="page">
    <PageHeader title="Activity" description="Redacted command history from this Console. DKB resources remain the authoritative state." />
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 6" :key="n" /></div>
    <EmptyState v-else-if="!query.data.value?.activities.length" title="No Console activity yet" message="Operations started here will appear with their scope, status, and recovery summary." />
    <section v-else class="activity-list">
      <article v-for="item in query.data.value?.activities" :key="item.id"><Clock3 :size="18" /><div><strong>{{ item.commandId }}</strong><small>{{ item.resourceKey }} · {{ date(item.startedAt) }}</small><p v-if="item.summary">{{ item.summary }}</p></div><StatusBadge :status="item.status" /></article>
      <footer v-if="pagination" class="catalog-pagination activity-pagination">
        <AppButton size="sm" :disabled="pagination.page <= 1" aria-label="Show newer activity" @click="page -= 1"><ChevronLeft :size="15" />Newer</AppButton>
        <span>Showing {{ rangeStart }}–{{ rangeEnd }} of {{ pagination.total }} recent actions · {{ pagination.retainedLimit }} retained</span>
        <AppButton size="sm" :disabled="pagination.page >= pagination.totalPages" aria-label="Show older activity" @click="page += 1">Older<ChevronRight :size="15" /></AppButton>
      </footer>
    </section>
  </div>
</template>
