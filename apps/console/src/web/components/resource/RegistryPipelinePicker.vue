<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, ChevronsUpDown, Search, Workflow } from '@lucide/vue';
import { ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxItemIndicator, ComboboxPortal, ComboboxRoot, ComboboxTrigger, ComboboxViewport } from 'reka-ui';
import type { RegistryPipeline } from '../../types.js';
import StatusBadge from '../interface/StatusBadge.vue';

const props = defineProps<{ modelValue: string; pipelines: RegistryPipeline[]; disabled?: boolean; inputId: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const filter = ref('');
const selected = computed(() => props.pipelines.find((item) => item.name === props.modelValue));
const options = computed(() => [...props.pipelines].sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name))
  .filter((item) => [item.name, ...item.providers.map((provider) => provider.id)].join(' ').toLowerCase().includes(filter.value.toLowerCase())));
function choose(value: unknown): void {
  const candidate = props.pipelines.find((item) => item.name === value);
  if (candidate?.available) emit('update:modelValue', candidate.name);
}
</script>

<template>
  <div class="registry-package-picker">
    <ComboboxRoot :model-value="modelValue || undefined" :disabled="disabled" :ignore-filter="true" :reset-search-term-on-blur="false" :reset-search-term-on-select="false" open-on-click open-on-focus @update:model-value="choose">
      <ComboboxAnchor class="registry-package-control"><Search :size="17" aria-hidden="true" /><ComboboxInput :id="inputId" v-model="filter" aria-label="Filter and select a Registry Pipeline" placeholder="Filter Pipelines or providers" /><ComboboxTrigger class="registry-package-trigger" aria-label="Show Registry Pipelines"><ChevronsUpDown :size="17" /></ComboboxTrigger></ComboboxAnchor>
      <ComboboxPortal><ComboboxContent class="registry-package-options" position="popper" align="start" :side-offset="6" :collision-padding="12">
        <header><strong>Trusted Registry Pipelines</strong><span>{{ options.length }} recipes</span></header>
        <ComboboxViewport class="registry-package-viewport">
          <ComboboxEmpty class="registry-package-empty">No Pipelines match this filter.</ComboboxEmpty>
          <ComboboxItem v-for="item in options" :key="item.name" class="registry-package-option" :value="item.name" :disabled="!item.available" :text-value="item.name">
            <Workflow :size="19" aria-hidden="true" /><span class="registry-package-copy"><span><strong>{{ item.name }}</strong><small v-if="item.default">Registry default</small></span><em>{{ item.resolutionError ? 'Provider chain not resolved' : item.providers.map((provider) => provider.id).join(' → ') }}</em><em v-if="item.resolutionError">{{ item.resolutionError.message }}</em><em v-else-if="!item.available">Unavailable — Registry provider health must recover before publication.</em></span>
            <StatusBadge :status="item.available ? 'available' : 'unavailable'" /><ComboboxItemIndicator class="registry-package-selected"><Check :size="16" /></ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent></ComboboxPortal>
    </ComboboxRoot>
    <div v-if="selected" class="registry-package-summary" aria-live="polite"><Workflow :size="18" /><span><strong>{{ selected.name }}{{ selected.default ? ' · Registry default' : '' }}</strong><small>{{ selected.resolutionError ? 'Service requirements not resolved' : selected.requiredServices.length ? `Requires ${selected.requiredServices.join(', ')}` : 'No external services declared' }}</small></span><StatusBadge :status="selected.available ? 'available' : 'unavailable'" /></div>
  </div>
</template>
