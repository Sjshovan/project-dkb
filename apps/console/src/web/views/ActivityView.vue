<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { getJson } from '../api.js';
import ActivityDataTable from '../components/resource/ActivityDataTable.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import type { ActivityPage } from '../types.js';

const query = useQuery({
  queryKey: ['activity-table'],
  queryFn: () => getJson<ActivityPage>('/api/v1/activity?page=1&perPage=500'),
  refetchInterval: 5_000,
});
</script>

<template>
  <div class="page">
    <PageHeader title="Activity" description="Redacted command history from this Console. DKB resources remain the authoritative state." />
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 8" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Activity unavailable</h2><p>{{ query.error.value?.message }}</p><button type="button" @click="query.refetch()">Retry</button></div></section>
    <section v-else class="activity-table-shell"><ActivityDataTable :rows="query.data.value?.activities ?? []" /></section>
  </div>
</template>
