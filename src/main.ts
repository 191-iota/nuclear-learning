import '@/polyfills';
import { restoreMirror, startMirror } from '@/persist';

// The stores read localStorage synchronously when their modules load, so the disk
// restore must complete BEFORE the app module graph is imported — hence the dynamic
// imports. A failed restore never blocks the boot.
void (async () => {
  try {
    await restoreMirror();
  } catch {
    /* boot regardless */
  }
  startMirror();
  const [{ createApp }, { default: App }] = await Promise.all([
    import('vue'),
    import('@/App.vue'),
  ]);
  await Promise.all([import('katex/dist/katex.min.css'), import('@/style.css')]);
  createApp(App).mount('#app');
})();
