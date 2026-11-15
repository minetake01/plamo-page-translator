import type {
  RegionInfo,
  RegionRule,
  Settings,
  SiteProfile,
  TranslationRequest,
} from './types';

export type Message =
  | { type: 'settings:get' }
  | { type: 'settings:set'; settings: Settings }
  | { type: 'translate'; request: TranslationRequest }
  | { type: 'lang:detect'; text: string }
  | { type: 'gemini:detect'; text: string }
  | { type: 'gemini:classify'; image?: string; page: { title: string; url: string }; regions: RegionInfo[] }
  | { type: 'gemini:test' }
  | { type: 'capture:visible' }
  | { type: 'probe' }
  | {
      type: 'profile:match';
      query: { origin: string; hash: string; features: number[]; viewport: 'narrow' | 'wide' };
    }
  | {
      type: 'profile:save';
      profile: Omit<SiteProfile, 'id' | 'createdAt' | 'updatedAt' | 'hits'>;
    }
  | { type: 'profile:saveRule'; profileId: string; rule: RegionRule }
  | { type: 'profile:clear' }
  | { type: 'cache:clear' };

export type Response<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function ok<T>(data: T): Response<T> {
  return { ok: true, data };
}

export function fail(error: unknown): Response<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function isResponse(value: unknown): value is Response {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

export async function send<T>(message: Message): Promise<T> {
  const response = await browser.runtime.sendMessage(message) as Response<T>;
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
