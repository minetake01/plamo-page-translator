import type { SiteProfile } from './types';

const TAGS = [
  'div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'section', 'article', 'main',
  'header', 'footer', 'nav', 'aside', 'h1', 'h2', 'h3', 'table', 'tr', 'td',
  'form', 'button', 'pre', 'code', 'blockquote',
];

const ROLES = ['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'tablist'];
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas']);

export interface Signature {
  hash: string;
  features: number[];
}

export function hashString(value: string): string {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function skeletonSignature(document: Document): Signature {
  const parts: string[] = [];
  const counts = new Map<string, number>();
  let total = 0;

  const visit = (element: Element, depth: number): void => {
    if (total >= 500 || depth > 8) return;
    if (SKIP.has(element.localName)) return;
    total += 1;
    const role = element.getAttribute('role') ?? '';
    const classes = Array.from(element.classList)
      .filter((name) => /^[A-Za-z][\w-]{0,24}$/.test(name))
      .filter((name) => !/^(css|sc|jsx|emotion|svelte)-/.test(name))
      .sort()
      .slice(0, 3);
    parts.push(`${element.localName}|${role}|${classes.join('.')}|${depth}`);
    counts.set(element.localName, (counts.get(element.localName) ?? 0) + 1);
    if (role) counts.set(`@${role}`, (counts.get(`@${role}`) ?? 0) + 1);
    for (const child of Array.from(element.children)) visit(child, depth + 1);
  };

  if (document.body) visit(document.body, 0);
  const features = [
    ...TAGS.map((tag) => counts.get(tag) ?? 0),
    ...ROLES.map((role) => counts.get(`@${role}`) ?? 0),
  ].map((value) => value / Math.max(1, total));
  return { hash: hashString(parts.join('\n')), features };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function pathPattern(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean).map((segment) => {
      if (/^\d+$/.test(segment)) return '*';
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return '*';
      if (/^\d{4}-\d{2}(-\d{2})?$/.test(segment)) return '*';
      if (segment.length > 48 && /[-_]/.test(segment)) return '*';
      return segment;
    });
    return `/${segments.join('/')}`;
  } catch {
    return url;
  }
}

export function viewportClass(): 'narrow' | 'wide' {
  return window.innerWidth < 900 ? 'narrow' : 'wide';
}

export function bestProfile(
  profiles: SiteProfile[],
  query: { origin: string; hash: string; features: number[]; viewport: 'narrow' | 'wide' },
): SiteProfile | undefined {
  const candidates = profiles.filter(
    (profile) => profile.origin === query.origin && profile.viewportClass === query.viewport,
  );
  const exact = candidates.find((profile) => profile.skeletonHash === query.hash);
  if (exact) return exact;
  let best: SiteProfile | undefined;
  let score = 0;
  for (const candidate of candidates) {
    const value = cosine(candidate.features, query.features);
    if (value > score) {
      score = value;
      best = candidate;
    }
  }
  return score >= 0.82 ? best : undefined;
}
