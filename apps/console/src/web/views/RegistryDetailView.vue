<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { DkbRegistryCatalogEntry, DkbRegistryCatalogPage } from '@sjshovan/dkb-protocol/registryCatalog.js';
import { ArrowLeft, ChevronRight, PackageOpen, Search, UsersRound } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import { getJson } from '../api.js';
import AppButton from '../components/interface/AppButton.vue';
import ConsolePagination from '../components/interface/ConsolePagination.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import type { ResourceRow } from '../types.js';

const props = defineProps<{ registry: string }>();
const queryText = ref('');
const appliedQuery = ref('');
const type = ref<'all' | 'dkb' | 'collection'>('all');
const page = ref(1);
const context = useQuery({
  queryKey: computed(() => ['registry-context', props.registry]),
  queryFn: () => getJson<{ registry: ResourceRow; libraries: ResourceRow[] }>(`/api/v1/registries/${encodeURIComponent(props.registry)}`),
});
const catalog = useQuery({
  queryKey: computed(() => ['registry-catalog', props.registry, appliedQuery.value, type.value, page.value]),
  queryFn: () => getJson<DkbRegistryCatalogPage>(`/api/v1/registries/${encodeURIComponent(props.registry)}/catalog?${new URLSearchParams({
    ...(appliedQuery.value ? { q: appliedQuery.value } : {}), type: type.value, page: String(page.value), perPage: '20',
  })}`),
  placeholderData: (previous) => previous,
});
const registry = computed(() => context.data.value?.registry);
const libraries = computed(() => context.data.value?.libraries ?? []);
const entries = computed(() => catalog.data.value?.entries ?? []);
const lastPage = computed(() => Math.max(catalog.data.value?.pages.dkbs?.lastPage ?? 1, catalog.data.value?.pages.collections?.lastPage ?? 1));
const catalogTotal = computed(() => Object.values(catalog.data.value?.pages ?? {}).reduce((total, value) => total + value.total, 0));
const paginationSummary = computed(() => `Page ${page.value} of ${lastPage.value} · ${catalogTotal.value} matching ${catalogTotal.value === 1 ? 'entry' : 'entries'}`);

function applySearch(): void { appliedQuery.value = queryText.value.trim(); page.value = 1; }
function selectType(value: 'all' | 'dkb' | 'collection'): void { type.value = value; page.value = 1; }
function entryRoute(entry: DkbRegistryCatalogEntry): string {
  return `/registries/${encodeURIComponent(props.registry)}/${entry.type === 'dkb' ? 'dkbs' : 'collections'}/${encodeURIComponent(entry.namespace)}/${encodeURIComponent(entry.slug)}`;
}
function releaseLabel(entry: DkbRegistryCatalogEntry): string { return entry.type === 'dkb' ? entry.latestVersion ?? 'No release' : entry.latestRevision ? `Revision ${entry.latestRevision}` : 'No revision'; }
function formatDate(value?: string | null): string { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : 'Not published'; }

watch(lastPage, (value) => {
  if (page.value > value) page.value = value;
});
</script>

<template>
  <div class="page registry-detail-page">
    <RouterLink class="back-link" to="/registries"><ArrowLeft :size="16" />Registries</RouterLink>
    <div v-if="context.isPending.value" class="skeleton-stack"><span v-for="n in 5" :key="n" /></div>
    <section v-else-if="context.isError.value" class="recovery-panel"><div><h2>Registry unavailable</h2><p>{{ context.error.value?.message }}</p><AppButton @click="context.refetch()">Try again</AppButton></div></section>
    <template v-else-if="registry">
      <PageHeader :title="registry.displayName ?? registry.name" description="Browse signed DKB releases and immutable Collections available through this Registry.">
        <template #actions><StatusBadge :status="registry.status" /><StatusBadge :status="registry.authenticated ? 'authenticated' : 'anonymous'" /></template>
      </PageHeader>
      <section class="registry-context-card">
        <dl><div><dt>Endpoint</dt><dd><code>{{ registry.url }}</code></dd></div><div><dt>Access</dt><dd>{{ registry.authenticated ? [registry.credential?.user, registry.credential?.team].filter(Boolean).join(' · ') : 'Public entries only' }}</dd></div><div><dt>Libraries</dt><dd>{{ libraries.length ? libraries.map((item) => item.name).join(', ') : 'No connected Libraries' }}</dd></div></dl>
      </section>

      <section class="catalog-panel">
        <header class="catalog-toolbar">
          <form role="search" @submit.prevent="applySearch"><Search :size="17" aria-hidden="true" /><input v-model="queryText" aria-label="Search Registry" placeholder="Search identity, namespace, name, or description" /><AppButton type="submit" size="sm">Search</AppButton></form>
          <div class="segment-control" aria-label="Catalog type"><button v-for="option in (['all', 'dkb', 'collection'] as const)" :key="option" type="button" :aria-pressed="type === option" @click="selectType(option)">{{ option === 'all' ? 'All' : option === 'dkb' ? 'DKBs' : 'Collections' }}</button></div>
        </header>
        <div v-if="catalog.isPending.value" class="skeleton-stack catalog-skeleton"><span v-for="n in 6" :key="n" /></div>
        <section v-else-if="catalog.isError.value" class="recovery-panel"><div><h2>Catalog unavailable</h2><p>{{ catalog.error.value?.message }}</p><AppButton @click="catalog.refetch()">Retry</AppButton></div></section>
        <EmptyState v-else-if="entries.length === 0" title="No matching Registry entries" message="Try a broader search or choose another catalog type." />
        <template v-else>
          <div class="catalog-grid">
            <RouterLink v-for="entry in entries" :key="`${entry.type}:${entry.id}`" class="catalog-entry" :to="entryRoute(entry)">
              <component :is="entry.type === 'dkb' ? PackageOpen : UsersRound" :size="20" />
              <span><small>{{ entry.type === 'dkb' ? 'DKB' : 'Collection' }}</small><strong>{{ entry.id }}</strong><em>{{ entry.description || 'No description provided.' }}</em></span>
              <span class="catalog-entry-meta"><StatusBadge :status="entry.visibility" /><b>{{ releaseLabel(entry) }}</b><small>{{ formatDate(entry.publishedAt) }}</small><ChevronRight :size="17" /></span>
            </RouterLink>
          </div>
          <ConsolePagination v-if="lastPage > 1" :page="page" :total-pages="lastPage" :summary="paginationSummary" pagination-label="Registry catalog pagination" :disabled="catalog.isFetching.value" @update:page="page = $event" />
        </template>
      </section>
    </template>
  </div>
</template>
