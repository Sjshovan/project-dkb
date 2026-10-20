<script setup lang="ts">
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import AppButton from './AppButton.vue';

withDefaults(defineProps<{ open: boolean; title: string; description: string; confirmLabel?: string; busy?: boolean; danger?: boolean }>(), {
  confirmLabel: 'Confirm', busy: false, danger: false,
});
const emit = defineEmits<{ 'update:open': [value: boolean]; confirm: [] }>();
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal><DialogOverlay class="drawer-overlay" /><DialogContent class="confirm-dialog" @escape-key-down="busy && $event.preventDefault()" @pointer-down-outside="busy && $event.preventDefault()">
      <DialogTitle>{{ title }}</DialogTitle><DialogDescription>{{ description }}</DialogDescription>
      <footer><AppButton :disabled="busy" @click="emit('update:open', false)">Cancel</AppButton><AppButton :variant="danger ? 'danger' : 'primary'" :loading="busy" @click="emit('confirm')">{{ confirmLabel }}</AppButton></footer>
    </DialogContent></DialogPortal>
  </DialogRoot>
</template>
