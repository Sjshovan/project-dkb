<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue';
import { FileStack } from '@lucide/vue';
import type { DkbBuildTrustVerification, DkbInstalledBuildSummary, DkbInstalledEntryDetail } from '@sjshovan/dkb-protocol/packageInspection.js';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { followOperation, startOperation } from '../../api.js';
import OperationTimeline from './OperationTimeline.vue';
import StoredBuildDataTable from './StoredBuildDataTable.vue';
import type { InstalledBuildSelection } from '../../resourceRoutes.js';

const props = defineProps<{ detail: DkbInstalledEntryDetail; library: string; initialBuild?: InstalledBuildSelection }>();
const selectedBuild = ref<DkbInstalledBuildSummary>();
const BuildDetailsDrawer = defineAsyncComponent(() => import('./BuildDetailsDrawer.vue'));
const verifications = ref<Record<string, DkbBuildTrustVerification>>({});
const verifying = ref(false);
const error = ref('');
const events = ref<DkbCommandEvent[]>([]);
let unsubscribe: (() => void) | undefined;
watch(() => props.detail, () => { verifications.value = {}; selectedBuild.value = undefined; });
const requestedBuild = computed(() => {
  if (!props.initialBuild || props.detail.status !== 'installed' || props.detail.version !== props.initialBuild.version) return undefined;
  const matches = props.detail.builds.filter((build) => build.kind === props.initialBuild!.kind && build.buildDigest === props.initialBuild!.buildDigest);
  return matches.length === 1 ? matches[0] : undefined;
});
watch([() => props.initialBuild, () => props.detail], () => { if (props.initialBuild) selectedBuild.value = requestedBuild.value; }, { immediate: true });
onBeforeUnmount(() => unsubscribe?.());
function trust(build: DkbInstalledBuildSummary): string {
  const result = verifications.value[build.buildDigest];
  if (result?.status === 'registry-verified') return 'Registry verified';
  if (result?.status === 'failed') return 'Failed';
  if (result?.status === 'local-verified') return 'Local · hashes verified';
  return props.detail.source === 'local' ? 'Local build' : 'Unverified';
}
async function verify(): Promise<void> {
  if (verifying.value || !selectedBuild.value) return;
  const digest = selectedBuild.value.buildDigest;
  verifying.value = true; error.value = ''; events.value = []; unsubscribe?.();
  try {
    const id = await startOperation('package.build.verify', { library: props.library, identity: props.detail.identity, buildDigest: digest });
    unsubscribe = followOperation(id, (event) => {
      events.value.push(event);
      if (event.event === 'result') {
        const value = event.value as DkbBuildTrustVerification;
        if (value.format === 'dkb.build-trust.v1' && value.buildDigest === digest && value.identity === props.detail.identity) verifications.value[digest] = value;
      }
      if (event.event === 'failure') error.value = event.error.message;
      if (event.event === 'completion') { verifying.value = false; if (event.status !== 'succeeded' && !verifications.value[digest] && !error.value) error.value = 'Build verification did not complete. Review the operation details and retry.'; }
    });
  } catch (cause) { verifying.value = false; error.value = cause instanceof Error ? cause.message : String(cause); }
}

function shortDigest(value?: string): string {
  if (!value) return 'Unavailable';
  return value.length > 24 ? `${value.slice(0, 21)}…` : value;
}

</script>

<template>
  <div class="build-chain build-chain--library" aria-label="Library package build storage">
    <article><FileStack :size="20" /><span><small>Package version</small><strong>{{ detail.identity }}@{{ detail.version }}</strong><code>{{ shortDigest(detail.provenance.sourceDigest ?? detail.digest) }}</code></span></article>
  </div>

  <section class="stored-builds">
    <header><div><h2>Stored builds</h2><p>Immutable Evidence and Retrieval Builds are shared by Runtime activations and remain reusable until explicitly pruned.</p></div><span class="count">{{ detail.builds.length }}</span></header>
    <p>Receipt presence is not signature verification. Inspect a build and run Verify for a one-time check of its exact stored chain.</p>
    <p v-if="initialBuild && !requestedBuild" class="form-notice" role="status">The exact {{ initialBuild.kind }} build for version {{ initialBuild.version }} is no longer available here. No different version or build was opened.</p>
    <StoredBuildDataTable v-if="detail.builds.length" :rows="detail.builds" :trust="trust" @inspect="selectedBuild = $event" />
    <div v-else class="quiet-state">No stored builds were found.</div>
  </section>

  <OperationTimeline :events="events" />
  <BuildDetailsDrawer v-if="selectedBuild" :open="true" :build="selectedBuild" :trust="trust(selectedBuild)" :verification="verifications[selectedBuild.buildDigest]" :verifying="verifying" :error="error" @verify="verify" @update:open="!$event && (selectedBuild = undefined)" />
</template>
