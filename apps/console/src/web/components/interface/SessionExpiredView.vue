<script setup lang="ts">
import { Check, Clock3, Copy, RefreshCw, ShieldCheck, Terminal } from '@lucide/vue';
import { ref } from 'vue';
import AppButton from './AppButton.vue';

defineProps<{ detail?: string; reconnecting?: boolean; reconnectError?: string }>();
const emit = defineEmits<{ reconnect: [] }>();
const copied = ref(false);

async function copyCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText('dkb console');
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 2_000);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <main class="session-expired-page">
    <section class="session-expired-panel" aria-labelledby="session-expired-title">
      <header class="session-expired-brand"><span class="brand-mark">D</span><span><b>DKB</b><small>Host Console</small></span></header>
      <div class="session-expired-icon" aria-hidden="true"><Clock3 :size="25" /></div>
      <div class="session-expired-copy">
        <h1 id="session-expired-title">Your Console session expired</h1>
        <p>DKB ends browser sessions after 12 hours and whenever the local Console restarts. Your Libraries, Runtimes, Registries, and installed knowledge are unchanged.</p>
      </div>

      <div class="session-safety-note"><ShieldCheck :size="19" aria-hidden="true" /><span><b>Your DKB data is safe.</b><small>Only this browser's temporary access ended.</small></span></div>

      <div class="session-recovery">
        <h2>Reconnect to the Console</h2>
        <ol>
          <li><span>1</span><div>Open <b>DKB Console</b> from this computer's applications menu.</div></li>
          <li><span>2</span><div>If the launcher is not installed yet, run the command below. DKB will open a fresh, one-time link.</div></li>
        </ol>
        <div class="session-command"><Terminal :size="18" aria-hidden="true" /><code>dkb console</code><AppButton size="sm" variant="quiet" :aria-label="copied ? 'Command copied' : 'Copy dkb console command'" @click="copyCommand"><Check v-if="copied" :size="15" /><Copy v-else :size="15" />{{ copied ? 'Copied' : 'Copy' }}</AppButton></div>
      </div>

      <p v-if="reconnectError" class="session-reconnect-error" role="alert">{{ reconnectError }}</p>
      <div class="session-expired-actions"><AppButton variant="primary" :loading="reconnecting" :disabled="reconnecting" @click="emit('reconnect')"><RefreshCw v-if="!reconnecting" :size="16" />I reopened it — retry</AppButton></div>

      <details v-if="detail" class="session-expired-detail"><summary>Technical details</summary><p>{{ detail }}</p></details>
    </section>
  </main>
</template>
