import '@fontsource-variable/instrument-sans';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createApp } from 'vue';
import { Toaster } from 'vue-sonner';
import App from './App.vue';
import { establishConsoleSession } from './api.js';
import { router } from './router.js';
import './styles.css';

await establishConsoleSession();
const app = createApp(App);
app.use(router);
app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } }) });
app.component('ConsoleToaster', Toaster);
app.mount('#app');
