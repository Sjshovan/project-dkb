<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { Boxes, Database, Library, Server } from '@lucide/vue';
import { getJson } from '../../api.js';
import type { ResourceListing } from '../../types.js';

interface Overview { libraries: ResourceListing; runtimes: ResourceListing; registries: ResourceListing; stacks: ResourceListing }
const query = useQuery({ queryKey: ['overview-context'], queryFn: () => getJson<Overview>('/api/v1/overview') });
</script>

<template>
  <div class="context-strip" aria-label="Host defaults">
    <span><Library :size="15" /><b>Library</b>{{ query.data.value?.libraries.selected ?? 'none' }}</span>
    <span><Server :size="15" /><b>Runtime</b>{{ query.data.value?.runtimes.selected ?? 'none' }}</span>
    <span><Database :size="15" /><b>Registry</b>{{ query.data.value?.registries.selected ?? 'none' }}</span>
    <span><Boxes :size="15" /><b>Stack</b>{{ query.data.value?.stacks.default ?? 'none' }}</span>
  </div>
</template>
