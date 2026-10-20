<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { DkbInstalledEntryDetail } from '@sjshovan/dkb-protocol/packageInspection.js';
import { getJson } from '../../api.js';
import { installedBuildRoute, installedEntryRoute } from '../../resourceRoutes.js';
import { retainedAuditBuild, type AuditEvidenceSelection } from './runtimeAuditPresentation.js';

const props = defineProps<{
  library?: string; identity: string; version: string; kind: 'evidence' | 'retrieval'; digest: string;
  evidenceDigest?: string; evidenceId?: string;
}>();
const emit = defineEmits<{ inspectEvidence: [selection: AuditEvidenceSelection] }>();
const entryPath = computed(() => props.library ? installedEntryRoute(props.library, props.identity) : undefined);
const detail = useQuery({
  queryKey: computed(() => ['installed-entry', props.library, props.identity]),
  enabled: computed(() => Boolean(entryPath.value)),
  queryFn: () => getJson<DkbInstalledEntryDetail>(`/api/v1${entryPath.value}`), retry: false,
});
const retained = computed(() => !detail.isFetching.value && !detail.isError.value ? retainedAuditBuild(detail.data.value, props) : undefined);
const to = computed(() => retained.value && props.library ? installedBuildRoute(props.library, props.identity, {
  version: props.version, kind: props.kind, buildDigest: props.digest,
}) : undefined);
function inspectEvidence(): void {
  if (retained.value && props.library && props.evidenceId && props.kind === 'evidence') emit('inspectEvidence', {
    library: props.library, identity: props.identity, version: props.version, evidenceDigest: props.digest, evidenceId: props.evidenceId,
  });
}
</script>

<template>
  <span class="audit-build-reference">
    <button v-if="to && evidenceId && kind === 'evidence'" type="button" class="resource-reference resource-reference--button" @click="inspectEvidence"><code>{{ evidenceId }}</code></button>
    <a v-else-if="to" class="resource-reference" :href="to"><code>{{ digest }}</code></a>
    <code v-else>{{ evidenceId ?? digest }}</code>
    <small v-if="entryPath && detail.isFetching.value" role="status">Checking retained build…</small>
    <small v-else-if="!to">{{ !library ? 'Historical Library unavailable.' : detail.isError.value ? 'Build inspection unavailable. Retry from the package view.' : 'Exact version or build no longer retained.' }}</small>
  </span>
</template>

<style scoped>
.audit-build-reference { display: grid; gap: .25rem; min-width: 0; overflow-wrap: anywhere; }
.audit-build-reference button { text-align: start; }
.audit-build-reference small { color: var(--muted); }
</style>
