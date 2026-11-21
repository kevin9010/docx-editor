<script setup lang="ts">
import { locale, t } from './i18n';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { WRITING_ACTIONS, agentRunBudget, buildWritingPrompt, type WritingAction } from './agent/actions';
import { connectCodex, inspectCodex, runCodexAgent, type CodexClient, type CodexStatus } from './agent/codex';
import { runDocumentAgent } from './agent/loop';
import { checkClaude, runClaudeAgent } from './agent/claude';
import { listModels, type ModelInfo } from './agent/endpoint';
import { applyProposal } from './agent/review';
import { withAbort } from './agent/cancellation';
import type { AgentDiagnostic, AgentDocument, AgentProposal, AgentReviewSession, AgentSelection, ApiFormat, AuthScheme } from './agent/types';

const props = defineProps<{ document: AgentDocument | null; selection: AgentSelection | null; disabled: boolean }>();
// `applyFailed` carries whether the document changed despite the failure.
const emit = defineEmits<{ busy: [value: boolean]; applying: []; applied: []; applyFailed: [changed: boolean] }>();

type Provider = 'codex' | 'claude' | ApiFormat;
function isApiProvider(value: Provider): value is ApiFormat { return value === 'openai' || value === 'anthropic'; }
const stored = (key: string) => localStorage.getItem(`superdoc.desktop.${key}`);
// Earlier versions stored the OpenAI-compatible provider as `baseUrl` with unprefixed keys.
const storedProvider = stored('provider');
const provider = ref<Provider>(storedProvider === 'baseUrl' || storedProvider === 'openai' ? 'openai' : storedProvider === 'anthropic' ? 'anthropic' : storedProvider === 'claude' ? 'claude' : 'codex');
const executable = ref(stored('codexPath') ?? '');
const codexModel = ref((stored('codexModel') ?? '').trim());
const claudeModel = ref((stored('claudeModel') ?? '').trim());
const claudeAliases = ['opus', 'sonnet', 'haiku', 'fable', 'best', 'opusplan', 'sonnet[1m]', 'opus[1m]'];
const selectedModel = computed(() => (provider.value === 'codex' ? codexModel.value : provider.value === 'claude' ? claudeModel.value : model.value).trim());
const claudeConnection = ref<{ executable: string; signedIn: boolean } | null>(null);
const PROVIDER_LABELS: Record<Provider, string> = { codex: 'Local Codex CLI', claude: 'Local Claude Code CLI', openai: 'OpenAI-compatible API', anthropic: 'Anthropic (Claude) API' };

// Each API format keeps its own endpoint, model, session key and model list, so
// switching providers never sends one provider's key to another's endpoint.
// Keys stay in memory only.
interface ApiSettings { baseUrl: string; model: string; apiKey: string; models: ModelInfo[] }
const apiSettings: Record<ApiFormat, ApiSettings> = {
  openai: { baseUrl: stored('openai.baseUrl') ?? stored('baseUrl') ?? 'https://api.openai.com/v1', model: stored('openai.model') ?? stored('model') ?? 'gpt-4o-mini', apiKey: '', models: [] },
  anthropic: { baseUrl: stored('anthropic.baseUrl') ?? 'https://api.anthropic.com', model: stored('anthropic.model') ?? 'claude-opus-5-5', apiKey: '', models: [] },
};
const authScheme = ref<AuthScheme>(stored('anthropic.authScheme') === 'bearer' ? 'bearer' : 'apiKey');
const baseUrl = ref('');
const model = ref('');
const apiKey = ref('');
const availableModels = ref<ModelInfo[]>([]);
function loadApiSettings(format: ApiFormat): void {
  const settings = apiSettings[format];
  baseUrl.value = settings.baseUrl;
  model.value = settings.model;
  apiKey.value = settings.apiKey;
  availableModels.value = settings.models;
}
function saveApiSettings(format: ApiFormat): void {
  Object.assign(apiSettings[format], { baseUrl: baseUrl.value.trim(), model: model.value.trim(), apiKey: apiKey.value, models: availableModels.value });
}
loadApiSettings(isApiProvider(provider.value) ? provider.value : 'openai');
const action = ref<WritingAction>('polish');
const instruction = ref('');
const language = ref('');
const scope = ref<'selection' | 'document'>('document');
const busy = ref(false);
const running = ref(false);
const status = ref('');
const startedAt = ref(0);
const now = ref(Date.now());
const lastActivityAt = ref(0);
const activityLog = ref<Array<{ at: number; message: string }>>([]);
const checking = ref(false);
const settingsOpen = ref(false);
const progressActive = computed(() => running.value || checking.value);
const elapsed = computed(() => Math.max(0, Math.floor((now.value - startedAt.value) / 1000)));
const quietSeconds = computed(() => Math.max(0, Math.floor((now.value - lastActivityAt.value) / 1000)));
let progressTimer: ReturnType<typeof setInterval> | null = null;
function markActivity(): void { lastActivityAt.value = Date.now(); }
function setStatus(message: string): void {
  markActivity();
  status.value = message;
  if (activityLog.value.at(-1)?.message !== message) {
    activityLog.value.push({ at: Date.now(), message });
    if (activityLog.value.length > 60) activityLog.value.shift();
  }
}
function beginProgress(): void {
  now.value = startedAt.value = lastActivityAt.value = Date.now();
  activityLog.value = [];
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => { now.value = Date.now(); }, 1000);
}
function endProgress(): void {
  now.value = Date.now();
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}
function stop(): void { setStatus('Stopping the current operation…'); abort?.abort(); }

// Streamed replies can deliver dozens of deltas per second; render at most once per frame.
let pendingOutput: string | null = null;
let outputFrame = 0;
function flushOutput(): void {
  if (outputFrame) cancelAnimationFrame(outputFrame);
  outputFrame = 0;
  if (pendingOutput !== null) output.value = pendingOutput;
  pendingOutput = null;
}
function showOutput(value: string): void {
  markActivity();
  pendingOutput = value;
  if (!outputFrame) outputFrame = requestAnimationFrame(flushOutput);
}

const error = ref('');
const diagnostic = ref<AgentDiagnostic | null>(null);
const output = ref('');
const connection = ref<CodexStatus | null>(null);
const review = ref<AgentReviewSession | null>(null);
const proposalDrafts = ref<Record<string, string>>({});
const actionLabel = computed(() => WRITING_ACTIONS.find(item => item.id === action.value)?.label ?? 'Custom');
function proposalText(proposal: AgentProposal): string {
  return proposalDrafts.value[proposal.id] ?? (proposal.action === 'replace_text' ? proposal.replacement : proposal.comment) ?? '';
}
function proposalEdited(proposal: AgentProposal): boolean {
  return proposalText(proposal) !== (proposal.action === 'replace_text' ? proposal.replacement : proposal.comment);
}
function proposalValidation(proposal: AgentProposal): string {
  const text = proposalText(proposal);
  if (text.length > 16_000) return 'Keep the suggestion within 16,000 characters.';
  if (proposal.action === 'add_comment' && !text.trim()) return 'Enter a comment before applying it.';
  if (proposal.action === 'replace_text' && text === proposal.find) return 'The suggested text is identical to the original.';
  return '';
}
let abort: AbortController | null = null;
let disposed = false;

// A connected Codex process is kept warm between runs so each run skips process
// start-up and the initialize handshake. It is closed after a quiet period, when
// the provider or executable changes, and when the panel unmounts.
const CODEX_IDLE_CLOSE_MS = 10 * 60_000;
let codex: CodexClient | null = null;
let codexExecutable = '';
let codexIdleTimer: ReturnType<typeof setTimeout> | null = null;
function clearCodexIdleTimer(): void {
  if (codexIdleTimer) clearTimeout(codexIdleTimer);
  codexIdleTimer = null;
}
async function closeCodex(): Promise<void> {
  clearCodexIdleTimer();
  const current = codex;
  codex = null;
  await current?.close().catch(() => {});
}
function scheduleCodexIdleClose(): void {
  clearCodexIdleTimer();
  if (codex && !codex.isClosed) codexIdleTimer = setTimeout(() => { void closeCodex(); }, CODEX_IDLE_CLOSE_MS);
}
const canRun = computed(() => Boolean(props.document && !props.disabled && !busy.value &&
  (action.value !== 'custom' || instruction.value.trim()) && (scope.value !== 'selection' || props.selection)));
watch(() => props.selection, (selection) => { if (selection) scope.value = 'selection'; });
watch(() => props.document, () => {
  review.value = null;
  proposalDrafts.value = {};
  output.value = '';
  error.value = '';
  diagnostic.value = null;
  status.value = '';
  scope.value = 'document';
});
watch(busy, (value) => emit('busy', value), { flush: 'sync' });
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistSettings(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  if (isApiProvider(provider.value)) saveApiSettings(provider.value);
  const values: Record<string, string> = {
    provider: provider.value, codexPath: executable.value.trim(), codexModel: codexModel.value.trim(), claudeModel: claudeModel.value.trim(),
    'openai.baseUrl': apiSettings.openai.baseUrl, 'openai.model': apiSettings.openai.model,
    'anthropic.baseUrl': apiSettings.anthropic.baseUrl, 'anthropic.model': apiSettings.anthropic.model,
    'anthropic.authScheme': authScheme.value,
  };
  for (const [key, value] of Object.entries(values)) localStorage.setItem(`superdoc.desktop.${key}`, value);
}
watch([provider, executable, codexModel, claudeModel, baseUrl, model, authScheme], () => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSettings, 300);
});
watch(executable, () => { connection.value = null; void closeCodex(); });
watch(provider, (next, previous) => {
  if (isApiProvider(previous)) saveApiSettings(previous);
  if (isApiProvider(next)) loadApiSettings(next);
  if (next !== 'codex') void closeCodex();
  status.value = '';
  output.value = '';
  claudeConnection.value = null;
  error.value = '';
  diagnostic.value = null;
});
// A different endpoint or auth scheme invalidates the listed models; switching
// providers only swaps in that provider's own list.
watch([provider, baseUrl, authScheme], ([nextProvider], [previousProvider]) => {
  if (nextProvider === previousProvider) availableModels.value = [];
});
// The window's close handler flushes settings, because unmount does not run on close.
defineExpose({ flushSettings: persistSettings });

function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }

async function openCodex(includeModels = false): Promise<CodexClient> {
  clearCodexIdleTimer();
  const path = executable.value.trim();
  const warm = codex && !codex.isClosed && codexExecutable === path ? codex : null;
  if (warm) setStatus('Reusing the running Codex connection…');
  try {
    let connected = warm;
    if (!connected) {
      await closeCodex();
      connected = await connectCodex(path, abort?.signal, setStatus);
      codex = connected;
      codexExecutable = path;
    }
    if (disposed || abort?.signal.aborted) throw new Error('Cancelled.');
    // A reused process still re-reads the login: it is one cheap request and
    // catches a logout or expired token since the last run.
    const inspected = await withAbort(inspectCodex(connected, includeModels, setStatus), abort?.signal);
    connection.value = { ...inspected, models: includeModels ? inspected.models : connection.value?.models ?? [] };
    if (!connection.value.signedIn) throw new Error('Codex is not signed in. Run codex login in your terminal, then check the connection again.');
    return connected;
  } catch (reason) {
    await closeCodex();
    throw reason;
  }
}

async function checkConnection(): Promise<void> {
  busy.value = true;
  error.value = '';
  diagnostic.value = null;
  checking.value = true;
  beginProgress();
  setStatus(provider.value === 'claude' ? 'Checking installed Claude Code…' : 'Checking installed Codex…');
  abort = new AbortController();
  try {
    if (provider.value === 'claude') {
      claudeConnection.value = await checkClaude(abort.signal);
      if (!claudeConnection.value.signedIn) throw new Error('Claude Code is not signed in. Run claude auth login in your terminal, then check the connection again.');
      setStatus('Claude Code installation and login checked. Model availability is checked when you generate suggestions.');
    } else {
      await openCodex(true);
      setStatus('Codex login and model list checked. Provider availability is checked when you generate suggestions.');
    }
  } catch (reason) { if (!abort?.signal.aborted) error.value = errorText(reason); setStatus(abort?.signal.aborted ? 'Connection check stopped.' : 'Connection check failed.'); }
  finally { scheduleCodexIdleClose(); abort = null; busy.value = false; checking.value = false; endProgress(); }
}

async function loadModels(): Promise<void> {
  if (!isApiProvider(provider.value) || busy.value) return;
  const format = provider.value;
  if (!apiKey.value.trim()) { error.value = 'Enter a session API key in Connection settings, then retry.'; return; }
  busy.value = true;
  checking.value = true;
  error.value = '';
  diagnostic.value = null;
  beginProgress();
  setStatus('Loading models from the endpoint…');
  try {
    const models = await listModels({ format, baseUrl: baseUrl.value, apiKey: apiKey.value, authScheme: authScheme.value });
    availableModels.value = models;
    setStatus(models.length ? `Connected. ${models.length} model(s) available.` : 'Connected, but the endpoint listed no models. Enter the model ID manually.');
  } catch (reason) {
    error.value = errorText(reason);
    setStatus('Could not load the model list. You can still enter the model ID manually.');
  } finally { busy.value = false; checking.value = false; endProgress(); }
}

async function run(): Promise<void> {
  const document = props.document;
  if (!document || !canRun.value) return;
  busy.value = true;
  running.value = true;
  error.value = '';
  diagnostic.value = null;
  output.value = '';
  beginProgress();
  setStatus('Preparing document context…');
  abort = new AbortController();
  try {
    if (isApiProvider(provider.value) && !apiKey.value.trim()) { settingsOpen.value = true; throw new Error('Enter a session API key in Connection settings, then retry.'); }
    if (isApiProvider(provider.value) && !model.value.trim()) { settingsOpen.value = true; throw new Error('A model name is required to run the Agent.'); }
    const info = await withAbort(Promise.resolve(document.info({})), abort.signal);
    if (action.value === 'translate' && !language.value.trim()) throw new Error('Enter the language to translate into.');
    const selection = scope.value === 'selection' ? props.selection : undefined;
    if (scope.value === 'selection' && (!selection || selection.revision !== info.revision)) {
      throw new Error('The selection changed or expired. Select the passage again before running the Agent.');
    }
    if (selection && selection.text.length > 12_000) throw new Error('Select a shorter passage (up to 12,000 characters), or choose Whole document.');
    persistSettings();
    const characters = selection ? selection.text.length : (await withAbort(Promise.resolve(document.getText({})), abort.signal)).length;
    review.value = { revision: info.revision, ...(selection ? { selection } : {}), proposals: [] };
    proposalDrafts.value = {};
    const options = {
      ...agentRunBudget(characters),
      document, review: review.value,
      prompt: buildWritingPrompt(action.value, instruction.value, language.value, Boolean(selection)) + (locale.value === 'zh-CN' ? '\nExplain progress and suggestions to the user in Simplified Chinese. Keep the replacement text in the original or explicitly requested output language.' : ''),
      baseUrl: baseUrl.value, apiKey: apiKey.value,
      apiFormat: isApiProvider(provider.value) ? provider.value : undefined,
      authScheme: authScheme.value,
      model: selectedModel.value,
      signal: abort.signal,
      onStatus: setStatus,
      onActivity: markActivity,
      onDiagnostic: (value: AgentDiagnostic | null) => { diagnostic.value = value; },
      onText: showOutput,
    };
    const result = provider.value === 'codex'
      ? await runCodexAgent(await openCodex(), options)
      : provider.value === 'claude' ? await runClaudeAgent(options) : await runDocumentAgent(options);
    flushOutput();
    if (result.status === 'completed' || !output.value) output.value = result.summary;
    setStatus(result.status === 'completed' ? 'Ready for your review.' : result.status === 'aborted' ? 'Stopped. Any suggestions below can still be reviewed.' : diagnostic.value ? 'The run stopped because the model service returned errors. Review the details below.' : 'The run did not complete.');
    if (result.status === 'failed' || result.status === 'max_turns') error.value = result.summary;
  } catch (reason) { if (!abort?.signal.aborted) error.value = errorText(reason); setStatus(abort?.signal.aborted ? 'Stopped.' : 'Could not start the Agent.'); }
  finally { flushOutput(); scheduleCodexIdleClose(); abort = null; busy.value = false; running.value = false; endProgress(); }
}

async function apply(proposal: AgentProposal): Promise<void> {
  if (!props.document || !review.value || busy.value || props.disabled) return;
  if (proposalValidation(proposal)) return;
  const approvedText = proposalText(proposal);
  busy.value = true;
  error.value = '';
  diagnostic.value = null;
  const revisionBefore = review.value.revision;
  emit('applying');
  try {
    await applyProposal(props.document, review.value, proposal, approvedText);
    delete proposalDrafts.value[proposal.id];
    emit('applied');
    status.value = 'Applied for review. Accept or reject in SuperDoc, then save when ready.';
  } catch (reason) {
    error.value = errorText(reason);
    const after = await Promise.resolve(props.document.info({})).catch(() => null);
    emit('applyFailed', !after || after.revision !== revisionBefore);
  }
  finally { busy.value = false; }
}

onBeforeUnmount(() => {
  endProgress();
  disposed = true;
  abort?.abort();
  if (outputFrame) cancelAnimationFrame(outputFrame);
  if (persistTimer) persistSettings();
  void closeCodex();
});
</script>

<template>
  <div class="agent-panel">
    <header class="agent-heading">
      <div class="agent-title"><div><span class="eyebrow">{{ t('WRITING ASSISTANT') }}</span><h2>{{ t('Document Agent') }}</h2></div></div>
    </header>
    <section v-if="status || progressActive" class="agent-progress" :aria-label="t('Agent progress')">
      <div class="progress-current"><span v-if="progressActive" class="progress-spinner" /><strong class="agent-status-text" role="status">{{ t(status) }}</strong><button v-if="progressActive" @click="stop">{{ t(review?.proposals.length && running ? 'Stop and review' : 'Stop') }}</button></div>
      <p class="progress-time">{{ t(progressActive ? 'Elapsed' : 'Duration') }} {{ elapsed }}s<span v-if="progressActive"> · {{ t(`Last update ${quietSeconds}s ago`) }}</span><span v-if="review?.proposals.length"> · {{ t(`${review.proposals.length} suggestion(s)`) }}</span></p>
      <p v-if="progressActive && quietSeconds >= 20" class="progress-wait">{{ t(`No new update for ${quietSeconds}s. Waiting for ${t(provider === 'codex' ? 'Codex / its model provider' : provider === 'claude' ? 'Claude Code / its model provider' : 'the model endpoint')}; you can stop at any time.`) }}</p>
      <p v-if="running && output" class="progress-preview">{{ output.slice(-240) }}</p>
      <details class="activity-log"><summary>{{ t(`Activity · ${activityLog.length} updates`) }}</summary><ol><li v-for="(entry, index) in activityLog" :key="index"><time>+{{ Math.max(0, Math.floor((entry.at - startedAt) / 1000)) }}s</time><span>{{ t(entry.message) }}</span></li></ol></details>
    </section>
    <aside v-if="diagnostic" class="agent-error agent-diagnostic" role="alert">
      <strong>{{ t(diagnostic.title) }}</strong><p>{{ t(diagnostic.hint) }}</p>
      <details><summary>{{ t('Provider error details') }}</summary><pre>{{ diagnostic.detail }}</pre></details>
    </aside>
    <div v-if="error && !diagnostic" class="agent-error" role="alert">{{ t(error) }}</div>
    <div class="agent-content">
    <label class="field-label" for="agent-provider">{{ t('Connect with') }}</label>
    <select id="agent-provider" v-model="provider" :disabled="busy"><option v-for="(label, id) in PROVIDER_LABELS" :key="id" :value="id">{{ t(label) }}</option></select>
    <details class="connection-settings" :open="settingsOpen" @toggle="settingsOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('Connection settings') }}</summary>
      <div v-if="provider === 'codex'" class="agent-settings">
        <label class="field-label" for="codex-path">{{ t('Codex executable') }} <span>{{ t('(optional)') }}</span></label>
        <input id="codex-path" v-model="executable" :disabled="busy" :placeholder="t('Auto-detect installed Codex')" />
        <label class="field-label" for="codex-model">{{ t('Model') }}</label>
        <input id="codex-model" v-model="codexModel" :disabled="busy" autocomplete="off" spellcheck="false" list="codex-model-options" :placeholder="t('CLI default')" aria-describedby="codex-model-help" />
        <datalist id="codex-model-options"><option v-for="item in connection?.models" :key="item.model" :value="item.model">{{ item.displayName }}</option></datalist>
        <button :disabled="busy || !codexModel" @click="codexModel = ''">{{ t('Use CLI default') }}</button>
        <small id="codex-model-help" class="agent-description">{{ t('Type a model ID or choose a suggestion. Leave blank to use the CLI default. The list is not an allowlist.') }}</small>
        <button :disabled="busy" :title="t('Check connection and load models')" @click="checkConnection">{{ t('Check connection') }}</button>
        <small v-if="connection?.models.length" class="connection-path">{{ t(`${connection.models.length} model(s) available`) }}</small>
        <small v-if="connection" class="connection-path">{{ connection.executable }}</small>
        <p class="agent-description">{{ t('Uses the Codex already installed on this computer and its existing login.') }}</p>
      </div>
      <div v-else-if="provider === 'claude'" class="agent-settings">
        <label class="field-label" for="claude-model">{{ t('Model') }} <span>{{ t('(optional)') }}</span></label>
        <input id="claude-model" v-model="claudeModel" :disabled="busy" autocomplete="off" spellcheck="false" list="claude-model-options" :placeholder="t('CLI default')" aria-describedby="claude-model-help" />
        <datalist id="claude-model-options"><option v-for="alias in claudeAliases" :key="alias" :value="alias">{{ alias }}</option></datalist>
        <button :disabled="busy || !claudeModel" @click="claudeModel = ''">{{ t('Use CLI default') }}</button>
        <small id="claude-model-help" class="agent-description">{{ t('Type a model ID or choose a suggestion. Leave blank to use the CLI default. The list is not an allowlist.') }}</small>
        <p class="agent-description">{{ t('Claude suggestions are common aliases, not discovered account models. Custom provider IDs are supported; CLI and account policies still apply.') }}</p>
        <button :disabled="busy" @click="checkConnection">{{ t('Check connection') }}</button>
        <small v-if="claudeConnection" class="connection-path">{{ claudeConnection.executable }}</small>
        <p class="agent-description">{{ t('Uses the native Claude Code installed in your home .local/bin directory and its existing login or environment credentials. No API key is stored by this app.') }}</p>
        <p class="agent-description">{{ t('Claude Code runs with tools and customizations disabled. It returns suggestions only; select a passage for documents over 120,000 characters.') }}</p>
      </div>
      <div v-else class="agent-settings">
        <label class="field-label" for="base-url">{{ t('Base URL') }}</label><input id="base-url" v-model="baseUrl" :disabled="busy" autocomplete="off" spellcheck="false" />
        <label class="field-label" for="api-key">{{ t('API key') }} <span>{{ t('(session only)') }}</span></label><input id="api-key" v-model="apiKey" :disabled="busy" type="password" autocomplete="off" :placeholder="t('Not stored by the app')" />
        <template v-if="provider === 'anthropic'">
          <label class="field-label" for="auth-scheme">{{ t('Key header') }}</label>
          <select id="auth-scheme" v-model="authScheme" :disabled="busy"><option value="apiKey">x-api-key ({{ t('Claude API') }})</option><option value="bearer">Authorization: Bearer ({{ t('some gateways') }})</option></select>
        </template>
        <label class="field-label" for="model">{{ t('Model') }}</label>
        <input id="model" v-model="model" :disabled="busy" autocomplete="off" spellcheck="false" list="model-options" :placeholder="t('Model ID, e.g. a gateway model name')" />
        <datalist id="model-options"><option v-for="item in availableModels" :key="item.id" :value="item.id">{{ item.displayName }}</option></datalist>
        <button :disabled="busy || !apiKey.trim()" @click="loadModels">{{ t('Load models') }}</button>
        <small v-if="availableModels.length" class="connection-path">{{ t(`${availableModels.length} model(s) available`) }}</small>
        <p class="agent-description">{{ t(provider === 'anthropic' ? 'Uses the Anthropic Messages API. Works with the Claude API and gateways that accept the same format; enter the model ID your gateway expects.' : 'Uses the OpenAI chat completions format. Works with OpenAI and compatible gateways.') }}</p>
      </div>
    </details>
    <p class="quick-action-hint">{{ t('Choose an action, review the scope and instructions, then confirm below to start.') }}</p>
    <div class="writing-actions" :aria-label="t('Writing actions')"><button v-for="item in WRITING_ACTIONS" :key="item.id" :aria-pressed="action === item.id" :disabled="busy || disabled || !document" @click="action = item.id">{{ t(item.label) }}</button><button :aria-pressed="action === 'custom'" :disabled="busy" @click="action = 'custom'">{{ t('Custom') }}</button></div>
    <label class="field-label" for="agent-scope">{{ t('Work on') }}</label>
    <select id="agent-scope" v-model="scope" :disabled="busy"><option value="document">{{ t('Whole document') }}</option><option value="selection" :disabled="!selection">{{ t('Selected passage') }}</option></select>
    <blockquote v-if="scope === 'selection' && selection" class="selection-preview">{{ selection.text }}</blockquote>
    <p v-if="scope === 'selection' && !selection" class="agent-description">{{ t('Select a passage in the document to continue.') }}</p>
    <label class="field-label" for="agent-language">{{ t('Output language') }} <span>{{ t('(optional)') }}</span></label>
    <input id="agent-language" v-model="language" :disabled="busy" :placeholder="t(action === 'translate' ? 'E.g. English / 简体中文' : 'Keep original language')" />
    <label class="field-label" for="agent-prompt">{{ t('Instruction') }} <span v-if="action !== 'custom'">{{ t('(optional)') }}</span></label>
    <textarea id="agent-prompt" v-model="instruction" :disabled="busy" rows="3" :placeholder="t('E.g. Make the tone warmer while preserving the meaning.')" />
    <section class="run-confirmation" :aria-label="t('Review task')">
      <strong>{{ t('Review task') }}</strong>
      <p>{{ t(actionLabel) }} · {{ t(scope === 'selection' ? 'Selected passage' : 'Whole document') }} · {{ t(PROVIDER_LABELS[provider]) }}<template v-if="selectedModel"> · {{ selectedModel }}</template><template v-else-if="!isApiProvider(provider)"> · {{ t('CLI default') }}</template></p>
      <p>{{ t('Starting generates suggestions for your review. You can edit each suggestion before applying it.') }}</p>
      <button class="primary" :disabled="!canRun" @click="run">{{ t('Confirm and generate suggestions') }}</button>
    </section>
    <div v-if="output" class="agent-summary"><span class="eyebrow">{{ t('RESPONSE') }}</span><p>{{ output }}</p></div>
    <div v-if="review?.proposals.length" class="suggestions">
      <h3>{{ t(`Suggestions · ${review.proposals.length}`) }}</h3>
      <article v-for="(proposal, index) in review.proposals" :key="proposal.id" class="suggestion" :data-state="proposal.state">
        <span class="eyebrow">{{ t(proposal.action === 'replace_text' ? 'REVISION' : 'COMMENT') }} · {{ t(proposal.state) }}</span>
        <label>{{ t('Original') }}</label><p class="original-text">{{ proposal.find }}</p>
        <template v-if="proposal.state === 'pending'">
          <label :for="`suggestion-${proposal.id}`">{{ t(proposal.action === 'replace_text' ? 'Suggested (editable)' : 'Comment (editable)') }}</label>
          <textarea :id="`suggestion-${proposal.id}`" class="suggestion-editor" :aria-label="t(`${proposal.action === 'replace_text' ? 'Edit suggestion' : 'Edit comment'} ${index + 1}`)" :value="proposalText(proposal)" :disabled="busy || disabled" rows="5" maxlength="16000" @input="proposalDrafts[proposal.id] = ($event.target as HTMLTextAreaElement).value" />
          <p class="suggestion-help">{{ t('Review and edit this text, then apply when ready.') }}<span v-if="proposal.action === 'replace_text' && !proposalText(proposal)"> {{ t('(Delete this text)') }}</span></p>
          <div v-if="proposalEdited(proposal)" class="suggestion-draft"><span>{{ t('Edited by you') }}</span><button :disabled="busy || disabled" @click="delete proposalDrafts[proposal.id]">{{ t('Restore Agent suggestion') }}</button></div>
          <p v-if="proposalValidation(proposal)" class="error-text">{{ t(proposalValidation(proposal)) }}</p>
          <div class="suggestion-actions"><button class="primary" :disabled="busy || disabled || !!proposalValidation(proposal)" @click="apply(proposal)">{{ t(proposal.action === 'replace_text' ? 'Apply as revision' : 'Add comment') }}</button><button :disabled="busy" @click="proposal.state = 'dismissed'">{{ t('Dismiss') }}</button></div>
        </template>
        <template v-else>
          <label>{{ t(proposal.action === 'replace_text' ? 'Suggested' : 'Comment') }}</label><p class="replacement-text">{{ proposalText(proposal) || t('(Delete this text)') }}</p>
        </template>
        <p v-if="proposal.error" class="error-text">{{ t(proposal.error) }}</p>
      </article>
    </div>
    <p class="privacy-note">{{ t(`Only when you run the Agent, the chosen document context is sent through ${t(provider === 'codex' ? 'your Codex provider' : provider === 'claude' ? 'your Claude Code provider' : 'your configured endpoint')}. Suggestions are saved only when you apply them and save the document.`) }}</p>
    </div>
  </div>
</template>
