<script setup lang="ts">
import { computed } from 'vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { X } from '@lucide/vue';
import type { ResourceKind, ResourceRow } from '../../types.js';
import AppButton from '../interface/AppButton.vue';
import StatusBadge from '../interface/StatusBadge.vue';
import { healthCheckStatus } from './healthStatus.js';

const props = defineProps<{
  open: boolean;
  kind: ResourceKind;
  row?: ResourceRow;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const title = computed(() => props.row ? `${props.row.name} status` : 'Status details');
const description = computed(() => `Results from the most recent one-time ${singular(props.kind)} check.`);
const location = computed(() => props.row?.path ?? props.row?.url ?? props.row?.stateRoot);

function singular(kind: ResourceKind): string {
  return kind === 'libraries' ? 'Library' : kind === 'runtimes' ? 'Runtime' : kind === 'registries' ? 'Registry' : 'Stack';
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="drawer-overlay" />
      <DialogContent class="action-drawer status-details-drawer">
        <header>
          <div><DialogTitle>{{ title }}</DialogTitle><DialogDescription>{{ description }}</DialogDescription></div>
          <button class="icon-button" type="button" aria-label="Close status details" @click="emit('update:open', false)"><X :size="20" /></button>
        </header>

        <div v-if="row" class="drawer-body">
          <section class="health-summary" aria-label="Resource status summary">
            <div><span>Current status</span><StatusBadge :status="row.status" /></div>
            <p v-if="row.message">{{ row.message }}</p>
            <dl v-if="location">
              <div><dt>Location</dt><dd>{{ location }}</dd></div>
            </dl>
          </section>

          <section v-if="row.checks?.length" class="health-check-results" aria-labelledby="health-check-results-title">
            <h2 id="health-check-results-title">Checks</h2>
            <ul>
              <li v-for="(check, index) in row.checks" :key="`${check.name ?? check.component ?? 'check'}-${index}`">
                <div>
                  <strong>{{ check.name ?? check.component ?? `Check ${index + 1}` }}</strong>
                  <small>{{ check.message || 'No additional detail was returned.' }}</small>
                </div>
                <StatusBadge :status="healthCheckStatus(check)" />
              </li>
            </ul>
          </section>

          <p v-else-if="!row.message" class="quiet-state">No additional details were returned for this resource.</p>
        </div>

        <footer class="status-details-footer"><AppButton @click="emit('update:open', false)">Done</AppButton></footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
