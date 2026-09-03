<script setup lang="ts">
import { computed } from 'vue';
import { hostResourceRoute, installedEntryRoute, pipelineRoute, registryEntryRoute, type HostResourceKind } from '../../resourceRoutes.js';

const props = defineProps<{
  kind: HostResourceKind | 'pipeline' | 'installed-entry' | 'registry-dkb' | 'registry-collection';
  name: string;
  label?: string;
  library?: string;
  registry?: string;
  runtime?: string;
}>();

const to = computed(() => {
  if (props.kind === 'pipeline') return pipelineRoute(props.name, props.runtime);
  if (props.kind === 'installed-entry') return props.library ? installedEntryRoute(props.library, props.name) : undefined;
  if (props.kind === 'registry-dkb' || props.kind === 'registry-collection') {
    return props.registry ? registryEntryRoute(props.registry, props.name, props.kind === 'registry-dkb' ? 'dkb' : 'collection') : undefined;
  }
  return hostResourceRoute(props.kind, props.name);
});
</script>

<template>
  <a v-if="to" class="resource-reference" :href="to"><slot>{{ label ?? name }}</slot></a>
  <span v-else><slot>{{ label ?? name }}</slot></span>
</template>
