<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import type { DkbRegistryCatalogEntry } from '@sjshovan/dkb-protocol/registryCatalog.js';
import { ArrowLeft, PackageOpen, Plus, RefreshCw, Server } from '@lucide/vue';
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
import RegistryPackagePicker from '../components/resource/RegistryPackagePicker.vue';
import type { ResourceListing, ResourceRow, RuntimeStatus } from '../types.js';

const props = defineProps<{ name: string }>();
const queryClient = useQueryClient();
const query = useQuery({ queryKey: ['library-packages', props.name], queryFn: () => getJson<{ packages?: Array<Record<string, unknown>> }>(`/api/v1/libraries/${encodeURIComponent(props.name)}/packages`) });
const libraries = useQuery({ queryKey: ['resources', 'libraries', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/libraries') });
const registries = useQuery({ queryKey: ['resources', 'registries', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/registries') });
const servingRuntimes = useQuery({
  queryKey: computed(() => ['library-runtimes', props.name]),
  queryFn: () => getJson<{ runtimes: Array<ResourceRow & { runtime?: RuntimeStatus }> }>(`/api/v1/libraries/${encodeURIComponent(props.name)}/runtimes`),
  retry: false,
});
const defaultRegistry = computed(() => {
  const registryName = libraries.data.value?.libraries?.find((library) => library.name === props.name)?.registry;
  return registries.data.value?.registries?.find((registry) => registry.name === registryName);
});
const drawer = ref<'install'>();
const pendingPackage = ref<string>();
const pendingUpgrade = ref<string>();
const busy = ref(false);
const events = ref<DkbCommandEvent[]>([]);
const operationId = ref<string>();
const selectedInstallEntry = ref<DkbRegistryCatalogEntry>();
const install = reactive({ identity: '', version: '', revision: undefined as number | undefined, registry: '', force: false });

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

function openInstall(): void { Object.assign(install, { identity: '', version: '', revision: undefined, registry: defaultRegistry.value?.name ?? registries.data.value?.registries?.[0]?.name ?? '', force: false }); selectedInstallEntry.value = undefined; drawer.value = 'install'; }
function resetInstallPackage(): void { Object.assign(install, { identity: '', version: '', revision: undefined }); selectedInstallEntry.value = undefined; }
function selectInstallPackage(entry: DkbRegistryCatalogEntry | undefined): void {
  selectedInstallEntry.value = entry;
  install.version = entry?.type === 'dkb' ? entry.latestVersion ?? '' : '';
  install.revision = entry?.type === 'collection' ? entry.latestRevision ?? undefined : undefined;
}
function submitInstall(): void {
  const registry = registries.data.value?.registries?.find((item) => item.name === install.registry);
  if (!registry?.url) { toast.error('Choose a registered Registry for this install.'); return; }
  if (!selectedInstallEntry.value || selectedInstallEntry.value.id !== install.identity) { toast.error('Choose knowledge from the Registry catalog before installing.'); return; }
  void run('package.install', {
    library: props.name,
    identity: install.identity,
    ...(selectedInstallEntry.value.type === 'dkb' ? { version: install.version } : { revision: install.revision }),
    force: install.force,
    registryUrl: registry.url,
  }, `${install.identity} installed.`, () => { drawer.value = undefined; });
}
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
function packageRoute(item: Record<string, unknown>): string | undefined {
  const match = /^@([^/]+)\/(.+)$/u.exec(packageIdentity(item));
  return match ? `/libraries/${encodeURIComponent(props.name)}/entries/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}` : undefined;
}
</script>

<template>
  <div class="page">
    <RouterLink class="back-link" to="/libraries"><ArrowLeft :size="16" />Libraries</RouterLink>
    <PageHeader :title="props.name" description="Installed knowledge, Collections, immutable builds, and provenance shared by any number of Runtimes.">
      <template #actions><AppButton variant="primary" @click="openInstall"><Plus :size="16" />Install knowledge</AppButton></template>
    </PageHeader>
    <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancelCurrent" />
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 4" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Library details unavailable</h2><p>{{ query.error.value?.message }}</p></div></section>
    <EmptyState v-else-if="!(query.data.value?.packages?.length)" title="No installed knowledge" message="Install a DKB or Collection from any registered Registry to populate this Library." />
    <section v-else class="package-list"><article v-for="item in query.data.value?.packages" :key="packageIdentity(item)"><PackageOpen :size="19" /><div><RouterLink v-if="packageRoute(item)" class="package-detail-link" :to="packageRoute(item)!"><strong>{{ packageIdentity(item) }}</strong><small>{{ item.version ?? item.revision ?? 'editable' }}</small></RouterLink><template v-else><strong>{{ packageIdentity(item) }}</strong><small>{{ item.version ?? item.revision ?? 'editable' }}</small></template></div><div class="package-actions"><StatusBadge :status="String(item.status ?? 'installed')" /><AppButton size="sm" variant="quiet" @click="pendingUpgrade = packageIdentity(item)"><RefreshCw :size="14" />Upgrade</AppButton><AppButton size="sm" variant="quiet" @click="pendingPackage = packageIdentity(item)">Uninstall</AppButton></div></article></section>

    <section class="serving-runtimes-section">
      <header class="section-heading"><div><h2>Serving Runtimes</h2><p>Each Runtime independently selects a Pipeline while sharing this Library's immutable knowledge builds.</p></div><span class="count">{{ servingRuntimes.data.value?.runtimes.length ?? 0 }}</span></header>
      <div v-if="servingRuntimes.isPending.value" class="skeleton-stack"><span v-for="n in 2" :key="n" /></div>
      <EmptyState v-else-if="!servingRuntimes.data.value?.runtimes.length" title="No Runtime serves this Library" message="Bind an existing Runtime from its detail page. The Library remains fully manageable offline." />
      <div v-else class="serving-runtime-list"><RouterLink v-for="runtime in servingRuntimes.data.value?.runtimes" :key="runtime.name" :to="`/runtimes/${encodeURIComponent(runtime.name)}`"><Server :size="18" /><span><strong>{{ runtime.name }}</strong><small>{{ runtime.runtime?.target ?? runtime.target ?? 'Pipeline unavailable' }}</small></span><StatusBadge :status="runtime.runtime?.stale ? 'stale' : runtime.runtime ? 'ready' : runtime.status ?? 'known'" /></RouterLink></div>
    </section>

    <ActionDrawer :open="drawer === 'install'" title="Install knowledge" description="Choose a Registry, find available knowledge, and confirm the exact release. The signed Registry origin is retained with the install." submit-label="Install selected knowledge" :submit-disabled="!selectedInstallEntry || !install.identity || (selectedInstallEntry.type === 'dkb' ? !install.version : !install.revision)" :busy="busy" @update:open="!$event && (drawer = undefined)" @submit="submitInstall">
      <FormField label="Registry" hint="The Library default is only a convenience; any registered Registry may be selected." required><select v-model="install.registry" required @change="resetInstallPackage"><option v-for="registry in registries.data.value?.registries" :key="registry.name" :value="registry.name">{{ registry.name }}{{ registry.name === defaultRegistry?.name ? ' · default' : '' }}</option></select></FormField>
      <div class="form-field"><label for="registry-package-filter">Knowledge <b aria-hidden="true">*</b></label><RegistryPackagePicker v-model="install.identity" :registry="install.registry" input-id="registry-package-filter" @select="selectInstallPackage" /><small>Type to filter available DKBs and Collections, then choose one from the catalog.</small></div>
      <FormField v-if="selectedInstallEntry?.type === 'dkb'" label="Version" hint="The latest published version is selected automatically; enter another exact version if needed." required><input v-model="install.version" autocomplete="off" placeholder="1.0.0" required /></FormField>
      <FormField v-else-if="selectedInstallEntry?.type === 'collection'" label="Revision" hint="The latest immutable Collection revision is selected automatically." required><input v-model.number="install.revision" type="number" min="1" step="1" required /></FormField>
      <p class="form-notice">Changing the install source does not change this Library's default Registry.</p>
      <label class="checkbox-field"><input v-model="install.force" type="checkbox" /><span><b>Repair or replace existing install</b><small>Use only when reinstalling or recovering an incomplete package.</small></span></label>
    </ActionDrawer>
    <ConfirmDialog :open="Boolean(pendingPackage)" :title="`Uninstall ${pendingPackage ?? ''}?`" description="The package becomes unretrievable immediately and its source and derived builds are removed from this Library. Other Libraries are unchanged." confirm-label="Uninstall" danger :busy="busy" @update:open="!$event && (pendingPackage = undefined)" @confirm="uninstall" />
    <ConfirmDialog :open="Boolean(pendingUpgrade)" :title="`Upgrade ${pendingUpgrade ?? ''}?`" description="DKB resolves the latest signed release, validates its exact build chain, and atomically replaces the installed version." confirm-label="Upgrade" :busy="busy" @update:open="!$event && (pendingUpgrade = undefined)" @confirm="upgrade" />
  </div>
</template>
