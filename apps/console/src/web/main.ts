import '@fontsource-variable/instrument-sans';
import 'datatables.net-dt/css/dataTables.dataTables.css';
import 'datatables.net-columncontrol-dt/css/columnControl.dataTables.css';
import 'datatables.net-responsive-dt/css/responsive.dataTables.css';
import 'vue-sonner/style.css';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createApp } from 'vue';
import { Toaster } from 'vue-sonner';
import App from './App.vue';
import { ConsoleSessionExpiredError, establishConsoleSession } from './api.js';
import { router } from './router.js';
import './styles.css';

try {
  await establishConsoleSession();
} catch (error) {
  if (!(error instanceof ConsoleSessionExpiredError)) throw error;
}
const app = createApp(App);
app.use(router);
app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } }) });
app.component('ConsoleToaster', Toaster);
app.mount('#app');
