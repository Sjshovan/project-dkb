<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ArrowLeft, ChevronRight, File, FileArchive, FileCode2, FileImage, Folder, FolderOpen } from '@lucide/vue';
import type { DkbPackageContents, DkbPackagePreview } from '@sjshovan/dkb-protocol/packageInspection.js';
import { getJson } from '../../api.js';
import AppButton from '../interface/AppButton.vue';
import EmptyState from '../interface/EmptyState.vue';
import StatusBadge from '../interface/StatusBadge.vue';

const props = defineProps<{ library: string; namespace: string; name: string }>();
const directory = ref('.');
const listing = ref<DkbPackageContents>();
const preview = ref<DkbPackagePreview>();
const loading = ref(false);
const loadingMore = ref(false);
const previewLoading = ref(false);
const error = ref<string>();
const previewError = ref<string>();

const apiRoot = computed(() => `/api/v1/libraries/${encodeURIComponent(props.library)}/entries/${encodeURIComponent(props.namespace)}/${encodeURIComponent(props.name)}`);
const crumbs = computed(() => directory.value === '.' ? [] : directory.value.split('/'));

watch(apiRoot, () => void openDirectory('.'), { immediate: true });

async function openDirectory(path: string): Promise<void> {
  directory.value = path || '.';
  listing.value = undefined;
  preview.value = undefined;
  error.value = undefined;
  loading.value = true;
  try {
    listing.value = await getJson<DkbPackageContents>(`${apiRoot.value}/contents?path=${encodeURIComponent(directory.value)}&limit=100`);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (!listing.value?.nextCursor || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const page = await getJson<DkbPackageContents>(`${apiRoot.value}/contents?path=${encodeURIComponent(directory.value)}&cursor=${encodeURIComponent(listing.value.nextCursor)}&limit=100`);
    listing.value = { ...page, entries: [...listing.value.entries, ...page.entries] };
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loadingMore.value = false;
  }
}

async function openFile(path: string): Promise<void> {
  preview.value = undefined;
  previewError.value = undefined;
  previewLoading.value = true;
  try {
    preview.value = await getJson<DkbPackagePreview>(`${apiRoot.value}/preview?path=${encodeURIComponent(path)}`);
  } catch (cause) {
    previewError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    previewLoading.value = false;
  }
}

function openCrumb(index: number): void {
  void openDirectory(index < 0 ? '.' : crumbs.value.slice(0, index + 1).join('/'));
}

function parentDirectory(): void {
  const parts = directory.value === '.' ? [] : directory.value.split('/');
  parts.pop();
  void openDirectory(parts.join('/') || '.');
}

function fileIcon(kind?: string): typeof File {
  if (kind === 'code' || kind === 'config' || kind === 'text') return FileCode2;
  if (kind === 'image') return FileImage;
  if (kind === 'binary') return FileArchive;
  return File;
}

function formatBytes(value?: number): string {
  if (value === undefined) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}
</script>

<template>
  <section class="contents-browser">
    <div class="contents-tree" :class="{ 'contents-tree--hidden-mobile': preview || previewLoading || previewError }">
      <header class="contents-toolbar">
        <AppButton v-if="directory !== '.'" size="sm" variant="quiet" aria-label="Open parent directory" @click="parentDirectory"><ArrowLeft :size="15" />Up</AppButton>
        <nav aria-label="Package path">
          <button type="button" @click="openCrumb(-1)">Package</button>
          <template v-for="(crumb, index) in crumbs" :key="`${index}:${crumb}`"><ChevronRight :size="14" /><button type="button" @click="openCrumb(index)">{{ crumb }}</button></template>
        </nav>
      </header>
      <div v-if="loading" class="skeleton-stack contents-skeleton"><span v-for="n in 5" :key="n" /></div>
      <div v-else-if="error" class="recovery-panel"><div><h2>Contents unavailable</h2><p>{{ error }}</p><button type="button" @click="openDirectory(directory)">Try again</button></div></div>
      <EmptyState v-else-if="!listing?.entries.length" title="Empty directory" message="This directory contains no portable package files." />
      <ul v-else class="file-list">
        <li v-for="entry in listing.entries" :key="entry.path">
          <button type="button" :disabled="entry.kind === 'file' && !entry.previewable" @click="entry.kind === 'directory' ? openDirectory(entry.path) : openFile(entry.path)">
            <Folder v-if="entry.kind === 'directory'" :size="18" />
            <component :is="fileIcon(entry.contentKind)" v-else :size="18" />
            <span><strong>{{ entry.name }}</strong><small v-if="entry.kind === 'file'">{{ formatBytes(entry.bytes) }}<template v-if="entry.evidenceRecords"> · {{ entry.evidenceRecords }} evidence records</template></small><small v-else>Directory</small></span>
            <StatusBadge v-if="entry.kind === 'file' && !entry.previewable" status="binary" />
            <ChevronRight v-else :size="16" />
          </button>
        </li>
      </ul>
      <footer v-if="listing?.nextCursor"><AppButton :loading="loadingMore" @click="loadMore">Load more</AppButton></footer>
    </div>

    <aside class="source-preview" :class="{ 'source-preview--open': preview || previewLoading || previewError }">
      <header>
        <AppButton class="preview-back" size="sm" variant="quiet" @click="preview = undefined; previewError = undefined"><ArrowLeft :size="15" />Contents</AppButton>
        <div><small>Untrusted source data</small><strong>{{ preview?.path ?? 'File preview' }}</strong></div>
        <StatusBadge v-if="preview" :status="preview.previewable ? 'previewable' : 'binary'" />
      </header>
      <div v-if="previewLoading" class="skeleton-stack preview-skeleton"><span v-for="n in 7" :key="n" /></div>
      <div v-else-if="previewError" class="recovery-panel"><div><h2>Preview unavailable</h2><p>{{ previewError }}</p></div></div>
      <div v-else-if="preview" class="preview-body">
        <dl class="preview-metadata"><div><dt>Size</dt><dd>{{ formatBytes(preview.bytes) }}</dd></div><div><dt>Type</dt><dd>{{ preview.mediaType }}</dd></div><div><dt>Evidence</dt><dd>{{ preview.evidenceRecords }} records</dd></div><div><dt>SHA-256</dt><dd><code>{{ preview.sha256 }}</code></dd></div></dl>
        <p v-if="preview.truncated" class="preview-warning">Preview limited to {{ formatBytes(preview.bytesRead) }}. The installed file is unchanged.</p>
        <pre v-if="preview.content !== undefined"><code>{{ preview.content }}</code></pre>
        <div v-else class="binary-preview"><FileArchive :size="28" /><h2>Preview not available</h2><p>DKB does not render binary, image, HTML, SVG, or other active content in the Console.</p></div>
      </div>
      <div v-else class="preview-placeholder"><FolderOpen :size="28" /><h2>Select a file</h2><p>Portable text and code files open here as inert source data.</p></div>
    </aside>
  </section>
</template>
