<script setup lang="ts">
import { Activity, Boxes, GitBranch, Moon, Settings } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import PageHeader from '../components/interface/PageHeader.vue';
</script>

<template>
  <div class="page"><PageHeader title="More" description="Pipeline, Stack, activity, appearance, and local Console settings." /><nav class="more-list"><RouterLink to="/pipelines"><GitBranch :size="20" /><span><b>Pipelines</b><small>Compare availability and build coverage for each Runtime.</small></span></RouterLink><RouterLink to="/stacks"><Boxes :size="20" /><span><b>Stacks</b><small>Manage complete local service bundles.</small></span></RouterLink><RouterLink to="/activity"><Activity :size="20" /><span><b>Activity</b><small>Follow operations and recovery details.</small></span></RouterLink><button type="button" disabled><Moon :size="20" /><span><b>Appearance</b><small>Use the theme control in the top bar.</small></span></button><button type="button" disabled><Settings :size="20" /><span><b>Console settings</b><small>Loopback and security defaults are fixed in developer preview.</small></span></button></nav></div>
</template>
