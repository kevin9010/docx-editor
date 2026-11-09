import { describe, expect, it } from 'vitest';
import { codexDiagnostic } from './codex-errors';

describe('Codex provider diagnostics', () => {
  it('uses the underlying cause when the message only says reconnecting', () => {
    const result = codexDiagnostic({ message: 'Reconnecting... 1/100', additionalDetails: 'stream disconnected before completion: Concurrency limit exceeded for user, please retry later', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } });
    expect(result.title).toContain('concurrent request limit');
    expect(result.detail).toContain('Concurrency limit exceeded');
    expect(result.hint).toContain('local Codex process is connected');
  });

  it('distinguishes authentication, quota, and transport errors from structured HTTP errors', () => {
    expect(codexDiagnostic({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }).title).toContain('authentication');
    expect(codexDiagnostic({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }).title).toContain('limiting');
    const network = codexDiagnostic({ additionalDetails: 'Connection reset', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } });
    expect(network.title).toBe('The model request failed.');
    expect(network.detail).toContain('HTTP 503');
    expect(codexDiagnostic({ codexErrorInfo: 'usageLimitExceeded' }).title).toContain('limiting');
  });

  it('redacts credentials and URL query strings from displayed errors', () => {
    const result = codexDiagnostic({ message: 'Bearer secret-token sk-example-secret', additionalDetails: 'https://user:password@example.test/v1/responses?api_key=private#token' });
    expect(result.detail).toContain('https://example.test/v1/responses');
    for (const secret of ['secret-token', 'sk-example-secret', 'password', 'private', '#token']) expect(result.detail).not.toContain(secret);
  });
});
