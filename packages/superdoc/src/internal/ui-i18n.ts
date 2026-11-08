import { getCurrentInstance, shallowRef, type Ref } from 'vue';

type Locale = 'en' | 'zh-CN';

// Public/headless controllers can read and change language before Vue is installed.
// Attach reactivity only when a built-in surface actually renders.
function createLocaleState(value: Locale) {
  let reactive: Ref<Locale> | undefined;
  return {
    get value(): Locale { return reactive?.value ?? value; },
    set value(next: Locale) { value = next; if (reactive) reactive.value = next; },
    bind(): Ref<Locale> { return reactive ??= shallowRef(value); },
  };
}
const locales = new WeakMap<object, ReturnType<typeof createLocaleState>>();
const fallback = createLocaleState('en');

export function uiLocale(owner?: object) {
  if (!owner) return fallback;
  let locale = locales.get(owner);
  if (!locale) {
    const configured = (owner as { config?: { ui?: { locale?: unknown } } }).config?.ui?.locale;
    locale = createLocaleState(configured === 'zh-CN' ? 'zh-CN' : 'en');
    locales.set(owner, locale);
  }
  return locale;
}

const zh: Record<string, string> = {
  'Applying…': '正在应用…', 'Remove selected watermark': '移除所选水印', 'Remove watermark': '移除水印', 'Apply watermark': '应用水印',
  'No picture selected': '尚未选择图片', 'Replace picture': '替换图片', 'Choose picture': '选择图片',
  'Horizontal': '水平', 'Diagonal': '倾斜', 'left': '左对齐', 'center': '居中', 'right': '右对齐',
  'The document changed. Review the latest state before applying.': '文档已变化，请核对最新状态后再应用。',
  'Add page numbers': '添加页码',
  'Page numbers can’t be changed as a suggestion. Switch to Editing to change them.': '页码无法作为修订更改，请切换到编辑模式。',
  'Page numbers can’t be changed right now.': '当前无法更改页码。',
  'In the header or footer you’re editing': '插入到正在编辑的页眉或页脚',
  'Place the cursor without selecting text': '请取消文本选择，仅放置光标',
  'Click into a header or footer first': '请先点击页眉或页脚',
  'No watermark': '无水印', 'Picture': '图片', 'Remove selected': '移除所选水印',
  '(disabled)': '（不可用）', '0% opaque, 100% transparent': '0% 为不透明，100% 为完全透明',
  'Add link': '添加链接', 'Add watermark': '添加水印', 'All applicable': '所有适用页面', 'Apply to': '应用到', 'Auto': '自动',
  'Choose font color': '选择字体颜色', 'Choose watermark picture': '选择水印图片', 'Clear color selection': '清除所选颜色',
  'Close watermark dialog': '关闭水印对话框', 'Custom colors': '自定义颜色', 'Custom placement retained.': '保留自定义位置。',
  'Custom size retained': '保留自定义尺寸', 'Default': '默认', 'Entire document': '整篇文档', 'Even': '偶数页', 'First': '首页',
  'First page number': '起始页码', 'Font': '字体', 'Font color': '字体颜色', 'Format': '格式',
  "Lighten the picture's colors.": '淡化图片颜色。', 'Link details': '链接信息', 'Orientation': '方向', 'PNG or JPEG': 'PNG 或 JPEG',
  'Page anchor': '页面定位', 'Page type': '页面类型', 'Picture scale': '图片缩放', 'Position': '位置', 'Preserve aspect ratio': '保持宽高比',
  'Preview': '预览', 'Preview at the selected page size': '按所选页面尺寸预览', 'Remove': '移除', 'Review latest state': '查看最新状态',
  'Scale': '缩放', 'Size (pt)': '字号（磅）', 'Start at': '起始值', 'Text presets': '预设文字', 'Transparency': '透明度',
  'Transparency percentage': '透明度百分比', 'Type or paste a link': '输入或粘贴链接', 'Update': '更新', 'Washout': '淡化',
  'Watermark preview': '水印预览', 'Watermark scope': '水印范围', 'Watermark settings': '水印设置', 'Watermark text': '水印文字',
  'Watermark type': '水印类型', 'Watermarks to edit': '要编辑的水印',
  'Find text': '查找文字', 'Replace text': '替换文字', 'Previous match (Shift+Enter)': '上一个匹配项（Shift+Enter）', 'Next match (Enter)': '下一个匹配项（Enter）',
  'Close (Escape)': '关闭（Esc）', 'Close find and replace': '关闭查找和替换', 'All': '全部', 'Use regular expression': '使用正则表达式', 'Invalid pattern': '无效的正则表达式',
  'Reply or add others with @': '回复或使用 @ 提及他人', 'Comment or add others with @': '添加批注或使用 @ 提及他人', 'Retry': '重试',
  'Bold': '加粗', 'Font family': '字体', 'Font size': '字号', 'AI text generation': 'AI 生成文字',
  'Italic': '斜体', 'Underline': '下划线', 'Highlight color': '突出显示颜色', 'Highlight': '突出显示',
  'Strikethrough': '删除线', 'Text color': '文字颜色', 'Color': '文字颜色', 'Search': '查找',
  'Link': '链接', 'Link dropdown': '链接选项', 'Image': '图片', 'Table of contents': '目录', 'Watermark': '水印',
  'Page number': '页码', 'Insert table': '插入表格', 'Table': '表格', 'Table options': '表格选项', 'Table actions': '表格操作',
  'Insert row above': '在上方插入行', 'Insert row below': '在下方插入行', 'Insert column left': '在左侧插入列', 'Insert column right': '在右侧插入列',
  'Delete row': '删除行', 'Delete column': '删除列', 'Delete table': '删除表格', 'Remove borders': '移除边框', 'Merge cells': '合并单元格',
  'Split cell': '拆分单元格', 'Fix tables': '修复表格', 'Alignment': '对齐方式', 'Text align': '段落对齐',
  'Bullet list': '项目符号', 'Numbered list': '编号列表', 'Left indent': '减少缩进', 'Right indent': '增加缩进',
  'Left-to-right': '从左向右', 'Right-to-left': '从右向左', 'Zoom': '缩放', 'Measurement unit': '度量单位',
  'Undo': '撤销', 'Redo': '重做', 'Track Changes': '修订', 'Track changes': '修订',
  'Accept changes under selection': '接受选区中的修订', 'Reject changes under selection': '拒绝选区中的修订',
  'Accept tracked changes': '接受修订', 'Reject tracked changes': '拒绝修订', 'Toggle Show Original': '切换显示原始版本',
  'Toggle Show Final': '切换显示最终版本', 'Clear formatting': '清除格式', 'Format painter': '格式刷', 'Copy formatting': '格式刷',
  'Line height': '行距', 'Format text': '文字格式', 'Show or hide ruler': '显示或隐藏标尺', 'Ruler': '标尺',
  'Show or hide formatting marks': '显示或隐藏格式标记', 'Formatting marks': '格式标记', 'Insert page break': '插入分页符',
  'Editing': '编辑', 'Suggesting': '修订', 'Viewing': '阅读', 'Document mode': '文档模式',
  'Edit document directly': '直接编辑文档', 'Edits become suggestions': '将修改标记为修订', 'View clean version of document only': '只读查看文档',
  'Linked styles': '段落样式', 'Update to match selection': '更新为选区的格式', 'Update style to match selection': '更新样式为选区格式',
  'Toolbar': '工具栏', 'Overflow items': '更多工具', 'Toolbar separator': '工具栏分隔线', 'Options': '选项',
  'Left': '左对齐', 'Center': '居中', 'Right': '右对齐', 'Justify': '两端对齐',
  'Align left': '左对齐', 'Align center': '居中', 'Align right': '右对齐', 'Justify text': '两端对齐',
  'Inches': '英寸', 'Centimeters': '厘米', 'Points': '磅', 'Automatic': '自动', 'None': '无',
  'Add a comment': '添加批注', 'Comment': '批注', 'Comments': '批注', 'Reply': '回复', 'Reply…': '回复…',
  'Cancel': '取消', 'Save': '保存', 'Send': '发送', 'Submit': '提交', 'Delete': '删除', 'Edit': '编辑',
  'Resolve': '解决', 'Resolved': '已解决', 'Reopen': '重新打开', 'Reopen comment': '重新打开批注',
  'Resolve comment': '解决批注', 'Delete comment': '删除批注', 'Edit comment': '编辑批注',
  'IMPORTED': '已导入', 'Show more': '展开', 'Show less': '收起', 'Accept': '接受', 'Reject': '拒绝',
  'Added hyperlink ': '添加超链接 ', 'Changed hyperlink to ': '将超链接改为 ', 'Added new line': '添加新行',
  'Added table': '添加表格', 'Deleted table': '删除表格', 'Format: ': '格式：', 'Replaced ': '将 ',
  ' with ': ' 替换为 ', 'Deleted line break': '删除换行符', 'Added line break': '添加换行符', 'Deleted ': '删除 ', 'Added ': '添加 ',
  'Comment thread': '批注会话', 'Tracked change discussion': '修订讨论', 'Comment actions': '批注操作',
  'Reply to comment': '回复批注', 'Comment reply': '批注回复', 'Comment text': '批注内容',
  'No comments yet': '暂无批注', 'No comments': '暂无批注', 'No changes': '暂无修订',
  'Find': '查找', 'Find…': '查找…', 'Find in document': '在文档中查找', 'Replace': '替换', 'Replace…': '替换…',
  'Replace with': '替换为', 'Replace all': '全部替换', 'No results': '无匹配结果', 'No matches': '无匹配结果',
  'Previous match': '上一个匹配项', 'Next match': '下一个匹配项', 'Close': '关闭', 'Close search': '关闭查找',
  'Match case': '区分大小写', 'Ignore diacritics': '忽略变音符号', 'Regular expression': '正则表达式',
  'Use regular expressions': '使用正则表达式', 'Toggle replace': '展开或收起替换',
  'Password Required': '需要密码', 'Incorrect Password': '密码错误', 'Open': '打开', 'Decrypting…': '正在解密…',
  'This document is password protected. Enter the password to open it.': '本文档受密码保护，请输入密码以打开。',
  'Enter password': '请输入密码', 'Document password': '文档密码', 'Incorrect password. Please try again.': '密码错误，请重试。',
  'Timed out while decrypting. Please try again.': '解密超时，请重试。', 'Unable to decrypt this document.': '无法解密本文档。',
  'Loading…': '正在加载…', 'Loading document…': '正在加载文档…', 'Loading document': '正在加载文档',
  'Text': '文字', 'URL': '网址', 'Apply': '应用', 'Insert': '插入', 'Remove link': '移除链接', 'Open link': '打开链接',
  'Edit link': '编辑链接', 'Insert link': '插入链接', 'Display text': '显示文字',
  'Page numbers': '页码', 'Top of page': '页眉', 'Bottom of page': '页脚', 'Show on first page': '首页显示页码',
  'Remove page numbers': '移除页码', 'Insert at cursor': '在光标处插入', 'Page Number': '页码',
};

/** Only application-authored UI copy belongs here, never document or comment content. */
export function translateUi(locale: 'en' | 'zh-CN', message: string): string {
  if (locale === 'en') return message;
  if (message.endsWith(' options')) return `${translateUi(locale, message.slice(0, -8))}选项`;
  return zh[message] ?? message;
}

export function useUiTranslation() {
  const globals = getCurrentInstance()?.appContext.config.globalProperties;
  const owner = globals?.$superdoc ?? globals?.$toolbar?.superdoc;
  const locale = uiLocale(owner).bind();
  return { locale, t: (message: string) => translateUi(locale.value, message) };
}
