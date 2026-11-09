import { describe, expect, it } from 'vitest';
import { normalizeChatCompletionUrl } from './endpoint';

describe('normalizeChatCompletionUrl', () => {
  it('adds the OpenAI-compatible path to an origin', () => {
    expect(normalizeChatCompletionUrl('https://api.example.test')).toBe(
      'https://api.example.test/v1/chat/completions',
    );
  });

  it('preserves a v1 base path', () => {
    expect(normalizeChatCompletionUrl('https://gateway.example.test/v1/')).toBe(
      'https://gateway.example.test/v1/chat/completions',
    );
  });

  it('does not duplicate a complete endpoint', () => {
    expect(normalizeChatCompletionUrl('https://gateway.example.test/v1/chat/completions')).toBe(
      'https://gateway.example.test/v1/chat/completions',
    );
  });

  it('rejects unsupported protocols', () => {
    expect(() => normalizeChatCompletionUrl('file:///tmp/model')).toThrow('HTTPS');
  });

  it('allows HTTP only for loopback gateways', () => {
    expect(normalizeChatCompletionUrl('http://localhost:3000/v1')).toBe(
      'http://localhost:3000/v1/chat/completions',
    );
    expect(() => normalizeChatCompletionUrl('http://gateway.example.test/v1')).toThrow('HTTPS');
  });

  it('rejects credentials and query strings', () => {
    expect(() => normalizeChatCompletionUrl('https://user@example.test/v1')).toThrow('credentials');
    expect(() => normalizeChatCompletionUrl('https://example.test/v1?key=secret')).toThrow('query');
  });
});
