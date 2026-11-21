import { t } from '../i18n';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Must match `DOCUMENT_PATH_HEADER` in src-tauri/src/commands.rs. */
export const DOCUMENT_PATH_HEADER = 'x-superdoc-path';

export interface OpenedDocument {
  path: string | null;
  name: string;
  data: Uint8Array<ArrayBuffer>;
}

export interface DocumentFileMetadata {
  modifiedAtMs: number;
  size: number;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'document.docx';
}

export async function readDocumentFromPath(filePath: string): Promise<OpenedDocument> {
  if (!isTauriRuntime()) {
    throw new Error('Native file access is only available in the Tauri desktop runtime.');
  }

  // `read_file` answers with a binary IPC response, which arrives as an ArrayBuffer.
  const bytes = await invoke<ArrayBuffer>('read_file', { path: filePath });
  return {
    path: filePath,
    name: fileNameFromPath(filePath),
    data: new Uint8Array(bytes),
  };
}

export async function chooseAndReadDocument(): Promise<OpenedDocument | null> {
  if (!isTauriRuntime()) {
    throw new Error('Use the browser file picker when running the Vite preview.');
  }

  const selected = await open({
    title: t('Open Word document'),
    multiple: false,
    directory: false,
    filters: [{ name: t('Word document'), extensions: ['docx'] }],
  });

  if (!selected || Array.isArray(selected)) return null;
  return readDocumentFromPath(selected);
}

export async function writeDocumentToPath(filePath: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('Native file access is only available in the Tauri desktop runtime.');
  }

  // Send the bytes as a raw octet-stream body; JSON would encode every byte as a number.
  await invoke('write_file', data, { headers: { [DOCUMENT_PATH_HEADER]: encodeURIComponent(filePath) } });
}

export async function chooseSavePath(defaultPath?: string | null): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw new Error('Native save dialogs are only available in the Tauri desktop runtime.');
  }

  const selected = await save({
    title: t('Save Word document'),
    defaultPath: defaultPath ?? undefined,
    filters: [{ name: t('Word document'), extensions: ['docx'] }],
  });

  if (!selected) return null;
  return /\.docx$/i.test(selected) ? selected : `${selected}.docx`;
}

export async function saveDocumentBytes(
  data: Uint8Array<ArrayBuffer>,
  currentPath: string | null,
): Promise<string | null> {
  const destination = currentPath ?? (await chooseSavePath());
  if (!destination) return null;

  await writeDocumentToPath(destination, data);
  return destination;
}

export async function getDocumentFileMetadata(filePath: string): Promise<DocumentFileMetadata> {
  if (!isTauriRuntime()) {
    throw new Error('Native file access is only available in the Tauri desktop runtime.');
  }

  return invoke<DocumentFileMetadata>('file_metadata', { path: filePath });
}

export async function readBrowserFile(file: File): Promise<OpenedDocument> {
  return {
    path: null,
    name: file.name,
    data: new Uint8Array(await file.arrayBuffer()),
  };
}
