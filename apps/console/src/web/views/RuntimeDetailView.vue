<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { ArrowLeft, Library, RefreshCw, Server, Workflow } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import { toast } from 'vue-sonner';
import { cancelOperation, followOperation, getJson, startOperation } from '../api.js';
import ActionDrawer from '../components/interface/ActionDrawer.vue';
import AppButton from '../components/interface/AppButton.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import FormField from '../components/interface/FormField.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import OperationTimeline from '../components/resource/OperationTimeline.vue';
import type { PipelineListing, ResourceListing, ResourceRow, RuntimeDetail } from '../types.js';

const props = defineProps<{ name: string }>();
const queryClient = useQueryClient();
const query = useQuery({
  queryKey: computed(() => ['runtime-detail', props.name]),
  queryFn: () => getJson<RuntimeDetail>(`/api/v1/runtimes/${encodeURIComponent(props.name)}`),
  retry: false,
});
const pipelines = useQuery({
  queryKey: computed(() => ['runtime-pipelines', props.name]),
  queryFn: () => getJson<PipelineListing>(`/api/v1/runtimes/${encodeURIComponent(props.name)}/pipelines`),
  retry: false,
});
const libraries = useQuery({ queryKey: ['resources', 'libraries', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/libraries') });
const drawer = ref<'library' | 'pipeline'>();
const selectedLibrary = ref('');
const remoteHandle = ref('');
const selectedPipeline = ref('');
const busy = ref(false);
const events = ref<DkbCommandEvent[]>([]);
const operationId = ref<string>();
const runtime = computed(() => query.data.value?.runtime);
const inventory = computed(() => query.data.value?.inventory);
const isRemote = computed(() => inventory.value?.kind === 'remote');
const activeCoverage = computed(() => runtime.value?.activation
  ? `${Object.keys(runtime.value.activation.packages).length}/${runtime.value.packageCount}`
  : `0/${runtime.value?.packageCount ?? 0}`);

watch(() => inventory.value?.library, (value) => { if (value) selectedLibrary.value = value; }, { immediate: true });
watch(() => pipelines.data.value, (value) => {
  if (!selectedPipeline.value) selectedPipeline.value = value?.activeTarget ?? value?.targets[0]?.name ?? '';
}, { immediate: true });

async function run(commandId: 'runtime.library.use' | 'runtime.refresh' | 'pipeline.use', input: Record<string, unknown>, success: string): Promise<void> {
  busy.value = true;
  events.value = [];
  try {
    const id = await startOperation(commandId, input);
    operationId.value = id;
    followOperation(id, (event) => {
      events.value.push(event);
      if (event.event !== 'completion') return;
      busy.value = false;
      if (event.status === 'succeeded') {
        toast.success(success);
        drawer.value = undefined;
      } else toast.error('The Runtime kept its previous activation. Review the recovery details below.');
      void refresh();
    });
  } catch (error) {
    busy.value = false;
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function refresh(): Promise<void> {
  await Promise.all([
    query.refetch(),
    pipelines.refetch(),
    queryClient.invalidateQueries({ queryKey: ['resources'] }),
    queryClient.invalidateQueries({ queryKey: ['overview'] }),
  ]);
}

function changeLibrary(): void {
  const library = isRemote.value ? remoteHandle.value : selectedLibrary.value;
  if (!library) return;
  void run('runtime.library.use', {
    runtime: props.name,
    library,
    ...(isRemote.value ? { handle: remoteHandle.value } : {}),
  }, `${props.name} now serves ${library}.`);
}
function changePipeline(): void {
  if (!selectedPipeline.value) return;
  void run('pipeline.use', {
    runtime: props.name,
    target: selectedPipeline.value,
    ...(inventory.value?.url ? { runtimeUrl: inventory.value.url } : {}),
  }, `${selectedPipeline.value} is active on ${props.name}.`);
}
function refreshRuntime(): void { void run('runtime.refresh', { runtime: props.name }, `${props.name} activation is current.`); }
async function cancelCurrent(): Promise<void> { if (operationId.value) await cancelOperation(operationId.value); }
function shortDigest(value?: string): string { return value ? `${value.slice(0, 19)}…` : 'Not activated'; }
function libraryLabel(library: ResourceRow): string {
  return library.displayName && library.displayName !== library.name
    ? `${library.name} · ${library.displayName}`
    : library.name;
}
</script>

<template>
  <div class="page runtime-detail-page">
    <RouterLink class="back-link" to="/runtimes"><ArrowLeft :size="16" />Runtimes</RouterLink>
    <PageHeader :title="props.name" description="One independently configured retrieval endpoint with its own Library binding and Pipeline activation.">
      <template #actions>
        <AppButton variant="primary" @click="drawer = 'library'"><Library :size="16" />Change Library</AppButton>
        <AppButton :disabled="isRemote || pipelines.isError.value || !pipelines.data.value?.targets.length" @click="drawer = 'pipeline'"><Workflow :size="16" />Change Pipeline</AppButton>
        <AppButton :loading="busy" :disabled="busy" @click="refreshRuntime"><RefreshCw v-if="!busy" :size="16" />Refresh</AppButton>
      </template>
    </PageHeader>
    <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancelCurrent" />
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 5" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Runtime unavailable</h2><p>{{ query.error.value?.message }}</p><AppButton @click="query.refetch()">Retry</AppButton></div></section>
    <template v-else-if="runtime && inventory">
      <section v-if="runtime.stale" class="stale-runtime-banner"><div><strong>Refresh required</strong><p>The Library changed after this activation. This Runtime will not serve stale evidence.</p></div><AppButton size="sm" @click="refreshRuntime">Refresh Runtime</AppButton></section>
      <section class="runtime-facts">
        <article><Server :size="19" /><span><small>Status</small><strong>{{ runtime.stale ? 'Stale' : 'Ready' }}</strong><em>{{ inventory.url }}</em></span></article>
        <article><Library :size="19" /><span><small>Serving Library</small><strong>{{ inventory.library ?? runtime.library.id }}</strong><em>{{ runtime.packageCount }} installed DKB{{ runtime.packageCount === 1 ? '' : 's' }}</em></span></article>
        <article><Workflow :size="19" /><span><small>Active Pipeline</small><strong>{{ runtime.target }}</strong><em>{{ activeCoverage }} package builds active</em></span></article>
      </section>
      <section class="runtime-detail-ledger">
        <header><div><h2>Activation</h2><p>The exact immutable build graph currently selected only for this Runtime.</p></div><StatusBadge :status="runtime.stale ? 'stale' : 'ready'" /></header>
        <dl>
          <div><dt>Runtime ID</dt><dd>{{ runtime.runtimeId }}</dd></div>
          <div><dt>Library identity</dt><dd><code>{{ runtime.library.id }}</code></dd></div>
          <div><dt>Library generation</dt><dd>{{ runtime.library.generation }}</dd></div>
          <div><dt>Activation generation</dt><dd>{{ runtime.activation?.generation ?? 'Not activated' }}</dd></div>
          <div><dt>Compatibility</dt><dd><code>{{ shortDigest(runtime.activation?.compatibilityDigest) }}</code></dd></div>
          <div><dt>Runtime version</dt><dd>{{ runtime.version }}</dd></div>
        </dl>
      </section>
      <section v-if="pipelines.isError.value" class="recovery-panel"><div><h2>Pipeline catalog unavailable</h2><p>{{ pipelines.error.value?.message }}</p><p v-if="isRemote">Remote Runtimes report their active Pipeline, but local plugin discovery is available only when the host has that Runtime’s state root.</p></div></section>
    </template>

    <ActionDrawer :open="drawer === 'library'" title="Change Serving Library" description="DKB prepares the complete destination build graph, then changes only this Runtime’s binding." submit-label="Prepare and switch" :busy="busy" @update:open="!$event && (drawer = undefined)" @submit="changeLibrary">
      <FormField v-if="!isRemote" label="Library" hint="Any registered local Library can be served by multiple Runtimes." required><select v-model="selectedLibrary" required><option v-for="library in libraries.data.value?.libraries" :key="library.name" :value="library.name">{{ libraryLabel(library) }}</option></select></FormField>
      <FormField v-else label="Runtime Library handle" hint="Remote Runtimes resolve operator-defined handles locally; this Console never sends host filesystem paths." required><input v-model="remoteHandle" autocomplete="off" placeholder="shared-knowledge" required /></FormField>
      <p class="form-notice">The current Library and Pipeline remain active if preparation or validation fails.</p>
    </ActionDrawer>
    <ActionDrawer :open="drawer === 'pipeline'" title="Change Active Pipeline" description="Select one resolved Pipeline available to this Runtime. Existing immutable builds are reused." submit-label="Prepare and switch" :busy="busy" @update:open="!$event && (drawer = undefined)" @submit="changePipeline">
      <FormField label="Pipeline" hint="Origin, provider health, and package coverage are shown on the Pipelines page." required><select v-model="selectedPipeline" required><option v-for="target in pipelines.data.value?.targets" :key="target.name" :value="target.name">{{ target.name }} · {{ target.coverage.ready }}/{{ target.coverage.total }} ready · {{ target.health }}</option></select></FormField>
      <RouterLink class="form-link" :to="`/pipelines?runtime=${encodeURIComponent(props.name)}`">Compare Pipeline details</RouterLink>
    </ActionDrawer>
  </div>
</template>
