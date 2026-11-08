import { Menu, MenuItem, Submenu, CheckMenuItem, type MenuItemOptions } from '@tauri-apps/api/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t, type Locale } from './i18n';

export type MenuCommand = 'open' | 'save' | 'saveAs' | 'reload' | 'autoSave' | 'agent' | 'zh-CN' | 'en';
export interface MenuState {
  fileName: string; dirty: boolean; canOpen: boolean; canSave: boolean; canReload: boolean;
  autoSave: boolean; agent: boolean; locale: Locale;
}
export const fileCommands = [
  { id: 'open', label: 'Open', shortcut: 'Ctrl+O', accelerator: 'CmdOrCtrl+O' },
  { id: 'save', label: 'Save', shortcut: 'Ctrl+S', accelerator: 'CmdOrCtrl+S' },
  { id: 'saveAs', label: 'Save As', shortcut: 'Ctrl+Shift+S', accelerator: 'CmdOrCtrl+Shift+S' },
  { id: 'reload', label: 'Reload', shortcut: 'Ctrl+Shift+R', accelerator: 'CmdOrCtrl+Shift+R' },
] as const;
export function commandEnabled(id: string, state: MenuState): boolean {
  return id === 'open' ? state.canOpen : id === 'reload' ? state.canReload : state.canSave;
}

export async function createNativeMenu(state: MenuState, dispatch: (id: MenuCommand) => void) {
  const resources: Array<{ close(): Promise<void> }> = [];
  try {
    const createItem = async (options: MenuItemOptions) => {
      const item = await MenuItem.new(options); resources.push(item); return item;
    };
    const items = await Promise.all(fileCommands.map(item => createItem({
      id: `desktop-${item.id}`, text: t(item.label), accelerator: item.accelerator,
      enabled: commandEnabled(item.id, state), action: () => dispatch(item.id),
    })));
    const check = async (id: MenuCommand, text: string, checked: boolean) => {
      const item = await CheckMenuItem.new({ id: `desktop-${id}`, text, checked, action: () => dispatch(id) });
      resources.push(item); return item;
    };
    const autoSave = await check('autoSave', t('Auto-save'), state.autoSave);
    const agent = await check('agent', t('Document Agent'), state.agent);
    const chinese = await check('zh-CN', '简体中文', state.locale === 'zh-CN');
    const english = await check('en', 'English', state.locale === 'en');
    const file = await Submenu.new({ text: t('File'), items: [...items, { item: 'Separator' }, autoSave] }); resources.push(file);
    const view = await Submenu.new({ text: t('View'), items: [agent] }); resources.push(view);
    const language = await Submenu.new({ text: t('Language'), items: [chinese, english] }); resources.push(language);
    const menu = await Menu.new({ items: [file, view, language] }); resources.push(menu);
    const previous = await menu.setAsWindowMenu();
    await previous?.close().catch(() => {});
    return {
      async update(next: MenuState) {
        await Promise.all([
          ...items.map((item, index) => item.setEnabled(commandEnabled(fileCommands[index].id, next))),
          ...items.map((item, index) => item.setText(t(fileCommands[index].label))),
          autoSave.setChecked(next.autoSave), autoSave.setText(t('Auto-save')),
          agent.setChecked(next.agent), agent.setText(t('Document Agent')),
          chinese.setChecked(next.locale === 'zh-CN'), english.setChecked(next.locale === 'en'),
          file.setText(t('File')), view.setText(t('View')), language.setText(t('Language')),
          getCurrentWindow().setTitle(`${next.dirty ? '* ' : ''}${t(next.fileName)} — SuperDoc Desktop`),
        ]);
      },
      async dispose() { for (const resource of resources.reverse()) await resource.close().catch(() => {}); },
    };
  } catch (error) {
    for (const resource of resources.reverse()) await resource.close().catch(() => {});
    throw error;
  }
}
