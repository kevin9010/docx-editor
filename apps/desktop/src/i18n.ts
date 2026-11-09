import { ref } from 'vue';

export type Locale = 'en' | 'zh-CN';
export const locale = ref<Locale>(typeof localStorage !== 'undefined' && localStorage.getItem('superdoc.desktop.locale') === 'en' ? 'en' : 'zh-CN');
export function setLocale(value: Locale): void {
  locale.value = value;
  localStorage.setItem('superdoc.desktop.locale', value);
  document.documentElement.lang = value;
}

const zh: Record<string, string> = {
  'Copy': '复制', 'Cut': '剪切', 'Paste': '粘贴', 'Paste without formatting': '粘贴为纯文本', 'Select all': '全选', 'Select All': '全选',
  'Bold': '加粗', 'Italic': '斜体', 'Underline': '下划线', 'Strikethrough': '删除线', 'Accept change': '接受修订', 'Reject change': '拒绝修订', 'Delete': '删除',
  'File': '文件', 'View': '视图', 'Language': '语言', 'Application menu': '应用菜单',
  'Open': '打开', 'Save': '保存', 'Save As': '另存为', 'Reload': '重新载入',
  'Auto-save': '自动保存', 'Unsaved': '未保存', 'Saved': '已保存', 'No document': '未打开文档',
  'Show Agent': '展开助手', 'Hide Agent': '收起助手', 'Document Agent': '文档助手',
  'Open a DOCX file to begin.': '打开 DOCX 文档以开始编辑。',
  'Open a Word document': '打开 Word 文档', 'Choose DOCX': '选择 DOCX 文档',
  'DOCX files stay local until you explicitly use the Agent or save them.': '文档在本机编辑。使用助手时才会发送所选内容，保存时写入文件。',
  'Drop a DOCX file to open it': '拖入 DOCX 文件以打开',
  'Only DOCX files can be opened by dropping them on the window.': '仅支持拖入 DOCX 文件。',
  'Open failed.': '打开失败。', 'Save failed.': '保存失败。', 'Save As failed.': '另存为失败。', 'Reload failed.': '重新载入失败。',
  'Could not load the document.': '无法加载文档。', 'An unexpected desktop error occurred.': '桌面客户端发生意外错误。',
  'The editor surface is not mounted.': '编辑器尚未就绪。', 'No document is open.': '尚未打开文档。',
  'SuperDoc did not return an exported DOCX.': 'SuperDoc 未能导出 DOCX 文件。',
  'Loading {name}…': '正在加载 {name}…', 'Ready — {name}': '就绪 — {name}',
  'Unsaved changes — {name}': '有未保存的修改 — {name}', 'Saved {name}': '已保存 {name}', 'Reloaded {name}': '已重新载入 {name}',
  'Discard unsaved changes and open another document?': '放弃未保存的修改并打开其他文档？',
  'Discard unsaved changes and open the dropped document?': '放弃未保存的修改并打开拖入的文档？',
  'Reload the file from disk and discard unsaved changes?': '从磁盘重新载入文件并放弃未保存的修改？',
  'The file changed on disk. Overwrite it with your current edits?': '磁盘上的文件已被修改。是否用当前编辑内容覆盖？',
  'Save cancelled because the file changed on disk.': '文件已被其他程序修改，本次保存已取消。',
  'The file changed on disk. Reload before saving to review it.': '文件已被其他程序修改，请重新载入并核对后再保存。',
  'Downloaded edited DOCX (browser preview).': '已下载编辑后的 DOCX（浏览器预览）。',
  'Agent revisions are ready for review. Auto-save is paused until you save.': '助手修订已应用，等待审阅。自动保存已暂停，请核对后手动保存。',
  'Open Word document': '打开 Word 文档', 'Save Word document': '保存 Word 文档', 'Word document': 'Word 文档',
  'Scroll toolbar left': '向左滚动工具栏', 'Scroll toolbar right': '向右滚动工具栏', 'Scrollable document toolbar': '可横向滚动的文档工具栏',
  'WRITING ASSISTANT': '写作助手', 'Agent progress': '助手进度', 'Stop and review': '停止并审阅', 'Stop': '停止',
  'Elapsed': '已用时', 'Duration': '耗时', 'Last update {seconds}s ago': '{seconds} 秒前收到更新', '{count} suggestion(s)': '{count} 条建议',
  'No new update for {seconds}s. Waiting for {provider}; you can stop at any time.': '已 {seconds} 秒没有新消息，正在等待{provider}，可随时停止。',
  'Codex / its model provider': 'Codex 或其模型服务', 'the model endpoint': '模型接口',
  'Activity · {count} updates': '过程记录 · {count} 条', 'Connect with': '连接方式',
  'Local Codex CLI': '本机 Codex CLI', 'Base URL': '自定义 API 地址', 'Connection settings': '连接设置',
  'Codex executable': 'Codex 程序路径', '(optional)': '（可选）', 'Auto-detect installed Codex': '自动检测已安装的 Codex',
  'Model': '模型', 'CLI default': '使用 CLI 默认模型', 'Check connection': '测试连接',
  'Uses the Codex already installed on this computer and its existing login.': '使用本机已安装的 Codex 和已有登录状态。',
  'API key': 'API 密钥', '(session only)': '（仅本次会话）', 'Not stored by the app': '应用不会保存密钥',
  'Choose an action, review the scope and instructions, then confirm below to start.': '先选择功能，核对处理范围和补充要求，再点击下方确认按钮开始。', 'Writing actions': '写作功能',
  'Revise': '修订', 'Polish': '润色', 'Proofread': '校对', 'Academic': '学术润色', 'Translate': '翻译', 'Summarize': '总结', 'Custom': '自定义',
  'Work on': '处理范围', 'Whole document': '整篇文档', 'Selected passage': '选中段落',
  'Select a passage in the document to continue.': '请先在文档中选择需要处理的文字。',
  'Output language': '输出语言', 'E.g. English / 简体中文': '例如：简体中文 / English', 'Keep original language': '保持原文语言',
  'Instruction': '补充要求', 'E.g. Make the tone warmer while preserving the meaning.': '例如：保持原意，使表述更严谨、自然。',
  'Confirm and generate suggestions': '确认并生成建议', 'Review task': '确认任务',
  'Starting generates suggestions for your review. You can edit each suggestion before applying it.': '确认后将生成待审核的建议，您可以逐条修改后再应用。',
  'Suggested (editable)': '建议内容（可编辑）', 'Comment (editable)': '批注内容（可编辑）',
  'Edit suggestion {number}': '编辑建议 {number}', 'Edit comment {number}': '编辑批注 {number}',
  'Review and edit this text, then apply when ready.': '请核对或修改以上内容，确认后再应用。',
  'Edited by you': '已手动修改', 'Restore Agent suggestion': '恢复 Agent 原建议',
  'Enter a comment before applying it.': '请填写批注内容后再应用。',
  'Keep the suggestion within 16,000 characters.': '建议内容请控制在 16,000 字符以内。',
  'The suggested text is identical to the original.': '建议内容与原文相同，无需应用。',
  'RESPONSE': '回复', 'Suggestions · {count}': '修改建议 · {count}',
  'REVISION': '修订', 'COMMENT': '批注', 'pending': '待审阅', 'applied': '已应用', 'dismissed': '已忽略',
  'Original': '原文', 'Suggested': '建议内容', 'Comment': '批注', '(Delete this text)': '（删除这段文字）',
  'Apply as revision': '以修订方式应用', 'Add comment': '添加批注', 'Dismiss': '忽略',
  'your Codex provider': 'Codex 配置的模型服务', 'your configured endpoint': '自定义模型接口',
  'Only when you run the Agent, the chosen document context is sent through {provider}. Suggestions are saved only when you apply them and save the document.': '运行助手时，所选文档内容会发送至{provider}。建议只有在您应用并保存文档后才写入文件。',
  'Stopping the current operation…': '正在停止当前操作…', 'Cancelled.': '已取消。', 'Stopped.': '已停止。',
  'Checking installed Codex…': '正在检测本机 Codex…',
  'Codex is ready. Your existing login and CLI settings will be used.': 'Codex 连接正常，将使用已有登录状态和 CLI 配置。',
  'Connection check stopped.': '连接测试已停止。', 'Connection check failed.': '连接测试失败。',
  'Preparing document context…': '正在准备文档内容…',
  'Enter a session API key in Connection settings, then retry.': '请在“连接设置”中填写本次会话的 API 密钥后重试。',
  'Enter the language to translate into.': '请先填写要翻译成的目标语言。',
  'The selection changed or expired. Select the passage again before running the Agent.': '选区已变化或失效，请重新选择文字后运行助手。',
  'Select a shorter passage (up to 12,000 characters), or choose Whole document.': '请将选区缩短至 12,000 字符以内，或选择“整篇文档”。',
  'Ready for your review.': '建议已就绪，请审阅。', 'Stopped. Any suggestions below can still be reviewed.': '已停止，仍可审阅下方已生成的建议。',
  'The run did not complete.': '任务未能完成。', 'Could not start the Agent.': '无法启动助手。',
  'Applied for review. Accept or reject in SuperDoc, then save when ready.': '已应用为修订，请在编辑器中接受或拒绝，确认后保存。',
  'Codex is not signed in. Run codex login in your terminal, then check the connection again.': 'Codex 尚未登录。请在终端运行 codex login，然后重新测试连接。',
  'Local Codex is available in the desktop app. The browser preview cannot launch local programs.': '本机 Codex 仅能在桌面客户端中使用，浏览器预览无法启动本地程序。',
  'Starting the installed Codex CLI…': '正在启动本机 Codex CLI…', 'Codex started. Initializing the connection…': 'Codex 已启动，正在初始化连接…',
  'Checking the existing Codex login…': '正在检查 Codex 登录状态…', 'Loading available Codex models…': '正在获取可用的 Codex 模型…',
  'Creating a Codex document session…': '正在创建 Codex 文档会话…', 'Sending your instruction to {model}…': '正在向 {model} 发送任务…',
  'Codex accepted the request. Waiting for the model…': 'Codex 已接收任务，正在等待模型…',
  'The model is processing your request…': '模型正在处理您的请求…', 'Receiving the model response…': '正在接收模型回复…',
  'Connection interrupted; Codex is retrying. {detail}': '连接中断，Codex 正在重试。{detail}',
  'The model service is retrying ({attempt}/{limit}). Review the provider details below.': '模型服务正在重试（{attempt}/{limit}），请查看下方原因。',
  'The model service has reached its concurrent request limit.': '模型服务的账号并发请求已达上限。',
  'This limit comes from the model provider. Wait for other requests using this account to finish, then retry. The local Codex process is connected.': '这是模型服务的并发限制。请等待同一账号的其他请求结束后再试，本机 Codex 进程连接正常。',
  'The model service rejected authentication or access.': '模型服务拒绝了认证或访问请求。',
  'Check the selected model and the login or credentials used by your Codex provider.': '请检查所选模型，以及 Codex 模型服务使用的登录状态或凭据。',
  'The model service is limiting requests or usage.': '模型服务触发了请求频率或用量限制。',
  'Check your provider quota or wait before retrying. Reconnecting the local CLI does not remove this limit.': '请检查服务商额度，或稍后重试。重新连接本机 CLI 无法解除此限制。',
  'The model request failed.': '模型请求失败。',
  'The local CLI started successfully. Check the provider error below for connection, model, or request details.': '本机 CLI 已启动，请查看下方服务商错误详情，了解连接、模型或请求问题。',
  'Provider error details': '模型服务错误详情',
  'Stopped after five consecutive model service errors. Review the provider details below before retrying.': '模型服务已连续报错五次，本次任务已停止。请查看下方错误详情后再重试。',
  'The run stopped because the model service returned errors. Review the details below.': '模型服务返回错误，任务已停止。请查看下方原因。',
  'Codex login and model list checked. Provider availability is checked when you generate suggestions.': 'Codex 登录状态与模型列表已检查。模型服务是否可用将在生成建议时验证。',
  'Codex reported a system error. Check its provider connection and retry.': 'Codex 报告系统错误，请检查模型服务连接后重试。',
  'Codex is waiting for an external action. You can stop and retry with document-only instructions.': 'Codex 正在等待外部操作。您可以停止任务，再用仅涉及文档处理的要求重试。',
  'Codex requested an unsupported action; only document tools are available.': 'Codex 请求了不支持的操作；此处仅提供文档处理工具。',
  'Reading the selected document context…': '正在读取所选文档内容…', 'Preparing a suggestion for review…': '正在准备修改建议…',
  'Suggestion ready. Waiting for Codex to finish; you can stop and review now.': '建议已生成，正在等待 Codex 完成说明；也可现在停止并审阅。',
  'Suggestion ready. Waiting for the model to finish; you can stop and review now.': '建议已生成，正在等待模型完成说明；也可现在停止并审阅。',
  'Document context sent. Waiting for the model…': '文档内容已发送，正在等待模型…', 'Document context read.': '已读取文档内容。',
  'Asking the model (turn {turn}/{total})…': '正在请求模型（第 {turn}/{total} 轮）…', 'Running {tool}…': '正在运行文档工具 {tool}…',
  'Document tool: {detail}': '文档工具：{detail}',
  'The Agent run was cancelled.': '助手任务已取消。',
  'The Agent run was cancelled. Pending suggestions remain available for review.': '助手任务已取消，已生成的建议仍可审阅。',
  'Codex finished. Review the suggestions below.': 'Codex 已完成，请审阅下方建议。',
  'Codex did not respond to {method}. Reconnect and try again.': 'Codex 未响应 {method}，请重新连接后重试。',
  'Codex exceeded the five-minute limit. Review any suggestions before trying again.': 'Codex 已超过五分钟时限，请先审阅已有建议，再重试。',
  'No Codex activity for two minutes. The run was stopped. Check the Codex provider connection or choose another model, then retry. Existing suggestions are still available.': 'Codex 已两分钟没有新消息，任务已停止。请检查模型服务连接或切换模型后重试，已有建议仍可审阅。',
  'Codex is disconnected.': 'Codex 已断开连接。', 'Codex connection closed.': 'Codex 连接已关闭。',
  'Language changes apply immediately without reloading the document.': '切换界面语言立即生效，不会重新载入文档。',
};

const patterns = Object.entries(zh).filter(([key]) => key.includes('{')).map(([key, translated]) => {
  const names: string[] = [];
  const expression = key.split(/(\{\w+\})/).map(part => {
    if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([\\s\\S]*?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { expression: new RegExp(`^${expression}$`), names, translated };
});

/** Translate application-owned copy only. Document text and model output never go through this function. */
export function t(message: string): string {
  if (locale.value === 'en') return message;
  if (zh[message]) return zh[message];
  for (const pattern of patterns) {
    const match = pattern.expression.exec(message);
    if (match) return pattern.translated.replace(/\{(\w+)\}/g, (_, name: string) => match[pattern.names.indexOf(name) + 1] ?? '');
  }
  return message;
}
