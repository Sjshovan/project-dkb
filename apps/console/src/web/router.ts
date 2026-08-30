import { createRouter, createWebHistory } from 'vue-router';
import ActivityView from './views/ActivityView.vue';
import InstalledEntryDetailView from './views/InstalledEntryDetailView.vue';
import LibraryDetailView from './views/LibraryDetailView.vue';
import MoreView from './views/MoreView.vue';
import OverviewView from './views/OverviewView.vue';
import ResourceView from './views/ResourceView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewView },
    { path: '/libraries', name: 'libraries', component: ResourceView, props: { kind: 'libraries' } },
    { path: '/libraries/:name', name: 'library', component: LibraryDetailView, props: true },
    { path: '/libraries/:library/entries/:namespace/:name', name: 'installed-entry', component: InstalledEntryDetailView, props: true },
    { path: '/runtimes', name: 'runtimes', component: ResourceView, props: { kind: 'runtimes' } },
    { path: '/registries', name: 'registries', component: ResourceView, props: { kind: 'registries' } },
    { path: '/stacks', name: 'stacks', component: ResourceView, props: { kind: 'stacks' } },
    { path: '/activity', name: 'activity', component: ActivityView },
    { path: '/more', name: 'more', component: MoreView },
  ],
});
