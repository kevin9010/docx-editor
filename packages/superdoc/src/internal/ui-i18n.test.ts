import { describe, expect, it } from 'vite-plus/test';
import { createSuperDocUI } from '../public/ui/create-super-doc-ui';
import { translateUi } from './ui-i18n';

function host(locale?: 'en' | 'zh-CN') {
  return { config: { ui: { locale } }, activeEditor: null, on: () => {}, off: () => {} };
}

describe('built-in UI language', () => {
  it('keeps language local to an instance and ignores changes after disposal', () => {
    const chinese = createSuperDocUI({ superdoc: host('zh-CN') });
    const english = createSuperDocUI({ superdoc: host() });
    expect(chinese.getLocale()).toBe('zh-CN');
    expect(english.getLocale()).toBe('en');
    chinese.setLocale('en');
    english.setLocale('zh-CN');
    expect(chinese.getLocale()).toBe('en');
    expect(english.getLocale()).toBe('zh-CN');
    english.destroy();
    english.setLocale('en');
    expect(english.getLocale()).toBe('zh-CN');
    chinese.destroy();
  });

  it('preserves unknown copy and switches built-in labels without changing commands', () => {
    expect(translateUi('zh-CN', 'Font family options')).toBe('字体选项');
    expect(translateUi('zh-CN', 'Accept tracked changes')).toBe('接受修订');
    expect(translateUi('en', 'Accept tracked changes')).toBe('Accept tracked changes');
    expect(translateUi('zh-CN', 'Custom application label')).toBe('Custom application label');
  });
});
