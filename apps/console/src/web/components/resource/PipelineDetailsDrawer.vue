<script setup lang="ts">
import { computed } from 'vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { CheckCircle2, X } from '@lucide/vue';
import type { PipelineTarget } from '../../types.js';
import AppButton from '../interface/AppButton.vue';
import ResourceLink from '../interface/ResourceLink.vue';
import StatusBadge from '../interface/StatusBadge.vue';

const props = defineProps<{
  open: boolean;
  runtime: string;
  target?: PipelineTarget;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const failures = computed(() => props.target?.healthDetails.filter((item) => !item.ok) ?? []);
const missingBuilds = computed(() => props.target ? Math.max(0, props.target.coverage.total - props.target.coverage.ready) : 0);
const title = computed(() => props.target ? `${props.target.name} availability` : 'Pipeline availability');
const description = computed(() => `Resolved for ${props.runtime || 'the selected Runtime'} using the latest one-time Pipeline check.`);
const statusMessage = computed(() => {
  if (!props.target) return '';
  if (props.target.health === 'unavailable') {
    const count = failures.value.length;
    return `${count} required ${count === 1 ? 'provider is' : 'providers are'} not healthy, so DKB will not activate this Pipeline.`;
  }
  if (props.target.active) return 'This is the Pipeline currently serving queries for this Runtime.';
  return 'Every required provider passed its health check. DKB can prepare missing builds before activation.';
});

function providerKind(kind: string): string {
  return kind === 'embedding' ? 'Embedding provider' : kind === 'index' ? 'Index provider' : kind === 'retrieval' ? 'Retrieval provider' : `${kind} provider`;
}

function checkExplanation(check: PipelineTarget['healthDetails'][number]): string {
  if (check.ok) return 'The provider responded successfully.';
  if (check.detail?.toLowerCase() === 'fetch failed') return 'The provider health endpoint could not be reached from this Runtime context.';
  return 'This provider did not pass its required health check.';
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="drawer-overlay" />
      <DialogContent class="action-drawer status-details-drawer pipeline-details-drawer">
        <header>
          <div><DialogTitle>{{ title }}</DialogTitle><DialogDescription>{{ description }}</DialogDescription></div>
          <button class="icon-button" type="button" aria-label="Close Pipeline details" @click="emit('update:open', false)"><X :size="20" /></button>
        </header>

        <div v-if="target" class="drawer-body">
          <section class="health-summary" :class="`health-summary--${target.health}`" aria-label="Pipeline availability summary">
            <div>
              <span>Current status</span>
              <div class="pipeline-detail-status"><span v-if="target.active" class="pipeline-active-badge"><CheckCircle2 :size="14" />Active</span><StatusBadge :status="target.health" /></div>
            </div>
            <p>{{ statusMessage }}</p>
            <dl>
              <div><dt>Runtime</dt><dd><ResourceLink kind="runtime" :name="runtime" /></dd></div>
              <div><dt>Definition</dt><dd>{{ target.origin }}</dd></div>
              <div><dt>Package coverage</dt><dd>{{ target.coverage.ready }}/{{ target.coverage.total }} builds ready<span v-if="missingBuilds"> · {{ missingBuilds }} will be prepared</span></dd></div>
            </dl>
          </section>

          <section class="health-check-results" aria-labelledby="pipeline-provider-checks-title">
            <h2 id="pipeline-provider-checks-title">Provider checks</h2>
            <ul>
              <li v-for="check in target.healthDetails" :key="`${check.kind}:${check.id}`">
                <div>
                  <strong>{{ providerKind(check.kind) }}</strong>
                  <code>{{ check.id }}</code>
                  <small>{{ checkExplanation(check) }}</small>
                  <small v-if="check.detail" class="pipeline-raw-detail">Reported: {{ check.detail }}</small>
                </div>
                <StatusBadge :status="check.ok ? 'ready' : 'unavailable'" />
              </li>
            </ul>
          </section>

          <section class="pipeline-resolution" aria-labelledby="pipeline-resolution-title">
            <h2 id="pipeline-resolution-title">Resolved Pipeline</h2>
            <dl>
              <div><dt>Provider chain</dt><dd>{{ target.providers.join(' → ') }}</dd></div>
              <div><dt>Embedding</dt><dd>{{ target.dimensions === null ? 'Unavailable' : `${target.dimensions} dimensions · ${target.metric ?? 'unknown metric'}` }}</dd></div>
              <div><dt>Required services</dt><dd>{{ target.requiredServices.join(', ') || 'None' }}</dd></div>
              <div><dt>Compatibility</dt><dd><code>{{ target.compatibilityDigest ?? 'Unavailable until the Pipeline resolves' }}</code></dd></div>
            </dl>
          </section>

          <section v-if="target.health === 'unavailable'" class="pipeline-recovery-note">
            <strong>How to recover</strong>
            <p>Start or repair the failed provider service, then refresh this page. DKB preserves the currently active Pipeline until every required check passes.</p>
          </section>
        </div>

        <footer class="status-details-footer"><AppButton @click="emit('update:open', false)">Done</AppButton></footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
