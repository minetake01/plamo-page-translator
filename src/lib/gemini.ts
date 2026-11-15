import { LANGUAGES } from './languages';
import type { RegionAction, RegionInfo, Settings } from './types';

export interface GeminiRegionResult {
  action: RegionAction;
  confidence: number;
}

const ACTION_CRITERIA = {
  translate: 'Primary readable content such as article body, headings, captions, quotes.',
  skip: 'Navigation, tabs, menus, buttons, file names, code, metadata, ads, cookie banners.',
  labels_only: 'UI labels that are useful to translate but must not change layout.',
  descend: 'Mixed container; classify its child regions separately.',
} as const;

export class GeminiError extends Error {
  override name = 'GeminiError';
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function endpoint(settings: Settings): string {
  return settings.geminiEndpoint.replace(/\/+$/, '');
}

async function post(settings: Settings, body: unknown): Promise<Record<string, unknown>> {
  if (!settings.geminiApiKey) throw new GeminiError(0, 'Gemini API key is not configured');
  const response = await fetch(endpoint(settings), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': settings.geminiApiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5_000, settings.timeoutMs)),
  });
  if (!response.ok) {
    throw new GeminiError(response.status, `Gemini returned HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function answersOf(raw: Record<string, unknown>): Record<string, unknown> {
  const answers = raw.answers;
  if (typeof answers !== 'object' || answers === null) {
    throw new GeminiError(0, 'Gemini returned no answers');
  }
  return answers as Record<string, unknown>;
}

export async function geminiDetectLanguage(
  settings: Settings,
  text: string,
): Promise<{ lang?: string; confidence: number }> {
  const criteria: Record<string, string> = {};
  for (const language of LANGUAGES) criteria[language.code] = language.label;
  const raw = await post(settings, {
    model: 'gemini-decision-1',
    input: [{ type: 'text', text: text.slice(0, 2_000) }],
    questions: {
      lang: {
        type: 'choice',
        instructions: 'What is the primary language of the main readable content?',
        criteria,
      },
    },
  });
  const answer = answersOf(raw).lang;
  if (!answer || typeof answer !== 'object') return { confidence: 0 };
  const choice = (answer as { choice?: unknown }).choice;
  const confidence = (answer as { confidence?: unknown }).confidence;
  return {
    lang: typeof choice === 'string' ? choice : undefined,
    confidence: typeof confidence === 'number' ? confidence : 0,
  };
}

export async function geminiClassifyRegions(
  settings: Settings,
  imageDataUrl: string | undefined,
  page: { title: string; url: string },
  regions: RegionInfo[],
): Promise<Map<string, GeminiRegionResult>> {
  if (regions.length === 0) return new Map();
  const lines = [
    `Page: ${page.title || '(untitled)'}`,
    `URL: ${page.url}`,
    'Regions (page coordinates):',
    ...regions.map((region) => {
      const [x, y, width, height] = region.box;
      return `${region.id.toUpperCase()}: <${region.tag}>${region.role ? ` role=${region.role}` : ''} box=${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)} linkDensity=${region.linkDensity.toFixed(2)} codeDensity=${region.codeDensity.toFixed(2)} text="${region.text.replace(/\s+/g, ' ').slice(0, 80)}"`;
    }),
  ];
  const input: Array<Record<string, unknown>> = [{ type: 'text', text: lines.join('\n') }];
  if (imageDataUrl) {
    const data = imageDataUrl.replace(/^data:image\/[a-z]+;base64,/i, '');
    input.push({
      type: 'image',
      data,
      mime_type: imageDataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg',
      resolution: 'medium',
    });
  }
  const questions: Record<string, unknown> = {};
  for (const region of regions) {
    const label = region.id.toUpperCase();
    questions[region.id] = {
      type: 'choice',
      instructions: `Region ${label} is <${region.tag}>${region.role ? ` with role ${region.role}` : ''}. It contains: ${region.text.slice(0, 100)}. Should its text be translated for a reader of the target language?`,
      criteria: ACTION_CRITERIA,
    };
  }
  const raw = await post(settings, { model: 'gemini-decision-1', input, questions });
  const answers = answersOf(raw);
  const result = new Map<string, GeminiRegionResult>();
  for (const region of regions) {
    const answer = answers[region.id];
    if (!answer || typeof answer !== 'object') continue;
    const choice = (answer as { choice?: unknown }).choice;
    const confidence = (answer as { confidence?: unknown }).confidence;
    if (choice !== 'translate' && choice !== 'skip' && choice !== 'labels_only' && choice !== 'descend') {
      continue;
    }
    result.set(region.id, {
      action: choice,
      confidence: typeof confidence === 'number' ? confidence : 0,
    });
  }
  return result;
}
