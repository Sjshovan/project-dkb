<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { DkbRegistrySourceInventoryPage, DkbSourceInventoryEntry } from '@sjshovan/dkb-protocol/registryCatalog.js';
import { File, FolderTree } from '@lucide/vue';
import { getJson } from '../../api.js';
import AppButton from '../interface/AppButton.vue';
import EmptyState from '../interface/EmptyState.vue';

const props = defineProps<{ registry: string; namespace: string; name: string; version: string }>();
const entries = ref<DkbSourceInventoryEntry[]>([]);
const cursor = ref<string>();
const route = computed(() => `/api/v1/registries/${encodeURIComponent(props.registry)}/dkbs/${encodeURIComponent(props.namespace)}/${encodeURIComponent(props.name)}/contents?${new URLSearchParams({ version: props.version, path: '.', limit: '100', ...(cursor.value ? { cursor: cursor.value } : {}) })}`);
const query = useQuery({ queryKey: computed(() => ['registry-contents', props.registry, props.namespace, props.name, props.version, cursor.value]), queryFn: () => getJson<DkbRegistrySourceInventoryPage>(route.value) });
const inventory = computed(() => query.data.value?.sourceInventory);
watch(() => [props.registry, props.namespace, props.name, props.version], () => { entries.value = []; cursor.value = undefined; });
watch(() => query.data.value, (value) => {
  if (!value) return;
  const seen = new Set(entries.value.map((item) => item.path));
  entries.value.push(...value.entries.filter((item) => !seen.has(item.path)));
}, { immediate: true });
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(1)} MiB`; }
function shortHash(value: string): string { return value.length > 24 ? `${value.slice(0, 21)}…` : value; }
</script>

<template>
  <div class="remote-contents">
    <header><div><FolderTree :size="19" /><span><strong>Signed source inventory</strong><small>Metadata only. Install this release to preview file bodies locally.</small></span></div><dl v-if="inventory"><div><dt>Files</dt><dd>{{ inventory.count }}</dd></div><div><dt>Inventory</dt><dd><code>{{ shortHash(inventory.hash) }}</code></dd></div></dl></header>
    <div v-if="query.isPending.value && entries.length === 0" class="skeleton-stack"><span v-for="n in 8" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Source inventory unavailable</h2><p>{{ query.error.value?.message }}</p><AppButton @click="query.refetch()">Retry</AppButton></div></section>
    <EmptyState v-else-if="entries.length === 0" title="No portable source files" message="This release did not publish a source inventory." />
    <ul v-else><li v-for="entry in entries" :key="entry.path"><File :size="17" /><span><strong>{{ entry.path }}</strong><small>{{ formatBytes(entry.bytes) }}</small></span><code :title="entry.hash">{{ shortHash(entry.hash) }}</code></li></ul>
    <footer v-if="query.data.value?.nextCursor"><AppButton :loading="query.isFetching.value" @click="cursor = query.data.value?.nextCursor ?? undefined">Load more files</AppButton></footer>
  </div>
</template>
