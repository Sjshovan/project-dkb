<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { RefreshCw } from '@lucide/vue';
import { useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { cancelOperation, followOperation, getJson, startOperation } from '../api.js';
import AppButton from '../components/interface/AppButton.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import FormField from '../components/interface/FormField.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import OperationTimeline from '../components/resource/OperationTimeline.vue';
import PipelineDataTable from '../components/resource/PipelineDataTable.vue';
import PipelineDetailsDrawer from '../components/resource/PipelineDetailsDrawer.vue';
import { isHostDefault, selectOptionLabel } from '../selectOptions.js';
import type { PipelineListing, PipelineTarget, ResourceListing } from '../types.js';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const selectedRuntime = ref(typeof route.query.runtime === 'string' ? route.query.runtime : '');
const busyTarget = ref<string>();
const details = ref<PipelineTarget>();
const events = ref<DkbCommandEvent[]>([]);
const operationId = ref<string>();
const runtimes = useQuery({ queryKey: ['resources', 'runtimes', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/runtimes') });
watch(() => runtimes.data.value, (value) => {
  if (!selectedRuntime.value) selectedRuntime.value = value?.selected ?? value?.runtimes?.[0]?.name ?? '';
}, { immediate: true });
const pipelines = useQuery({
  queryKey: computed(() => ['runtime-pipelines', selectedRuntime.value]),
  queryFn: () => getJson<PipelineListing>(`/api/v1/runtimes/${encodeURIComponent(selectedRuntime.value)}/pipelines`),
  enabled: computed(() => Boolean(selectedRuntime.value)),
  retry: false,
});
const visible = computed(() => pipelines.data.value?.targets ?? []);
const runtimeIsRemote = computed(() => runtimes.data.value?.runtimes?.find((runtime) => runtime.name === selectedRuntime.value)?.kind === 'remote');

function activate(target: PipelineTarget): void {
  if (target.active || target.health !== 'ready' || busyTarget.value) return;
  busyTarget.value = target.name;
  events.value = [];
  void startOperation('pipeline.use', { runtime: selectedRuntime.value, target: target.name })
    .then((id) => {
      operationId.value = id;
      followOperation(id, (event) => {
        events.value.push(event);
        if (event.event !== 'completion') return;
        busyTarget.value = undefined;
        if (event.status === 'succeeded') toast.success(`${target.name} is active on ${selectedRuntime.value}.`);
        else toast.error('Pipeline activation failed. The previous Runtime activation was preserved.');
        void pipelines.refetch();
        void queryClient.invalidateQueries({ queryKey: ['runtime-detail', selectedRuntime.value] });
      });
    })
    .catch((error) => { busyTarget.value = undefined; toast.error(error instanceof Error ? error.message : String(error)); });
}
async function cancelCurrent(): Promise<void> { if (operationId.value) await cancelOperation(operationId.value); }
watch([() => route.params.pipeline, () => pipelines.data.value], ([pipeline]) => {
  if (typeof pipeline !== 'string') return;
  details.value = pipelines.data.value?.targets.find((target) => target.name === pipeline);
}, { immediate: true });
function closeDetails(): void {
  details.value = undefined;
  if (route.name === 'pipeline') void router.replace({ name: 'pipelines', query: selectedRuntime.value ? { runtime: selectedRuntime.value } : undefined });
}
</script>

<template>
  <div class="page pipelines-page">
    <PageHeader title="Pipelines" description="Compare resolved provider chains, service health, compatibility, and build coverage for one Runtime at a time.">
      <template #actions><AppButton :loading="pipelines.isFetching.value" :disabled="!selectedRuntime || pipelines.isFetching.value" @click="pipelines.refetch()"><RefreshCw v-if="!pipelines.isFetching.value" :size="16" />Refresh</AppButton></template>
    </PageHeader>
    <div class="pipeline-toolbar"><FormField label="Runtime" hint="Pipeline availability is resolved in the selected Runtime’s own context."><select v-model="selectedRuntime"><option v-for="runtime in runtimes.data.value?.runtimes" :key="runtime.name" :value="runtime.name">{{ selectOptionLabel(runtime.name, [isHostDefault(runtime) ? 'Default' : undefined, runtime.library ?? 'No Library association']) }}</option></select></FormField></div>
    <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancelCurrent" />
    <div v-if="pipelines.isPending.value" class="skeleton-stack"><span v-for="n in 5" :key="n" /></div>
    <section v-else-if="pipelines.isError.value" class="recovery-panel"><div><h2>Pipeline catalog unavailable</h2><p>{{ pipelines.error.value?.message }}</p><AppButton @click="pipelines.refetch()">Retry</AppButton></div></section>
    <EmptyState v-else-if="visible.length === 0" title="No matching Pipelines" message="Choose a local Runtime with a state root or clear the Pipeline filter." />
    <PipelineDataTable v-else :rows="visible" :runtime="selectedRuntime" :runtime-is-remote="runtimeIsRemote" :busy-target="busyTarget" @details="details = $event" @activate="activate" />
    <PipelineDetailsDrawer :open="Boolean(details)" :runtime="selectedRuntime" :target="details" @update:open="!$event && closeDetails()" />
  </div>
</template>
