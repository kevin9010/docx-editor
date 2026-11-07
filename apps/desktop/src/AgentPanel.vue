<script setup lang="ts">
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

async function openCodex(): Promise<CodexClient> {
  const connected = await connectCodex(executable.value.trim(), abort?.signal);
  client = connected;
  if (disposed || abort?.signal.aborted) { await connected.close(); throw new Error('Cancelled.'); }
  connection.value = await withAbort(inspectCodex(connected), abort?.signal);
  if (!connection.value.signedIn) throw new Error('Codex is not signed in. Run codex login in your terminal, then check the connection again.');
  return connected;
}

async function checkConnection(): Promise<void> {
  busy.value = true;
  error.value = '';
  status.value = 'Checking installed Codex…';
  abort = new AbortController();
  try {
    await openCodex();
    status.value = 'Codex is ready. Your existing login and CLI settings will be used.';
  } catch (reason) { error.value = errorText(reason); status.value = ''; }
  finally { await client?.close().catch(() => {}); client = null; abort = null; busy.value = false; }
}

async function run(): Promise<void> {
  const document = props.document;
  if (!document || !canRun.value) return;
  busy.value = true;
  running.value = true;
  error.value = '';
  output.value = '';
  status.value = 'Preparing document context…';
  abort = new AbortController();
  try {
    const info = await document.info({});
    if (action.value === 'translate' && !language.value.trim()) throw new Error('Enter the language to translate into.');
    const selection = scope.value === 'selection' ? props.selection : undefined;
    if (scope.value === 'selection' && (!selection || selection.revision !== info.revision)) {
      throw new Error('The selection changed or expired. Select the passage again before running the Agent.');
    }
    if (selection && selection.text.length > 12_000) throw new Error('Select a shorter passage (up to 12,000 characters), or choose Whole document.');
    review.value = { revision: info.revision, ...(selection ? { selection } : {}), proposals: [] };
    const options = {
      document, review: review.value,
      prompt: buildWritingPrompt(action.value, instruction.value, language.value, Boolean(selection)),
      baseUrl: baseUrl.value, apiKey: apiKey.value,
      model: provider.value === 'codex' ? codexModel.value : model.value,
      signal: abort.signal,
      onStatus: (value: string) => { status.value = value; },
      onText: (value: string) => { output.value = value; },
    };
    const result = provider.value === 'codex'
      ? await runCodexAgent(await openCodex(), options)
      : await runDocumentAgent(options);
    output.value = result.summary;
    status.value = result.status === 'completed' ? 'Ready for your review.' : result.status === 'aborted' ? 'Stopped.' : 'The run did not complete.';
    if (result.status === 'failed' || result.status === 'max_turns') error.value = result.summary;
  } catch (reason) { error.value = errorText(reason); status.value = abort?.signal.aborted ? 'Stopped.' : ''; }
  finally { await client?.close().catch(() => {}); client = null; abort = null; busy.value = false; running.value = false; }
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

onBeforeUnmount(() => { disposed = true; abort?.abort(); void client?.close().catch(() => {}); });
</script>

<template>
  <div class="agent-content">
    <div class="agent-title"><div><span class="eyebrow">WRITING ASSISTANT</span><h2>Document Agent</h2></div></div>
    <p class="agent-description">Improve your writing, review each suggestion, and keep the final say.</p>
    <label class="field-label" for="agent-provider">Connect with</label>
    <select id="agent-provider" v-model="provider" :disabled="busy"><option value="codex">Local Codex CLI</option><option value="baseUrl">Base URL</option></select>
    <details class="connection-settings">
      <summary>Connection settings</summary>
      <div v-if="provider === 'codex'" class="agent-settings">
        <label class="field-label" for="codex-path">Codex executable <span>(optional)</span></label>
        <input id="codex-path" v-model="executable" :disabled="busy" placeholder="Auto-detect installed Codex" />
        <label class="field-label" for="codex-model">Model</label>
        <select id="codex-model" v-model="codexModel" :disabled="busy"><option value="">CLI default</option><option v-if="codexModel && !connection?.models.some(item => item.model === codexModel)" :value="codexModel">{{ codexModel }}</option><option v-for="item in connection?.models" :key="item.model" :value="item.model">{{ item.displayName }}</option></select>
        <button :disabled="busy" @click="checkConnection">Check connection</button>
        <small v-if="connection" class="connection-path">{{ connection.executable }}</small>
        <p class="agent-description">Uses the Codex already installed on this computer and its existing login.</p>
      </div>
      <div v-else class="agent-settings">
        <label class="field-label" for="base-url">Base URL</label><input id="base-url" v-model="baseUrl" :disabled="busy" autocomplete="off" />
        <label class="field-label" for="model">Model</label><input id="model" v-model="model" :disabled="busy" autocomplete="off" />
        <label class="field-label" for="api-key">API key <span>(session only)</span></label><input id="api-key" v-model="apiKey" :disabled="busy" type="password" autocomplete="off" placeholder="Not stored by the app" />
      </div>
    </details>
    <div class="writing-actions" aria-label="Writing actions"><button v-for="item in WRITING_ACTIONS" :key="item.id" :aria-pressed="action === item.id" :disabled="busy" @click="action = item.id">{{ item.label }}</button><button :aria-pressed="action === 'custom'" :disabled="busy" @click="action = 'custom'">Custom</button></div>
    <label class="field-label" for="agent-scope">Work on</label>
    <select id="agent-scope" v-model="scope" :disabled="busy"><option value="document">Whole document</option><option value="selection" :disabled="!selection">Selected passage</option></select>
    <blockquote v-if="scope === 'selection' && selection" class="selection-preview">{{ selection.text }}</blockquote>
    <p v-if="scope === 'selection' && !selection" class="agent-description">Select a passage in the document to continue.</p>
    <label class="field-label" for="agent-language">Output language <span>(optional)</span></label>
    <input id="agent-language" v-model="language" :disabled="busy" :placeholder="action === 'translate' ? 'E.g. English / 简体中文' : 'Keep original language'" />
    <label class="field-label" for="agent-prompt">Instruction <span v-if="action !== 'custom'">(optional)</span></label>
    <textarea id="agent-prompt" v-model="instruction" :disabled="busy" rows="3" placeholder="E.g. Make the tone warmer while preserving the meaning." />
    <div class="agent-controls"><button v-if="!running" class="primary" :disabled="!canRun" @click="run">Generate suggestions</button><button v-else @click="abort?.abort()">Stop</button></div>
    <div v-if="status" class="agent-status" role="status">{{ status }}</div>
    <div v-if="error" class="agent-error" role="alert">{{ error }}</div>
    <div v-if="output" class="agent-summary"><span class="eyebrow">RESPONSE</span><p>{{ output }}</p></div>
    <div v-if="review?.proposals.length" class="suggestions">
      <h3>Suggestions · {{ review.proposals.length }}</h3>
      <article v-for="proposal in review.proposals" :key="proposal.id" class="suggestion" :data-state="proposal.state">
        <span class="eyebrow">{{ proposal.action === 'replace_text' ? 'REVISION' : 'COMMENT' }} · {{ proposal.state }}</span>
        <label>Original</label><p class="original-text">{{ proposal.find }}</p>
        <label>{{ proposal.action === 'replace_text' ? 'Suggested' : 'Comment' }}</label><p class="replacement-text">{{ proposal.replacement || proposal.comment || '(Delete this text)' }}</p>
        <div v-if="proposal.state === 'pending'" class="suggestion-actions"><button class="primary" :disabled="busy || disabled" @click="apply(proposal)">{{ proposal.action === 'replace_text' ? 'Apply as revision' : 'Add comment' }}</button><button :disabled="busy" @click="proposal.state = 'dismissed'">Dismiss</button></div>
        <p v-if="proposal.error" class="error-text">{{ proposal.error }}</p>
      </article>
    </div>
    <p class="privacy-note">Only when you run the Agent, the chosen document context is sent through {{ provider === 'codex' ? 'your Codex provider' : 'your configured endpoint' }}. Suggestions are saved only when you apply them and save the document.</p>
  </div>
</template>
