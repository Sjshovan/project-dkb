<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { X } from '@lucide/vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import type { DkbEvidenceInspection } from '@sjshovan/dkb-protocol/packageInspection.js';
import AppButton from '../interface/AppButton.vue';
import { getJson } from '../../api.js';
import { installedEntryRoute } from '../../resourceRoutes.js';
import type { AuditEvidenceSelection } from './runtimeAuditPresentation.js';

const props = defineProps<{ selection?: AuditEvidenceSelection }>();
const emit = defineEmits<{ close: [] }>();
const query = useQuery({
  queryKey: computed(() => ['historical-evidence', props.selection]),
  enabled: computed(() => Boolean(props.selection)), retry: false,
  queryFn: () => {
    const value = props.selection!;
    const query = new URLSearchParams({ version: value.version, evidenceDigest: value.evidenceDigest, evidenceId: value.evidenceId });
    return getJson<DkbEvidenceInspection>(`/api/v1${installedEntryRoute(value.library, value.identity)}/evidence?${query}`);
  },
});
const record = computed(() => query.data.value);
</script>

<template>
  <DialogRoot :open="Boolean(selection)" @update:open="!$event && emit('close')">
    <DialogPortal><DialogOverlay class="drawer-overlay" /><DialogContent class="action-drawer status-details-drawer build-details-drawer evidence-details-drawer">
      <header><div><DialogTitle>Evidence record</DialogTitle><DialogDescription>The exact retained record, not a query against the current Runtime.</DialogDescription></div><button type="button" class="icon-button" aria-label="Close Evidence details" @click="emit('close')"><X :size="20" /></button></header>
      <div class="drawer-body">
        <p v-if="query.isPending.value" class="quiet-state" role="status">Validating the retained Evidence Build…</p>
        <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Historical Evidence unavailable</h2><p>{{ query.error.value?.message }}</p><p>No other build or record has been substituted.</p><AppButton @click="query.refetch()">Retry inspection</AppButton></div></section>
        <template v-else-if="record">
          <p class="form-notice">Source content is untrusted data and is displayed as plain text. This inspection checks the stored content identity; it does not certify Registry signatures or activate a Runtime.</p>
          <section><h2>{{ record.title.value }}</h2><p v-if="record.title.truncated">Title truncated from {{ record.title.bytes }} bytes.</p><pre class="evidence-source-text">{{ record.text.value }}</pre><p v-if="record.text.truncated" class="form-notice">Text preview truncated from {{ record.text.bytes }} bytes.</p></section>
          <section class="build-identities"><h2>Recorded identity</h2><dl>
            <div><dt>Package version</dt><dd>{{ record.identity }}@{{ record.version }}</dd></div><div><dt>Evidence ID</dt><dd><code>{{ record.evidenceId }}</code></dd></div><div><dt>Evidence Build</dt><dd><code>{{ record.evidenceDigest }}</code></dd></div><div><dt>Evidence Profile</dt><dd><code>{{ record.evidenceProfileDigest }}</code></dd></div><div><dt>Source ID</dt><dd><code>{{ record.sourceId }}</code></dd></div><div><dt>Source hash</dt><dd><code>{{ record.sourceHash }}</code></dd></div><div><dt>Text hash</dt><dd><code>{{ record.textHash }}</code></dd></div><div><dt>Asset / store</dt><dd>{{ record.assetId }} / {{ record.storeId }}</dd></div><div><dt>Source type</dt><dd>{{ record.sourceType }}</dd></div><div><dt>Chunk span</dt><dd>{{ record.chunk.start }}–{{ record.chunk.end }} · ordinal {{ record.chunk.ordinal }}</dd></div><div><dt>Updated</dt><dd>{{ record.updatedAt }}</dd></div>
          </dl></section>
          <section v-for="field in (['locator', 'assetLocator', 'provenance'] as const)" :key="field"><h2>{{ field === 'locator' ? 'Source locator' : field === 'assetLocator' ? 'Asset locator' : 'Provenance' }}</h2><pre>{{ record[field].value }}</pre><p v-if="record[field].truncated" class="form-notice">Preview truncated from {{ record[field].bytes }} bytes.</p></section>
        </template>
      </div>
      <footer class="status-details-footer"><AppButton @click="emit('close')">Done</AppButton></footer>
    </DialogContent></DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.evidence-details-drawer pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.evidence-details-drawer code, .evidence-details-drawer dd, .evidence-details-drawer h2 { overflow-wrap: anywhere; }
.evidence-source-text { font: inherit; line-height: 1.65; }
.evidence-details-drawer .recovery-panel > div { min-width: 0; }
</style>
