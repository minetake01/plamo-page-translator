import { hashString } from './profile';
import type { Settings, TranslationRequest } from './types';

const CACHE_KEY = 'plamo-translation-cache';
const LIMIT = 1_000;

let memory: Map<string, string> | undefined;
let loading: Promise<Map<string, string>> | undefined;

async function load(): Promise<Map<string, string>> {
  if (memory) return memory;
  if (!loading) {
    loading = (async () => {
      const stored = await browser.storage.local.get(CACHE_KEY);
      const raw = stored[CACHE_KEY];
      const map = new Map<string, string>();
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === 'string') map.set(key, value);
        }
      }
      memory = map;
      return map;
    })();
  }
  return loading;
}

export function translationKey(settings: Settings, request: TranslationRequest): string {
  return hashString(JSON.stringify([
    settings.protocol,
    settings.model,
    request.targetLang,
    request.sourceLang ?? 'auto',
    request.form ?? '',
    request.context ?? '',
    request.glossary ?? [],
    request.text,
  ]));
}

export async function cacheGet(key: string): Promise<string | undefined> {
  const map = await load();
  return map.get(key);
}

export async function cacheSet(key: string, value: string): Promise<void> {
  const map = await load();
  map.set(key, value);
  if (map.size > LIMIT) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  await browser.storage.local.set({ [CACHE_KEY]: Object.fromEntries(map) });
}

export async function clearCache(): Promise<void> {
  memory = new Map();
  await browser.storage.local.remove(CACHE_KEY);
}
