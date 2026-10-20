<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { RouterLink } from 'vue-router';
import { toast } from 'vue-sonner';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { cancelOperation, followOperation, getJson, startOperation } from '../../api.js';
import type { RegistryPipelineCatalog, ResourceListing } from '../../types.js';
import ActionDrawer from '../interface/ActionDrawer.vue';
import FormField from '../interface/FormField.vue';
import OperationTimeline from './OperationTimeline.vue';
import RegistryPipelinePicker from './RegistryPipelinePicker.vue';

const props = defineProps<{ open: boolean; library: string; identity: string; version: string }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const queryClient = useQueryClient();
const registry = ref('');
const pipeline = ref('');
const busy = ref(false);
const error = ref('');
const events = ref<DkbCommandEvent[]>([]);
const operationId = ref<string>();
let unsubscribe: (() => void) | undefined;
const registryQuery = useQuery({ queryKey: ['registries', 'publish'], queryFn: () => getJson<ResourceListing>('/api/v1/registries'), enabled: computed(() => props.open) });
const registries = computed(() => [...(registryQuery.data.value?.registries ?? [])].sort((a, b) => Number(Boolean(b.default ?? b.selected)) - Number(Boolean(a.default ?? a.selected)) || a.name.localeCompare(b.name)));
const destination = computed(() => registries.value.find((item) => item.name === registry.value));
const catalog = useQuery({ queryKey: computed(() => ['registry-pipelines', registry.value]), queryFn: () => getJson<RegistryPipelineCatalog>(`/api/v1/registries/${encodeURIComponent(registry.value)}/pipelines`), enabled: computed(() => props.open && Boolean(destination.value)), retry: false });
const selected = computed(() => catalog.data.value?.pipelines.find((item) => item.name === pipeline.value));
const canPublish = computed(() => Boolean(destination.value?.url && selected.value?.available && !catalog.isFetching.value && !catalog.isError.value));
watch(registries, (items) => { if (!registry.value) registry.value = items.find((item) => item.default || item.selected)?.name ?? items[0]?.name ?? ''; }, { immediate: true });
watch(registry, () => { pipeline.value = ''; error.value = ''; });
watch(() => catalog.data.value, (value) => { if (!pipeline.value && value?.pipelines.some((item) => item.name === value.default && item.available)) pipeline.value = value.default; }, { immediate: true });
onBeforeUnmount(() => unsubscribe?.());

async function publish(): Promise<void> {
  if (busy.value || !canPublish.value || !destination.value?.url) return;
  busy.value = true; error.value = ''; events.value = []; unsubscribe?.();
  try {
    const id = await startOperation('package.publish', { library: props.library, identity: props.identity, url: destination.value.url, pipeline: pipeline.value });
    operationId.value = id;
    unsubscribe = followOperation(id, (event) => {
      events.value.push(event);
      if (event.event === 'failure') error.value = event.error.message;
      if (event.event !== 'completion') return;
      busy.value = false;
      void queryClient.invalidateQueries({ queryKey: ['activity'] });
      if (event.status === 'succeeded') {
        toast.success(`${props.identity}@${props.version} published.`);
        void queryClient.invalidateQueries({ queryKey: ['registry-entry'] });
        void queryClient.invalidateQueries({ queryKey: ['registry-catalog'] });
        emit('update:open', false);
      } else if (!error.value) error.value = event.status === 'cancelled' ? 'Publication was cancelled. Your selection is preserved; inspect the Registry version before retrying.' : 'Publication did not complete. Review the operation details before retrying.';
    });
  } catch (cause) { busy.value = false; error.value = cause instanceof Error ? cause.message : String(cause); }
}
async function cancel(): Promise<void> {
  if (!operationId.value) return;
  try { await cancelOperation(operationId.value); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
</script>

<template>
  <ActionDrawer :open="open" title="Publish knowledge" description="Upload editable source once. The Registry compiles and signs the selected Pipeline; local builds are never uploaded." submit-label="Publish source" :busy="busy" :submit-disabled="!canPublish" @update:open="emit('update:open', $event)" @submit="publish">
    <p><strong>{{ identity }}@{{ version }}</strong> from {{ library }}. An existing immutable version cannot be overwritten.</p>
    <p class="form-notice">New packages are private. An existing package retains its Registry visibility; publication does not change it.</p>
    <div v-if="registryQuery.isError.value" class="recovery-panel" role="alert"><div><p>{{ registryQuery.error.value?.message }}</p><button type="button" :disabled="busy" @click="registryQuery.refetch()">Retry Registries</button></div></div>
    <FormField label="Registry" hint="Credentials remain on this host. Publishing requires permission for this namespace." required><select v-model="registry" :disabled="busy || registryQuery.isPending.value"><option value="" disabled>Choose a Registry</option><option v-for="item in registries" :key="item.name" :value="item.name">{{ item.name }}{{ item.default || item.selected ? ' · Default' : '' }}</option></select></FormField>
    <p v-if="!registryQuery.isPending.value && !registries.length">No Registries are registered. <RouterLink to="/registries">Register a Registry</RouterLink> first.</p>
    <div v-if="catalog.isError.value" class="recovery-panel" role="alert"><div><p>{{ catalog.error.value?.message }}</p><button type="button" :disabled="busy" @click="catalog.refetch()">Retry Pipelines</button></div></div>
    <FormField label="Registry Pipeline" hint="The selected recipe is explicit. Changing a Runtime Pipeline does not change this publication." required><p v-if="catalog.isPending.value && registry" role="status">Loading trusted Registry Pipelines…</p><RegistryPipelinePicker v-else v-model="pipeline" input-id="publish-pipeline" :pipelines="catalog.data.value?.pipelines ?? []" :disabled="busy || !registry" /></FormField>
    <p v-if="catalog.data.value && !catalog.data.value.pipelines.some((item) => item.available)" role="status">No healthy Pipeline is available. Restore the Registry’s compiler services and retry.</p>
    <div v-if="error" class="recovery-panel" role="alert"><div><p>{{ error }}</p><RouterLink v-if="registry" :to="`/registries/${encodeURIComponent(registry)}`">Open Registry details and authentication</RouterLink></div></div>
    <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancel" />
  </ActionDrawer>
</template>
