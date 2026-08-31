<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import ActionDrawer from '../interface/ActionDrawer.vue';
import FormField from '../interface/FormField.vue';
import type { PipelineTarget, ResourceKind, ResourceRow } from '../../types.js';

const props = defineProps<{ open: boolean; kind: ResourceKind; libraries: ResourceRow[]; pipelines?: PipelineTarget[]; busy?: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean]; submit: [input: Record<string, unknown>] }>();
const form = reactive({ name: '', path: '', url: '', kind: 'remote', library: '', compilerTarget: '', pipeline: '', verify: true });
const singular = computed(() => ({ libraries: 'library', runtimes: 'runtime', registries: 'registry', stacks: 'stack' }[props.kind]));
const title = computed(() => props.kind === 'stacks' ? 'Start a Stack' : `Register a ${singular.value[0].toUpperCase()}${singular.value.slice(1)}`);
const description = computed(() => ({
  libraries: 'Add an existing local Library to this host inventory. Its files are not moved.',
  runtimes: 'Add a local or remote Runtime endpoint. Registration never starts or changes the service.',
  registries: 'Add a package Registry endpoint. Credentials are configured separately.',
  stacks: 'Start or update a complete local DKB stack while preserving its existing data.',
}[props.kind]));

watch(() => props.open, (open) => {
  if (!open) return;
  Object.assign(form, { name: props.kind === 'stacks' ? 'local' : '', path: '', url: '', kind: 'remote', library: props.kind === 'stacks' ? props.libraries[0]?.name ?? '' : '', compilerTarget: '', pipeline: '', verify: true });
});

function submit(): void {
  if (props.kind === 'libraries') emit('submit', { path: form.path, name: form.name });
  if (props.kind === 'runtimes') emit('submit', { name: form.name, url: form.url, kind: form.kind, library: form.library, verify: form.verify });
  if (props.kind === 'registries') emit('submit', { name: form.name, url: form.url, verify: form.verify });
  if (props.kind === 'stacks') emit('submit', { name: form.name || 'local', library: form.library, compilerTarget: form.compilerTarget, pipeline: form.pipeline });
}
</script>

<template>
  <ActionDrawer :open="open" :title="title" :description="description" :busy="busy" :submit-label="kind === 'stacks' ? 'Start Stack' : 'Register'" @update:open="emit('update:open', $event)" @submit="submit">
    <FormField v-if="kind !== 'libraries'" label="Name" required><input v-model="form.name" autocomplete="off" required /></FormField>
    <FormField v-if="kind === 'libraries'" label="Library path" hint="Use an absolute path to a folder containing a Library dkb.json." required><input v-model="form.path" autocomplete="off" required /></FormField>
    <FormField v-if="kind === 'libraries'" label="Host name" hint="Optional short name used only on this machine."><input v-model="form.name" autocomplete="off" /></FormField>
    <FormField v-if="kind === 'runtimes' || kind === 'registries'" label="URL" required><input v-model="form.url" type="url" inputmode="url" placeholder="http://127.0.0.1:7331" required /></FormField>
    <FormField v-if="kind === 'runtimes'" label="Runtime kind"><select v-model="form.kind"><option value="remote">Remote</option><option value="docker">Docker</option><option value="process">Process</option></select></FormField>
    <FormField v-if="kind === 'runtimes'" label="Library" hint="Optional host Library association."><select v-model="form.library"><option value="">No association</option><option v-for="library in libraries" :key="library.name" :value="library.name">{{ library.displayName ?? library.name }}</option></select></FormField>
    <FormField v-if="kind === 'stacks'" label="Library" hint="The Stack Runtime serves this Library without copying its knowledge." required><select v-model="form.library" required><option v-for="library in libraries" :key="library.name" :value="library.name">{{ library.displayName ?? library.name }}</option></select></FormField>
    <FormField v-if="kind === 'stacks'" label="Runtime Pipeline" hint="Select a resolved target already known to this host, or use the bundled distribution default."><select v-model="form.pipeline"><option value="">Distribution default</option><option v-for="pipeline in pipelines" :key="pipeline.name" :value="pipeline.name">{{ pipeline.name }} · {{ pipeline.providers.join(' → ') }}</option></select></FormField>
    <FormField v-if="kind === 'stacks'" label="Registry compiler target" hint="Independent from the Runtime Pipeline. Leave empty to use the Registry default."><select v-model="form.compilerTarget"><option value="">Registry default</option><option v-for="pipeline in pipelines" :key="pipeline.name" :value="pipeline.name">{{ pipeline.name }}</option></select></FormField>
    <label v-if="kind === 'runtimes' || kind === 'registries'" class="checkbox-field"><input v-model="form.verify" type="checkbox" /><span><b>Verify before saving</b><small>The resource is still registered with a recovery warning if it is offline.</small></span></label>
  </ActionDrawer>
</template>
