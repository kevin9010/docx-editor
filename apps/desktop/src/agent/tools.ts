import type {
  AgentDocument,
  AgentToolContext,
  AgentToolDefinitions,
  AgentToolName,
  AgentToolResult,
} from './types';
import type { ChatCompletionMessageParam } from './wire-types';

const MAX_TEXT_CHARS = 12_000;
const MAX_MATCHES = 8;
const MAX_TOOL_RESULT_CHARS = 20_000;
const MAX_FIND_CHARS = 2_000;
const MAX_MUTATION_TEXT_CHARS = 8_000;

export const AGENT_SYSTEM_PROMPT = [
  'You are the SuperDoc desktop document assistant.',
  '',
  'You may inspect the open Word document and propose precise edits.',
  'Before editing, inspect or search the document.',
  'Every text mutation is applied as a tracked change so the user can review it in SuperDoc.',
  'Never claim an edit succeeded unless the tool receipt says status "applied" and the post-mutation revision changed.',
  'Search again after every mutation because search handles are revision-scoped.',
  'You cannot accept or reject tracked changes; leave that decision to the user.',
  'Keep tool calls focused and stop when the request is complete.',
].join('\n');

export const AGENT_TOOLS: AgentToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'superdoc_inspect',
      description:
        'Read a bounded document summary and optional full text excerpt. Use findText to locate exact text '
        + 'before requesting a mutation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          includeText: {
            type: 'boolean',
            description: 'Include up to 12000 characters of document text.',
          },
          findText: {
            type: 'string',
            description: 'Optional literal text to find in the document.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'superdoc_perform_action',
      description:
        'Apply one safe, reviewable tracked action to the open document. Search by literal text; '
        + 'never provide an opaque ref from an earlier turn.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['replace_text', 'add_comment'],
          },
          find: {
            type: 'string',
            description: 'The exact text to locate before the action.',
          },
          replacement: {
            type: 'string',
            description: 'Replacement text for replace_text.',
          },
          comment: {
            type: 'string',
            description: 'Comment text for add_comment.',
          },
        },
        required: ['action', 'find'],
      },
    },
  },
];

export function isAgentToolName(value: string): value is AgentToolName {
  return value === 'superdoc_inspect' || value === 'superdoc_perform_action';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringField(
  value: unknown,
  field: string,
  maxLength = MAX_MUTATION_TEXT_CHARS,
): string | null {
  const candidate = asRecord(value)[field];
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= maxLength
    ? candidate
    : null;
}

function statusFromReceipt(receipt: unknown): 'applied' | 'failed' {
  const record = asRecord(receipt);
  const receiptStatus = record.status;
  if (
    record.success !== true ||
    record.changed === false ||
    record.failure ||
    record.error ||
    receiptStatus === 'failed' ||
    receiptStatus === 'partial' ||
    receiptStatus === 'aborted'
  ) {
    return 'failed';
  }
  return 'applied';
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_TEXT_CHARS)}\n[document text truncated]`, truncated: true };
}

async function inspectDocument(context: AgentToolContext, input: unknown): Promise<AgentToolResult> {
  const options = asRecord(input);
  const info = await context.document.info({});
  const result: AgentToolResult = {
    status: 'applied',
    info,
  };

  if (options.includeText === true) {
    const text = await context.document.getText({});
    Object.assign(result, truncateText(text));
  }

  const findText = stringField(input, 'findText', MAX_FIND_CHARS);
  if (findText) {
    const matches = await context.document.query.match({
      select: { type: 'text', pattern: findText, mode: 'contains', caseSensitive: true },
      require: 'all',
      limit: MAX_MATCHES,
    });
    result.matches = matches.items.map((item) => {
      if (item.matchKind === 'text') {
        return {
          id: item.id,
          ref: item.handle.ref,
          matchKind: item.matchKind,
          snippet: item.snippet,
          target: item.target,
        };
      }
      return {
        id: item.id,
        ref: item.handle.ref,
        matchKind: item.matchKind,
      };
    });
    result.evaluatedRevision = matches.evaluatedRevision;
  }

  return result;
}

async function findFirstMatch(document: AgentDocument, find: string) {
  const matches = await document.query.match({
    select: { type: 'text', pattern: find, mode: 'contains', caseSensitive: true },
    require: 'first',
  });
  const item = matches.items[0];
  if (!item || item.matchKind !== 'text') return null;
  return { item, evaluatedRevision: matches.evaluatedRevision };
}

async function performAction(
  context: AgentToolContext,
  input: unknown,
): Promise<AgentToolResult> {
  const action = stringField(input, 'action', 64);
  const find = stringField(input, 'find', MAX_FIND_CHARS);
  if (!action || !find) return { status: 'invalid', message: 'action and find are required.' };
  if (action !== 'replace_text' && action !== 'add_comment') {
    return { status: 'invalid', message: `Unsupported action: ${action}.` };
  }

  const matchResult = await findFirstMatch(context.document, find);
  if (!matchResult) {
    return { status: 'no_match', message: `Could not find the exact text: ${find}` };
  }

  const { item: match, evaluatedRevision } = matchResult;
  const expectedRevision = typeof evaluatedRevision === 'string' ? evaluatedRevision : undefined;

  if (action === 'replace_text') {
    const replacement = stringField(input, 'replacement');
    if (replacement === null) {
      return {
        status: 'invalid',
        message: 'replacement is required and must be within the supported length.',
      };
    }

    const receipt = await context.document.replace(
      { target: match.target, text: replacement },
      { changeMode: 'tracked', ...(expectedRevision ? { expectedRevision } : {}) },
    );
    const afterInfo = asRecord(await context.document.info({}));
    const afterRevision = typeof afterInfo.revision === 'string' ? afterInfo.revision : undefined;
    const receiptStatus = statusFromReceipt(receipt);
    const revisionChanged = Boolean(expectedRevision && afterRevision && expectedRevision !== afterRevision);
    const status =
      receiptStatus === 'applied' && expectedRevision && !revisionChanged
        ? 'failed'
        : receiptStatus;
    return {
      status,
      receipt,
      preRevision: expectedRevision,
      postRevision: afterRevision,
      revisionChanged,
      message:
        status === 'applied'
          ? 'Tracked replacement applied; the user must review it.'
          : 'The document API did not provide a successful, revision-changing replacement receipt. '
            + 'Review it before retrying.',
    };
  }

  const comment = stringField(input, 'comment');
  if (comment === null) {
    return {
      status: 'invalid',
      message: 'comment is required and must be within the supported length.',
    };
  }

  const receipt = await context.document.comments.create({
    target: match.target,
    text: comment,
    author: 'SuperDoc Agent',
    authorEmail: 'agent@local',
  });
  const afterInfo = asRecord(await context.document.info({}));
  const afterRevision = typeof afterInfo.revision === 'string' ? afterInfo.revision : undefined;
  const receiptStatus = statusFromReceipt(receipt);
  const revisionChanged = Boolean(expectedRevision && afterRevision && expectedRevision !== afterRevision);
  const status =
    receiptStatus === 'applied' && expectedRevision && !revisionChanged
      ? 'failed'
      : receiptStatus;
  return {
    status,
    receipt,
    preRevision: expectedRevision,
    postRevision: afterRevision,
    revisionChanged,
    message:
      status === 'applied'
        ? 'Comment added to the matched text.'
        : 'The document API did not provide a successful, revision-changing comment receipt. '
          + 'Review it before retrying.',
  };
}

export async function dispatchAgentTool(
  context: AgentToolContext,
  name: string,
  input: unknown,
): Promise<AgentToolResult> {
  if (context.signal?.aborted) return { status: 'aborted', message: 'The Agent run was cancelled.' };
  if (!isAgentToolName(name)) return { status: 'invalid', message: `Tool is not advertised: ${name}` };
  if (name === 'superdoc_inspect') return inspectDocument(context, input);
  return performAction(context, input);
}

export function toolResultMessage(callId: string, result: AgentToolResult): ChatCompletionMessageParam {
  const serialized = JSON.stringify(result);
  const content = serialized.length <= MAX_TOOL_RESULT_CHARS
    ? serialized
    : JSON.stringify({
        status: 'failed',
        message: 'The tool result exceeded the model context safety limit; request a narrower inspection.',
      });
  return {
    role: 'tool',
    tool_call_id: callId,
    content,
  };
}
