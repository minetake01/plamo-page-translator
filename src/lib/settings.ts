import type { Settings } from './types';

export const STORAGE_KEY = 'plamo-settings';

export const DEFAULT_SETTINGS: Settings = {
  protocol: 'plamo',
  endpoint: 'http://127.0.0.1:45871/v1',
  model: 'plamo-3-translate',
  apiKey: '',
  targetLang: 'ja',
  form: 'polite',
  autoTranslate: true,
  siteDisabled: [],
  timeoutMs: 20_000,
  concurrency: 2,
  addSpecialTokens: true,
  langChange: true,
  shortTextMin: 2,
  geminiEnabled: false,
  geminiApiKey: '',
  geminiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/decisions',
  geminiScreenshot: true,
  testMode: false,
};

export function mergeSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const value = raw as Partial<Settings>;
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...value,
    siteDisabled: Array.isArray(value.siteDisabled)
      ? value.siteDisabled.filter((item): item is string => typeof item === 'string')
      : [...DEFAULT_SETTINGS.siteDisabled],
  };
  if (merged.protocol !== 'plamo' && merged.protocol !== 'openai-chat') {
    merged.protocol = DEFAULT_SETTINGS.protocol;
  }
  if (typeof merged.endpoint !== 'string' || merged.endpoint.trim() === '') {
    merged.endpoint = DEFAULT_SETTINGS.endpoint;
  }
  merged.endpoint = merged.endpoint.replace(/\/+$/, '');
  if (typeof merged.model !== 'string' || merged.model.trim() === '') {
    merged.model = DEFAULT_SETTINGS.model;
  }
  if (merged.concurrency < 1) merged.concurrency = 1;
  if (merged.concurrency > 4) merged.concurrency = 4;
  if (merged.timeoutMs < 1_000) merged.timeoutMs = 1_000;
  return merged;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return mergeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const merged = mergeSettings(settings);
  await browser.storage.local.set({ [STORAGE_KEY]: merged });
  return merged;
}

export function isSiteDisabled(settings: Settings, origin: string): boolean {
  return settings.siteDisabled.includes(origin);
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
