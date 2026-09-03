<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { LogIn, LogOut, Plus, RefreshCw, Square } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { cancelOperation, followOperation, getJson, startOperation } from '../api.js';
import AppButton from '../components/interface/AppButton.vue';
import ConfirmDialog from '../components/interface/ConfirmDialog.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import ResourceTable from '../components/interface/ResourceTable.vue';
import HealthDetailsDrawer from '../components/resource/HealthDetailsDrawer.vue';
import { summarizeHealth } from '../components/resource/healthStatus.js';
import OperationTimeline from '../components/resource/OperationTimeline.vue';
import ResourceCreateDrawer from '../components/resource/ResourceCreateDrawer.vue';
import type { PipelineListing, ResourceKind, ResourceListing, ResourceRow } from '../types.js';
import { hostResourceRoute } from '../resourceRoutes.js';

const props = defineProps<{ kind: ResourceKind }>();
const queryClient = useQueryClient();
const checkedListing = ref<ResourceListing>();
const checking = ref(false);
const details = ref<ResourceRow>();
const events = ref<DkbCommandEvent[]>([]);
const createOpen = ref(false);
const busy = ref(false);
const operationId = ref<string>();
const pending = ref<{ row: ResourceRow; action: 'forget' | 'stop' | 'logout' }>();
const metadata = computed(() => ({
  libraries: ['Libraries', 'Local knowledge roots registered on this host.'],
  runtimes: ['Runtimes', 'Known local and remote retrieval services.'],
  registries: ['Registries', 'Package endpoints, authentication, and Library usage.'],
  stacks: ['Stacks', 'Complete local DKB service bundles and their targets.'],
}[props.kind]));
const query = useQuery({ queryKey: computed(() => ['resources', props.kind]), queryFn: () => getJson<ResourceListing>(`/api/v1/resources/${props.kind}`) });
const libraryQuery = useQuery({ queryKey: ['resources', 'libraries', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/libraries') });
const runtimeQuery = useQuery({ queryKey: ['resources', 'runtimes', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/runtimes') });
const pipelineRuntime = computed(() => runtimeQuery.data.value?.selected ?? runtimeQuery.data.value?.runtimes?.[0]?.name ?? '');
const pipelineQuery = useQuery({
  queryKey: computed(() => ['runtime-pipelines', pipelineRuntime.value]),
  queryFn: () => getJson<PipelineListing>(`/api/v1/runtimes/${encodeURIComponent(pipelineRuntime.value)}/pipelines`),
  enabled: computed(() => props.kind === 'stacks' && Boolean(pipelineRuntime.value)),
  retry: false,
});
const rows = computed(() => checkedListing.value?.[props.kind] ?? query.data.value?.[props.kind] ?? []);
const libraries = computed(() => libraryQuery.data.value?.libraries ?? []);
const singular = computed<'library' | 'runtime' | 'registry' | 'stack'>(() => ({ libraries: 'library', runtimes: 'runtime', registries: 'registry', stacks: 'stack' } as const)[props.kind]);

watch(() => props.kind, () => {
  checkedListing.value = undefined;
  details.value = undefined;
});
const confirmation = computed(() => {
  if (!pending.value) return { title: '', description: '', label: 'Confirm', danger: false };
  const { row, action } = pending.value;
  if (action === 'stop') return { title: `Stop ${row.name}?`, description: 'Services stop, but volumes, secrets, Libraries, and the host entry are preserved.', label: 'Stop Stack', danger: false };
  if (action === 'logout') return { title: `Sign out of ${row.name}?`, description: 'The Registry token is revoked and the saved host credential is removed. Registered resources are unchanged.', label: 'Sign out', danger: true };
  return { title: `Forget ${row.name}?`, description: `This removes only the host inventory entry. It does not delete or stop the ${singular.value}.`, label: 'Forget', danger: true };
});

async function checkStatus(): Promise<void> {
  if (props.kind === 'libraries' || checking.value) return;
  checking.value = true;
  try {
    const listing = await getJson<ResourceListing>(`/api/v1/resources/${props.kind}?check=1`);
    checkedListing.value = listing;
    const checkedRows = listing[props.kind] ?? [];
    const summary = summarizeHealth(checkedRows);
    const resourceLabel = checkedRows.length === 1 ? singular.value : props.kind;
    if (summary.errors > 0) {
      const warningText = summary.warnings > 0 ? ` and ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}` : '';
      toast.error('Status check finished with errors', {
        description: `${summary.errors} error${summary.errors === 1 ? '' : 's'}${warningText} across ${checkedRows.length} ${resourceLabel}. Select a status badge for details.`,
        duration: 7_000,
      });
    } else if (summary.warnings > 0) {
      toast.warning('Status check finished with warnings', {
        description: `${summary.warnings} of ${checkedRows.length} ${resourceLabel} returned a warning. Select a status badge for details.`,
        duration: 7_000,
      });
    } else if (checkedRows.length > 0) {
      toast.success('Status check finished', { description: `All ${checkedRows.length} ${resourceLabel} responded successfully.`, duration: 5_000 });
    } else {
      toast.info('Status check finished', { description: `No ${props.kind} are registered on this host.`, duration: 5_000 });
    }
    await queryClient.invalidateQueries({ queryKey: ['overview'] });
  } catch (error) {
    toast.error('Status check failed', { description: error instanceof Error ? error.message : String(error), duration: 7_000 });
  } finally {
    checking.value = false;
  }
}

async function run(commandId: string, input: Record<string, unknown>, success: string, after?: () => void): Promise<void> {
  busy.value = true;
  events.value = [];
  try {
    const id = await startOperation(commandId, input);
    operationId.value = id;
    followOperation(id, (event) => {
      events.value.push(event);
      if (event.event !== 'completion') return;
      busy.value = false;
      if (event.status === 'succeeded') { toast.success(success); after?.(); }
      else toast.error('The operation did not complete. Review the recovery details below.');
      void refreshAll();
    });
  } catch (error) {
    busy.value = false;
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function cancelCurrent(): Promise<void> {
  if (!operationId.value) return;
  try { await cancelOperation(operationId.value); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
}

async function refreshAll(): Promise<void> {
  checkedListing.value = undefined;
  await Promise.all([
    query.refetch(),
    queryClient.invalidateQueries({ queryKey: ['overview'] }),
    queryClient.invalidateQueries({ queryKey: ['overview-context'] }),
    queryClient.invalidateQueries({ queryKey: ['resources'] }),
  ]);
}

function register(input: Record<string, unknown>): void {
  const commandId = props.kind === 'stacks' ? 'stack.up' : `${singular.value}.register`;
  void run(commandId, input, `${String(input.name || singular.value)} is ready on this host.`, () => { createOpen.value = false; });
}
function setDefault(row: ResourceRow): void { void run(`${singular.value}.use`, { name: row.name }, `${row.name} is now the default ${singular.value}.`); }
function authenticate(row: ResourceRow): void { void run('registry.login', { url: row.url, abilities: ['registry:read'] }, `Signed in to ${row.name}.`); }
function ask(row: ResourceRow, action: 'forget' | 'stop' | 'logout'): void { pending.value = { row, action }; }
function confirmPending(): void {
  if (!pending.value) return;
  const { row, action } = pending.value;
  const commandId = action === 'stop' ? 'stack.down' : action === 'logout' ? 'registry.logout' : `${singular.value}.unregister`;
  const input = action === 'stop' ? { name: row.name } : action === 'logout' ? { url: row.url, revoke: true } : { name: row.name };
  void run(commandId, input, action === 'stop' ? `${row.name} stopped; its data is preserved.` : action === 'logout' ? `Signed out of ${row.name}.` : `${row.name} was forgotten.`, () => { pending.value = undefined; });
}
function isDefault(row: ResourceRow): boolean { return Boolean(row.selected ?? row.default); }
</script>

<template>
  <div class="page">
    <PageHeader :title="metadata[0]" :description="metadata[1]">
      <template #actions>
        <AppButton variant="primary" :aria-label="kind === 'stacks' ? 'Start a local Stack' : `Register a ${singular}`" @click="createOpen = true"><Plus :size="16" />{{ kind === 'stacks' ? 'Start Stack' : 'Register' }}</AppButton>
        <AppButton v-if="kind !== 'libraries'" :loading="checking" :disabled="checking" @click="checkStatus"><RefreshCw v-if="!checking" :size="16" />{{ checking ? 'Checking status…' : 'Check status' }}</AppButton>
      </template>
    </PageHeader>
    <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancelCurrent" />
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 6" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>{{ metadata[0] }} unavailable</h2><p>{{ query.error.value?.message }}</p><AppButton @click="query.refetch()">Retry</AppButton></div></section>
    <EmptyState v-else-if="rows.length === 0" :title="`No ${props.kind} registered`" :message="kind === 'stacks' ? 'Start a local Stack to register its Registry and Runtime automatically.' : `Register the first ${singular} without leaving the Console.`" />
    <ResourceTable v-else :rows="rows" :kind="kind" @details="details = $event">
      <template #actions="{ row }"><div class="table-actions"><span v-if="isDefault(row)" class="default-label">Default</span><AppButton v-else size="sm" variant="quiet" @click="setDefault(row)">Set default</AppButton><a class="table-inspect-link" :href="hostResourceRoute(singular, row.name)">Inspect</a><AppButton v-if="kind === 'registries'" size="sm" variant="quiet" @click="row.authenticated ? ask(row, 'logout') : authenticate(row)"><component :is="row.authenticated ? LogOut : LogIn" :size="14" />{{ row.authenticated ? 'Sign out' : 'Sign in' }}</AppButton><AppButton v-if="kind === 'stacks'" size="sm" variant="quiet" @click="ask(row, 'stop')"><Square :size="14" />Stop</AppButton><AppButton v-else size="sm" variant="quiet" @click="ask(row, 'forget')">Forget</AppButton></div></template>
    </ResourceTable>
    <ResourceCreateDrawer :open="createOpen" :kind="kind" :libraries="libraries" :pipelines="pipelineQuery.data.value?.targets ?? []" :busy="busy" @update:open="createOpen = $event" @submit="register" />
    <HealthDetailsDrawer :open="Boolean(details)" :kind="kind" :row="details" @update:open="!$event && (details = undefined)" />
    <ConfirmDialog :open="Boolean(pending)" :title="confirmation.title" :description="confirmation.description" :confirm-label="confirmation.label" :danger="confirmation.danger" :busy="busy" @update:open="!$event && (pending = undefined)" @confirm="confirmPending" />
  </div>
</template>
