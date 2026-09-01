<script setup lang="ts">
import { computed } from 'vue';
import { Database, FileJson2, Fingerprint, Layers3, X } from '@lucide/vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import type { DkbInstalledBuildFile, DkbInstalledBuildSummary } from '@sjshovan/dkb-protocol/packageInspection.js';
import AppButton from '../interface/AppButton.vue';
import StatusBadge from '../interface/StatusBadge.vue';

const props = defineProps<{ open: boolean; build?: DkbInstalledBuildSummary }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const title = computed(() => props.build?.kind === 'evidence'
  ? 'Evidence Build contents'
  : `${props.build?.target ?? 'Retrieval'} Build contents`);
const description = computed(() => props.build?.kind === 'evidence'
  ? 'The embedding-free interpretation of this package’s source, reusable by compatible retrieval pipelines.'
  : 'Runtime-ready search artifacts derived from one exact Evidence Build.');

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDate(value?: string): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function shortDigest(value?: string): string {
  if (!value) return 'Unavailable';
  return value.length > 30 ? `${value.slice(0, 27)}…` : value;
}

function fileLabel(file: DkbInstalledBuildFile): string {
  if (file.role === 'evidence_ir') return 'Evidence IR';
  if (file.role === 'evidence_catalog') return 'Evidence catalog';
  if (file.role === 'build_lock') return 'Build lock';
  if (file.role === 'profile_lock') return 'Resolved Pipeline recipe';
  if (file.role === 'artifact_manifest') return 'Artifact manifest';
  if (file.path.endsWith('.faiss')) return 'Vector index';
  if (file.path.endsWith('.sqlite')) return 'Search data and ID mappings';
  if (file.path.endsWith('manifest.json')) return 'Provider manifest';
  return 'Provider artifact';
}

function filePurpose(file: DkbInstalledBuildFile): string {
  if (file.role === 'evidence_ir') return 'Parsed and chunked text, stable Evidence IDs, source locators, and provenance metadata.';
  if (file.role === 'evidence_catalog') return 'DKB-owned lookup data for canonical evidence text, source relationships, and citations.';
  if (file.role === 'build_lock' && props.build?.kind === 'evidence') return 'Package identity, profile digest, build digest, record counts, and creation time.';
  if (file.role === 'build_lock') return 'Parent Evidence digest, compatibility, artifact tree, and exact Retrieval Build identity.';
  if (file.role === 'profile_lock') return 'The exact embedding, index, retrieval, and compatibility recipe used for this build.';
  if (file.role === 'artifact_manifest') return 'The validated list of provider artifacts with their byte sizes and hashes.';
  if (file.path.endsWith('.faiss')) return 'Dense vectors arranged for nearest-neighbor search.';
  if (file.path.endsWith('.sqlite')) return 'Provider-owned lexical data, search metadata, and mappings back to stable Evidence IDs.';
  if (file.path.endsWith('manifest.json')) return 'Provider-specific metadata required to validate and open the search index.';
  return 'Provider-owned data required to serve this retrieval space.';
}

function providerKind(kind: DkbInstalledBuildSummary['providers'][number]['kind']): string {
  const labels = { evidence: 'Evidence', parser: 'Parser', chunker: 'Chunker', embedding: 'Embedding', index: 'Index', retrieval: 'Retrieval' };
  return labels[kind];
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="drawer-overlay" />
      <DialogContent class="action-drawer status-details-drawer build-details-drawer">
        <header>
          <div><DialogTitle>{{ title }}</DialogTitle><DialogDescription>{{ description }}</DialogDescription></div>
          <button class="icon-button" type="button" aria-label="Close Build details" @click="emit('update:open', false)"><X :size="20" /></button>
        </header>

        <div v-if="build" class="drawer-body">
          <section class="build-drawer-summary" aria-label="Build summary">
            <div><span class="build-type-icon"><Database v-if="build.kind === 'evidence'" :size="19" /><Layers3 v-else :size="19" /></span><span><strong>{{ build.kind === 'evidence' ? 'Evidence Build' : 'Retrieval Build' }}</strong><small>{{ build.target ?? (build.kind === 'evidence' ? 'Embedding-free and portable' : 'Custom Pipeline') }}</small></span><StatusBadge status="stored" /></div>
            <dl>
              <div><dt>Stored size</dt><dd>{{ formatBytes(build.bytes) }}</dd></div>
              <div><dt>Created</dt><dd>{{ formatDate(build.generatedAt) }}</dd></div>
              <div v-if="build.recordCount !== undefined"><dt>Evidence records</dt><dd>{{ build.recordCount }}</dd></div>
              <div v-if="build.chunkCount !== undefined"><dt>Chunks</dt><dd>{{ build.chunkCount }}</dd></div>
              <div><dt>Stored files</dt><dd>{{ build.files.length }}</dd></div>
            </dl>
          </section>

          <section class="build-file-inventory" aria-labelledby="build-files-title">
            <div class="build-drawer-heading"><FileJson2 :size="18" /><span><h2 id="build-files-title">What this build contains</h2><p>Exact files stored in this immutable build.</p></span></div>
            <ul>
              <li v-for="file in build.files" :key="file.path">
                <div><strong>{{ fileLabel(file) }}</strong><code>{{ file.path }}</code><small>{{ filePurpose(file) }}</small><code v-if="file.hash" class="build-file-hash">{{ shortDigest(file.hash) }}</code></div>
                <span>{{ formatBytes(file.bytes) }}</span>
              </li>
            </ul>
          </section>

          <section class="build-recipe" aria-labelledby="build-recipe-title">
            <div class="build-drawer-heading"><Layers3 :size="18" /><span><h2 id="build-recipe-title">Compilation recipe</h2><p>The provider choices that produced this stored result.</p></span></div>
            <dl v-if="build.kind === 'retrieval'">
              <div><dt>Pipeline</dt><dd>{{ build.target ?? 'Custom' }}</dd></div>
              <div><dt>Embedding</dt><dd>{{ build.embedding?.space ?? 'Unavailable' }}<small v-if="build.embedding">{{ build.embedding.dimensions }} dimensions · {{ build.embedding.metric }} · {{ build.embedding.normalized ? 'normalized' : 'not normalized' }}</small></dd></div>
              <div><dt>Index</dt><dd>{{ build.index?.format ?? 'Unavailable' }}<small v-if="build.index">{{ build.index.provider }} · {{ build.index.mode }}</small></dd></div>
              <div><dt>Retrieval</dt><dd>{{ build.retrieval?.provider ?? 'Unavailable' }}<small v-if="build.retrieval">{{ build.retrieval.protocol }}</small></dd></div>
            </dl>
            <ul v-if="build.providers.length" class="build-provider-list">
              <li v-for="provider in build.providers" :key="`${provider.kind}:${provider.id}`"><span><strong>{{ providerKind(provider.kind) }} provider</strong><code>{{ provider.id }}</code></span><small>v{{ provider.version }}</small></li>
            </ul>
            <p v-else class="quiet-state">No provider receipt is stored for this standalone Evidence Build.</p>
            <div v-if="build.processors.length" class="build-processors"><strong>Processors</strong><span v-for="processor in build.processors" :key="`${processor.stage}:${processor.id}`">{{ processor.stage }} · {{ processor.id }}@{{ processor.version }}</span></div>
          </section>

          <section class="build-identities" aria-labelledby="build-identities-title">
            <div class="build-drawer-heading"><Fingerprint :size="18" /><span><h2 id="build-identities-title">Build identity</h2><p>Exact digests used for deterministic matching and validation.</p></span></div>
            <dl>
              <div><dt>Build digest</dt><dd><code>{{ build.buildDigest }}</code></dd></div>
              <div><dt>Profile digest</dt><dd><code>{{ build.profileDigest }}</code></dd></div>
              <div v-if="build.evidenceDigest"><dt>Parent Evidence</dt><dd><code>{{ build.evidenceDigest }}</code></dd></div>
              <div v-if="build.compatibilityDigest"><dt>Compatibility</dt><dd><code>{{ build.compatibilityDigest }}</code></dd></div>
            </dl>
          </section>
        </div>

        <footer class="status-details-footer"><AppButton @click="emit('update:open', false)">Done</AppButton></footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
