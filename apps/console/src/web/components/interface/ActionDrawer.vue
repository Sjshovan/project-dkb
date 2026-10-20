<script setup lang="ts">
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { X } from '@lucide/vue';
import AppButton from './AppButton.vue';

withDefaults(defineProps<{
  open: boolean;
  title: string;
  description: string;
  submitLabel?: string;
  busy?: boolean;
  submitDisabled?: boolean;
}>(), { submitLabel: 'Save', busy: false, submitDisabled: false });

const emit = defineEmits<{ 'update:open': [value: boolean]; submit: [] }>();
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="drawer-overlay" />
      <DialogContent class="action-drawer" @escape-key-down="busy && $event.preventDefault()" @pointer-down-outside="busy && $event.preventDefault()">
        <header>
          <div><DialogTitle>{{ title }}</DialogTitle><DialogDescription>{{ description }}</DialogDescription></div>
          <button class="icon-button" type="button" aria-label="Close" :disabled="busy" @click="emit('update:open', false)"><X :size="20" /></button>
        </header>
        <form @submit.prevent="emit('submit')">
          <div class="drawer-body"><slot /></div>
          <footer>
            <AppButton type="button" :disabled="busy" @click="emit('update:open', false)">Cancel</AppButton>
            <AppButton type="submit" variant="primary" :disabled="busy || submitDisabled" :loading="busy">{{ submitLabel }}</AppButton>
          </footer>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
