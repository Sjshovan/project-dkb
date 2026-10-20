<script setup lang="ts">
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { computed, nextTick, ref, watch } from 'vue';
import AppButton from '../interface/AppButton.vue';
import StatusBadge from '../interface/StatusBadge.vue';

const props = defineProps<{ events: DkbCommandEvent[]; operationId?: string }>();
const emit = defineEmits<{ cancel: [] }>();
const eventLog = ref<HTMLOListElement>();
const followsLatestEvent = ref(true);
const operationStatus = computed(() => {
  const last = props.events.at(-1);
  return last?.event === 'completion' ? last.status : 'running';
});
const timelineEvents = computed(() => {
  const latestProgress = new Set<string>();
  return [...props.events].reverse().filter((event) => {
    if (!['start', 'stage', 'progress', 'warning', 'failure', 'cancellation', 'completion'].includes(event.event)) return false;
    if (event.event !== 'progress') return true;
    if (latestProgress.has(event.phase)) return false;
    latestProgress.add(event.phase);
    return true;
  }).reverse();
});

function trackScrollPosition(): void {
  if (!eventLog.value) return;
  const distanceFromBottom = eventLog.value.scrollHeight - eventLog.value.scrollTop - eventLog.value.clientHeight;
  followsLatestEvent.value = distanceFromBottom < 40;
}

async function revealLatestEvent(): Promise<void> {
  await nextTick();
  if (!eventLog.value || !followsLatestEvent.value) return;
  eventLog.value.scrollTop = eventLog.value.scrollHeight;
}

watch(() => props.operationId, () => {
  followsLatestEvent.value = true;
  void revealLatestEvent();
});
watch(() => timelineEvents.value.at(-1)?.sequence, () => void revealLatestEvent(), { immediate: true });
</script>

<template>
  <section v-if="events.length" class="operation-panel">
    <header><h2>Current operation</h2><div class="operation-actions"><AppButton v-if="operationId && operationStatus === 'running'" size="sm" variant="quiet" @click="emit('cancel')">Cancel</AppButton><StatusBadge :status="operationStatus" /></div></header>
    <ol ref="eventLog" class="operation-event-log" role="log" aria-label="Operation events" aria-live="polite" aria-relevant="additions text" tabindex="0" @scroll.passive="trackScrollPosition">
      <li v-for="event in timelineEvents" :key="event.sequence">
        <span>{{ event.sequence + 1 }}</span>
        <p v-if="event.event === 'start'">{{ event.label }}</p>
        <p v-else-if="event.event === 'stage'">{{ event.label }} — {{ event.status }}</p>
        <div v-else-if="event.event === 'progress'" class="operation-progress"><p>{{ event.label }} <small>{{ event.value }} / {{ event.total }} {{ event.unit }}</small></p><progress :max="event.total || 1" :value="event.value" /></div>
        <p v-else-if="event.event === 'warning'">{{ event.message }}</p>
        <p v-else-if="event.event === 'failure'">{{ event.error.message }}</p>
        <p v-else-if="event.event === 'cancellation'">Cancellation requested — {{ event.reason }}</p>
        <p v-else-if="event.event === 'completion'">Operation {{ event.status }}</p>
      </li>
    </ol>
  </section>
</template>
