<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import type { DkbInstalledEntryDetail, DkbPackageVerification, DkbReceiptSignerSummary } from '@sjshovan/dkb-protocol/packageInspection.js';
import { ArrowLeft, Boxes, CalendarDays, Database, FileStack, PackageOpen, RefreshCw, ShieldCheck, Trash2, UserRound } from '@lucide/vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { cancelOperation, followOperation, getJson, startOperation } from '../api.js';
import AppButton from '../components/interface/AppButton.vue';
import ConfirmDialog from '../components/interface/ConfirmDialog.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import ResourceLink from '../components/interface/ResourceLink.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import BuildChain from '../components/resource/BuildChain.vue';
import CollectionMemberDataTable from '../components/resource/CollectionMemberDataTable.vue';
import InspectionChecks from '../components/resource/InspectionChecks.vue';
import OperationTimeline from '../components/resource/OperationTimeline.vue';
import PackageContentsBrowser from '../components/resource/PackageContentsBrowser.vue';
import PublishKnowledgeDrawer from '../components/resource/PublishKnowledgeDrawer.vue';
import { parseInstalledBuildSelection } from '../resourceRoutes.js';

const props = defineProps<{ library: string; namespace: string; name: string }>();
const router = useRouter();
const route = useRoute();
const queryClient = useQueryClient();
const identity = computed(() => `@${props.namespace.replace(/^@/u, '')}/${props.name}`.toLowerCase());
const apiPath = computed(() => `/api/v1/libraries/${encodeURIComponent(props.library)}/entries/${encodeURIComponent(props.namespace)}/${encodeURIComponent(props.name)}`);
const query = useQuery({ queryKey: computed(() => ['installed-entry', props.library, identity.value]), queryFn: () => getJson<DkbInstalledEntryDetail>(apiPath.value) });
const detail = computed(() => query.data.value);
const section = ref('overview');
const buildSelection = computed(() => parseInstalledBuildSelection(route.query));
watch(() => route.query, () => { if (route.query.view === 'builds' || buildSelection.value.selection || buildSelection.value.error) section.value = 'builds'; }, { immediate: true });
const busy = ref(false);
const pendingAction = ref<'upgrade' | 'uninstall'>();
const events = ref<DkbCommandEvent[]>([]);
const operationId = ref<string>();
const verification = ref<DkbPackageVerification>();
const publishOpen = ref(false);
const sections = computed(() => detail.value?.kind === 'collection'
  ? [{ id: 'overview', label: 'Overview' }, { id: 'members', label: 'Members' }, { id: 'provenance', label: 'Provenance' }, { id: 'integrity', label: 'Integrity' }]
  : [{ id: 'overview', label: 'Overview' }, { id: 'contents', label: 'Contents' }, { id: 'builds', label: 'Builds' }, { id: 'provenance', label: 'Provenance' }, { id: 'integrity', label: 'Integrity' }]);
const visibleChecks = computed(() => verification.value?.checks ?? detail.value?.integrity.checks ?? []);
const visibleRecovery = computed(() => verification.value?.recovery ?? detail.value?.integrity.recovery ?? []);
const integrityStatus = computed(() => verification.value?.status ?? detail.value?.integrity.status ?? 'not_applicable');

async function run(commandId: 'package.verify' | 'package.upgrade' | 'package.uninstall'): Promise<void> {
  busy.value = true;
  events.value = [];
  if (commandId === 'package.verify') verification.value = undefined;
  try {
    const id = await startOperation(commandId, { library: props.library, identity: identity.value });
    operationId.value = id;
    followOperation(id, (event) => {
      events.value.push(event);
      if (event.event === 'result' && commandId === 'package.verify') verification.value = event.value as DkbPackageVerification;
      if (event.event !== 'completion') return;
      busy.value = false;
      pendingAction.value = undefined;
      if (commandId === 'package.verify') {
        section.value = 'integrity';
        const result = verification.value;
        if (result?.status === 'passed') toast.success('Verification completed. Every applicable check passed.');
        else if (result?.status === 'warnings') toast.warning('Verification completed with warnings. Open Integrity for details.');
        else toast.error('Verification found integrity failures. Open Integrity for recovery steps.');
      } else if (event.status === 'succeeded' && commandId === 'package.uninstall') {
        toast.success(`${identity.value} uninstalled.`);
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        void router.push(`/libraries/${encodeURIComponent(props.library)}`);
      } else if (event.status === 'succeeded') {
        toast.success(`${identity.value} upgraded.`);
        void query.refetch();
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
      } else {
        toast.error('The operation did not complete. Review the recovery details below.');
      }
    });
  } catch (cause) {
    busy.value = false;
    toast.error(cause instanceof Error ? cause.message : String(cause));
  }
}

async function cancelCurrent(): Promise<void> {
  if (!operationId.value) return;
  try { await cancelOperation(operationId.value); } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
}

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDate(value?: string): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function shortDigest(value?: string): string { return value ? (value.length > 30 ? `${value.slice(0, 27)}…` : value) : 'Unavailable'; }
function signerLabel(value?: DkbReceiptSignerSummary): string { return value ? `${value.subjectId} · ${value.keyId}` : 'Unavailable'; }
</script>

<template>
  <div class="page entry-detail-page">
    <RouterLink class="back-link" :to="`/libraries/${encodeURIComponent(props.library)}`"><ArrowLeft :size="16" />{{ props.library }}</RouterLink>
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 7" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Installed knowledge unavailable</h2><p>{{ query.error.value?.message }}</p><button type="button" @click="query.refetch()">Try again</button></div></section>
    <template v-else-if="detail">
      <PageHeader :title="detail.manifest?.displayName ?? detail.identity" :description="detail.manifest?.description ?? (detail.kind === 'collection' ? 'A pinned bundle of installed knowledge.' : 'Installed, provenance-preserving knowledge for this Library.')">
        <template #actions><AppButton v-if="detail.kind === 'dkb' && detail.source === 'local' && detail.status === 'installed'" :disabled="busy" @click="publishOpen = true">Publish</AppButton><AppButton :loading="busy && !pendingAction" @click="run('package.verify')"><ShieldCheck :size="16" />Verify</AppButton><AppButton :disabled="busy" @click="pendingAction = 'upgrade'"><RefreshCw :size="16" />Upgrade</AppButton><AppButton variant="danger" :disabled="busy" @click="pendingAction = 'uninstall'"><Trash2 :size="16" />Uninstall</AppButton></template>
      </PageHeader>

      <div class="entry-identity-strip"><StatusBadge :status="detail.status" /><StatusBadge :status="detail.kind" /><span>{{ detail.identity }}<template v-if="detail.version">@{{ detail.version }}</template><template v-else-if="detail.revision"> · revision {{ detail.revision }}</template></span><span>{{ detail.source === 'registry' ? 'Registry-managed' : 'Editable local source' }}</span></div>
      <OperationTimeline :events="events" :operation-id="operationId" @cancel="cancelCurrent" />

      <label class="section-picker"><span>View</span><select v-model="section"><option v-for="item in sections" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
      <nav class="detail-tabs" aria-label="Installed knowledge sections"><button v-for="item in sections" :key="item.id" type="button" :aria-current="section === item.id ? 'page' : undefined" @click="section = item.id">{{ item.label }}<StatusBadge v-if="item.id === 'integrity'" :status="integrityStatus" /></button></nav>

      <section v-if="section === 'overview'" class="detail-section">
        <div class="metric-grid">
          <article><FileStack :size="20" /><span><small>Portable files</small><strong>{{ detail.sourceSummary.files }}</strong><em>{{ formatBytes(detail.sourceSummary.bytes) }}</em></span></article>
          <article><Database :size="20" /><span><small>Evidence records</small><strong>{{ detail.sourceSummary.evidenceRecords }}</strong><em>{{ detail.sourceSummary.searchableSources }} searchable sources</em></span></article>
          <article><Boxes :size="20" /><span><small>{{ detail.kind === 'collection' ? 'Members' : 'Stored builds' }}</small><strong>{{ detail.kind === 'collection' ? detail.members.length : detail.builds.length }}</strong><em>{{ detail.kind === 'collection' ? 'Exact signed dependencies' : 'Reusable across Runtime activations' }}</em></span></article>
          <article><ShieldCheck :size="20" /><span><small>Integrity</small><strong>{{ integrityStatus.replaceAll('_', ' ') }}</strong><em>Last verified {{ verification ? formatDate(verification.checkedAt) : 'when opened' }}</em></span></article>
        </div>
        <div class="overview-grid">
          <article class="detail-card"><header><PackageOpen :size="19" /><div><h2>Package information</h2><p>Identity and declared package metadata.</p></div></header><dl class="detail-list"><div><dt>Identity</dt><dd><code>{{ detail.identity }}</code></dd></div><div><dt>Version</dt><dd>{{ detail.version ?? `revision ${detail.revision ?? 'unknown'}` }}</dd></div><div><dt>Publisher</dt><dd>{{ detail.manifest?.publisher ?? 'Not declared' }}</dd></div><div><dt>License</dt><dd>{{ detail.manifest?.license ?? 'Not declared' }}</dd></div><div><dt>Installed</dt><dd>{{ formatDate(detail.installedAt) }}</dd></div><div><dt>Required by</dt><dd><span v-if="!detail.requiredBy.length">Direct install</span><span v-else class="resource-reference-list"><ResourceLink v-for="requirement in detail.requiredBy" :key="requirement" kind="installed-entry" :name="requirement" :library="props.library" /></span></dd></div></dl></article>
          <article class="detail-card"><header><ShieldCheck :size="19" /><div><h2>Trust summary</h2><p>Receipt presence and immutable Library build coverage.</p></div></header><dl class="detail-list"><div><dt>Source receipt</dt><dd><StatusBadge :status="detail.provenance.receiptStatus" /></dd></div><div><dt>Install chain</dt><dd><StatusBadge :status="detail.provenance.installChainStatus" /></dd></div><div><dt>Package tree</dt><dd><code>{{ shortDigest(detail.provenance.packageTreeHash) }}</code></dd></div><div><dt>Stored builds</dt><dd>{{ detail.builds.length }}</dd></div><div><dt>Permissions</dt><dd>Read {{ detail.manifest?.permissions?.read === false ? 'denied' : 'allowed' }} · Write {{ detail.manifest?.permissions?.write === true ? 'allowed' : 'denied' }}</dd></div></dl></article>
        </div>
      </section>

      <section v-else-if="section === 'contents' && detail.kind === 'dkb'" class="detail-section detail-section--flush"><PackageContentsBrowser :library="props.library" :namespace="props.namespace" :name="props.name" /></section>
      <section v-else-if="section === 'builds' && detail.kind === 'dkb'" class="detail-section"><p v-if="buildSelection.error" class="form-notice" role="status">{{ buildSelection.error }}</p><BuildChain :detail="detail" :library="props.library" :initial-build="buildSelection.selection" /></section>

      <section v-else-if="section === 'members' && detail.kind === 'collection'" class="detail-section">
        <header class="section-heading"><div><h2>Collection members</h2><p>Exact versions resolved by this Collection in the current Library.</p></div><span class="count">{{ detail.members.length }}</span></header>
        <EmptyState v-if="!detail.members.length" title="No members" message="This Collection does not declare any package dependencies." />
        <CollectionMemberDataTable v-else :rows="detail.members" :library="props.library" />
      </section>

      <section v-else-if="section === 'provenance'" class="detail-section provenance-layout">
        <article class="detail-card"><header><UserRound :size="19" /><div><h2>Signing identities</h2><p>Human-readable signer metadata; private key material is never stored here.</p></div></header><dl class="detail-list"><div><dt>Publisher</dt><dd>{{ signerLabel(detail.provenance.publisher) }}</dd></div><div><dt>Publisher fingerprint</dt><dd><code>{{ shortDigest(detail.provenance.publisher?.publicKeyFingerprint) }}</code></dd></div><div><dt>Registry</dt><dd>{{ signerLabel(detail.provenance.registry) }}</dd></div><div><dt>Registry fingerprint</dt><dd><code>{{ shortDigest(detail.provenance.registry?.publicKeyFingerprint) }}</code></dd></div></dl></article>
        <article class="detail-card"><header><CalendarDays :size="19" /><div><h2>Release chain</h2><p>Content identities remain stable while Runtimes choose among stored builds.</p></div></header><dl class="detail-list"><div><dt>Source digest</dt><dd><code>{{ detail.provenance.sourceDigest ?? 'Unavailable' }}</code></dd></div><div><dt>Payload hash</dt><dd><code>{{ detail.provenance.payloadHash ?? 'Unavailable' }}</code></dd></div><div><dt>Evidence builds</dt><dd>{{ detail.builds.filter((build) => build.kind === 'evidence').length }}</dd></div><div><dt>Retrieval builds</dt><dd>{{ detail.builds.filter((build) => build.kind === 'retrieval').length }}</dd></div></dl></article>
      </section>

      <section v-else-if="section === 'integrity'" class="detail-section integrity-section">
        <header class="section-heading"><div><h2>{{ verification ? 'Verification results' : 'Current integrity' }}</h2><p>{{ verification ? `Checked ${formatDate(verification.checkedAt)}. This was a one-time check.` : 'These checks were derived while loading the installed entry. Run Verify for a fresh, explicit check.' }}</p></div><StatusBadge :status="integrityStatus" /></header>
        <InspectionChecks :checks="visibleChecks" :recovery="visibleRecovery" />
      </section>
      <PublishKnowledgeDrawer v-if="detail.kind === 'dkb' && detail.source === 'local' && detail.version" v-model:open="publishOpen" :library="props.library" :identity="detail.identity" :version="detail.version" />
    </template>

    <ConfirmDialog :open="pendingAction === 'upgrade'" :title="`Upgrade ${identity}?`" description="DKB resolves the latest signed release, validates its exact build chain, and atomically replaces the installed version." confirm-label="Upgrade" :busy="busy" @update:open="!$event && (pendingAction = undefined)" @confirm="run('package.upgrade')" />
    <ConfirmDialog :open="pendingAction === 'uninstall'" :title="`Uninstall ${identity}?`" description="The package becomes unretrievable immediately and its source, Evidence Builds, and Retrieval Builds are removed from this Library. Other Libraries are unchanged." confirm-label="Uninstall" danger :busy="busy" @update:open="!$event && (pendingAction = undefined)" @confirm="run('package.uninstall')" />
  </div>
</template>
