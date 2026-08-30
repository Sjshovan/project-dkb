<script setup lang="ts">
import { computed } from 'vue';
import { Clipboard, ShieldCheck } from '@lucide/vue';
import { toast } from 'vue-sonner';
import type { DkbInspectionCheck } from '@sjshovan/dkb-protocol/packageInspection.js';
import AppButton from '../interface/AppButton.vue';
import EmptyState from '../interface/EmptyState.vue';
import StatusBadge from '../interface/StatusBadge.vue';

const props = defineProps<{ checks: DkbInspectionCheck[]; recovery?: string[] }>();
const ordered = computed(() => [...props.checks].sort((left, right) => severity(left.status) - severity(right.status)));

async function copy(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    toast.success('Recovery command copied.');
  } catch {
    toast.error('Could not copy the recovery command.');
  }
}

function severity(status: DkbInspectionCheck['status']): number {
  return ({ failed: 0, warning: 1, passed: 2, not_applicable: 3 })[status];
}
</script>

<template>
  <EmptyState v-if="checks.length === 0" title="No integrity checks" message="This entry does not expose any applicable checks." />
  <div v-else class="inspection-checks">
    <ul>
      <li v-for="item in ordered" :key="item.id">
        <div>
          <strong>{{ item.label }}</strong>
          <p>{{ item.message }}</p>
          <code v-if="item.recovery">{{ item.recovery }}</code>
        </div>
        <div class="inspection-check-actions">
          <StatusBadge :status="item.status" />
          <AppButton v-if="item.recovery" size="sm" variant="quiet" :aria-label="`Copy recovery command for ${item.label}`" @click="copy(item.recovery)"><Clipboard :size="14" />Copy</AppButton>
        </div>
      </li>
    </ul>
    <div v-if="recovery?.length" class="recovery-command-list">
      <header><ShieldCheck :size="18" /><div><strong>Recovery sequence</strong><small>Run only the commands that correspond to the failed checks above.</small></div></header>
      <div v-for="command in recovery" :key="command"><code>{{ command }}</code><AppButton size="sm" variant="quiet" aria-label="Copy recovery command" @click="copy(command)"><Clipboard :size="14" />Copy</AppButton></div>
    </div>
  </div>
</template>
