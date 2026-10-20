<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ArrowLeft, Boxes } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import { getJson } from '../api.js';
import AppButton from '../components/interface/AppButton.vue';
import EmptyState from '../components/interface/EmptyState.vue';
import PageHeader from '../components/interface/PageHeader.vue';
import ResourceLink from '../components/interface/ResourceLink.vue';
import StatusBadge from '../components/interface/StatusBadge.vue';
import type { ResourceListing } from '../types.js';

const props = defineProps<{ name: string }>();
const query = useQuery({ queryKey: ['resources', 'stacks', false], queryFn: () => getJson<ResourceListing>('/api/v1/resources/stacks') });
const stack = computed(() => query.data.value?.stacks?.find((item) => item.name === props.name));
</script>

<template>
  <div class="page">
    <RouterLink class="back-link" to="/stacks"><ArrowLeft :size="16" />Stacks</RouterLink>
    <div v-if="query.isPending.value" class="skeleton-stack"><span v-for="n in 4" :key="n" /></div>
    <section v-else-if="query.isError.value" class="recovery-panel"><div><h2>Stack unavailable</h2><p>{{ query.error.value?.message }}</p><AppButton @click="query.refetch()">Retry</AppButton></div></section>
    <EmptyState v-else-if="!stack" title="Stack not found" message="This Stack is no longer registered on the host." />
    <template v-else>
      <PageHeader :title="stack.name" description="A local DKB service bundle and the resources it connects."><template #actions><StatusBadge :status="stack.status" /></template></PageHeader>
      <section class="runtime-detail-ledger"><header><div><h2>Stack connections</h2><p>Every referenced DKB object opens its canonical Console view.</p></div><Boxes :size="20" /></header><dl>
        <div><dt>Library</dt><dd><ResourceLink v-if="stack.library" kind="library" :name="stack.library" /><span v-else>Not associated</span></dd></div>
        <div><dt>Runtime</dt><dd><ResourceLink v-if="stack.runtime" kind="runtime" :name="stack.runtime" /><span v-else>Not associated</span></dd></div>
        <div><dt>Registry</dt><dd><ResourceLink v-if="stack.registry" kind="registry" :name="stack.registry" /><span v-else>Not associated</span></dd></div>
        <div><dt>Compiler target</dt><dd>{{ stack.target ?? 'Default' }}</dd></div>
        <div><dt>State root</dt><dd><code>{{ stack.stateRoot ?? 'Unavailable' }}</code></dd></div>
      </dl></section>
    </template>
  </div>
</template>
