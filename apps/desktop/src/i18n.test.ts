import { afterEach, describe, expect, it } from 'vitest';
import { locale, t } from './i18n';

afterEach(() => { locale.value = 'zh-CN'; });
describe('desktop messages', () => {
  it('preserves filenames and provider details in localized progress', () => {
    locale.value = 'zh-CN';
    expect(t('Loading 申请书_{正式稿}.docx…')).toBe('正在加载 申请书_{正式稿}.docx…');
    expect(t('Connection interrupted; Codex is retrying. HTTP 503')).toBe('连接中断，Codex 正在重试。HTTP 503');
    expect(t('Last update 21s ago')).toBe('21 秒前收到更新');
    expect(t('Unknown provider response')).toBe('Unknown provider response');
    locale.value = 'en';
    expect(t('Last update 21s ago')).toBe('Last update 21s ago');
  });
});
