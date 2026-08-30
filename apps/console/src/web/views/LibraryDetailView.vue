<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { ArrowLeft, PackageOpen, Plus, RefreshCw, Workflow } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import { toast } from 'vue-sonner';
import { cancelOperation, followOperation, getJson, startOperation } from '../api.js';
import ActionDrawer from '../components/interface/ActionDrawer.vue';
import AppButton from '../components/interface/AppButton.vue';
import ConfirmDialog from '../components/interface/ConfirmDialog.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import FormField from '../components/interface/FormField.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import OperationTimeline from '../components/resource/OperationTimeline.vue';
import type { ResourceListing } from '../types.js';

const props = defineProps<{ name: string }>();
const queryClient = useQueryClient();
const query = useQuery({ queryKey: ['library-packages', props.name], queryFn: () => getJson<{ packages?: Array<Record<string, unknown>> }>(`/api/v1/libraries/${encodeURIComponent(props.name)}/packages`) });
const libraries = useQuery({ queryKey: ['resources', 'libraries', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/libraries') });
const root = computed(() => libraries.data.value?.libraries?.find((library) => library.name === props.name)?.path ?? props.name);
const drawer = ref<'install' | 'pipeline'>();
const pendingPackage = ref<string>();
const pendingUpgrade = ref<string>();
const busy = ref(false);
const events = ref<DkbCommandEvent[]>([]);
const operationId = ref<string>();
const install = reactive({ identity: '', version: '', force: false });
const pipeline = reactive({ target: 'default' });

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
      void query.refetch();
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
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

function openInstall(): void { Object.assign(install, { identity: '', version: '', force: false }); drawer.value = 'install'; }
function submitInstall(): void { void run('package.install', { library: props.name, ...install }, `${install.identity} installed.`, () => { drawer.value = undefined; }); }
function submitPipeline(): void { void run('pipeline.use', { library: root.value, target: pipeline.target }, `${pipeline.target} is active for ${props.name}.`, () => { drawer.value = undefined; }); }
function uninstall(): void {
  if (!pendingPackage.value) return;
  const identity = pendingPackage.value;
  void run('package.uninstall', { library: props.name, identity }, `${identity} uninstalled.`, () => { pendingPackage.value = undefined; });
}
function upgrade(): void {
  if (!pendingUpgrade.value) return;
  const identity = pendingUpgrade.value;
  void run('package.upgrade', { library: props.name, identity }, `${identity} upgraded.`, () => { pendingUpgrade.value = undefined; });
}
function packageIdentity(item: Record<string, unknown>): string { return String(item.id ?? item.identity ?? 'unknown'); }
</script>

<template>
  <div class="page">
    <RouterLink class="back-link" to="/libraries"><ArrowLeft :size="16" />Libraries</RouterLink>
    <PageHeader :title="props.name" description="Installed knowledge, Collections, active builds, and provenance for this Library.">
      <template #actions><AppButton variant="primary" @click="openInstall"><Plus :size="16" />Install knowledge</AppButton><AppButton @click="drawer = 'pipeline'"><Workflow :size="16" />Change pipeline</AppButton></template>
    </PageHeader>
    <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancelCurrent" />
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 4" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Library details unavailable</h2><p>{{ query.error.value?.message }}</p></div></section>
    <EmptyState v-else-if="!(query.data.value?.packages?.length)" title="No installed knowledge" message="Install a DKB or Collection from the configured Registry to populate this Library." />
    <section v-else class="package-list"><article v-for="item in query.data.value?.packages" :key="packageIdentity(item)"><PackageOpen :size="19" /><div><strong>{{ packageIdentity(item) }}</strong><small>{{ item.version ?? item.revision ?? 'editable' }}</small></div><div class="package-actions"><StatusBadge :status="String(item.status ?? 'installed')" /><AppButton size="sm" variant="quiet" @click="pendingUpgrade = packageIdentity(item)"><RefreshCw :size="14" />Upgrade</AppButton><AppButton size="sm" variant="quiet" @click="pendingPackage = packageIdentity(item)">Uninstall</AppButton></div></article></section>

    <ActionDrawer :open="drawer === 'install'" title="Install knowledge" description="Download an exact signed package build from this Library’s Registry and activate it atomically." submit-label="Install" :busy="busy" @update:open="!$event && (drawer = undefined)" @submit="submitInstall">
      <FormField label="Package" hint="Use the namespaced Registry identity." required><input v-model="install.identity" autocomplete="off" placeholder="@namespace/package" required /></FormField>
      <FormField label="Version" hint="Leave empty to install the Registry default version."><input v-model="install.version" autocomplete="off" placeholder="1.0.0" /></FormField>
      <label class="checkbox-field"><input v-model="install.force" type="checkbox" /><span><b>Repair or replace existing install</b><small>Use only when reinstalling or recovering an incomplete package.</small></span></label>
    </ActionDrawer>
    <ActionDrawer :open="drawer === 'pipeline'" title="Change retrieval pipeline" description="Prepare every required Evidence and Retrieval Build, verify the graph, then switch the Runtime atomically." submit-label="Prepare and switch" :busy="busy" @update:open="!$event && (drawer = undefined)" @submit="submitPipeline">
      <FormField label="Pipeline target" hint="Existing builds are reused; missing signed builds are downloaded or compiled from editable source." required><input v-model="pipeline.target" autocomplete="off" required /></FormField>
      <p class="form-notice">The current target remains active if any package cannot be prepared or verified.</p>
    </ActionDrawer>
    <ConfirmDialog :open="Boolean(pendingPackage)" :title="`Uninstall ${pendingPackage ?? ''}?`" description="The package becomes unretrievable immediately and its source and derived builds are removed from this Library. Other Libraries are unchanged." confirm-label="Uninstall" danger :busy="busy" @update:open="!$event && (pendingPackage = undefined)" @confirm="uninstall" />
    <ConfirmDialog :open="Boolean(pendingUpgrade)" :title="`Upgrade ${pendingUpgrade ?? ''}?`" description="DKB resolves the latest signed release, validates its exact build chain, and atomically replaces the installed version." confirm-label="Upgrade" :busy="busy" @update:open="!$event && (pendingUpgrade = undefined)" @confirm="upgrade" />
  </div>
</template>
