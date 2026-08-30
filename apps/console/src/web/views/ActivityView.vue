<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { Clock3 } from '@lucide/vue';
import { getJson } from '../api.js';
import EmptyState from '../components/interface/EmptyState.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import type { ActivityRecord } from '../types.js';

const query = useQuery({ queryKey: ['activity'], queryFn: () => getJson<{ activities: ActivityRecord[] }>('/api/v1/activity'), refetchInterval: 5_000 });
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
</script>

<template>
  <div class="page">
    <PageHeader title="Activity" description="Redacted command history from this Console. DKB resources remain the authoritative state." />
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 6" :key="n" /></div>
    <EmptyState v-else-if="!query.data.value?.activities.length" title="No Console activity yet" message="Operations started here will appear with their scope, status, and recovery summary." />
    <section v-else class="activity-list"><article v-for="item in query.data.value?.activities" :key="item.id"><Clock3 :size="18" /><div><strong>{{ item.commandId }}</strong><small>{{ item.resourceKey }} · {{ date(item.startedAt) }}</small><p v-if="item.summary">{{ item.summary }}</p></div><StatusBadge :status="item.status" /></article></section>
  </div>
</template>
