import type { RegionAction, RegionInfo, RegionRule } from './types';

const EXCLUDED_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title',
  'textarea', 'select', 'option', 'optgroup', 'canvas', 'svg', 'math',
  'code', 'pre', 'kbd', 'samp', 'var', 'ruby', 'rt', 'rp', 'iframe',
  'object', 'embed', 'video', 'audio', 'input', 'button',
]);

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const LANDMARKS = [
  'header', 'nav', 'main', 'article', 'aside', 'footer',
  '[role="banner"]', '[role="navigation"]', '[role="main"]',
  '[role="complementary"]', '[role="contentinfo"]',
];

const EXCLUDED_SELECTOR = [
  '[data-plamo-own]',
  '[translate="no"]',
  '.notranslate',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(',');

export function pageOptOut(document: Document): boolean {
  if (document.documentElement.translate === false) return true;
  const meta = document.querySelector('meta[name="google" i]');
  if (!meta) return false;
  const value = (meta.getAttribute('content') ?? meta.getAttribute('value') ?? '').trim().toLowerCase();
  return value === 'notranslate';
}

export function isExcludedElement(element: Element): boolean {
  if (element.closest(EXCLUDED_SELECTOR)) return true;
  if ('translate' in element && (element as HTMLElement).translate === false) return true;
  if (EXCLUDED_TAGS.has(element.localName)) return true;
  if (element.hasAttribute('hidden')) return true;
  const style = getComputedStyleSafe(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
  return false;
}

function getComputedStyleSafe(element: Element): CSSStyleDeclaration | null {
  try {
    return element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
  } catch {
    return null;
  }
}

export function isBlockElement(element: Element): boolean {
  if (BLOCK_TAGS.has(element.localName)) return true;
  const style = getComputedStyleSafe(element);
  if (!style) return false;
  return /^(block|list-item|table-cell|table-caption|flow-root|flex|grid)$/.test(style.display);
}

export function hasBlockChild(element: Element): boolean {
  for (const child of Array.from(element.children)) {
    if (!isExcludedElement(child) && isBlockElement(child)) return true;
  }
  return false;
}

export function blockText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function stableSelector(element: Element): string {
  const id = element.getAttribute('id');
  if (id && /^[A-Za-z][\w-]{0,48}$/.test(id)) return `#${id}`;
  const parts: string[] = [];
  let current: Element | null = element;
  let depth = 0;
  while (current && current.nodeType === Node.ELEMENT_NODE && depth < 4) {
    const tag = current.localName;
    const classes = Array.from(current.classList)
      .filter((name) => /^[A-Za-z][\w-]{0,24}$/.test(name))
      .filter((name) => !/^(css|sc|jsx|emotion|svelte)-/.test(name))
      .slice(0, 2);
    const parent: Element | null = current.parentElement;
    const sameTag = parent
      ? Array.from(parent.children).filter((child: Element) => child.localName === tag).indexOf(current) + 1
      : 1;
    const part = `${tag}${classes.map((name) => `.${name}`).join('')}:nth-of-type(${sameTag})`;
    parts.unshift(part);
    if (id && /^[A-Za-z][\w-]{0,48}$/.test(id)) {
      parts.unshift(`#${id}`);
      break;
    }
    current = parent;
    depth += 1;
  }
  return parts.join(' > ');
}

export function pageScope(document: Document): Element {
  return document.querySelector('main, article, [role="main"]') ?? document.body;
}

export function findTranslatableBlocks(
  document: Document,
  profileRules: RegionRule[] = [],
): Element[] {
  const scope = pageScope(document);
  const skipSelectors = profileRules.filter((rule) => rule.action === 'skip').map((rule) => rule.selector);
  const forceSelectors = profileRules
    .filter((rule) => rule.action === 'translate')
    .map((rule) => rule.selector);
  const blocks: Element[] = [];
  const used = new Set<Element>();

  const shouldSkip = (element: Element): boolean => {
    if (skipSelectors.some((selector) => safeMatches(element, selector))) return true;
    if (scope === document.body) {
      const landmark = element.closest('nav, aside, footer, header');
      if (landmark && !forceSelectors.some((selector) => safeMatches(landmark, selector))) return true;
    }
    return false;
  };

  const visit = (element: Element, force = false): void => {
    if (used.has(element) || isExcludedElement(element)) return;
    if (!force && element !== scope && shouldSkip(element)) return;

    if (hasBlockChild(element)) {
      for (const child of Array.from(element.children)) visit(child, force);
      return;
    }
    if (!isBlockElement(element)) return;
    const text = blockText(element);
    if (text.length < 2) return;
    if (blocks.includes(element)) return;
    blocks.push(element);
    used.add(element);
  };

  // Manual "translate" rules can force a subtree outside the normal scope.
  for (const selector of forceSelectors) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      let target: Element | null = element;
      while (target && !isBlockElement(target)) target = target.parentElement;
      visit(target ?? element, true);
    }
  }

  if (isExcludedElement(scope)) return blocks;
  if (hasBlockChild(scope)) {
    for (const child of Array.from(scope.children)) visit(child);
  } else if (blockText(scope).length >= 2) {
    blocks.push(scope);
  }
  return blocks;
}

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector) || element.closest(selector) !== null;
  } catch {
    return false;
  }
}

export function contextFor(element: Element): string {
  const document = element.ownerDocument;
  const heading = element.closest('section, article, main');
  const nearestHeading = heading?.querySelector('h1, h2, h3')?.textContent ?? '';
  const previous = element.previousElementSibling?.textContent ?? '';
  const next = element.nextElementSibling?.textContent ?? '';
  const text = blockText(element);
  const parts = [
    document.title,
    document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
    document.querySelector('h1')?.textContent ?? '',
    nearestHeading,
  ];
  if (text.length < 80) {
    parts.push(previous.slice(0, 120), next.slice(0, 120));
  }
  return parts
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, 300);
}

function stats(element: Element): {
  box: [number, number, number, number];
  text: string;
  linkDensity: number;
  codeDensity: number;
} {
  let rect: DOMRect | undefined;
  try {
    rect = element.getBoundingClientRect();
  } catch {
    rect = undefined;
  }
  const text = blockText(element);
  const linkText = Array.from(element.querySelectorAll('a'))
    .map((link) => link.textContent ?? '')
    .join('');
  const codeText = Array.from(element.querySelectorAll('code, pre, kbd, samp, var'))
    .map((code) => code.textContent ?? '')
    .join('');
  const total = Math.max(1, text.length);
  return {
    box: rect ? [rect.left, rect.top, rect.width, rect.height] : [0, 0, 0, 0],
    text,
    linkDensity: linkText.length / total,
    codeDensity: codeText.length / total,
  };
}

function initialAction(element: Element, linkDensity: number, codeDensity: number): {
  action: RegionAction;
  confidence: number;
} {
  const tag = element.localName;
  const role = element.getAttribute('role') ?? '';
  if (tag === 'main' || tag === 'article' || role === 'main') return { action: 'translate', confidence: 0.9 };
  if (tag === 'nav' || tag === 'aside' || tag === 'footer' || role === 'navigation' || role === 'contentinfo') {
    return { action: 'skip', confidence: 0.9 };
  }
  if (tag === 'header' || role === 'banner') return { action: 'skip', confidence: 0.8 };
  if (codeDensity > 0.3) return { action: 'skip', confidence: 0.9 };
  if (linkDensity > 0.55 && (element.textContent?.length ?? 0) < 400) return { action: 'skip', confidence: 0.7 };
  if ((element.textContent?.length ?? 0) > 200 && linkDensity < 0.35) {
    return { action: 'translate', confidence: 0.6 };
  }
  return { action: 'descend', confidence: 0.4 };
}

export function buildHeuristicRegions(document: Document): RegionInfo[] {
  const seen = new Set<Element>();
  const candidates: Element[] = [];
  for (const selector of LANDMARKS) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (seen.has(element)) continue;
      if (Array.from(seen).some((parent) => parent.contains(element))) continue;
      seen.add(element);
      candidates.push(element);
    }
  }
  if (candidates.length === 0) candidates.push(pageScope(document));

  return candidates.map((element, index) => {
    const stat = stats(element);
    const initial = initialAction(element, stat.linkDensity, stat.codeDensity);
    const mixed = Array.from(element.children).some((child) => isBlockElement(child)) &&
      stat.linkDensity > 0.2 && stat.linkDensity < 0.6;
    return {
      id: `r${index}`,
      selector: stableSelector(element),
      tag: element.localName,
      role: element.getAttribute('role') ?? undefined,
      level: 0,
      box: stat.box,
      text: stat.text.slice(0, 80),
      linkDensity: stat.linkDensity,
      codeDensity: stat.codeDensity,
      action: initial.action,
      confidence: mixed ? Math.min(initial.confidence, 0.5) : initial.confidence,
      mixed,
    };
  });
}

export function needsDecision(region: RegionInfo): boolean {
  return region.level === 0 || region.confidence < 0.85 || region.mixed || region.action === 'descend';
}
