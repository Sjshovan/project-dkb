<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { DkbRegistryCatalogEntry, DkbRegistryCatalogPage } from '@sjshovan/dkb-protocol/registryCatalog.js';
import { Check, ChevronsUpDown, PackageOpen, Search, UsersRound } from '@lucide/vue';
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from 'reka-ui';
import { getJson } from '../../api.js';
import StatusBadge from '../interface/StatusBadge.vue';

const props = withDefaults(defineProps<{
  registry: string;
  modelValue: string;
  inputId?: string;
}>(), { inputId: 'registry-package-filter' });

const emit = defineEmits<{
  'update:modelValue': [value: string];
  select: [entry: DkbRegistryCatalogEntry | undefined];
}>();

const filter = ref('');
const appliedFilter = ref('');
const selectedEntry = ref<DkbRegistryCatalogEntry>();
let filterTimer: number | undefined;

const catalog = useQuery({
  queryKey: computed(() => ['registry-install-catalog', props.registry, appliedFilter.value]),
  queryFn: () => getJson<DkbRegistryCatalogPage>(`/api/v1/registries/${encodeURIComponent(props.registry)}/catalog?${new URLSearchParams({
    ...(appliedFilter.value ? { q: appliedFilter.value } : {}),
    type: 'all',
    page: '1',
    perPage: '50',
  })}`),
  enabled: computed(() => Boolean(props.registry)),
  retry: false,
  staleTime: 15_000,
});

const entries = computed(() => catalog.data.value?.entries ?? []);
const hasMore = computed(() => Object.values(catalog.data.value?.pages ?? {}).some((page) => page.currentPage < page.lastPage));
const resultCount = computed(() => entries.value.length);

watch(() => props.registry, () => reset(), { flush: 'sync' });
watch(filter, (value) => {
  if (selectedEntry.value && value !== selectedEntry.value.id) clearSelection();
  if (filterTimer !== undefined) window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => { appliedFilter.value = value.trim(); }, 250);
});
onBeforeUnmount(() => { if (filterTimer !== undefined) window.clearTimeout(filterTimer); });

function choose(value: unknown): void {
  if (typeof value !== 'string') return;
  const entry = entries.value.find((candidate) => candidate.id === value);
  if (!entry || !isInstallable(entry)) return;
  selectedEntry.value = entry;
  filter.value = entry.id;
  emit('update:modelValue', entry.id);
  emit('select', entry);
}

function clearSelection(): void {
  selectedEntry.value = undefined;
  emit('update:modelValue', '');
  emit('select', undefined);
}

function reset(): void {
  if (filterTimer !== undefined) window.clearTimeout(filterTimer);
  filter.value = '';
  appliedFilter.value = '';
  clearSelection();
}

function isInstallable(entry: DkbRegistryCatalogEntry): boolean {
  return entry.type === 'dkb' ? Boolean(entry.latestVersion) : Boolean(entry.latestRevision);
}

function releaseLabel(entry: DkbRegistryCatalogEntry): string {
  if (entry.type === 'dkb') return entry.latestVersion ? `Version ${entry.latestVersion}` : 'No published version';
  return entry.latestRevision ? `Revision ${entry.latestRevision}` : 'No published revision';
}

function formatDate(value?: string | null): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : 'Not published';
}

</script>

<template>
  <div class="registry-package-picker">
    <ComboboxRoot
      :model-value="props.modelValue || undefined"
      :ignore-filter="true"
      :reset-search-term-on-blur="false"
      :reset-search-term-on-select="false"
      open-on-focus
      open-on-click
      @update:model-value="choose"
    >
      <ComboboxAnchor class="registry-package-control">
        <Search :size="17" aria-hidden="true" />
        <ComboboxInput
          :id="props.inputId"
          v-model="filter"
          aria-label="Filter and select Registry knowledge"
          placeholder="Filter by name, namespace, or description"
        />
        <ComboboxTrigger class="registry-package-trigger" aria-label="Show available Registry knowledge"><ChevronsUpDown :size="17" /></ComboboxTrigger>
      </ComboboxAnchor>

      <ComboboxPortal>
        <ComboboxContent class="registry-package-options" position="popper" align="start" :side-offset="6" :collision-padding="12">
          <header><strong>Available knowledge</strong><span v-if="!catalog.isPending.value && !catalog.isError.value">{{ resultCount }} {{ resultCount === 1 ? 'match' : 'matches' }}</span></header>
          <div v-if="!props.registry" class="registry-package-empty">Choose a Registry to browse its knowledge.</div>
          <div v-else-if="catalog.isPending.value" class="registry-package-loading" aria-live="polite"><span v-for="item in 4" :key="item" /></div>
          <div v-else-if="catalog.isError.value" class="registry-package-error" role="alert"><strong>{{ props.registry }} is unavailable</strong><p>{{ catalog.error.value?.message }}</p><small>Bring this Registry online or choose another Registry above, then retry.</small><button type="button" @click="catalog.refetch()">Retry catalog</button></div>
          <ComboboxViewport v-else class="registry-package-viewport">
            <ComboboxEmpty class="registry-package-empty">{{ filter ? `No Registry knowledge matches “${filter}”.` : 'This Registry has no published knowledge.' }}</ComboboxEmpty>
            <ComboboxItem
              v-for="entry in entries"
              :key="`${entry.type}:${entry.id}`"
              class="registry-package-option"
              :value="entry.id"
              :text-value="[entry.id, entry.namespace, entry.name, entry.description].filter(Boolean).join(' ')"
              :disabled="!isInstallable(entry)"
            >
              <component :is="entry.type === 'dkb' ? PackageOpen : UsersRound" :size="19" aria-hidden="true" />
              <span class="registry-package-copy"><span><small>{{ entry.type === 'dkb' ? 'DKB' : 'Collection' }}</small><strong>{{ entry.id }}</strong></span><em>{{ entry.description || 'No description provided.' }}</em></span>
              <span class="registry-package-meta"><StatusBadge :status="entry.visibility" /><b>{{ releaseLabel(entry) }}</b><small>{{ formatDate(entry.publishedAt) }}</small></span>
              <ComboboxItemIndicator class="registry-package-selected"><Check :size="16" /></ComboboxItemIndicator>
            </ComboboxItem>
          </ComboboxViewport>
          <footer v-if="hasMore">Showing the first 50 matches. Keep typing to narrow the catalog.</footer>
        </ComboboxContent>
      </ComboboxPortal>
    </ComboboxRoot>

    <div v-if="selectedEntry" class="registry-package-summary" aria-live="polite">
      <component :is="selectedEntry.type === 'dkb' ? PackageOpen : UsersRound" :size="18" aria-hidden="true" />
      <span><strong>{{ selectedEntry.id }}</strong><small>{{ selectedEntry.description || 'No description provided.' }}</small></span>
      <span><StatusBadge :status="selectedEntry.type" /><b>{{ releaseLabel(selectedEntry) }}</b></span>
    </div>
  </div>
</template>
