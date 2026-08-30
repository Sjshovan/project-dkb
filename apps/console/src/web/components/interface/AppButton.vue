<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority';
import { computed, useAttrs } from 'vue';
import { twMerge } from 'tailwind-merge';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ variant?: ButtonVariants['variant']; size?: ButtonVariants['size']; loading?: boolean }>(), {
  variant: 'secondary', size: 'md', loading: false,
});
const attrs = useAttrs();
const styles = cva('app-button', {
  variants: {
    variant: { primary: 'app-button--primary', secondary: 'app-button--secondary', quiet: 'app-button--quiet', danger: 'app-button--danger' },
    size: { sm: 'app-button--sm', md: 'app-button--md' },
  },
  defaultVariants: { variant: 'secondary', size: 'md' },
});
type ButtonVariants = VariantProps<typeof styles>;
const classes = computed(() => twMerge(styles({ variant: props.variant, size: props.size }), String(attrs.class ?? '')));
</script>

<template>
  <button v-bind="attrs" :class="classes" :disabled="Boolean(attrs.disabled) || loading" :aria-busy="loading">
    <span v-if="loading" class="button-spinner" aria-hidden="true" />
    <slot />
  </button>
</template>
