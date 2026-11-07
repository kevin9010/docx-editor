import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openMock, save: saveMock }));

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
} from './document-session';

function useTauriRuntime(): void {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
}

describe('desktop document session', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    saveMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('extracts filenames from Windows and POSIX paths', () => {
    expect(fileNameFromPath('C:\\Documents\\contract.docx')).toBe('contract.docx');
    expect(fileNameFromPath('/tmp/contract.docx')).toBe('contract.docx');
    expect(fileNameFromPath('')).toBe('document.docx');
  });

  it('converts browser Files into an opened document', async () => {
    const file = new File(['hello'], 'draft.docx');
    const result = await readBrowserFile(file);

    expect(result).toEqual({
      path: null,
      name: 'draft.docx',
      data: new Uint8Array([104, 101, 108, 108, 111]),
    });
  });

  it('rejects native operations outside Tauri', async () => {
    expect(isTauriRuntime()).toBe(false);
    await expect(readDocumentFromPath('C:\\draft.docx')).rejects.toThrow(
      'Native file access is only available in the Tauri desktop runtime.',
    );
  });

  it('reads native documents and forwards byte arrays to Tauri', async () => {
    useTauriRuntime();
    invokeMock.mockResolvedValueOnce([1, 2, 3]);

    await expect(readDocumentFromPath('C:\\draft.docx')).resolves.toEqual({
      path: 'C:\\draft.docx',
      name: 'draft.docx',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(invokeMock).toHaveBeenCalledWith('read_file', { path: 'C:\\draft.docx' });

    await writeDocumentToPath('C:\\draft.docx', new Uint8Array([4, 5]));
    expect(invokeMock).toHaveBeenCalledWith('write_file', {
      path: 'C:\\draft.docx',
      data: [4, 5],
    });
  });

  it('handles cancelled dialogs and appends the DOCX extension', async () => {
    useTauriRuntime();
    openMock.mockResolvedValueOnce(null);
    expect(await chooseAndReadDocument()).toBeNull();

    saveMock.mockResolvedValueOnce(null);
    await expect(chooseSavePath()).resolves.toBeNull();

    saveMock.mockResolvedValueOnce('C:\\Documents\\renamed');
    await expect(chooseSavePath('C:\\Documents\\draft.docx')).resolves.toBe(
      'C:\\Documents\\renamed.docx',
    );
    expect(saveMock).toHaveBeenLastCalledWith(expect.objectContaining({
      defaultPath: 'C:\\Documents\\draft.docx',
    }));
  });

  it('saves to the current path or selected Save As path', async () => {
    useTauriRuntime();
    invokeMock.mockResolvedValue(undefined);
    await expect(saveDocumentBytes(new Uint8Array([7]), 'C:\\draft.docx')).resolves.toBe('C:\\draft.docx');
    expect(invokeMock).toHaveBeenCalledWith('write_file', {
      path: 'C:\\draft.docx',
      data: [7],
    });

    saveMock.mockResolvedValueOnce('C:\\new-name');
    await expect(saveDocumentBytes(new Uint8Array([8]), null)).resolves.toBe('C:\\new-name.docx');
  });

  it('reads file metadata through the native command', async () => {
    useTauriRuntime();
    invokeMock.mockResolvedValue({ modifiedAtMs: 123, size: 456 });

    await expect(getDocumentFileMetadata('C:\\draft.docx')).resolves.toEqual({
      modifiedAtMs: 123,
      size: 456,
    });
    expect(invokeMock).toHaveBeenCalledWith('file_metadata', { path: 'C:\\draft.docx' });
  });
});
