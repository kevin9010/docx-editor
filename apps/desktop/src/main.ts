import { createApp, nextTick } from 'vue';
import { invoke, isTauri } from '@tauri-apps/api/core';
import App from './App.vue';
import './styles.css';

createApp(App).mount('#app');

// A live process alone does not prove that the packaged frontend loaded.
if (isTauri()) {
  void nextTick().then(() => invoke('startup_ready')).catch(() => {});
}
