export type Protocol = 'plamo' | 'openai-chat';

export type RegionAction = 'translate' | 'skip' | 'labels_only' | 'descend';

export interface Settings {
  protocol: Protocol;
  endpoint: string;
  model: string;
  apiKey: string;
  targetLang: string;
  form: 'polite' | 'plain';
  autoTranslate: boolean;
  siteDisabled: string[];
  timeoutMs: number;
  concurrency: number;
  addSpecialTokens: boolean;
  langChange: boolean;
  shortTextMin: number;
  geminiEnabled: boolean;
  geminiApiKey: string;
  geminiEndpoint: string;
  geminiScreenshot: boolean;
  testMode: boolean;
}

export interface TranslationRequest {
  text: string;
  context?: string;
  sourceLang?: string;
  targetLang: string;
  form?: 'polite' | 'plain';
  glossary?: Array<{ source: string; target: string }>;
}

export interface RegionInfo {
  id: string;
  selector: string;
  tag: string;
  role?: string;
  level: number;
  box: [number, number, number, number];
  text: string;
  linkDensity: number;
  codeDensity: number;
  action: RegionAction;
  confidence: number;
  mixed: boolean;
}

export interface RegionRule {
  selector: string;
  action: RegionAction;
  source: 'manual' | 'gemini' | 'heuristic';
  confidence: number;
  scope: 'profile' | 'url';
  urlPattern?: string;
}

export interface SiteProfile {
  id: string;
  origin: string;
  pathPattern: string;
  viewportClass: 'narrow' | 'wide';
  skeletonHash: string;
  features: number[];
  pageLang?: string;
  regions: RegionRule[];
  createdAt: number;
  updatedAt: number;
  hits: number;
}

export interface Status {
  state: 'idle' | 'translating' | 'done' | 'error' | 'already-target';
  translated: number;
  total: number;
  message?: string;
}
