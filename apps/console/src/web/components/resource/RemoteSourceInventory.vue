<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { DkbRegistrySourceInventoryPage } from '@sjshovan/dkb-protocol/registryCatalog.js';
import { FolderTree } from '@lucide/vue';
import { getJson } from '../../api.js';
import AppButton from '../interface/AppButton.vue';
import SourceInventoryDataTable from './SourceInventoryDataTable.vue';

const props = defineProps<{ registry: string; namespace: string; name: string; version: string }>();
const route = computed(() => `/api/v1/registries/${encodeURIComponent(props.registry)}/dkbs/${encodeURIComponent(props.namespace)}/${encodeURIComponent(props.name)}/contents`);
const query = useQuery({ queryKey: computed(() => ['registry-contents', props.registry, props.namespace, props.name, props.version]), queryFn: loadInventory });
const inventory = computed(() => query.data.value?.sourceInventory);
async function loadInventory(): Promise<DkbRegistrySourceInventoryPage> {
  let page = await getJson<DkbRegistrySourceInventoryPage>(`${route.value}?${new URLSearchParams({ version: props.version, path: '.', limit: '200' })}`);
  const entries = [...page.entries];
  while (page.nextCursor) {
    page = await getJson<DkbRegistrySourceInventoryPage>(`${route.value}?${new URLSearchParams({ version: props.version, path: '.', limit: '200', cursor: page.nextCursor })}`);
    entries.push(...page.entries);
  }
  return { ...page, entries };
}
function shortHash(value: string): string { return value.length > 24 ? `${value.slice(0, 21)}…` : value; }
</script>

<template>
  <div class="remote-contents">
    <header><div><FolderTree :size="19" /><span><strong>Signed source inventory</strong><small>Metadata only. Install this release to preview file bodies locally.</small></span></div><dl v-if="inventory"><div><dt>Files</dt><dd>{{ inventory.count }}</dd></div><div><dt>Inventory</dt><dd><code>{{ shortHash(inventory.hash) }}</code></dd></div></dl></header>
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 8" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Source inventory unavailable</h2><p>{{ query.error.value?.message }}</p><AppButton @click="query.refetch()">Retry</AppButton></div></section>
    <SourceInventoryDataTable v-else :rows="query.data.value?.entries ?? []" />
  </div>
</template>
