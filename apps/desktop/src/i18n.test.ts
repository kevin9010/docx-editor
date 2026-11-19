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
    expect(t('Codex exceeded the 9-minute limit. Review any suggestions before trying again.')).toBe('Codex 已超过 9 分钟时限，请先审阅已有建议，再重试。');
    expect(t('The Agent used all 12 turns before finishing. 3 suggestion(s) are ready for review; run it again for the remaining text or select a smaller passage.')).toContain('12 轮');
    locale.value = 'en';
    expect(t('Last update 21s ago')).toBe('Last update 21s ago');
  });
});
