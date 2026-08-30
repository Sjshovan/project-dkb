<script setup lang="ts">
import { CircleOff } from '@lucide/vue';
defineProps<{ title: string; message: string }>();
</script>

<template>
  <div class="empty-state">
    <CircleOff :size="24" aria-hidden="true" />
    <div><strong>{{ title }}</strong><p>{{ message }}</p></div>
  </div>
</template>
