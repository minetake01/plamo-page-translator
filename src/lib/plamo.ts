import { normalizeLanguage } from './languages';
import {
  openaiBody,
  parseOpenAIResponse,
  parsePlamoResponse,
  plamoBody,
} from './prompt';
import type { Settings, TranslationRequest } from './types';

export type TranslationErrorCode =
  | 'unavailable'
  | 'http'
  | 'invalid'
  | 'timeout'
  | 'aborted'
  | 'truncated';

export class TranslationError extends Error {
  override name = 'TranslationError';
  constructor(readonly code: TranslationErrorCode, message: string) {
    super(message);
  }
}

export interface DetectedLanguage {
  lang?: string;
  reliable: boolean;
}

export async function detectLanguage(text: string): Promise<DetectedLanguage> {
  const sample = text.slice(0, 2_000);
  if (sample.trim() === '') return { reliable: false };
  try {
    const result = await browser.i18n.detectLanguage(sample);
    const top = result.languages[0];
    if (top) {
      return {
        lang: normalizeLanguage(top.language) ?? top.language,
        reliable: result.isReliable,
      };
    }
  } catch {
    // Fall back to script detection.
  }
  return { lang: detectScript(text), reliable: false };
}

function detectScript(text: string): string | undefined {
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/u.test(text)) return 'ko';
  if (/[\u0e00-\u0e7f]/u.test(text)) return 'th';
  if (/[\u0590-\u05ff]/u.test(text)) return 'he';
  if (/[\u0600-\u06ff]/u.test(text)) return 'ar';
  if (/[\u0400-\u04ff]/u.test(text)) return 'ru';
  if (/[\u4e00-\u9fff]/u.test(text)) return 'zh-hans';
  return undefined;
}

export async function translateText(
  settings: Settings,
  request: TranslationRequest,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const endpoint = settings.endpoint.replace(/\/+$/, '');
  const url = settings.protocol === 'plamo' ? `${endpoint}/completions` : `${endpoint}/chat/completions`;
  const body = settings.protocol === 'plamo'
    ? plamoBody(
        {
          text: request.text,
          targetLang: request.targetLang,
          sourceLang: request.sourceLang,
          form: request.form,
          context: request.context,
          glossary: request.glossary,
        },
        settings.model,
        settings.addSpecialTokens,
      )
    : openaiBody(
        {
          text: request.text,
          targetLang: request.targetLang,
          sourceLang: request.sourceLang,
          form: request.form,
          context: request.context,
          glossary: request.glossary,
        },
        settings.model,
      );
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.protocol === 'openai-chat' && settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw new TranslationError('aborted', 'translation aborted');
    if (timeout.aborted) throw new TranslationError('timeout', 'translation timed out');
    throw new TranslationError('unavailable', `cannot reach ${endpoint}`);
  }
  if (!response.ok) {
    throw new TranslationError('http', `translation server returned HTTP ${response.status}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new TranslationError('invalid', 'translation response is not JSON');
  }
  try {
    return settings.protocol === 'plamo' ? parsePlamoResponse(raw) : parseOpenAIResponse(raw);
  } catch (error) {
    if (error instanceof Error && error.message.includes('truncated')) {
      throw new TranslationError('truncated', error.message);
    }
    throw new TranslationError('invalid', error instanceof Error ? error.message : 'invalid response');
  }
}

export async function probe(settings: Settings): Promise<{ ok: boolean; models: string[] }> {
  const endpoint = settings.endpoint.replace(/\/+$/, '');
  try {
    const response = await fetch(`${endpoint}/models`, {
      signal: AbortSignal.timeout(Math.min(settings.timeoutMs, 5_000)),
    });
    if (!response.ok) return { ok: false, models: [] };
    const raw = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = (raw.data ?? [])
      .map((model) => (typeof model.id === 'string' ? model.id : ''))
      .filter(Boolean);
    return { ok: models.includes(settings.model), models };
  } catch {
    return { ok: false, models: [] };
  }
}
