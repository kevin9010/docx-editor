<script setup lang="ts">
import { locale, t } from './i18n';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { WRITING_ACTIONS, buildWritingPrompt, type WritingAction } from './agent/actions';
import { connectCodex, inspectCodex, runCodexAgent, type CodexClient, type CodexStatus } from './agent/codex';
import { runDocumentAgent } from './agent/loop';
import { applyProposal } from './agent/review';
import { withAbort } from './agent/cancellation';
import type { AgentDocument, AgentProposal, AgentReviewSession, AgentSelection } from './agent/types';

const props = defineProps<{ document: AgentDocument | null; selection: AgentSelection | null; disabled: boolean }>();
const emit = defineEmits<{ busy: [value: boolean]; applying: []; applied: [] }>();
const provider = ref(localStorage.getItem('superdoc.desktop.provider') === 'baseUrl' ? 'baseUrl' : 'codex');
const executable = ref(localStorage.getItem('superdoc.desktop.codexPath') ?? '');
const codexModel = ref(localStorage.getItem('superdoc.desktop.codexModel') ?? '');
const baseUrl = ref(localStorage.getItem('superdoc.desktop.baseUrl') ?? 'https://api.openai.com/v1');
const model = ref(localStorage.getItem('superdoc.desktop.model') ?? 'gpt-4o-mini');
const apiKey = ref('');
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
async function runAction(value: WritingAction): Promise<void> {
  action.value = value;
  if (value !== 'custom') await run();
}

const error = ref('');
const output = ref('');
const connection = ref<CodexStatus | null>(null);
const review = ref<AgentReviewSession | null>(null);
let abort: AbortController | null = null;
let client: CodexClient | null = null;
let disposed = false;
const canRun = computed(() => Boolean(props.document && !props.disabled && !busy.value &&
  (action.value !== 'custom' || instruction.value.trim()) && (scope.value !== 'selection' || props.selection)));
watch(() => props.selection, (selection) => { if (selection) scope.value = 'selection'; });
watch(() => props.document, () => {
  review.value = null;
  output.value = '';
  error.value = '';
  status.value = '';
  scope.value = 'document';
});
watch(busy, (value) => emit('busy', value), { flush: 'sync' });
watch([provider, executable, codexModel, baseUrl, model], () => {
  for (const [key, value] of Object.entries({ provider: provider.value, codexPath: executable.value.trim(), codexModel: codexModel.value, baseUrl: baseUrl.value.trim(), model: model.value.trim() })) {
    localStorage.setItem(`superdoc.desktop.${key}`, value);
  }
});
watch(executable, () => { connection.value = null; });

function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }

async function openCodex(includeModels = false): Promise<CodexClient> {
  const connected = await connectCodex(executable.value.trim(), abort?.signal, setStatus);
  client = connected;
  if (disposed || abort?.signal.aborted) { await connected.close(); throw new Error('Cancelled.'); }
  const inspected = await withAbort(inspectCodex(connected, includeModels, setStatus), abort?.signal);
  connection.value = { ...inspected, models: includeModels ? inspected.models : connection.value?.models ?? [] };
  if (!connection.value.signedIn) throw new Error('Codex is not signed in. Run codex login in your terminal, then check the connection again.');
  return connected;
}

async function checkConnection(): Promise<void> {
  busy.value = true;
  error.value = '';
  checking.value = true;
  beginProgress();
  setStatus('Checking installed Codex…');
  abort = new AbortController();
  try {
    await openCodex(true);
    setStatus('Codex is ready. Your existing login and CLI settings will be used.');
  } catch (reason) { if (!abort?.signal.aborted) error.value = errorText(reason); setStatus(abort?.signal.aborted ? 'Connection check stopped.' : 'Connection check failed.'); }
  finally { await client?.close().catch(() => {}); client = null; abort = null; busy.value = false; checking.value = false; endProgress(); }
}

async function run(): Promise<void> {
  const document = props.document;
  if (!document || !canRun.value) return;
  busy.value = true;
  running.value = true;
  error.value = '';
  output.value = '';
  beginProgress();
  setStatus('Preparing document context…');
  abort = new AbortController();
  try {
    if (provider.value === 'baseUrl' && !apiKey.value.trim()) { settingsOpen.value = true; throw new Error('Enter a session API key in Connection settings, then retry.'); }
    const info = await withAbort(Promise.resolve(document.info({})), abort.signal);
    if (action.value === 'translate' && !language.value.trim()) throw new Error('Enter the language to translate into.');
    const selection = scope.value === 'selection' ? props.selection : undefined;
    if (scope.value === 'selection' && (!selection || selection.revision !== info.revision)) {
      throw new Error('The selection changed or expired. Select the passage again before running the Agent.');
    }
    if (selection && selection.text.length > 12_000) throw new Error('Select a shorter passage (up to 12,000 characters), or choose Whole document.');
    review.value = { revision: info.revision, ...(selection ? { selection } : {}), proposals: [] };
    const options = {
      document, review: review.value,
      prompt: buildWritingPrompt(action.value, instruction.value, language.value, Boolean(selection)) + (locale.value === 'zh-CN' ? '\nExplain progress and suggestions to the user in Simplified Chinese. Keep the replacement text in the original or explicitly requested output language.' : ''),
      baseUrl: baseUrl.value, apiKey: apiKey.value,
      model: provider.value === 'codex' ? codexModel.value : model.value,
      signal: abort.signal,
      onStatus: setStatus,
      onActivity: markActivity,
      onText: (value: string) => { markActivity(); output.value = value; },
    };
    const result = provider.value === 'codex'
      ? await runCodexAgent(await openCodex(), options)
      : await runDocumentAgent(options);
    if (result.status === 'completed' || !output.value) output.value = result.summary;
    setStatus(result.status === 'completed' ? 'Ready for your review.' : result.status === 'aborted' ? 'Stopped. Any suggestions below can still be reviewed.' : 'The run did not complete.');
    if (result.status === 'failed' || result.status === 'max_turns') error.value = result.summary;
  } catch (reason) { if (!abort?.signal.aborted) error.value = errorText(reason); setStatus(abort?.signal.aborted ? 'Stopped.' : 'Could not start the Agent.'); }
  finally { await client?.close().catch(() => {}); client = null; abort = null; busy.value = false; running.value = false; endProgress(); }
}

async function apply(proposal: AgentProposal): Promise<void> {
  if (!props.document || !review.value || busy.value || props.disabled) return;
  busy.value = true;
  error.value = '';
  emit('applying');
  try {
    await applyProposal(props.document, review.value, proposal);
    emit('applied');
    status.value = 'Applied for review. Accept or reject in SuperDoc, then save when ready.';
  } catch (reason) { error.value = errorText(reason); }
  finally { busy.value = false; }
}

onBeforeUnmount(() => { endProgress(); disposed = true; abort?.abort(); void client?.close().catch(() => {}); });
</script>

<template>
  <div class="agent-panel">
    <header class="agent-heading">
      <div class="agent-title"><div><span class="eyebrow">{{ t('WRITING ASSISTANT') }}</span><h2>{{ t('Document Agent') }}</h2></div></div>
    </header>
    <section v-if="status || progressActive" class="agent-progress" :aria-label="t('Agent progress')">
      <div class="progress-current"><span v-if="progressActive" class="progress-spinner" /><strong class="agent-status-text" role="status">{{ t(status) }}</strong><button v-if="progressActive" @click="stop">{{ t(review?.proposals.length && running ? 'Stop and review' : 'Stop') }}</button></div>
      <p class="progress-time">{{ t(progressActive ? 'Elapsed' : 'Duration') }} {{ elapsed }}s<span v-if="progressActive"> · {{ t(`Last update ${quietSeconds}s ago`) }}</span><span v-if="review?.proposals.length"> · {{ t(`${review.proposals.length} suggestion(s)`) }}</span></p>
      <p v-if="progressActive && quietSeconds >= 20" class="progress-wait">{{ t(`No new update for ${quietSeconds}s. Waiting for ${t(provider === 'codex' ? 'Codex / its model provider' : 'the model endpoint')}; you can stop at any time.`) }}</p>
      <p v-if="running && output" class="progress-preview">{{ output.slice(-240) }}</p>
      <details class="activity-log"><summary>{{ t(`Activity · ${activityLog.length} updates`) }}</summary><ol><li v-for="(entry, index) in activityLog" :key="index"><time>+{{ Math.max(0, Math.floor((entry.at - startedAt) / 1000)) }}s</time><span>{{ t(entry.message) }}</span></li></ol></details>
    </section>
    <div v-if="error" class="agent-error" role="alert">{{ t(error) }}</div>
    <div class="agent-content">
    <label class="field-label" for="agent-provider">{{ t('Connect with') }}</label>
    <select id="agent-provider" v-model="provider" :disabled="busy"><option value="codex">{{ t('Local Codex CLI') }}</option><option value="baseUrl">{{ t('Base URL') }}</option></select>
    <details class="connection-settings" :open="settingsOpen" @toggle="settingsOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('Connection settings') }}</summary>
      <div v-if="provider === 'codex'" class="agent-settings">
        <label class="field-label" for="codex-path">{{ t('Codex executable') }} <span>{{ t('(optional)') }}</span></label>
        <input id="codex-path" v-model="executable" :disabled="busy" :placeholder="t('Auto-detect installed Codex')" />
        <label class="field-label" for="codex-model">{{ t('Model') }}</label>
        <select id="codex-model" v-model="codexModel" :disabled="busy"><option value="">{{ t('CLI default') }}</option><option v-if="codexModel && !connection?.models.some(item => item.model === codexModel)" :value="codexModel">{{ codexModel }}</option><option v-for="item in connection?.models" :key="item.model" :value="item.model">{{ item.displayName }}</option></select>
        <button :disabled="busy" @click="checkConnection">{{ t('Check connection') }}</button>
        <small v-if="connection" class="connection-path">{{ connection.executable }}</small>
        <p class="agent-description">{{ t('Uses the Codex already installed on this computer and its existing login.') }}</p>
      </div>
      <div v-else class="agent-settings">
        <label class="field-label" for="base-url">{{ t('Base URL') }}</label><input id="base-url" v-model="baseUrl" :disabled="busy" autocomplete="off" />
        <label class="field-label" for="model">{{ t('Model') }}</label><input id="model" v-model="model" :disabled="busy" autocomplete="off" />
        <label class="field-label" for="api-key">{{ t('API key') }} <span>{{ t('(session only)') }}</span></label><input id="api-key" v-model="apiKey" :disabled="busy" type="password" autocomplete="off" :placeholder="t('Not stored by the app')" />
      </div>
    </details>
    <p class="quick-action-hint">{{ t('Click an action to run on the chosen text.') }}</p>
    <div class="writing-actions" :aria-label="t('Writing actions')"><button v-for="item in WRITING_ACTIONS" :key="item.id" :aria-pressed="action === item.id" :disabled="busy || disabled || !document" @click="runAction(item.id)">{{ t(item.label) }}</button><button :aria-pressed="action === 'custom'" :disabled="busy" @click="action = 'custom'">{{ t('Custom') }}</button></div>
    <label class="field-label" for="agent-scope">{{ t('Work on') }}</label>
    <select id="agent-scope" v-model="scope" :disabled="busy"><option value="document">{{ t('Whole document') }}</option><option value="selection" :disabled="!selection">{{ t('Selected passage') }}</option></select>
    <blockquote v-if="scope === 'selection' && selection" class="selection-preview">{{ selection.text }}</blockquote>
    <p v-if="scope === 'selection' && !selection" class="agent-description">{{ t('Select a passage in the document to continue.') }}</p>
    <label class="field-label" for="agent-language">{{ t('Output language') }} <span>{{ t('(optional)') }}</span></label>
    <input id="agent-language" v-model="language" :disabled="busy" :placeholder="t(action === 'translate' ? 'E.g. English / 简体中文' : 'Keep original language')" />
    <label class="field-label" for="agent-prompt">{{ t('Instruction') }} <span v-if="action !== 'custom'">{{ t('(optional)') }}</span></label>
    <textarea id="agent-prompt" v-model="instruction" :disabled="busy" rows="3" :placeholder="t('E.g. Make the tone warmer while preserving the meaning.')" />
    <div class="agent-controls"><button class="primary" :disabled="!canRun" @click="run">{{ t('Generate suggestions') }}</button></div>
    <div v-if="output" class="agent-summary"><span class="eyebrow">{{ t('RESPONSE') }}</span><p>{{ output }}</p></div>
    <div v-if="review?.proposals.length" class="suggestions">
      <h3>{{ t(`Suggestions · ${review.proposals.length}`) }}</h3>
      <article v-for="proposal in review.proposals" :key="proposal.id" class="suggestion" :data-state="proposal.state">
        <span class="eyebrow">{{ t(proposal.action === 'replace_text' ? 'REVISION' : 'COMMENT') }} · {{ t(proposal.state) }}</span>
        <label>{{ t('Original') }}</label><p class="original-text">{{ proposal.find }}</p>
        <label>{{ t(proposal.action === 'replace_text' ? 'Suggested' : 'Comment') }}</label><p class="replacement-text">{{ proposal.replacement || proposal.comment || t('(Delete this text)') }}</p>
        <div v-if="proposal.state === 'pending'" class="suggestion-actions"><button class="primary" :disabled="busy || disabled" @click="apply(proposal)">{{ t(proposal.action === 'replace_text' ? 'Apply as revision' : 'Add comment') }}</button><button :disabled="busy" @click="proposal.state = 'dismissed'">{{ t('Dismiss') }}</button></div>
        <p v-if="proposal.error" class="error-text">{{ t(proposal.error) }}</p>
      </article>
    </div>
    <p class="privacy-note">{{ t(`Only when you run the Agent, the chosen document context is sent through ${t(provider === 'codex' ? 'your Codex provider' : 'your configured endpoint')}. Suggestions are saved only when you apply them and save the document.`) }}</p>
    </div>
  </div>
</template>
