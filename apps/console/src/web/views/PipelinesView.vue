<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { AlertTriangle, CheckCircle2, ChevronRight, RefreshCw, Search, Workflow } from '@lucide/vue';
import { useRoute } from 'vue-router';
import { toast } from 'vue-sonner';
import { cancelOperation, followOperation, getJson, startOperation } from '../api.js';
import AppButton from '../components/interface/AppButton.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import FormField from '../components/interface/FormField.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import OperationTimeline from '../components/resource/OperationTimeline.vue';
import PipelineDetailsDrawer from '../components/resource/PipelineDetailsDrawer.vue';
import { isHostDefault, selectOptionLabel } from '../selectOptions.js';
import type { PipelineListing, PipelineTarget, ResourceListing } from '../types.js';

const route = useRoute();
const queryClient = useQueryClient();
const selectedRuntime = ref(typeof route.query.runtime === 'string' ? route.query.runtime : '');
const filter = ref('');
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
const visible = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  return (pipelines.data.value?.targets ?? []).filter((target) => !needle
    || target.name.toLowerCase().includes(needle)
    || target.providers.some((provider) => provider.toLowerCase().includes(needle)));
});
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
function short(value: string): string { return `${value.slice(0, 19)}…`; }
function failedHealth(target: PipelineTarget): PipelineTarget['healthDetails'] { return target.healthDetails.filter((item) => !item.ok); }
function unavailableSummary(target: PipelineTarget): string {
  const count = failedHealth(target).length;
  return `${count} required ${count === 1 ? 'provider is' : 'providers are'} unavailable`;
}
</script>

<template>
  <div class="page pipelines-page">
    <PageHeader title="Pipelines" description="Compare resolved provider chains, service health, compatibility, and build coverage for one Runtime at a time.">
      <template #actions><AppButton :loading="pipelines.isFetching.value" :disabled="!selectedRuntime || pipelines.isFetching.value" @click="pipelines.refetch()"><RefreshCw v-if="!pipelines.isFetching.value" :size="16" />Refresh</AppButton></template>
    </PageHeader>
    <div class="pipeline-toolbar">
      <FormField label="Runtime" hint="Pipeline availability is resolved in the selected Runtime’s own context."><select v-model="selectedRuntime"><option v-for="runtime in runtimes.data.value?.runtimes" :key="runtime.name" :value="runtime.name">{{ selectOptionLabel(runtime.name, [isHostDefault(runtime) ? 'Default' : undefined, runtime.library ?? 'No Library association']) }}</option></select></FormField>
      <FormField label="Filter Pipelines" hint="Filter the resolved list by Pipeline name or provider."><div class="pipeline-filter-control"><Search :size="17" aria-hidden="true" /><input v-model="filter" type="search" aria-label="Filter Pipelines" placeholder="Name or provider" /></div></FormField>
    </div>
    <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancelCurrent" />
    <div v-if="pipelines.isPending.value" class="skeleton-stack"><span v-for="n in 5" :key="n" /></div>
    <section v-else-if="pipelines.isError.value" class="recovery-panel"><div><h2>Pipeline catalog unavailable</h2><p>{{ pipelines.error.value?.message }}</p><AppButton @click="pipelines.refetch()">Retry</AppButton></div></section>
    <EmptyState v-else-if="visible.length === 0" title="No matching Pipelines" message="Choose a local Runtime with a state root or clear the Pipeline filter." />
    <section v-else class="pipeline-list">
      <article v-for="target in visible" :key="target.name" :class="{ 'pipeline-list--active': target.active }">
        <header>
          <div class="pipeline-title"><Workflow :size="18" /><span><strong>{{ target.name }}</strong><small>{{ target.origin }} definition</small></span></div>
          <div class="pipeline-card-state">
            <span v-if="target.active" class="pipeline-active-badge"><CheckCircle2 :size="14" />Active</span>
            <button class="pipeline-status-trigger" type="button" :aria-label="`View availability details for ${target.name}`" @click="details = target"><StatusBadge :status="target.health" /><ChevronRight :size="15" aria-hidden="true" /></button>
          </div>
        </header>
        <dl>
          <div><dt>Provider chain</dt><dd>{{ target.providers.join(' → ') }}</dd></div>
          <div><dt>Embedding</dt><dd>{{ target.dimensions }} dimensions · {{ target.metric }}</dd></div>
          <div><dt>Package coverage</dt><dd>{{ target.coverage.ready }}/{{ target.coverage.total }} ready</dd></div>
          <div><dt>Required services</dt><dd>{{ target.requiredServices.join(', ') || 'None' }}</dd></div>
          <div><dt>Compatibility</dt><dd><code>{{ short(target.compatibilityDigest) }}</code></dd></div>
        </dl>
        <footer>
          <span v-if="target.active" class="pipeline-active-summary"><CheckCircle2 :size="15" />Serving this Runtime</span>
          <span v-else-if="runtimeIsRemote" class="remote-admin-note">Activation requires the Runtime operator</span>
          <button v-else-if="target.health !== 'ready'" class="pipeline-unavailable-link" type="button" @click="details = target"><AlertTriangle :size="15" /><span>{{ unavailableSummary(target) }}</span><ChevronRight :size="15" /></button>
          <AppButton v-if="!target.active" size="sm" variant="secondary" :disabled="target.health !== 'ready' || Boolean(busyTarget) || runtimeIsRemote" :loading="busyTarget === target.name" @click="activate(target)">Prepare and activate</AppButton>
        </footer>
      </article>
    </section>
    <PipelineDetailsDrawer :open="Boolean(details)" :runtime="selectedRuntime" :target="details" @update:open="!$event && (details = undefined)" />
  </div>
</template>
