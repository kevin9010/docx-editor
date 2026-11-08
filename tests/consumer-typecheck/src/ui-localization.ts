import type { Config, SuperDoc } from 'superdoc';
import type { SuperDocUI } from 'superdoc/ui';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const config = { selector: '#editor', ui: { locale: 'zh-CN' } } satisfies Config;
const params: Equal<Parameters<SuperDocUI['setLocale']>, [locale: 'en' | 'zh-CN']> = true;
const result: Equal<ReturnType<SuperDocUI['setLocale']>, void> = true;
const read: Equal<ReturnType<SuperDocUI['getLocale']>, 'en' | 'zh-CN'> = true;
const readParams: Equal<Parameters<SuperDocUI['getLocale']>, []> = true;
declare const superdoc: SuperDoc;
superdoc.ui.setLocale('zh-CN');
superdoc.ui.setLocale('en');
const language: 'en' | 'zh-CN' = superdoc.ui.getLocale();
// @ts-expect-error Only supported UI locales are accepted.
superdoc.ui.setLocale('fr');
// @ts-expect-error Startup configuration rejects unsupported UI locales.
const invalid: Config = { selector: '#editor', ui: { locale: 'fr' } };
void [config, params, result, read, readParams, language, invalid];
