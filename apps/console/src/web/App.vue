<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { Activity, Boxes, ChevronLeft, ChevronRight, Database, Home, Library, Menu, Moon, Server, Sun } from '@lucide/vue';
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import ContextStrip from './components/resource/ContextStrip.vue';

const route = useRoute();
const dark = ref(false);
const sidebarCollapsed = ref(false);
const navigation = [
  { name: 'Overview', route: '/', icon: Home },
  { name: 'Libraries', route: '/libraries', icon: Library },
  { name: 'Runtimes', route: '/runtimes', icon: Server },
  { name: 'Registries', route: '/registries', icon: Database },
  { name: 'Stacks', route: '/stacks', icon: Boxes, desktopOnly: true },
  { name: 'Activity', route: '/activity', icon: Activity, desktopOnly: true },
  { name: 'More', route: '/more', icon: Menu, mobileOnly: true },
];
const current = computed(() => navigation.find((item) => item.route === route.path)?.name ?? 'DKB Console');
function applyTheme(): void {
  document.documentElement.classList.toggle('dark', dark.value);
  localStorage.setItem('dkb-console-theme', dark.value ? 'dark' : 'light');
}
function toggleTheme(): void { dark.value = !dark.value; applyTheme(); }
function toggleSidebar(): void { sidebarCollapsed.value = !sidebarCollapsed.value; localStorage.setItem('dkb-console-sidebar', sidebarCollapsed.value ? 'collapsed' : 'expanded'); }
onMounted(() => {
  dark.value = localStorage.getItem('dkb-console-theme') === 'dark' || (!localStorage.getItem('dkb-console-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
  sidebarCollapsed.value = localStorage.getItem('dkb-console-sidebar') === 'collapsed';
  applyTheme();
});
</script>

<template>
  <TooltipProvider :delay-duration="350">
    <a class="skip-link" href="#main-content">Skip to content</a>
    <div class="app-shell" :class="{ 'app-shell--collapsed': sidebarCollapsed }">
      <aside class="desktop-sidebar">
        <div class="sidebar-heading"><RouterLink to="/" class="brand"><span class="brand-mark">D</span><span><b>DKB</b><small>Host Console</small></span></RouterLink><button class="sidebar-collapse" type="button" :aria-label="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'" @click="toggleSidebar"><ChevronRight v-if="sidebarCollapsed" :size="17" /><ChevronLeft v-else :size="17" /></button></div>
        <nav aria-label="Primary navigation">
          <RouterLink v-for="item in navigation.filter((entry) => !entry.mobileOnly)" :key="item.route" :to="item.route" :title="sidebarCollapsed ? item.name : undefined" :aria-label="sidebarCollapsed ? item.name : undefined" :aria-current="route.path === item.route ? 'page' : undefined">
            <component :is="item.icon" :size="18" aria-hidden="true" /><span>{{ item.name }}</span>
          </RouterLink>
        </nav>
        <div class="sidebar-footer"><span>Developer preview</span><small>Loopback only</small></div>
      </aside>

      <div class="app-column">
        <header class="mobile-topbar"><RouterLink to="/" class="mobile-brand"><b>DKB</b></RouterLink><span>{{ current }}</span><button class="icon-button" type="button" @click="toggleTheme" aria-label="Toggle appearance"><Sun v-if="dark" :size="19" /><Moon v-else :size="19" /></button></header>
        <header class="desktop-context"><ContextStrip /><TooltipRoot><TooltipTrigger as-child><button class="icon-button" type="button" @click="toggleTheme" aria-label="Toggle appearance"><Sun v-if="dark" :size="18" /><Moon v-else :size="18" /></button></TooltipTrigger><TooltipPortal><TooltipContent class="tooltip-content" side="bottom">{{ dark ? 'Use light appearance' : 'Use dark appearance' }}</TooltipContent></TooltipPortal></TooltipRoot></header>
        <main id="main-content"><RouterView /></main>
      </div>

      <nav class="mobile-nav" aria-label="Mobile navigation">
        <RouterLink v-for="item in navigation.filter((entry) => !entry.desktopOnly)" :key="item.route" :to="item.route" :aria-current="route.path === item.route ? 'page' : undefined"><component :is="item.icon" :size="20" aria-hidden="true" /><span>{{ item.name }}</span></RouterLink>
      </nav>
      <ConsoleToaster position="top-right" rich-colors close-button />
    </div>
  </TooltipProvider>
</template>
