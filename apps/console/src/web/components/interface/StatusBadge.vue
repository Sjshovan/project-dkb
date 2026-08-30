<script setup lang="ts">
import { computed } from 'vue';
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from '@lucide/vue';

const props = defineProps<{ status?: string }>();
const normalized = computed(() => (props.status ?? 'unknown').toLowerCase().replaceAll('_', ' '));
const tone = computed(() => ['ready', 'online', 'active', 'installed', 'ok', 'succeeded'].includes(normalized.value)
  ? 'positive'
  : ['failed', 'offline', 'missing', 'invalid', 'unavailable', 'cancelled'].includes(normalized.value)
    ? 'negative'
    : ['degraded', 'warning', 'incomplete', 'stale'].includes(normalized.value) ? 'warning' : 'neutral');
const icon = computed(() => tone.value === 'positive' ? CheckCircle2 : tone.value === 'negative' ? XCircle : tone.value === 'warning' ? AlertTriangle : CircleDashed);
</script>

<template>
  <span class="status-badge" :class="`status-badge--${tone}`">
    <component :is="icon" :size="14" aria-hidden="true" />
    {{ normalized }}
  </span>
</template>
