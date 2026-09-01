<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import type { DkbRegistryBuildSummary, DkbRegistryCollectionDetail, DkbRegistryPackageDetail } from '@sjshovan/dkb-protocol/registryCatalog.js';
import { ArrowLeft, Boxes, CalendarDays, Database, Download, FileStack, Link2, PackageOpen, ShieldCheck, UsersRound } from '@lucide/vue';
import { RouterLink, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { cancelOperation, followOperation, getJson, startOperation } from '../api.js';
import ActionDrawer from '../components/interface/ActionDrawer.vue';
import AppButton from '../components/interface/AppButton.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import FormField from '../components/interface/FormField.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import OperationTimeline from '../components/resource/OperationTimeline.vue';
import RemoteSourceInventory from '../components/resource/RemoteSourceInventory.vue';
import { defaultOptionLabel, isHostDefault, selectOptionLabel } from '../selectOptions.js';
import type { ResourceListing, ResourceRow } from '../types.js';

const props = defineProps<{ registry: string; kind: 'dkb' | 'collection'; namespace: string; name: string }>();
const router = useRouter();
const queryClient = useQueryClient();
const identity = computed(() => `@${props.namespace.replace(/^@/u, '')}/${props.name}`.toLowerCase());
const selectedVersion = ref('');
const selectedRevision = ref<number>();
const selectedTarget = ref('');
const section = ref('overview');
const drawer = ref<'install' | 'connect'>();
const busy = ref(false);
const events = ref<DkbCommandEvent[]>([]);
const operationId = ref<string>();
const installLibrary = ref('');
const connectLibrary = ref('');
const context = useQuery({
  queryKey: computed(() => ['registry-context', props.registry]),
  queryFn: () => getJson<{ registry: ResourceRow; libraries: ResourceRow[] }>(`/api/v1/registries/${encodeURIComponent(props.registry)}`),
});
const allLibraries = useQuery({ queryKey: ['resources', 'libraries', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/libraries') });
const detailUrl = computed(() => {
  const query = props.kind === 'dkb' && selectedVersion.value ? `?version=${encodeURIComponent(selectedVersion.value)}`
    : props.kind === 'collection' && selectedRevision.value ? `?revision=${selectedRevision.value}` : '';
  return `/api/v1/registries/${encodeURIComponent(props.registry)}/${props.kind === 'dkb' ? 'dkbs' : 'collections'}/${encodeURIComponent(props.namespace)}/${encodeURIComponent(props.name)}${query}`;
});
const query = useQuery({
  queryKey: computed(() => ['registry-entry', props.registry, props.kind, identity.value, selectedVersion.value, selectedRevision.value]),
  queryFn: () => getJson<DkbRegistryPackageDetail | DkbRegistryCollectionDetail>(detailUrl.value),
});
const detail = computed(() => query.data.value);
const packageDetail = computed(() => detail.value?.type === 'dkb' ? detail.value : undefined);
const collectionDetail = computed(() => detail.value?.type === 'collection' ? detail.value : undefined);
const release = computed(() => packageDetail.value?.selectedVersion);
const revision = computed(() => collectionDetail.value?.selectedRevision);
const matchingLibraries = computed(() => context.data.value?.libraries ?? []);
const installLibraries = computed(() => allLibraries.data.value?.libraries ?? []);
const disconnectedLibraries = computed(() => (allLibraries.data.value?.libraries ?? []).filter((library) => !matchingLibraries.value.some((matched) => matched.name === library.name)));
const builds = computed(() => release.value?.builds ?? []);
const targets = computed(() => [...new Set(builds.value.filter(isInstallableBuild).map((build) => build.target))]);
const members = computed(() => {
  const manifest = revision.value?.manifest;
  return isRecord(manifest) && Array.isArray(manifest.members) ? manifest.members.filter(isRecord) : [];
});
const sections = computed(() => props.kind === 'dkb'
  ? ['overview', 'versions', 'contents', 'builds', 'provenance']
  : ['overview', 'members', 'provenance']);

watch(() => query.data.value, (value) => {
  if (value?.type === 'dkb') {
    if (!selectedVersion.value) selectedVersion.value = value.selectedVersion.version;
    const installableTargets = [...new Set(value.selectedVersion.builds.filter(isInstallableBuild).map((build) => build.target))];
    if (!selectedTarget.value || !installableTargets.includes(selectedTarget.value)) {
      selectedTarget.value = value.selectedVersion.defaultTarget && installableTargets.includes(value.selectedVersion.defaultTarget)
        ? value.selectedVersion.defaultTarget
        : installableTargets[0] ?? '';
    }
  } else if (value?.type === 'collection' && !selectedRevision.value) selectedRevision.value = value.selectedRevision.revision;
}, { immediate: true });
watch(installLibraries, (value) => { if (!installLibrary.value && value[0]) installLibrary.value = value[0].name; }, { immediate: true });
watch(disconnectedLibraries, (value) => { if (!connectLibrary.value && value[0]) connectLibrary.value = value[0].name; }, { immediate: true });

function openInstall(): void {
  installLibrary.value = matchingLibraries.value[0]?.name ?? installLibraries.value[0]?.name ?? '';
  drawer.value = 'install';
}

async function run(commandId: 'package.install' | 'library.registry.use', input: Record<string, unknown>): Promise<void> {
  busy.value = true;
  events.value = [];
  try {
    const id = await startOperation(commandId, input);
    operationId.value = id;
    followOperation(id, (event) => {
      events.value.push(event);
      if (event.event !== 'completion') return;
      busy.value = false;
      if (event.status !== 'succeeded') { toast.error('The operation did not complete. Review the recovery details below.'); return; }
      if (commandId === 'library.registry.use') {
        toast.success(`${String(input.library)} connected to ${props.registry}.`);
        drawer.value = undefined;
        void Promise.all([context.refetch(), queryClient.invalidateQueries({ queryKey: ['resources'] })]);
        return;
      }
      toast.success(`${identity.value} installed.`);
      drawer.value = undefined;
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['overview'] }),
        queryClient.invalidateQueries({ queryKey: ['resources'] }),
        queryClient.invalidateQueries({ queryKey: ['registry-catalog', props.registry] }),
        queryClient.invalidateQueries({ queryKey: ['activity'] }),
      ]);
      const match = /^@([^/]+)\/(.+)$/u.exec(identity.value);
      if (match) void router.push(`/libraries/${encodeURIComponent(String(input.library))}/entries/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}`);
    });
  } catch (cause) {
    busy.value = false;
    toast.error(cause instanceof Error ? cause.message : String(cause));
  }
}

function submitInstall(): void {
  const registryUrl = context.data.value?.registry.url;
  if (!registryUrl || !installLibrary.value) return;
  if (props.kind === 'dkb' && (!selectedVersion.value || !selectedTarget.value)) {
    toast.error('Choose a published retrieval build before installing this DKB.');
    return;
  }
  void run('package.install', {
    library: installLibrary.value,
    identity: identity.value,
    registryUrl,
    ...(props.kind === 'dkb' ? { version: selectedVersion.value, target: selectedTarget.value } : { revision: selectedRevision.value }),
  });
}
function submitConnect(): void { if (connectLibrary.value) void run('library.registry.use', { library: connectLibrary.value, registry: props.registry }); }
async function cancelCurrent(): Promise<void> { if (operationId.value) await cancelOperation(operationId.value); }
function selectVersion(value: string): void { selectedVersion.value = value; selectedTarget.value = ''; }
function isInstallableBuild(build: DkbRegistryBuildSummary): boolean { return build.status === 'published' || build.status === 'ready'; }
function shortDigest(value?: string | null): string { return value ? value.length > 32 ? `${value.slice(0, 29)}…` : value : 'Unavailable'; }
function formatBytes(value?: number): string { if (value === undefined) return 'Unavailable'; return value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(1)} MiB`; }
function formatBuildBytes(build: DkbRegistryBuildSummary): string {
  if (build.evidenceSize === undefined && build.retrievalSize === undefined) return 'Unavailable';
  return formatBytes((build.evidenceSize ?? 0) + (build.retrievalSize ?? 0));
}
function formatDate(value?: string | null): string { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Unavailable'; }
function providerIds(value: unknown[]): string { const ids = value.map((item) => isRecord(item) ? String(item.id ?? item.providerId ?? '') : '').filter(Boolean); return ids.length ? ids.join(' → ') : 'Not reported'; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
</script>

<template>
  <div class="page entry-detail-page registry-entry-page">
    <RouterLink class="back-link" :to="`/registries/${encodeURIComponent(props.registry)}`"><ArrowLeft :size="16" />{{ props.registry }}</RouterLink>
    <div v-if="query.isPending.value && !detail" class="skeleton-stack"><span v-for="n in 7" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Registry entry unavailable</h2><p>{{ query.error.value?.message }}</p><AppButton @click="query.refetch()">Try again</AppButton></div></section>
    <template v-else-if="detail">
      <PageHeader :title="detail.entry.id" :description="detail.entry.description || (props.kind === 'dkb' ? 'A signed, versioned Durable Knowledgebase.' : 'An immutable bundle of exact DKB releases.')">
        <template #actions><AppButton variant="primary" :disabled="props.kind === 'dkb' && (!selectedVersion || !selectedTarget)" @click="openInstall"><Download :size="16" />Install from this Registry</AppButton><AppButton :disabled="!disconnectedLibraries.length" @click="drawer = 'connect'"><Link2 :size="16" />Set Library default</AppButton></template>
      </PageHeader>
      <div class="entry-identity-strip"><StatusBadge :status="props.kind" /><StatusBadge :status="detail.entry.visibility" /><span>{{ detail.entry.id }}</span><span>{{ props.kind === 'dkb' ? `Version ${selectedVersion}` : `Revision ${selectedRevision}` }}</span></div>
      <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancelCurrent" />
      <label class="section-picker"><span>View</span><select v-model="section"><option v-for="item in sections" :key="item" :value="item">{{ item[0]?.toUpperCase() }}{{ item.slice(1) }}</option></select></label>
      <nav class="detail-tabs" aria-label="Registry entry sections"><button v-for="item in sections" :key="item" type="button" :aria-current="section === item ? 'page' : undefined" @click="section = item">{{ item[0]?.toUpperCase() }}{{ item.slice(1) }}</button></nav>

      <section v-if="section === 'overview'" class="detail-section">
        <div class="metric-grid">
          <article><component :is="props.kind === 'dkb' ? PackageOpen : UsersRound" :size="20" /><span><small>Release</small><strong>{{ props.kind === 'dkb' ? selectedVersion : `r${selectedRevision}` }}</strong><em>{{ detail.entry.visibility }}</em></span></article>
          <article><Database :size="20" /><span><small>{{ props.kind === 'dkb' ? 'Evidence records' : 'Members' }}</small><strong>{{ props.kind === 'dkb' ? release?.recordCount ?? 0 : members.length }}</strong><em>{{ props.kind === 'dkb' ? `${builds.length} retrieval build${builds.length === 1 ? '' : 's'}` : 'Exact signed dependencies' }}</em></span></article>
          <article><ShieldCheck :size="20" /><span><small>Status</small><strong>{{ props.kind === 'dkb' ? release?.status : 'published' }}</strong><em>{{ props.kind === 'dkb' ? formatDate(release?.publishedAt) : formatDate(revision?.publishedAt) }}</em></span></article>
          <article><Boxes :size="20" /><span><small>Install options</small><strong>{{ installLibraries.length }}</strong><em>registered {{ installLibraries.length === 1 ? 'Library' : 'Libraries' }}</em></span></article>
        </div>
        <div class="overview-grid">
          <article class="detail-card"><header><FileStack :size="19" /><div><h2>Release identity</h2><p>The immutable source release selected for inspection.</p></div></header><dl class="detail-list"><div><dt>Identity</dt><dd><code>{{ detail.entry.id }}</code></dd></div><div><dt>{{ props.kind === 'dkb' ? 'Version' : 'Revision' }}</dt><dd>{{ props.kind === 'dkb' ? selectedVersion : selectedRevision }}</dd></div><div><dt>Published</dt><dd>{{ props.kind === 'dkb' ? formatDate(release?.publishedAt) : formatDate(revision?.publishedAt) }}</dd></div><div><dt>Registry</dt><dd>{{ props.registry }}</dd></div></dl></article>
          <article class="detail-card"><header><ShieldCheck :size="19" /><div><h2>Trust summary</h2><p>Digests carried by this signed Registry release.</p></div></header><dl class="detail-list"><template v-if="release"><div><dt>Receipt</dt><dd><code>{{ shortDigest(release.receiptHash) }}</code></dd></div><div><dt>Payload</dt><dd><code>{{ shortDigest(release.payloadHash) }}</code></dd></div><div><dt>Source tree</dt><dd><code>{{ shortDigest(release.packageTreeHash) }}</code></dd></div></template><template v-else><div><dt>Revision digest</dt><dd><code>{{ shortDigest(revision?.digest) }}</code></dd></div></template></dl></article>
        </div>
      </section>

      <section v-else-if="section === 'versions' && packageDetail" class="detail-section">
        <header class="section-heading"><div><h2>Published versions</h2><p>Select an exact immutable release to inspect and install.</p></div><span class="count">{{ packageDetail.versions.length }}</span></header>
        <ul class="release-list"><li v-for="item in packageDetail.versions" :key="item.version" :class="{ 'release-list--selected': item.version === selectedVersion }"><button type="button" @click="selectVersion(item.version)"><span><strong>{{ item.version }}</strong><small><code>{{ shortDigest(item.packageTreeHash) }}</code></small></span><StatusBadge :status="item.status" /></button></li></ul>
      </section>

      <section v-else-if="section === 'contents' && props.kind === 'dkb' && selectedVersion" class="detail-section detail-section--flush"><RemoteSourceInventory :registry="props.registry" :namespace="props.namespace" :name="props.name" :version="selectedVersion" /></section>

      <section v-else-if="section === 'builds' && props.kind === 'dkb'" class="detail-section">
        <header class="section-heading"><div><h2>Available retrieval builds</h2><p>Signed, runtime-ready builds derived from the selected Evidence Build.</p></div><span class="count">{{ builds.length }}</span></header>
        <EmptyState v-if="!builds.length" title="No available builds" message="This release cannot be installed until a trusted pipeline target finishes compiling." />
        <div v-else class="registry-build-list"><article v-for="build in builds" :key="build.retrievalBuildDigest"><header><div><strong>{{ build.target }}</strong><small>{{ providerIds(build.evidenceProviders) }} · {{ providerIds(build.retrievalProviders) }}</small></div><StatusBadge :status="build.status" /></header><dl><div><dt>Evidence</dt><dd><code>{{ shortDigest(build.evidenceDigest) }}</code></dd></div><div><dt>Retrieval</dt><dd><code>{{ shortDigest(build.retrievalBuildDigest) }}</code></dd></div><div><dt>Compatibility</dt><dd><code>{{ shortDigest(build.compatibilityDigest) }}</code></dd></div><div><dt>Stored size</dt><dd>{{ formatBuildBytes(build) }}</dd></div><div><dt>Built</dt><dd>{{ formatDate(build.retrievalBuiltAt) }}</dd></div></dl></article></div>
      </section>

      <section v-else-if="section === 'members' && props.kind === 'collection'" class="detail-section">
        <header class="section-heading"><div><h2>Collection members</h2><p>Exact package versions and release digests pinned by revision {{ selectedRevision }}.</p></div><span class="count">{{ members.length }}</span></header>
        <ul class="member-list"><li v-for="member in members" :key="String(member.id)"><PackageOpen :size="18" /><span><strong>{{ member.id }}</strong><small>Version {{ member.version }}</small></span><code>{{ shortDigest(String(member.digest ?? '')) }}</code></li></ul>
      </section>

      <section v-else-if="section === 'provenance'" class="detail-section provenance-layout">
        <article class="detail-card"><header><ShieldCheck :size="19" /><div><h2>Signed provenance</h2><p>Registry receipt references for the selected release.</p></div></header><dl class="detail-list"><template v-if="release"><div><dt>Source hash</dt><dd><code>{{ release.sourceHash ?? 'Unavailable' }}</code></dd></div><div><dt>Archive hash</dt><dd><code>{{ release.archiveHash ?? 'Unavailable' }}</code></dd></div><div><dt>Receipt hash</dt><dd><code>{{ release.receiptHash ?? 'Unavailable' }}</code></dd></div><div><dt>Payload hash</dt><dd><code>{{ release.payloadHash ?? 'Unavailable' }}</code></dd></div></template><template v-else><div><dt>Collection digest</dt><dd><code>{{ revision?.digest ?? 'Unavailable' }}</code></dd></div></template></dl></article>
        <article v-if="release" class="detail-card"><header><CalendarDays :size="19" /><div><h2>Build chronology</h2><p>Compiler and publication timestamps reported by the Registry.</p></div></header><dl class="detail-list"><div><dt>Queued</dt><dd>{{ formatDate(release.queuedAt) }}</dd></div><div><dt>Started</dt><dd>{{ formatDate(release.startedAt) }}</dd></div><div><dt>Compiled</dt><dd>{{ formatDate(release.compiledAt) }}</dd></div><div><dt>Published</dt><dd>{{ formatDate(release.publishedAt) }}</dd></div></dl></article>
      </section>
    </template>

    <ActionDrawer :open="drawer === 'install'" :title="`Install ${identity}`" description="Choose an exact release, compatible build target, and any registered destination Library." submit-label="Install signed release" :submit-disabled="props.kind === 'dkb' && (!selectedVersion || !selectedTarget)" :busy="busy" @update:open="!$event && (drawer = undefined)" @submit="submitInstall">
      <FormField label="Library" hint="This install records the current Registry as package origin without changing the Library default." required><select v-model="installLibrary" required><option v-for="library in installLibraries" :key="library.name" :value="library.name">{{ selectOptionLabel(library.displayName ?? library.name, [isHostDefault(library) ? 'Default Library' : undefined, matchingLibraries.some((matched) => matched.name === library.name) ? 'Registry default' : undefined]) }}</option></select></FormField>
      <FormField v-if="props.kind === 'dkb'" label="Version" hint="The exact immutable source release." required><select v-model="selectedVersion" required><option v-for="item in packageDetail?.versions" :key="item.version" :value="item.version">{{ item.version }} · {{ item.status }}</option></select></FormField>
      <FormField v-if="props.kind === 'dkb'" label="Retrieval target" hint="Only published signed builds are installable." required><select v-model="selectedTarget" required><option v-for="target in targets" :key="target" :value="target">{{ defaultOptionLabel(target, target === release?.defaultTarget) }}</option></select></FormField>
      <FormField v-else label="Revision" hint="Collection revisions are immutable." required><select v-model.number="selectedRevision" required><option v-for="item in collectionDetail?.entry.revisions" :key="item.revision" :value="item.revision">Revision {{ item.revision }} · {{ formatDate(item.publishedAt) }}</option></select></FormField>
      <p class="form-notice">The Registry credential stays on this host. The browser never receives it.</p>
    </ActionDrawer>
    <ActionDrawer :open="drawer === 'connect'" :title="`Set ${props.registry} as Library default`" description="This changes only the selected Library’s default package source. Existing packages keep their exact Registry origins." submit-label="Set as default" :busy="busy" @update:open="!$event && (drawer = undefined)" @submit="submitConnect">
      <FormField label="Library" hint="Choose a host Library that is not currently connected to this Registry." required><select v-model="connectLibrary" required><option v-for="library in disconnectedLibraries" :key="library.name" :value="library.name">{{ defaultOptionLabel(library.displayName ?? library.name, isHostDefault(library)) }}</option></select></FormField>
      <p class="form-notice"><Link2 :size="16" /> Future Registry browsing and installs for this Library will use {{ props.registry }}. This is an explicit configuration change.</p>
      <EmptyState v-if="!disconnectedLibraries.length" title="No Library is available to connect" message="Register a Library first, then return to this Registry entry." />
    </ActionDrawer>
  </div>
</template>
