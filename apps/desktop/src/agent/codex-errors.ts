import type { AgentDiagnostic } from './types';

export interface CodexTurnError {
  message?: string;
  additionalDetails?: string | null;
  codexErrorInfo?: string | Record<string, unknown> | null;
}

function redact(text: string): string {
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/g, value => {
      try { const url = new URL(value); return url.origin + url.pathname; }
      catch { return '[redacted URL]'; }
    }).slice(0, 4000);
}

export function codexDiagnostic(error: CodexTurnError): AgentDiagnostic {
  const code = error.codexErrorInfo;
  const kind = typeof code === 'string' ? code : code ? Object.keys(code)[0] : '';
  const data = typeof code === 'object' && code ? Object.values(code)[0] : null;
  const httpStatus = data && typeof data === 'object' && 'httpStatusCode' in data ? data.httpStatusCode : null;
  const detail = redact([error.message, error.additionalDetails, kind, httpStatus ? `HTTP ${httpStatus}` : ''].filter(Boolean).join('\n'));
  if (/concurrency limit|too many concurrent|maximum concurrent/i.test(detail)) {
    return { title: 'The model service has reached its concurrent request limit.', detail, hint: 'This limit comes from the model provider. Wait for other requests using this account to finish, then retry. The local Codex process is connected.' };
  }
  if (httpStatus === 401 || httpStatus === 403 || /unauthorized|authentication|invalid.{0,8}(api.?key|token)/i.test(detail)) {
    return { title: 'The model service rejected authentication or access.', detail, hint: 'Check the selected model and the login or credentials used by your Codex provider.' };
  }
  if (httpStatus === 429 || /rate.?limit|usageLimitExceeded|quota exceeded/i.test(detail)) {
    return { title: 'The model service is limiting requests or usage.', detail, hint: 'Check your provider quota or wait before retrying. Reconnecting the local CLI does not remove this limit.' };
  }
  return { title: 'The model request failed.', detail: detail || 'Codex provider error.', hint: 'The local CLI started successfully. Check the provider error below for connection, model, or request details.' };
}
