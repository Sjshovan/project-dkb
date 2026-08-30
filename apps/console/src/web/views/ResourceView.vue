<script setup lang="ts">
import { computed, h, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { CellContext } from '@tanstack/vue-table';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { LogIn, LogOut, Plus, RefreshCw, Square } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { cancelOperation, followOperation, getJson, startOperation } from '../api.js';
import AppButton from '../components/interface/AppButton.vue';
import ConfirmDialog from '../components/interface/ConfirmDialog.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import ResourceTable from '../components/interface/ResourceTable.vue';
import type { ResourceColumn, ResourceTableFeatures } from '../components/interface/resourceTableModel.js';
import StatusBadge from '../components/interface/StatusBadge.vue';
import OperationTimeline from '../components/resource/OperationTimeline.vue';
import ResourceActionsMenu from '../components/resource/ResourceActionsMenu.vue';
import ResourceCreateDrawer from '../components/resource/ResourceCreateDrawer.vue';
import type { ResourceKind, ResourceListing, ResourceRow } from '../types.js';

const props = defineProps<{ kind: ResourceKind }>();
const queryClient = useQueryClient();
const checked = ref(false);
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
const query = useQuery({ queryKey: computed(() => ['resources', props.kind, checked.value]), queryFn: () => getJson<ResourceListing>(`/api/v1/resources/${props.kind}${checked.value ? '?check=1' : ''}`) });
const libraryQuery = useQuery({ queryKey: ['resources', 'libraries', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/libraries') });
const rows = computed(() => query.data.value?.[props.kind] ?? []);
const libraries = computed(() => libraryQuery.data.value?.libraries ?? []);
const singular = computed(() => ({ libraries: 'library', runtimes: 'runtime', registries: 'registry', stacks: 'stack' }[props.kind]));
type ResourceCell = CellContext<ResourceTableFeatures, ResourceRow, unknown>;
const columns = computed<ResourceColumn[]>(() => [
  { accessorKey: 'name', header: 'Name', cell: ({ row }: ResourceCell) => h('div', { class: 'primary-cell' }, [h('strong', row.original.displayName ?? row.original.name), h('small', row.original.displayName ? row.original.name : resourceLocation(row.original))]) },
  { accessorKey: 'status', header: 'Status', cell: ({ row }: ResourceCell) => h(StatusBadge, { status: row.original.status }) },
  { id: 'association', header: associationLabel(props.kind), cell: ({ row }: ResourceCell) => association(row.original) },
  { id: 'location', header: 'Location', cell: ({ row }: ResourceCell) => h('span', { class: 'location-cell' }, resourceLocation(row.original)) },
  { id: 'actions', header: '', cell: ({ row }: ResourceCell) => h('div', { class: 'table-actions' }, actionNodes(row.original)) },
]);
const confirmation = computed(() => {
  if (!pending.value) return { title: '', description: '', label: 'Confirm', danger: false };
  const { row, action } = pending.value;
  if (action === 'stop') return { title: `Stop ${row.name}?`, description: 'Services stop, but volumes, secrets, Libraries, and the host entry are preserved.', label: 'Stop Stack', danger: false };
  if (action === 'logout') return { title: `Sign out of ${row.name}?`, description: 'The Registry token is revoked and the saved host credential is removed. Registered resources are unchanged.', label: 'Sign out', danger: true };
  return { title: `Forget ${row.name}?`, description: `This removes only the host inventory entry. It does not delete or stop the ${singular.value}.`, label: 'Forget', danger: true };
});

function actionNodes(row: ResourceRow) {
  return [
    ...(isDefault(row) ? [h('span', { class: 'default-label' }, 'Default')] : []),
    h(ResourceActionsMenu, {
      kind: props.kind, name: row.name, isDefault: isDefault(row), authenticated: row.authenticated,
      onDefault: () => void setDefault(row),
      onAuthenticate: () => row.authenticated ? ask(row, 'logout') : void authenticate(row),
      onStop: () => ask(row, 'stop'),
      onForget: () => ask(row, 'forget'),
    }),
  ];
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
function resourceLocation(row: ResourceRow): string { return row.path ?? row.url ?? row.stateRoot ?? '—'; }
function association(row: ResourceRow): string {
  if (props.kind === 'registries' && row.authenticated) return [row.credential?.user, row.credential?.team].filter(Boolean).join(' · ') || 'Signed in';
  return row.library ?? row.registry ?? row.runtime ?? row.target ?? row.kind ?? (row.usedBy?.join(', ') || '—');
}
function associationLabel(kind: ResourceKind): string { return kind === 'libraries' ? 'Registry' : kind === 'runtimes' ? 'Library' : kind === 'registries' ? 'Access / used by' : 'Target'; }
</script>

<template>
  <div class="page">
    <PageHeader :title="metadata[0]" :description="metadata[1]">
      <template #actions>
        <AppButton variant="primary" :aria-label="kind === 'stacks' ? 'Start a local Stack' : `Register a ${singular}`" @click="createOpen = true"><Plus :size="16" />{{ kind === 'stacks' ? 'Start Stack' : 'Register' }}</AppButton>
        <AppButton :variant="checked ? 'primary' : 'secondary'" @click="checked = !checked"><RefreshCw :size="16" />{{ checked ? 'Checks on' : 'Check health' }}</AppButton>
      </template>
    </PageHeader>
    <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancelCurrent" />
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 6" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>{{ metadata[0] }} unavailable</h2><p>{{ query.error.value?.message }}</p><AppButton @click="query.refetch()">Retry</AppButton></div></section>
    <EmptyState v-else-if="rows.length === 0" :title="`No ${props.kind} registered`" :message="kind === 'stacks' ? 'Start a local Stack to register its Registry and Runtime automatically.' : `Register the first ${singular} without leaving the Console.`" />
    <template v-else>
      <ResourceTable :rows="rows" :columns="columns" />
      <div class="mobile-resource-list">
        <article v-for="row in rows" :key="row.name"><header><div><strong>{{ row.displayName ?? row.name }}</strong><small v-if="row.displayName">{{ row.name }}</small></div><StatusBadge :status="row.status" /></header><dl><div><dt>{{ associationLabel(props.kind) }}</dt><dd>{{ association(row) }}</dd></div><div><dt>Location</dt><dd>{{ resourceLocation(row) }}</dd></div></dl><footer><span v-if="isDefault(row)" class="default-label">Default</span><AppButton v-else size="sm" variant="quiet" @click="setDefault(row)">Set default</AppButton><AppButton v-if="kind === 'registries'" size="sm" variant="quiet" @click="row.authenticated ? ask(row, 'logout') : authenticate(row)"><component :is="row.authenticated ? LogOut : LogIn" :size="15" />{{ row.authenticated ? 'Sign out' : 'Sign in' }}</AppButton><AppButton v-if="kind === 'stacks'" size="sm" variant="quiet" @click="ask(row, 'stop')"><Square :size="14" />Stop</AppButton><AppButton v-else size="sm" variant="quiet" @click="ask(row, 'forget')">Forget</AppButton><RouterLink v-if="props.kind === 'libraries'" :to="`/libraries/${row.name}`">Inspect</RouterLink></footer></article>
      </div>
    </template>
    <ResourceCreateDrawer :open="createOpen" :kind="kind" :libraries="libraries" :busy="busy" @update:open="createOpen = $event" @submit="register" />
    <ConfirmDialog :open="Boolean(pending)" :title="confirmation.title" :description="confirmation.description" :confirm-label="confirmation.label" :danger="confirmation.danger" :busy="busy" @update:open="!$event && (pending = undefined)" @confirm="confirmPending" />
  </div>
</template>
