<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { SuperDoc } from 'superdoc';
import type { BrowserDocumentApi } from 'superdoc';
import {
  chooseAndReadDocument,
  chooseSavePath,
  fileNameFromPath,
  getDocumentFileMetadata,
  isTauriRuntime,
  readBrowserFile,
  readDocumentFromPath,
  saveDocumentBytes,
  writeDocumentToPath,
  type OpenedDocument,
} from './document/document-session';
import { runDocumentAgent } from './agent/loop';
import type { AgentRunResult } from './agent/types';

const editorHost = ref<HTMLElement | null>(null);
const toolbarHost = ref<HTMLElement | null>(null);
const browserFileInput = ref<HTMLInputElement | null>(null);
const editor = shallowRef<SuperDoc | null>(null);
const openedDocument = ref<OpenedDocument | null>(null);
const status = ref('Open a DOCX file to begin.');
const errorMessage = ref('');
const isLoading = ref(false);
const isSaving = ref(false);
const isDirty = ref(false);
const autoSaveEnabled = ref(true);
const showAgent = ref(true);
const isDragActive = ref(false);
const agentPrompt = ref('');
const agentRunning = ref(false);
const agentStatus = ref('');
const agentSummary = ref('');
const agentError = ref('');
const lastAgentResult = ref<AgentRunResult | null>(null);
const baseUrl = ref(localStorage.getItem('superdoc.desktop.baseUrl') ?? 'https://api.openai.com/v1');
const model = ref(localStorage.getItem('superdoc.desktop.model') ?? 'gpt-4o-mini');
const apiKey = ref('');

let autoSaveTimer: number | null = null;
let metadataTimer: number | null = null;
let agentAbortController: AbortController | null = null;
let unlistenDragDrop: (() => void) | null = null;
let initializing = false;
let suppressAutoSave = false;
let mountGeneration = 0;
let lastDiskModifiedAt = 0;

const fileName = computed(() => openedDocument.value?.name ?? 'No document');
const canSave = computed(() => Boolean(editor.value && openedDocument.value && !isSaving.value));
const canRunAgent = computed(() => Boolean(getLiveDocument() && agentPrompt.value.trim() && !agentRunning.value));

function clearError(): void {
  errorMessage.value = '';
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected desktop error occurred.';
}

const docxNamePattern = /\.docx$/i;

function confirmDiscardChanges(action: string): boolean {
  if (!isDirty.value) return true;
  return window.confirm(`Discard unsaved changes and ${action}?`);
}

function getLiveDocument(): BrowserDocumentApi | null {
  const activeEditor = editor.value?.activeEditor as { doc?: BrowserDocumentApi } | null | undefined;
  return activeEditor?.doc ?? null;
}

function setDocumentState(document: OpenedDocument): void {
  openedDocument.value = document;
  isDirty.value = false;
  lastDiskModifiedAt = 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function mountDocument(document: OpenedDocument): Promise<void> {
  if (!editorHost.value || !toolbarHost.value) throw new Error('The editor surface is not mounted.');

  const generation = ++mountGeneration;
  editor.value?.destroy?.();
  editor.value = null;
  editorHost.value.replaceChildren();
  toolbarHost.value.replaceChildren();
  initializing = true;
  clearError();
  status.value = `Loading ${document.name}…`;

  const file = new File([toArrayBuffer(document.data)], document.name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const nextEditor = new SuperDoc({
    selector: editorHost.value,
    ui: {
      toolbar: {
        container: toolbarHost.value,
        // The Agent shares the window; only the editor column is available.
        responsiveTo: 'container',
        overflow: 'menu',
      },
    },
    document: file,
    documentMode: 'editing',
    rulers: true,
    comments: { visible: true },
    trackChanges: { replacementMode: 'grouped' },
    viewing: { trackedChanges: 'markup' },
    user: { name: 'Desktop User', email: 'desktop-user@local' },
    onReady: () => {
      if (generation !== mountGeneration) return;
      initializing = false;
      status.value = `Ready — ${document.name}`;
      isDirty.value = false;
      void refreshDiskMetadata();
    },
    onEditorUpdate: () => {
      if (generation !== mountGeneration || initializing) return;
      isDirty.value = true;
      status.value = `Unsaved changes — ${document.name}`;
      if (!suppressAutoSave) scheduleAutoSave();
    },
    onContentError: ({ error }) => {
      if (generation !== mountGeneration) return;
      errorMessage.value = messageFromError(error);
      status.value = 'Could not load the document.';
    },
    onException: (payload) => {
      if (generation !== mountGeneration) return;
      const record = payload as unknown as { error?: unknown; message?: unknown };
      errorMessage.value = messageFromError(record.error ?? record.message ?? payload);
    },
  });

  editor.value = nextEditor;
  setDocumentState(document);
}

async function refreshDiskMetadata(): Promise<void> {
  if (!openedDocument.value?.path || !isTauriRuntime()) return;
  try {
    const metadata = await getDocumentFileMetadata(openedDocument.value.path);
    lastDiskModifiedAt = metadata.modifiedAtMs;
  } catch {
    // The editor remains usable if metadata cannot be read; save will surface the real error.
  }
}

async function loadDocument(document: OpenedDocument): Promise<void> {
  await mountDocument(document);
  await refreshDiskMetadata();
}

async function openDocument(): Promise<void> {
  if (!confirmDiscardChanges('open another document')) return;
  isLoading.value = true;
  clearError();
  try {
    const document = isTauriRuntime()
      ? await chooseAndReadDocument()
      : null;
    if (document) await loadDocument(document);
  } catch (error) {
    errorMessage.value = messageFromError(error);
    status.value = 'Open failed.';
  } finally {
    isLoading.value = false;
  }
}

function openBrowserPicker(): void {
  browserFileInput.value?.click();
}

async function handleBrowserFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  isLoading.value = true;
  clearError();
  try {
    await loadDocument(await readBrowserFile(file));
  } catch (error) {
    errorMessage.value = messageFromError(error);
    status.value = 'Open failed.';
  } finally {
    isLoading.value = false;
  }
}

/**
 * Shared entry point for the two drop routes: the native drop Tauri reports in
 * the desktop build, and the HTML5 drop the browser preview uses.
 */
async function openDroppedDocument(name: string, load: () => Promise<OpenedDocument>): Promise<void> {
  if (!docxNamePattern.test(name)) {
    errorMessage.value = 'Only DOCX files can be opened by dropping them on the window.';
    return;
  }
  if (!confirmDiscardChanges('open the dropped document')) return;
  isLoading.value = true;
  clearError();
  try {
    await loadDocument(await load());
  } catch (error) {
    errorMessage.value = messageFromError(error);
    status.value = 'Open failed.';
  } finally {
    isLoading.value = false;
  }
}

/*
 * A Tauri window keeps `dragDropEnabled` on, so the webview swallows HTML5 drag
 * events and the OS drop arrives through the native event below. The HTML5
 * handlers stay for the Vite preview, which has no native bridge.
 */
async function listenForNativeDrops(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    unlistenDragDrop = await getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter') {
        isDragActive.value = true;
        return;
      }
      if (payload.type === 'over') return;
      isDragActive.value = false;
      if (payload.type !== 'drop') return;
      const [filePath] = payload.paths;
      if (filePath) void openDroppedDocument(filePath, () => readDocumentFromPath(filePath));
    });
  } catch {
    // Without the bridge a drop simply does nothing; Open still works.
    isDragActive.value = false;
  }
}

function handleWindowDragOver(event: DragEvent): void {
  if (isTauriRuntime()) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  isDragActive.value = true;
}

function handleWindowDragLeave(event: DragEvent): void {
  if (isTauriRuntime()) return;
  // `dragleave` also fires whenever the pointer crosses into a child element,
  // so the overlay only goes away once the drag has left the window entirely.
  if (event.relatedTarget === null) isDragActive.value = false;
}

function handleWindowDrop(event: DragEvent): void {
  if (isTauriRuntime()) return;
  event.preventDefault();
  isDragActive.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void openDroppedDocument(file.name, () => readBrowserFile(file));
}

async function exportCurrentDocument(): Promise<Uint8Array> {
  if (!editor.value) throw new Error('No document is open.');
  const blob = await editor.value.export({ exportType: ['docx'], triggerDownload: false, commentsType: 'external' });
  if (!blob) throw new Error('SuperDoc did not return an exported DOCX.');
  return new Uint8Array(await blob.arrayBuffer());
}

function downloadDocument(bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.value || 'document.docx';
  link.click();
  URL.revokeObjectURL(url);
}

async function saveDocument(): Promise<void> {
  if (!canSave.value) return;
  isSaving.value = true;
  clearError();
  try {
    const bytes = await exportCurrentDocument();
    if (!isTauriRuntime()) {
      downloadDocument(bytes);
      isDirty.value = false;
      status.value = 'Downloaded edited DOCX (browser preview).';
      return;
    }

    const currentPath = openedDocument.value?.path ?? null;
    if (currentPath && lastDiskModifiedAt > 0) {
      const metadata = await getDocumentFileMetadata(currentPath);
      if (metadata.modifiedAtMs > lastDiskModifiedAt + 1 && !window.confirm('The file changed on disk. Overwrite it with your current edits?')) {
        status.value = 'Save cancelled because the file changed on disk.';
        return;
      }
    }
    const path = await saveDocumentBytes(bytes, currentPath);
    if (path) {
      openedDocument.value = {
        path,
        name: fileNameFromPath(path),
        data: bytes,
      };
      isDirty.value = false;
      status.value = `Saved ${fileName.value}`;
      await refreshDiskMetadata();
    }
  } catch (error) {
    errorMessage.value = messageFromError(error);
    status.value = 'Save failed.';
  } finally {
    isSaving.value = false;
  }
}

async function saveAs(): Promise<void> {
  if (!editor.value) return;
  isSaving.value = true;
  clearError();
  try {
    const bytes = await exportCurrentDocument();
    if (!isTauriRuntime()) {
      downloadDocument(bytes);
      isDirty.value = false;
      status.value = 'Downloaded edited DOCX (browser preview).';
      return;
    }
    const path = await chooseSavePath(openedDocument.value?.path);
    if (!path) return;
    await writeDocumentToPath(path, bytes);
    openedDocument.value = { path, name: fileNameFromPath(path), data: bytes };
    isDirty.value = false;
    status.value = `Saved ${fileName.value}`;
    await refreshDiskMetadata();
  } catch (error) {
    errorMessage.value = messageFromError(error);
    status.value = 'Save As failed.';
  } finally {
    isSaving.value = false;
  }
}

async function reloadFromDisk(): Promise<void> {
  const path = openedDocument.value?.path;
  if (!path) return;
  if (isDirty.value && !window.confirm('Reload the file from disk and discard unsaved changes?')) return;
  isLoading.value = true;
  clearError();
  try {
    await loadDocument(await readDocumentFromPath(path));
    status.value = `Reloaded ${fileName.value}`;
  } catch (error) {
    errorMessage.value = messageFromError(error);
    status.value = 'Reload failed.';
  } finally {
    isLoading.value = false;
  }
}

function scheduleAutoSave(): void {
  if (!autoSaveEnabled.value || !isTauriRuntime() || !openedDocument.value?.path) return;
  if (autoSaveTimer !== null) window.clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = null;
    void saveDocument();
  }, 1200);
}

async function pollDiskChanges(): Promise<void> {
  if (!openedDocument.value?.path || !isTauriRuntime() || isSaving.value) return;
  try {
    const metadata = await getDocumentFileMetadata(openedDocument.value.path);
    if (lastDiskModifiedAt > 0 && metadata.modifiedAtMs > lastDiskModifiedAt + 1) {
      status.value = 'The file changed on disk. Reload before saving to review it.';
    }
  } catch {
    // A missing or locked file is reported when the user saves or reloads.
  }
}

function persistNonSecretSettings(): void {
  localStorage.setItem('superdoc.desktop.baseUrl', baseUrl.value.trim());
  localStorage.setItem('superdoc.desktop.model', model.value.trim());
}

async function runAgent(): Promise<void> {
  const document = getLiveDocument();
  if (!document || !agentPrompt.value.trim()) return;
  if (!apiKey.value.trim()) {
    agentError.value = 'Enter an API key for this session. It is not persisted by the app.';
    return;
  }

  persistNonSecretSettings();
  agentRunning.value = true;
  agentError.value = '';
  agentSummary.value = '';
  lastAgentResult.value = null;
  agentAbortController = new AbortController();
  suppressAutoSave = true;
  try {
    const result = await runDocumentAgent({
      document,
      prompt: agentPrompt.value.trim(),
      baseUrl: baseUrl.value,
      model: model.value,
      apiKey: apiKey.value,
      signal: agentAbortController.signal,
      onStatus: (nextStatus) => {
        agentStatus.value = nextStatus;
      },
    });
    lastAgentResult.value = result;
    agentSummary.value = result.summary;
    if (result.mutated) {
      isDirty.value = true;
      status.value = 'Agent changes are ready for review; they were not auto-saved.';
    }
  } catch (error) {
    agentError.value = messageFromError(error);
  } finally {
    suppressAutoSave = false;
    agentRunning.value = false;
    agentAbortController = null;
  }
}

function cancelAgent(): void {
  agentAbortController?.abort();
  agentStatus.value = 'Cancelling…';
}

function handleKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void saveDocument();
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('dragover', handleWindowDragOver);
  window.addEventListener('dragleave', handleWindowDragLeave);
  window.addEventListener('drop', handleWindowDrop);
  metadataTimer = window.setInterval(() => void pollDiskChanges(), 2500);
  void listenForNativeDrops();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('dragover', handleWindowDragOver);
  window.removeEventListener('dragleave', handleWindowDragLeave);
  window.removeEventListener('drop', handleWindowDrop);
  unlistenDragDrop?.();
  unlistenDragDrop = null;
  if (autoSaveTimer !== null) window.clearTimeout(autoSaveTimer);
  if (metadataTimer !== null) window.clearInterval(metadataTimer);
  agentAbortController?.abort();
  mountGeneration += 1;
  editor.value?.destroy?.();
});
</script>

<template>
  <main class="desktop-shell">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark">SD</span>
        <div>
          <h1>SuperDoc Desktop</h1>
          <p>{{ fileName }}</p>
        </div>
      </div>
      <div class="document-actions">
        <button :disabled="isLoading" @click="isTauriRuntime() ? openDocument() : openBrowserPicker()">Open</button>
        <button :disabled="!canSave" class="primary" @click="saveDocument">Save</button>
        <button :disabled="!editor || isSaving" @click="saveAs">Save As</button>
        <button :disabled="!openedDocument?.path || isLoading" @click="reloadFromDisk">Reload</button>
      </div>
      <div class="header-status" :class="{ dirty: isDirty }">
        <span class="status-dot" />
        {{ isDirty ? 'Unsaved' : 'Saved' }}
      </div>
    </header>

    <section class="workspace">
      <section class="editor-pane">
        <div ref="toolbarHost" class="editor-toolbar" />
        <!--
          SuperDoc mounts its own Vue app into `editorHost` and `mountDocument`
          clears the element before every mount. Nothing here may be owned by
          this template's render function: wiping Vue's children behind its back
          leaves stale vnodes and every later render throws.
        -->
        <div class="editor-area">
          <div ref="editorHost" class="editor-host" />
          <div v-if="!editor" class="empty-editor">
            <strong>Open a Word document</strong>
            <span>DOCX files stay local until you explicitly use the Agent or save them.</span>
            <button class="primary" @click="isTauriRuntime() ? openDocument() : openBrowserPicker()">Choose DOCX</button>
          </div>
        </div>
        <div class="status-bar">
          <span>{{ status }}</span>
          <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
        </div>
      </section>

      <aside class="agent-pane" :class="{ collapsed: !showAgent }">
        <button class="agent-toggle" @click="showAgent = !showAgent">
          {{ showAgent ? 'Hide Agent' : 'Show Agent' }}
        </button>
        <div v-if="showAgent" class="agent-content">
          <div class="agent-title">
            <div>
              <span class="eyebrow">CONTEXTUAL EDITING</span>
              <h2>Document Agent</h2>
            </div>
            <span class="local-badge">Tracked</span>
          </div>
          <p class="agent-description">
            Ask the Agent to inspect the open document or propose a precise edit. Changes remain tracked for your review.
          </p>
          <label class="field-label" for="agent-prompt">Instruction</label>
          <textarea id="agent-prompt" v-model="agentPrompt" rows="5" placeholder="E.g. Change every payment term from 60 to 30 days." />
          <div class="agent-settings">
            <label class="field-label" for="base-url">Base URL</label>
            <input id="base-url" v-model="baseUrl" autocomplete="off" @change="persistNonSecretSettings" />
            <label class="field-label" for="model">Model</label>
            <input id="model" v-model="model" autocomplete="off" @change="persistNonSecretSettings" />
            <label class="field-label" for="api-key">API key <span>(session only)</span></label>
            <input id="api-key" v-model="apiKey" type="password" autocomplete="off" placeholder="Not stored by the app" />
          </div>
          <div class="agent-controls">
            <button v-if="!agentRunning" class="primary" :disabled="!canRunAgent" @click="runAgent">Run Agent</button>
            <button v-else @click="cancelAgent">Stop</button>
            <label class="autosave-toggle">
              <input v-model="autoSaveEnabled" type="checkbox" />
              Auto-save local edits
            </label>
          </div>
          <div v-if="agentRunning || agentStatus" class="agent-status">{{ agentStatus }}</div>
          <div v-if="agentSummary" class="agent-summary">
            <span class="eyebrow">RESULT</span>
            <p>{{ agentSummary }}</p>
            <small v-if="lastAgentResult">{{ lastAgentResult.turns }} turn(s) · {{ lastAgentResult.status }}</small>
          </div>
          <div v-if="agentError" class="agent-error">{{ agentError }}</div>
          <p class="privacy-note">The document context is sent to the Base URL you configure. The API key is kept only in this session.</p>
        </div>
      </aside>
    </section>

    <input ref="browserFileInput" class="sr-only" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" @change="handleBrowserFile" />
    <div v-if="isDragActive" class="drop-overlay">Drop a DOCX file to open it</div>
  </main>
</template>
