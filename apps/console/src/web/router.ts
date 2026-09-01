import { createRouter, createWebHistory } from 'vue-router';
import InstalledEntryDetailView from './views/InstalledEntryDetailView.vue';
import LibraryDetailView from './views/LibraryDetailView.vue';
import MoreView from './views/MoreView.vue';
import OverviewView from './views/OverviewView.vue';
import RegistryDetailView from './views/RegistryDetailView.vue';
import RegistryEntryDetailView from './views/RegistryEntryDetailView.vue';
import ResourceView from './views/ResourceView.vue';
import RuntimeDetailView from './views/RuntimeDetailView.vue';
import PipelinesView from './views/PipelinesView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewView },
    { path: '/libraries', name: 'libraries', component: ResourceView, props: { kind: 'libraries' } },
    { path: '/libraries/:name', name: 'library', component: LibraryDetailView, props: true },
    { path: '/libraries/:library/entries/:namespace/:name', name: 'installed-entry', component: InstalledEntryDetailView, props: true },
    { path: '/runtimes', name: 'runtimes', component: ResourceView, props: { kind: 'runtimes' } },
    { path: '/runtimes/:name', name: 'runtime', component: RuntimeDetailView, props: true },
    { path: '/pipelines', name: 'pipelines', component: PipelinesView },
    { path: '/registries', name: 'registries', component: ResourceView, props: { kind: 'registries' } },
    { path: '/registries/:registry', name: 'registry', component: RegistryDetailView, props: true },
    { path: '/registries/:registry/dkbs/:namespace/:name', name: 'registry-dkb', component: RegistryEntryDetailView, props: (route) => ({ ...route.params, kind: 'dkb' }) },
    { path: '/registries/:registry/collections/:namespace/:name', name: 'registry-collection', component: RegistryEntryDetailView, props: (route) => ({ ...route.params, kind: 'collection' }) },
    { path: '/stacks', name: 'stacks', component: ResourceView, props: { kind: 'stacks' } },
    { path: '/activity', name: 'activity', component: () => import('./views/ActivityView.vue') },
    { path: '/more', name: 'more', component: MoreView },
  ],
});
