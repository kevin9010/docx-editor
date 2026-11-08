import { t } from '../i18n';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface OpenedDocument {
  path: string | null;
  name: string;
  data: Uint8Array;
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

  const bytes = await invoke<number[]>('read_file', { path: filePath });
  return {
    path: filePath,
    name: fileNameFromPath(filePath),
    data: Uint8Array.from(bytes),
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

export async function writeDocumentToPath(filePath: string, data: Uint8Array): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('Native file access is only available in the Tauri desktop runtime.');
  }

  await invoke('write_file', { path: filePath, data: Array.from(data) });
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
  data: Uint8Array,
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
