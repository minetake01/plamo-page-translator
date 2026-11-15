import { describe, expect, it } from 'vitest';
import { openaiBody, openaiMessages, parsePlamoResponse, pfml3Prompt, stripTerminator } from './prompt';

describe('pfml3Prompt', () => {
  it('builds a minimal prompt', () => {
    expect(pfml3Prompt({ text: 'Hello.', targetLang: 'ja' })).toBe(
      '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>input<|plamo:msg|>Hello.' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>',
    );
  });

  it('adds context, glossary and form', () => {
    const prompt = pfml3Prompt({
      text: 'Open the dashboard.',
      targetLang: 'ja',
      sourceLang: 'en',
      form: 'polite',
      context: 'Project management tool.',
      glossary: [{ source: 'dashboard', target: '管理画面' }],
    });
    expect(prompt).toContain('<|plamo:tag|>context<|plamo:msg|>Project management tool.');
    expect(prompt).toContain('<|plamo:tag|>glossary<|plamo:index|>dashboard<|plamo:item|>管理画面');
    expect(prompt).toContain('<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Open the dashboard.');
    expect(prompt).toContain('<|plamo:key|>form<|plamo:val|>polite');
  });

  it('neutralizes control tokens', () => {
    const prompt = pfml3Prompt({ text: 'x <|plamo:tag|> output', targetLang: 'ja' });
    expect(prompt).not.toContain('x <|plamo:tag|>');
    expect(prompt).toContain('＜|plamo:tag|>');
  });
});

describe('OpenAI-compatible mode', () => {
  it('does not send PLaMo-specific fields', () => {
    const body = openaiBody({ text: 'Hello.', targetLang: 'ja' }, 'gpt-test');
    expect(body).toMatchObject({ model: 'gpt-test', temperature: 0 });
    expect(body).not.toHaveProperty('prompt');
    expect(body).not.toHaveProperty('stop');
    expect(body).not.toHaveProperty('add_special_tokens');
  });

  it('uses a translation system message', () => {
    const messages = openaiMessages({ text: 'Hello.', targetLang: 'ja', context: 'Docs' });
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Translate the user text into ja');
    expect(messages[0]?.content).toContain('Preserve Markdown');
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello.' });
  });
});

describe('response parsing', () => {
  it('strips trailing stop tokens', () => {
    expect(stripTerminator('こんにちは。<|plamo:tag|>')).toBe('こんにちは。');
    expect(stripTerminator('こんにちは。<|plamo:bos|>')).toBe('こんにちは。');
  });

  it('reads completion text', () => {
    expect(parsePlamoResponse({ choices: [{ text: 'こんにちは。<|plamo:tag|>', finish_reason: 'stop' }] }))
      .toBe('こんにちは。');
  });

  it('rejects truncated output', () => {
    expect(() => parsePlamoResponse({ choices: [{ text: 'x', finish_reason: 'length' }] }))
      .toThrow('truncated');
  });
});
