<script setup lang="ts">
import { MoreHorizontal } from '@lucide/vue';
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from 'reka-ui';
import type { ResourceKind } from '../../types.js';

defineProps<{ kind: ResourceKind; name: string; isDefault: boolean; authenticated?: boolean }>();
const emit = defineEmits<{ default: []; authenticate: []; stop: []; forget: [] }>();
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger class="icon-button resource-menu-trigger" :aria-label="`Actions for ${name}`"><MoreHorizontal :size="19" /></DropdownMenuTrigger>
    <DropdownMenuPortal><DropdownMenuContent class="resource-menu" :side-offset="6" align="end">
      <DropdownMenuItem v-if="!isDefault" class="resource-menu-item" @select="emit('default')">Set as default</DropdownMenuItem>
      <DropdownMenuItem v-if="kind === 'registries'" class="resource-menu-item" @select="emit('authenticate')">{{ authenticated ? 'Sign out' : 'Sign in' }}</DropdownMenuItem>
      <DropdownMenuItem v-if="kind === 'stacks'" class="resource-menu-item" @select="emit('stop')">Stop services</DropdownMenuItem>
      <DropdownMenuSeparator class="resource-menu-separator" />
      <DropdownMenuItem v-if="kind !== 'stacks'" class="resource-menu-item resource-menu-item--danger" @select="emit('forget')">Forget from host</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
