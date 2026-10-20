<script setup lang="ts">
import { computed } from 'vue';
import { Fingerprint, HeartPulse, Layers3, ServerCog, X } from '@lucide/vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import AppButton from '../interface/AppButton.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import type { RegistryPipeline } from '../../types.js';

const props = defineProps<{ open: boolean; pipeline?: RegistryPipeline }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const healthRows = computed(() => (props.pipeline?.health ?? []).map((value) => ({ name: `${value.kind} · ${value.id}`, detail: value.detail ?? (value.ok ? 'Ready' : 'Unavailable'), ok: value.ok })));
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="drawer-overlay" />
      <DialogContent class="action-drawer status-details-drawer registry-pipeline-drawer">
        <header><div><DialogTitle>{{ pipeline?.name ?? 'Registry Pipeline' }}</DialogTitle><DialogDescription>The exact trusted compiler recipe advertised by this Registry.</DialogDescription></div><button class="icon-button" type="button" aria-label="Close Pipeline details" @click="emit('update:open', false)"><X :size="20" /></button></header>
        <div v-if="pipeline" class="drawer-body">
          <section class="build-drawer-summary"><div><span class="build-type-icon"><Layers3 :size="19" /></span><span><strong>{{ pipeline.name }}</strong><small>{{ pipeline.default ? 'Publication default' : 'Optional build recipe' }}</small></span><StatusBadge :status="pipeline.available ? 'available' : 'unavailable'" /></div><dl v-if="!pipeline.resolutionError"><div><dt>Providers</dt><dd>{{ pipeline.providers.length }}</dd></div><div><dt>Processors</dt><dd>{{ pipeline.processors.length }}</dd></div><div><dt>Required services</dt><dd>{{ pipeline.requiredServices.length }}</dd></div></dl></section>
          <section v-if="pipeline.resolutionError" class="recovery-panel" role="status">
            <div><h2>Recipe identity unavailable</h2><p>{{ pipeline.resolutionError.message }}</p><p>Provider receipts, service requirements and compatibility digests have not been verified. This recipe cannot be selected for compilation.</p><p>Installed compiler: <code>{{ pipeline.compilerBuildDigest }}</code></p></div>
          </section>
          <template v-else>
          <section class="build-recipe"><div class="build-drawer-heading"><ServerCog :size="18" /><span><h2>Provider chain</h2><p>Loaded in this exact order by the trusted compiler context.</p></span></div><ul class="build-provider-list"><li v-for="provider in pipeline.providers" :key="`${provider.kind}:${provider.id}`"><span><strong>{{ provider.kind }}</strong><code>{{ provider.id }}</code></span><small>v{{ provider.version }} · {{ provider.integrityDigest.slice(0, 14) }}…</small></li></ul><div v-if="pipeline.processors.length" class="build-processors"><strong>Ordered processors</strong><span v-for="processor in pipeline.processors" :key="`${processor.stage}:${processor.id}`">{{ processor.stage }} · {{ processor.id }}@{{ processor.version }}</span></div></section>
          <section class="build-identities"><div class="build-drawer-heading"><Fingerprint :size="18" /><span><h2>Recipe identity</h2><p>Names are labels; these digests control deterministic reuse and activation.</p></span></div><dl><div><dt>Installed compiler</dt><dd><code>{{ pipeline.compilerBuildDigest }}</code></dd></div><div><dt>Provider chain</dt><dd><code>{{ pipeline.buildDigest }}</code></dd></div><div><dt>Evidence Profile</dt><dd><code>{{ pipeline.evidenceProfileDigest }}</code></dd></div><div><dt>Retrieval Profile</dt><dd><code>{{ pipeline.retrievalProfileDigest }}</code></dd></div><div><dt>Compatibility</dt><dd><code>{{ pipeline.compatibilityDigest }}</code></dd></div></dl></section>
          <section class="build-recipe"><div class="build-drawer-heading"><HeartPulse :size="18" /><span><h2>Availability</h2><p>Services and health reported by the Registry compiler.</p></span></div><p v-if="!pipeline.requiredServices.length" class="quiet-state">No external services are required.</p><ul v-else class="build-provider-list"><li v-for="service in pipeline.requiredServices" :key="service"><span><strong>{{ service }}</strong><small>Required by this recipe</small></span></li></ul><ul v-if="healthRows.length" class="build-provider-list"><li v-for="row in healthRows" :key="row.name"><span><strong>{{ row.name }}</strong><small>{{ row.detail }}</small></span><StatusBadge :status="row.ok ? 'ready' : 'unavailable'" /></li></ul></section>
          </template>
        </div>
        <footer class="status-details-footer"><AppButton @click="emit('update:open', false)">Done</AppButton></footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
