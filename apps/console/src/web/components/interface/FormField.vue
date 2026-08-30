<script setup lang="ts">
defineProps<{ label: string; hint?: string; required?: boolean }>();
</script>

<template>
  <label class="form-field">
    <span>{{ label }}<b v-if="required" aria-hidden="true"> *</b></span>
    <slot />
    <small v-if="hint">{{ hint }}</small>
  </label>
</template>
