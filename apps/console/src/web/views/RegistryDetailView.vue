<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { DkbRegistryCatalogPage } from '@sjshovan/dkb-protocol/registryCatalog.js';
import { ArrowLeft } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import { getJson } from '../api.js';
import AppButton from '../components/interface/AppButton.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import ResourceLink from '../components/interface/ResourceLink.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import RegistryCatalogDataTable from '../components/resource/RegistryCatalogDataTable.vue';
import RegistryPipelineDataTable from '../components/resource/RegistryPipelineDataTable.vue';
import RegistryPipelineDetailsDrawer from '../components/resource/RegistryPipelineDetailsDrawer.vue';
import type { RegistryPipeline, RegistryPipelineCatalog, ResourceRow } from '../types.js';

const props = defineProps<{ registry: string }>();
const context = useQuery({
  queryKey: computed(() => ['registry-context', props.registry]),
  queryFn: () => getJson<{ registry: ResourceRow; libraries: ResourceRow[] }>(`/api/v1/registries/${encodeURIComponent(props.registry)}`),
});
const catalog = useQuery({
  queryKey: computed(() => ['registry-catalog', props.registry]),
  queryFn: loadCatalog,
});
const pipelines = useQuery({
  queryKey: computed(() => ['registry-pipelines', props.registry]),
  queryFn: () => getJson<RegistryPipelineCatalog>(`/api/v1/registries/${encodeURIComponent(props.registry)}/pipelines`),
  retry: false,
});
const selectedPipeline = ref<RegistryPipeline>();
const registry = computed(() => context.data.value?.registry);
const libraries = computed(() => context.data.value?.libraries ?? []);
const entries = computed(() => catalog.data.value?.entries ?? []);
async function loadCatalog(): Promise<DkbRegistryCatalogPage> {
  const endpoint = `/api/v1/registries/${encodeURIComponent(props.registry)}/catalog`;
  const first = await getJson<DkbRegistryCatalogPage>(`${endpoint}?type=all&page=1&perPage=100`);
  const lastPage = Math.max(first.pages.dkbs?.lastPage ?? 1, first.pages.collections?.lastPage ?? 1);
  if (lastPage === 1) return first;
  const pages = await Promise.all(Array.from({ length: lastPage - 1 }, (_, index) => getJson<DkbRegistryCatalogPage>(`${endpoint}?type=all&page=${index + 2}&perPage=100`)));
  const entries = [...first.entries, ...pages.flatMap((page) => page.entries)];
  return { ...first, entries: [...new Map(entries.map((entry) => [`${entry.type}:${entry.id}`, entry])).values()] };
}
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
        <dl><div><dt>Endpoint</dt><dd><code>{{ registry.url }}</code></dd></div><div><dt>Access</dt><dd>{{ registry.authenticated ? [registry.credential?.user, registry.credential?.team].filter(Boolean).join(' · ') : 'Public entries only' }}</dd></div><div><dt>Libraries</dt><dd><span v-if="!libraries.length">No connected Libraries</span><span v-else class="resource-reference-list"><ResourceLink v-for="library in libraries" :key="library.name" kind="library" :name="library.name" /></span></dd></div></dl>
      </section>

      <section class="catalog-panel registry-pipeline-panel">
        <header class="section-heading"><div><h2>Trusted compiler Pipelines</h2><p>Recipes this Registry can use to compile signed build variants from one immutable source release.</p></div><span class="count">{{ pipelines.data.value?.pipelines.length ?? 0 }}</span></header>
        <div v-if="pipelines.isPending.value" class="skeleton-stack catalog-skeleton"><span v-for="n in 3" :key="n" /></div>
        <section v-else-if="pipelines.isError.value" class="recovery-panel"><div><h2>Pipeline catalog unavailable</h2><p>{{ pipelines.error.value?.message }}</p><AppButton @click="pipelines.refetch()">Retry</AppButton></div></section>
        <RegistryPipelineDataTable v-else :rows="pipelines.data.value?.pipelines ?? []" @inspect="selectedPipeline = $event" />
      </section>

      <section class="catalog-panel">
        <div v-if="catalog.isPending.value" class="skeleton-stack catalog-skeleton"><span v-for="n in 6" :key="n" /></div>
        <section v-else-if="catalog.isError.value" class="recovery-panel"><div><h2>Catalog unavailable</h2><p>{{ catalog.error.value?.message }}</p><AppButton @click="catalog.refetch()">Retry</AppButton></div></section>
        <EmptyState v-else-if="entries.length === 0" title="No matching Registry entries" message="Try a broader search or choose another catalog type." />
        <RegistryCatalogDataTable v-else :rows="entries" :registry="props.registry" />
      </section>
    </template>
    <RegistryPipelineDetailsDrawer :open="Boolean(selectedPipeline)" :pipeline="selectedPipeline" @update:open="!$event && (selectedPipeline = undefined)" />
  </div>
</template>
