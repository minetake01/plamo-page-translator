export const PROMPT_REVISION = 'pfml3-v1';

export const STOP = ['<|plamo:tag|>', '<|plamo:bos|>'];

export function sanitizeText(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/<\|plamo:/g, '＜|plamo:')
    .replace(/\r\n?/g, '\n');
}

export interface PromptInput {
  text: string;
  targetLang: string;
  sourceLang?: string;
  form?: 'polite' | 'plain';
  context?: string;
  glossary?: Array<{ source: string; target: string }>;
}

export function pfml3Prompt(input: PromptInput): string {
  let prompt = '<|plamo:tag|>dataset<|plamo:msg|>translation';
  const context = input.context ? sanitizeText(input.context).trim() : '';
  if (context) prompt += `<|plamo:tag|>context<|plamo:msg|>${context}`;
  if (input.glossary?.length) {
    prompt += '<|plamo:tag|>glossary';
    for (const term of input.glossary.slice(0, 20)) {
      prompt += `<|plamo:index|>${sanitizeText(term.source)}<|plamo:item|>${sanitizeText(term.target)}`;
    }
  }
  prompt += '<|plamo:tag|>input';
  if (input.sourceLang) prompt += `<|plamo:key|>lang<|plamo:val|>${input.sourceLang}`;
  prompt += `<|plamo:msg|>${sanitizeText(input.text)}`;
  prompt += `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${input.targetLang}`;
  if (input.form && input.targetLang === 'ja') {
    prompt += `<|plamo:key|>form<|plamo:val|>${input.form}`;
  }
  return `${prompt}<|plamo:msg|>`;
}

export function maxOutputTokens(text: string): number {
  return Math.max(256, Math.min(2_048, Math.ceil(text.length * 0.8) + 128));
}

export function plamoBody(input: PromptInput, model: string, addSpecialTokens = true): Record<string, unknown> {
  return {
    model,
    prompt: pfml3Prompt(input),
    temperature: 0,
    max_tokens: maxOutputTokens(input.text),
    stop: STOP,
    add_special_tokens: addSpecialTokens,
  };
}

export function openaiMessages(input: PromptInput): Array<{ role: string; content: string }> {
  const context = input.context?.trim();
  const system = [
    'You are a translation engine.',
    `Translate the user text into ${input.targetLang}.`,
    'Output only the translation.',
    'Preserve Markdown syntax, link/image placeholders (__PLAMO_*__), and inline code.',
    context ? `Page context: ${context}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: sanitizeText(input.text) },
  ];
}

export function openaiBody(input: PromptInput, model: string): Record<string, unknown> {
  return {
    model,
    messages: openaiMessages(input),
    temperature: 0,
  };
}

export function stripTerminator(text: string): string {
  let output = text;
  for (;;) {
    const trimmed = output.replace(/\s+$/, '');
    const token = STOP.find((candidate) => trimmed.endsWith(candidate));
    if (!token) return trimmed;
    output = trimmed.slice(0, -token.length);
  }
}

export function parsePlamoResponse(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) throw new Error('PLaMo: invalid response');
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('PLaMo: no choices');
  const choice = choices[0] as { text?: unknown; finish_reason?: unknown };
  if (typeof choice.text !== 'string') throw new Error('PLaMo: no text');
  if (choice.finish_reason === 'length') throw new Error('PLaMo: output truncated');
  const text = stripTerminator(choice.text);
  if (text.trim() === '') throw new Error('PLaMo: empty translation');
  return text;
}

export function parseOpenAIResponse(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) throw new Error('OpenAI: invalid response');
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('OpenAI: no choices');
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  if (typeof message?.content !== 'string' || message.content.trim() === '') {
    throw new Error('OpenAI: empty translation');
  }
  return message.content.trim();
}
