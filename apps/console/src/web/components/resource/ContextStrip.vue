<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { Boxes, Database, Library, Server } from '@lucide/vue';
import { getJson } from '../../api.js';
import type { ResourceListing } from '../../types.js';
import ResourceLink from '../interface/ResourceLink.vue';

interface Overview { libraries: ResourceListing; runtimes: ResourceListing; registries: ResourceListing; stacks: ResourceListing }
const query = useQuery({ queryKey: ['overview-context'], queryFn: () => getJson<Overview>('/api/v1/overview') });
</script>

<template>
  <div class="context-strip" aria-label="Host defaults">
    <span><Library :size="15" /><b>Library</b><ResourceLink v-if="query.data.value?.libraries.selected" kind="library" :name="query.data.value.libraries.selected" /><template v-else>none</template></span>
    <span><Server :size="15" /><b>Runtime</b><ResourceLink v-if="query.data.value?.runtimes.selected" kind="runtime" :name="query.data.value.runtimes.selected" /><template v-else>none</template></span>
    <span><Database :size="15" /><b>Registry</b><ResourceLink v-if="query.data.value?.registries.selected" kind="registry" :name="query.data.value.registries.selected" /><template v-else>none</template></span>
    <span><Boxes :size="15" /><b>Stack</b><ResourceLink v-if="query.data.value?.stacks.default" kind="stack" :name="query.data.value.stacks.default" /><template v-else>none</template></span>
  </div>
</template>
