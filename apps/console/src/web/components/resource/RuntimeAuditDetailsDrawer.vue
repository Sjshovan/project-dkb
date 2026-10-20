<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import DataTablesCore from 'datatables.net-dt';
import { Fingerprint, Route, Search, ShieldCheck, X } from '@lucide/vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import AppButton from '../interface/AppButton.vue';
import ConsoleDataTable from '../interface/ConsoleDataTable.vue';
import ResourceLink from '../interface/ResourceLink.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import AuditBuildReference from './AuditBuildReference.vue';
import EvidenceDetailsDrawer from './EvidenceDetailsDrawer.vue';
import { consoleTextFilter, type ConsoleDataTableColumn } from '../interface/consoleDataTable.js';
import { auditAdmissionLabel, auditDate, auditElapsed, auditJson, auditLibraryReference, auditPackageAvailable, auditPipelineAvailable, auditRuntimeReference, auditSlotRender, safeAuditCitationUrl, type AuditInstalledPackage, type AuditEvidenceSelection } from './runtimeAuditPresentation.js';
import type { PipelineTarget, ResourceRow, RuntimeAuditEvent } from '../../types.js';

const props = defineProps<{
  open: boolean;
  event?: RuntimeAuditEvent;
  runtimeName: string;
  runtimeId?: string;
  libraries: ResourceRow[];
  pipelines: PipelineTarget[];
  packages: AuditInstalledPackage[];
  packagesPending?: boolean;
  packagesError?: string;
}>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const library = computed(() => auditLibraryReference(props.event, props.libraries));
const runtimeLink = computed(() => auditRuntimeReference(props.event, props.runtimeId, props.runtimeName));
const pipelineLink = computed(() => Boolean(runtimeLink.value) && auditPipelineAvailable(props.event, props.pipelines));
const selectedEvidence = ref<AuditEvidenceSelection>();
watch([() => props.open, () => props.event?.eventId], () => { selectedEvidence.value = undefined; });
const text = DataTablesCore.render.text();
function column(data: string, title: string, extra: Partial<ConsoleDataTableColumn> = {}): ConsoleDataTableColumn {
  return { data, name: data, title, render: text, columnControl: consoleTextFilter(title), ...extra };
}
const packageColumns: ConsoleDataTableColumn[] = [
  column('id', 'Package', { className: 'all', render: auditSlotRender('#audit-package') }),
  column('version', 'Version', { className: 'all' }),
  column('evidenceDigest', 'Evidence Build', { render: auditSlotRender('#audit-evidence-build') }),
  column('retrievalBuildDigest', 'Retrieval Build', { render: auditSlotRender('#audit-retrieval-build') }),
];
const candidateColumns: ConsoleDataTableColumn[] = [
  column('evidenceId', 'Evidence ID', { className: 'all', render: auditSlotRender('#candidate-evidence') }),
  column('packageId', 'Package', { render: auditSlotRender('#candidate-package') }),
  column('packageVersion', 'Version'),
  { data: 'score', name: 'score', title: 'Score', render: (value: number | null) => value === null ? 'Not ranked' : value },
  { data: (row: RuntimeAuditEvent['candidates'][number]) => row.channels.join(', ') || 'None', name: 'channels', title: 'Channels', render: text, columnControl: consoleTextFilter('Channels') },
  column('evidenceDigest', 'Evidence Build', { render: auditSlotRender('#candidate-evidence-build') }),
  column('retrievalBuildDigest', 'Retrieval Build', { render: auditSlotRender('#candidate-retrieval-build') }),
];
const citationColumns: ConsoleDataTableColumn[] = [
  column('evidenceId', 'Evidence ID', { className: 'all', render: auditSlotRender('#citation-evidence') }),
  column('packageId', 'Package', { render: auditSlotRender('#citation-package') }),
  column('packageVersion', 'Version'),
  { data: (row: RuntimeAuditEvent['citations'][number]) => auditJson(row.locator), name: 'locator', title: 'Source locator', render: auditSlotRender('#citation-locator'), columnControl: consoleTextFilter('Source locator') },
  { data: (row: RuntimeAuditEvent['citations'][number]) => row.url ?? '', name: 'url', title: 'Citation', render: auditSlotRender('#citation-url'), columnControl: consoleTextFilter('Citation URL') },
];
function packageLink(id: string, version: string): boolean {
  return !props.packagesPending && !props.packagesError
    && Boolean(library.value.name) && auditPackageAvailable(id, version, props.packages);
}
function citationEvidenceDigest(id: string, version: string): string | undefined {
  const matches = props.event?.packages.filter((pkg) => pkg.id === id && pkg.version === version) ?? [];
  return matches.length === 1 ? matches[0]!.evidenceDigest : undefined;
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="drawer-overlay" />
      <DialogContent class="action-drawer status-details-drawer runtime-audit-drawer build-details-drawer">
        <header><div><DialogTitle>Retrieval audit</DialogTitle><DialogDescription>A recorded request, its admission decision, and the exact evidence used.</DialogDescription></div><button class="icon-button" type="button" aria-label="Close audit details" @click="emit('update:open', false)"><X :size="20" /></button></header>
        <div v-if="event" class="drawer-body">
          <section class="build-drawer-summary"><div><span class="build-type-icon"><Search :size="19" /></span><span><strong>{{ event.query }}</strong><small>{{ event.channel }} · {{ auditDate(event.recordedAt) }}</small></span><StatusBadge :status="event.outcome === 'success' ? 'succeeded' : event.outcome" /></div><dl><div><dt>Admission</dt><dd>{{ auditAdmissionLabel(event) }}</dd></div><div><dt>Results</dt><dd>{{ event.resultCount }}</dd></div><div><dt>Elapsed</dt><dd>{{ auditElapsed(event.timing) }}</dd></div></dl></section>
          <section v-if="event.admission === 'rejected_before_admission' || event.error" class="recovery-panel"><div><h2>{{ event.admission === 'rejected_before_admission' ? 'Request not admitted' : event.outcome === 'cancelled' ? 'Request cancelled' : 'Request failed' }}</h2><p v-if="event.admission === 'rejected_before_admission'">No validated Library or build graph was admitted. This request did not release evidence.</p><p v-if="event.error">{{ event.error.message }}</p><code v-if="event.error?.code">{{ event.error.code }}</code><p v-if="event.outcome === 'cancelled'">The operation was cancelled. Retry when ready.</p><p v-else-if="!event.error">Inspect this Runtime’s binding and activation before retrying. No missing identity has been inferred from its current settings.</p></div></section>
          <p v-else-if="event.outcome === 'insufficient'" class="form-notice">The admitted builds did not provide sufficient evidence. Refine the query or inspect the available knowledge before retrying.</p>
          <p v-else-if="event.outcome === 'cancelled'" class="form-notice">The request was cancelled before completion. Retry when ready.</p>
          <section class="build-recipe"><div class="build-drawer-heading"><Route :size="18" /><span><h2>Recorded request</h2><p>Links appear only when the historical identity resolves to a known host object.</p></span></div><dl class="detail-list">
            <div><dt>Runtime</dt><dd><ResourceLink v-if="runtimeLink" kind="runtime" :name="runtimeLink" :label="event.runtime.id ?? runtimeLink" /><code v-else>{{ event.runtime.id ?? 'Identity unavailable before admission' }}</code><small v-if="event.runtime.id && !runtimeLink">Historical Runtime identity is not resolved on this page.</small></dd></div>
            <div><dt>Library</dt><dd><ResourceLink v-if="library.name" kind="library" :name="library.name" :label="library.id" /><code v-else>{{ library.id }}</code><small v-if="library.detail">{{ library.detail }}</small></dd></div>
            <div><dt>Pipeline</dt><dd><ResourceLink v-if="pipelineLink && event.pipeline" kind="pipeline" :name="event.pipeline.target" :runtime="runtimeLink" /><span v-else>{{ event.pipeline?.target ?? 'Not admitted' }}</span><small v-if="event.pipeline && !pipelineLink">This exact historical recipe is not available in the current Runtime catalog.</small></dd></div>
            <div><dt>Request ID</dt><dd><code>{{ event.requestId }}</code></dd></div><div><dt>Audit event</dt><dd><code>{{ event.eventId }}</code></dd></div><div><dt>Intent</dt><dd>{{ event.intent }}</dd></div><div><dt>Recorded status</dt><dd>{{ event.status }}</dd></div>
            <div><dt>Client</dt><dd>{{ event.client.id ?? 'Not identified' }}</dd></div><div><dt>Session</dt><dd>{{ event.client.sessionId ?? 'Not recorded' }}</dd></div><div><dt>Address</dt><dd>{{ event.client.address ?? 'Not recorded' }}</dd></div><div><dt>User agent</dt><dd>{{ event.client.userAgent ?? 'Not recorded' }}</dd></div>
          </dl></section>
          <template v-if="event.admission === 'admitted'">
            <section class="build-identities"><div class="build-drawer-heading"><Fingerprint :size="18" /><span><h2>Validated identity chain</h2><p>The recorded snapshot, not the Runtime’s current configuration.</p></span></div><dl>
              <div><dt>Activation</dt><dd><code>{{ event.runtime.activationDigest }}</code></dd></div><div><dt>Library generation</dt><dd>{{ event.library.generation }}</dd></div><div><dt>Library state</dt><dd><code>{{ event.library.stateDigest }}</code></dd></div><div><dt>Evidence Profile</dt><dd><code>{{ event.pipeline.evidenceProfileDigest }}</code></dd></div><div><dt>Retrieval Profile</dt><dd><code>{{ event.pipeline.retrievalProfileDigest }}</code></dd></div><div><dt>Compatibility</dt><dd><code>{{ event.pipeline.compatibilityDigest }}</code></dd></div>
            </dl></section>
            <section class="build-recipe"><div class="build-drawer-heading"><ShieldCheck :size="18" /><span><h2>Admitted package builds</h2><p>Full Evidence and Retrieval digests for each package in this snapshot.</p></span></div>
              <p v-if="packagesPending" class="quiet-state" role="status">Checking which historical releases remain installed…</p><p v-else-if="packagesError" class="form-notice">Package links are unavailable: {{ packagesError }}</p><p v-else class="quiet-state">Package links require the exact version in the recorded Library. The audit remains available after removal.</p>
              <ConsoleDataTable :rows="event.packages" :columns="packageColumns" caption="Package builds admitted for this audited request" noun="packages" search-placeholder="Search packages, versions, or build digests" empty-table="No packages were admitted into this snapshot.">
                <template #audit-package="{ rowData }"><ResourceLink v-if="packageLink(rowData.id, rowData.version)" kind="installed-entry" :name="rowData.id" :library="library.name" /><span v-else>{{ rowData.id }}</span></template>
                <template #audit-evidence-build="{ rowData }"><AuditBuildReference :library="library.name" :identity="rowData.id" :version="rowData.version" kind="evidence" :digest="rowData.evidenceDigest" /></template><template #audit-retrieval-build="{ rowData }"><AuditBuildReference :library="library.name" :identity="rowData.id" :version="rowData.version" kind="retrieval" :digest="rowData.retrievalBuildDigest" :evidence-digest="rowData.evidenceDigest" /></template>
              </ConsoleDataTable>
            </section>
            <section class="build-recipe"><div class="build-drawer-heading"><Search :size="18" /><span><h2>Evidence candidates</h2><p>Recorded Evidence IDs, package/build ownership, ranking scores, and search channels.</p></span></div>
              <ConsoleDataTable :rows="event.candidates" :columns="candidateColumns" caption="Evidence candidates recorded for this request" noun="candidates" search-placeholder="Search Evidence IDs, packages, or channels" empty-table="No evidence candidates were recorded for this request.">
                <template #candidate-evidence="{ rowData }"><AuditBuildReference :library="library.name" :identity="rowData.packageId" :version="rowData.packageVersion" kind="evidence" :digest="rowData.evidenceDigest" :evidence-id="rowData.evidenceId" @inspect-evidence="selectedEvidence = $event" /></template><template #candidate-package="{ rowData }"><ResourceLink v-if="packageLink(rowData.packageId, rowData.packageVersion)" kind="installed-entry" :name="rowData.packageId" :library="library.name" /><span v-else>{{ rowData.packageId }}</span></template>
                <template #candidate-evidence-build="{ rowData }"><AuditBuildReference :library="library.name" :identity="rowData.packageId" :version="rowData.packageVersion" kind="evidence" :digest="rowData.evidenceDigest" /></template><template #candidate-retrieval-build="{ rowData }"><AuditBuildReference :library="library.name" :identity="rowData.packageId" :version="rowData.packageVersion" kind="retrieval" :digest="rowData.retrievalBuildDigest" :evidence-digest="rowData.evidenceDigest" /></template>
              </ConsoleDataTable>
            </section>
            <section class="build-recipe"><h2>Citations and source locators</h2><p>Source links retain their recorded URL. They are not rewritten to the current Runtime or Library.</p>
              <ConsoleDataTable :rows="event.citations" :columns="citationColumns" caption="Citations and source locators recorded for this request" noun="citations" search-placeholder="Search citations, Evidence IDs, or source paths" empty-table="No citations were recorded for this request.">
                <template #citation-evidence="{ rowData }"><AuditBuildReference v-if="citationEvidenceDigest(rowData.packageId, rowData.packageVersion)" :library="library.name" :identity="rowData.packageId" :version="rowData.packageVersion" kind="evidence" :digest="citationEvidenceDigest(rowData.packageId, rowData.packageVersion)!" :evidence-id="rowData.evidenceId" @inspect-evidence="selectedEvidence = $event" /><span v-else><code>{{ rowData.evidenceId }}</code><small>The exact package build was not recorded.</small></span></template><template #citation-package="{ rowData }"><ResourceLink v-if="packageLink(rowData.packageId, rowData.packageVersion)" kind="installed-entry" :name="rowData.packageId" :library="library.name" /><span v-else>{{ rowData.packageId }}</span></template>
                <template #citation-locator="{ rowData }"><pre>{{ auditJson(rowData.locator) }}</pre></template><template #citation-url="{ rowData }"><a v-if="safeAuditCitationUrl(rowData.url)" class="resource-reference" :href="safeAuditCitationUrl(rowData.url)" target="_blank" rel="noopener noreferrer">{{ rowData.url }}</a><span v-else>{{ rowData.url ? 'Unavailable: unsupported or credential-bearing URL' : 'No source URL recorded' }}</span></template>
              </ConsoleDataTable>
            </section>
          </template>
          <details class="build-identities"><summary>Recorded timing detail</summary><pre>{{ auditJson(event.timing) }}</pre></details>
          <p class="quiet-state">The final validated snapshot and saved audit define this request’s point in time. Later observer activity cannot change its outcome; the next request revalidates state.</p>
        </div>
        <footer class="status-details-footer"><AppButton @click="emit('update:open', false)">Done</AppButton></footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <EvidenceDetailsDrawer :selection="selectedEvidence" @close="selectedEvidence = undefined" />
</template>

<style scoped>
.runtime-audit-drawer pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.runtime-audit-drawer code, .runtime-audit-drawer p, .runtime-audit-drawer :deep(td) { overflow-wrap: anywhere; }
.runtime-audit-drawer .recovery-panel > div { min-width: 0; }
.runtime-audit-drawer summary { cursor: pointer; }
</style>
