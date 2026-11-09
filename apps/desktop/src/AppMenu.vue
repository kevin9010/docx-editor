<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { isTauriRuntime } from './document/document-session';
import { t } from './i18n';
import { createNativeMenu, fileCommands, commandEnabled, type MenuCommand, type MenuState } from './window-menu';

const props = defineProps<{ state: MenuState }>();
const emit = defineEmits<{ command: [id: MenuCommand]; native: [ready: boolean] }>();
const nativeReady = ref(false);
const open = ref('');
const root = ref<HTMLElement | null>(null);
let native: Awaited<ReturnType<typeof createNativeMenu>> | null = null;
let disposed = false;
let queue = Promise.resolve();
function syncNative(): void {
  const state = { ...props.state };
  queue = queue.catch(() => {}).then(async () => {
    if (disposed || !native) return;
    try { await native.update(state); }
    catch (error) { console.warn('Could not update the native menu', error); }
  });
}
watch(() => props.state, syncNative, { deep: true });
watch(() => props.state.locale, () => { open.value = ''; });
function dispatch(id: MenuCommand): void { open.value = ''; emit('command', id); }
async function toggle(name: string, focusFirst = false): Promise<void> {
  open.value = open.value === name && !focusFirst ? '' : name;
  if (focusFirst) { await nextTick(); root.value?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus(); }
}
function close(restoreFocus = false): void {
  const name = open.value; open.value = '';
  if (restoreFocus) root.value?.querySelector<HTMLButtonElement>(`[data-menu="${name}"]`)?.focus();
}
function outside(event: PointerEvent): void { if (!root.value?.contains(event.target as Node)) close(); }
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
  if (event.key === 'Tab') { close(); return; }
  const items = [...root.value?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? []];
  if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[index]?.focus();
}
onMounted(async () => {
  document.addEventListener('pointerdown', outside);
  if (!isTauriRuntime()) return;
  try {
    native = await createNativeMenu(props.state, id => emit('command', id));
    if (disposed) { await native.dispose(); return; }
    nativeReady.value = true;
    emit('native', true);
    syncNative();
  } catch { nativeReady.value = false; emit('native', false); }
});
onBeforeUnmount(() => { disposed = true; document.removeEventListener('pointerdown', outside); void queue.finally(() => native?.dispose()); });
</script>

<template>
  <nav v-if="!nativeReady" ref="root" class="app-menu" :aria-label="t('Application menu')" @keydown="keydown">
    <div v-for="name in ['File', 'View', 'Language']" :key="name" class="menu-group">
      <button :data-menu="name" aria-haspopup="menu" :aria-expanded="open === name" @click="toggle(name)" @keydown.down.stop.prevent="toggle(name, true)">{{ t(name) }}</button>
      <div v-if="open === name" class="menu-popup" role="menu" :aria-label="t(name)">
        <template v-if="name === 'File'">
          <button v-for="item in fileCommands" :key="item.id" role="menuitem" :disabled="!commandEnabled(item.id, state)" @click="dispatch(item.id)"><span>{{ t(item.label) }}</span><kbd>{{ item.shortcut }}</kbd></button>
          <hr />
          <button role="menuitemcheckbox" :aria-checked="state.autoSave" @click="dispatch('autoSave')"><span>{{ t('Auto-save') }}</span><span>{{ state.autoSave ? '✓' : '' }}</span></button>
        </template>
        <button v-else-if="name === 'View'" role="menuitemcheckbox" :aria-checked="state.agent" @click="dispatch('agent')"><span>{{ t('Document Agent') }}</span><span>{{ state.agent ? '✓' : '' }}</span></button>
        <template v-else>
          <button role="menuitemradio" :aria-checked="state.locale === 'zh-CN'" @click="dispatch('zh-CN')"><span>简体中文</span><span>{{ state.locale === 'zh-CN' ? '✓' : '' }}</span></button>
          <button role="menuitemradio" :aria-checked="state.locale === 'en'" @click="dispatch('en')"><span>English</span><span>{{ state.locale === 'en' ? '✓' : '' }}</span></button>
        </template>
      </div>
    </div>
    <span class="window-file-name" :title="state.fileName">{{ state.dirty ? '* ' : '' }}{{ t(state.fileName) }} — SuperDoc Desktop</span>
  </nav>
</template>
