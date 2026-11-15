export const LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: 'English' },
  { code: 'zh-hans', label: '中文（簡体）' },
  { code: 'zh-hant', label: '中文（繁体）' },
  { code: 'ko', label: '한국어' },
  { code: 'ar', label: 'العربية' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'ms', label: 'Bahasa Melayu' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'bn', label: 'বাংলা' },
  { code: 'ta', label: 'தமிழ்' },
  { code: 'te', label: 'తెలుగు' },
  { code: 'ml', label: 'മലയാളം' },
  { code: 'mr', label: 'मराठी' },
  { code: 'gu', label: 'ગુજરાતી' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ' },
  { code: 'ur', label: 'اردو' },
  { code: 'fa', label: 'فارسی' },
  { code: 'he', label: 'עברית' },
  { code: 'sw', label: 'Kiswahili' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'ceb', label: 'Cebuano' },
  { code: 'jv', label: 'Basa Jawa' },
  { code: 'my', label: 'မြန်မာ' },
  { code: 'km', label: 'ខ្មែរ' },
  { code: 'si', label: 'සිංහල' },
  { code: 'ne', label: 'नेपाली' },
  { code: 'ka', label: 'ქართული' },
  { code: 'hy', label: 'Հայերեն' },
  { code: 'az', label: 'Azərbaycan' },
  { code: 'kk', label: 'Қазақша' },
  { code: 'uz', label: 'Oʻzbek' },
  { code: 'be', label: 'Беларуская' },
  { code: 'bg', label: 'Български' },
  { code: 'hr', label: 'Hrvatski' },
  { code: 'sr', label: 'Српски' },
  { code: 'sk', label: 'Slovenčina' },
  { code: 'sl', label: 'Slovenščina' },
  { code: 'lt', label: 'Lietuvių' },
  { code: 'lv', label: 'Latviešu' },
  { code: 'et', label: 'Eesti' },
  { code: 'eu', label: 'Euskara' },
  { code: 'ca', label: 'Català' },
];

const SUPPORTED = new Set(LANGUAGES.map((language) => language.code));

export function normalizeLanguage(tag: string | undefined | null): string | undefined {
  if (!tag) return undefined;
  const lower = tag.trim().toLowerCase();
  if (lower === '' || lower === 'auto') return undefined;
  if (lower.startsWith('zh-hant') || lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo') {
    return 'zh-hant';
  }
  if (lower.startsWith('zh')) return 'zh-hans';
  const primary = lower.split('-')[0] ?? '';
  return SUPPORTED.has(primary) ? primary : undefined;
}

export function languageLabel(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

const KANA = /[\u3040-\u30ff]/u;
const HANGUL = /[\uac00-\ud7af]/u;
const HAN = /[\u4e00-\u9fff]/u;
const CYRILLIC = /[\u0400-\u04ff]/u;
const ARABIC = /[\u0600-\u06ff]/u;
const HEBREW = /[\u0590-\u05ff]/u;
const THAI = /[\u0e00-\u0e7f]/u;
const DEVANAGARI = /[\u0900-\u097f]/u;
const LATIN = /[A-Za-z]/u;

export function detectScriptLanguage(text: string): string | undefined {
  if (KANA.test(text)) return 'ja';
  if (HANGUL.test(text)) return 'ko';
  if (THAI.test(text)) return 'th';
  if (HEBREW.test(text)) return 'he';
  if (ARABIC.test(text)) return 'ar';
  if (DEVANAGARI.test(text)) return 'hi';
  if (CYRILLIC.test(text)) return 'ru';
  if (HAN.test(text)) return 'zh-hans';
  if (LATIN.test(text)) return 'en';
  return undefined;
}

export function isProbablyTarget(text: string, target: string): boolean {
  const normalized = normalizeLanguage(target) ?? target;
  const sample = text.slice(0, 2_000);
  if (sample.trim() === '') return false;

  if (normalized === 'ja') {
    const kana = (sample.match(/[\u3040-\u30ff]/gu) ?? []).length;
    const letters = (sample.match(/[\p{L}\p{N}]/gu) ?? []).length;
    return letters > 0 && kana / letters >= 0.03;
  }
  if (normalized === 'ko') return HANGUL.test(sample);
  if (normalized === 'zh-hans' || normalized === 'zh-hant') {
    return HAN.test(sample) && !KANA.test(sample) && !HANGUL.test(sample);
  }
  if (normalized === 'ru' || normalized === 'uk' || normalized === 'bg' || normalized === 'sr' || normalized === 'be') {
    return CYRILLIC.test(sample);
  }
  if (normalized === 'ar' || normalized === 'fa' || normalized === 'ur') return ARABIC.test(sample);
  if (normalized === 'he') return HEBREW.test(sample);
  if (normalized === 'th') return THAI.test(sample);
  if (normalized === 'hi' || normalized === 'mr' || normalized === 'ne') return DEVANAGARI.test(sample);
  return false;
}

export function isLikelyTargetBlock(text: string, target: string, pageLang?: string): boolean {
  const normalized = normalizeLanguage(target) ?? target;
  if (isProbablyTarget(text, normalized)) return true;
  if (normalized !== 'en' && detectScriptLanguage(text) === normalized) return true;
  if (pageLang === normalized && !detectScriptLanguage(text)) return true;
  return false;
}
