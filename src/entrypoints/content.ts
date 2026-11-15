import { buildHeuristicRegions, blockText, contextFor, findTranslatableBlocks, isExcludedElement, needsDecision, pageOptOut, pageScope, stableSelector } from '../lib/dom';
import { applyMarkdown, restoreMarkdown, serializeInline, type MarkdownState } from '../lib/markdown';
import { send } from '../lib/messages';
import { isLikelyTargetBlock, isProbablyTarget, normalizeLanguage } from '../lib/languages';
import { pathPattern, skeletonSignature, viewportClass } from '../lib/profile';
import { STORAGE_KEY } from '../lib/settings';
import type { RegionAction, RegionInfo, RegionRule, Settings, SiteProfile, Status } from '../lib/types';

let settings: Settings | undefined;
let status: Status = { state: 'idle', translated: 0, total: 0 };
let profile: SiteProfile | null = null;
let pageLang = '';
let geminiCalls = 0;
let geminiRegions = 0;
let running = false;
let translated = new WeakSet<Element>();
const applied = new Map<Element, MarkdownState>();
let observer: MutationObserver | null = null;
let observerTimer: number | undefined;
let lastUrl = location.href;
let picker: (() => void) | null = null;

function setStatus(next: Status): void {
  status = next;
  if (settings?.testMode) {
    document.documentElement.dataset.plamoState = next.state;
    document.documentElement.dataset.plamoStats = JSON.stringify({
      units: next.total,
      translated: next.translated,
      skipped: Math.max(0, next.total - next.translated),
      failed: 0,
      profileHit: Boolean(profile),
      geminiCalls,
      geminiRegions,
      geminiQuestions: geminiRegions,
      geminiTokens: 0,
      message: next.message ?? '',
    });
  }
}

function sampleText(): string {
  return (pageScope(document).textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

function rulesFor(regions: RegionInfo[]): RegionRule[] {
  return regions
    .filter((region) => region.action !== 'descend')
    .map((region) => ({
      selector: region.selector,
      // labels_only is not rendered yet; skipping is safer than translating a
      // tab bar or toolbar as a full block and changing its layout.
      action: region.action === 'labels_only' ? 'skip' : region.action,
      source: 'heuristic' as const,
      confidence: region.confidence,
      scope: 'profile' as const,
    }));
}

async function classifyWithGemini(regions: RegionInfo[]): Promise<RegionInfo[]> {
  if (!settings?.geminiEnabled || !settings.geminiApiKey) return regions;
  const decision = regions.filter(needsDecision).slice(0, 30);
  if (decision.length === 0) return regions;
  let image: string | undefined;
  if (settings.geminiScreenshot) {
    image = await captureFullPage(decision).catch(() => undefined);
  }
  try {
    geminiCalls += 1;
    geminiRegions += decision.length;
    const answers = await send<Record<string, { action: RegionAction; confidence: number }>>({
      type: 'gemini:classify',
      image,
      page: { title: document.title, url: location.href },
      regions: decision,
    });
    return regions.map((region) => {
      const answer = answers[region.id];
      if (!answer || answer.confidence < 0.65) return region;
      return { ...region, action: answer.action, confidence: answer.confidence };
    });
  } catch {
    return regions;
  }
}

async function ensureProfile(): Promise<SiteProfile | null> {
  if (profile) return profile;
  const signature = skeletonSignature(document);
  const saved = await send<SiteProfile | null>({
    type: 'profile:match',
    query: {
      origin: location.origin,
      hash: signature.hash,
      features: signature.features,
      viewport: viewportClass(),
    },
  });
  if (saved) {
    profile = saved;
    return saved;
  }
  let regions = buildHeuristicRegions(document);
  regions = await classifyWithGemini(regions);
  profile = await send<SiteProfile>({
    type: 'profile:save',
    profile: {
      origin: location.origin,
      pathPattern: pathPattern(location.href),
      viewportClass: viewportClass(),
      skeletonHash: signature.hash,
      features: signature.features,
      pageLang,
      regions: rulesFor(regions),
    },
  });
  return profile;
}

async function start(force = false): Promise<void> {
  if (running) return;
  running = true;
  try {
    settings = await send<Settings>({ type: 'settings:get' });
    if (!settings.autoTranslate && !force) {
      setStatus({ state: 'idle', translated: 0, total: 0 });
      return;
    }
    if (settings.siteDisabled.includes(location.origin)) {
      setStatus({ state: 'idle', translated: 0, total: 0, message: 'site disabled' });
      return;
    }
    if (pageOptOut(document) && !force) {
      setStatus({ state: 'idle', translated: 0, total: 0, message: 'page opted out' });
      return;
    }
    const sample = sampleText();
    let detected = await send<{ lang?: string; reliable: boolean }>({ type: 'lang:detect', text: sample });
    if ((!detected.lang || !detected.reliable) && settings.geminiEnabled && settings.geminiApiKey) {
      try {
        const gemini = await send<{ lang?: string; confidence: number }>({ type: 'gemini:detect', text: sample });
        if (gemini.lang && gemini.confidence >= 0.65) {
          detected = { lang: gemini.lang, reliable: true };
        }
      } catch {
        // Keep the local detection.
      }
    }
    pageLang = normalizeLanguage(detected.lang) ?? '';
    const target = normalizeLanguage(settings.targetLang) ?? settings.targetLang;
    if (pageLang === target || isProbablyTarget(sample, target)) {
      setStatus({ state: 'already-target', translated: 0, total: 0, message: 'already in target language' });
      return;
    }

    const siteProfile = await ensureProfile();
    const blocks = findTranslatableBlocks(document, siteProfile?.regions ?? []);
    const queue = blocks.filter((block) => shouldTranslate(block, target));
    setStatus({ state: 'translating', translated: 0, total: queue.length });
    let cursor = 0;
    const workers = Array.from(
      { length: Math.max(1, Math.min(4, settings.concurrency)) },
      async () => {
        while (cursor < queue.length) {
          const index = cursor;
          cursor += 1;
          const block = queue[index];
          if (!block) return;
          await translateBlock(block, target, index);
        }
      },
    );
    await Promise.all(workers);
    setStatus({ state: 'done', translated: queue.length, total: queue.length });
    startObserver();
  } catch (error) {
    setStatus({
      state: 'error',
      translated: 0,
      total: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running = false;
  }
}

function shouldTranslate(block: Element, target: string): boolean {
  if (translated.has(block)) return false;
  if (isExcludedElement(block)) return false;
  const text = blockText(block);
  if (text.length < (settings?.shortTextMin ?? 2)) return false;
  if (isLikelyTargetBlock(text, target, pageLang)) return false;
  return true;
}

async function translateBlock(block: Element, target: string, index: number): Promise<void> {
  const serialized = serializeInline(Array.from(block.childNodes));
  if (!serialized.ok || serialized.markdown.trim() === '') return;
  try {
    const response = await send<{ text: string }>({
      type: 'translate',
      request: {
        text: serialized.markdown,
        context: contextFor(block),
        sourceLang: pageLang || undefined,
        targetLang: target,
        form: target === 'ja' ? settings?.form : undefined,
      },
    });
    const state = applyMarkdown(block, response.text, serialized, target, settings?.langChange ?? true);
    if (!state) return;
    applied.set(block, state);
    translated.add(block);
    setStatus({ state: 'translating', translated: index + 1, total: status.total });
  } catch {
    // Leave the original block untouched. The next observer pass may retry.
  }
}

function restoreAll(): void {
  for (const state of applied.values()) restoreMarkdown(state);
  applied.clear();
  translated = new WeakSet();
  setStatus({ state: 'idle', translated: 0, total: 0 });
}

function startObserver(): void {
  if (observer || !document.body) return;
  observer = new MutationObserver((records) => {
    const meaningful = records.some((record) => {
      const target = record.target;
      if (target.nodeType === Node.ELEMENT_NODE && (target as Element).closest('[data-plamo-own]')) {
        return false;
      }
      return true;
    });
    if (!meaningful) return;
    if (observerTimer !== undefined) window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(() => {
      observerTimer = undefined;
      void start(true);
    }, 600);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image load failed'));
    image.src = src;
  });
}

async function captureFullPage(regions: RegionInfo[]): Promise<string | undefined> {
  const viewportHeight = Math.max(400, window.innerHeight);
  const pageHeight = Math.max(
    viewportHeight,
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0,
  );
  const fullHeight = Math.min(12_000, pageHeight);
  const startY = window.scrollY;
  const fixed = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((element) => {
    const style = getComputedStyle(element);
    return style.position === 'fixed' || style.position === 'sticky';
  });
  const originalVisibility = fixed.map((element) => element.style.visibility);
  const shots: Array<{ image: string; y: number }> = [];
  try {
    let y = 0;
    for (;;) {
      window.scrollTo(0, y);
      await delay(140);
      const actualY = window.scrollY;
      const shot = await send<{ image: string }>({ type: 'capture:visible' });
      shots.push({ image: shot.image, y: actualY });
      if (shots.length === 1) fixed.forEach((element) => { element.style.visibility = 'hidden'; });
      if (actualY + viewportHeight >= fullHeight - 1 || shots.length >= 40) break;
      const next = actualY + viewportHeight - 80;
      if (next <= actualY) break;
      y = next;
    }
  } finally {
    fixed.forEach((element, index) => { element.style.visibility = originalVisibility[index] ?? ''; });
    window.scrollTo(0, startY);
  }
  if (shots.length === 0) return undefined;

  const images = await Promise.all(shots.map((shot) => loadImage(shot.image)));
  const first = images[0];
  if (!first) return undefined;
  const scale = first.width / Math.max(1, window.innerWidth);
  const canvasHeight = Math.max(...images.map((image, index) => (shots[index]?.y ?? 0) * scale + image.height));
  const canvas = document.createElement('canvas');
  canvas.width = first.width;
  canvas.height = Math.max(1, Math.min(12_000, canvasHeight));
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  images.forEach((image, index) => {
    const top = (shots[index]?.y ?? 0) * scale;
    context.drawImage(image, 0, top, image.width, image.height);
  });

  context.lineWidth = Math.max(2, Math.round(2 * scale));
  context.strokeStyle = '#e11d48';
  context.font = `${Math.round(16 * scale)}px Segoe UI, Arial`;
  context.textBaseline = 'top';
  for (const region of regions) {
    const [x, top, width, boxHeight] = region.box;
    const pageTop = (top + startY) * scale;
    context.strokeRect(x * scale, pageTop, width * scale, boxHeight * scale);
    context.fillStyle = '#e11d48';
    context.fillRect(Math.max(0, x * scale - 36 * scale), pageTop, 34 * scale, 24 * scale);
    context.fillStyle = '#fff';
    context.fillText(region.id.toUpperCase(), Math.max(2, x * scale - 34 * scale), pageTop + 3 * scale);
  }

  const maxWidth = 1_280;
  const maxHeight = 6_000;
  const ratio = Math.min(1, maxWidth / canvas.width, maxHeight / canvas.height);
  if (ratio < 1) {
    const scaled = document.createElement('canvas');
    scaled.width = Math.max(1, Math.round(canvas.width * ratio));
    scaled.height = Math.max(1, Math.round(canvas.height * ratio));
    scaled.getContext('2d')?.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    return scaled.toDataURL('image/jpeg', 0.82);
  }
  return canvas.toDataURL('image/jpeg', 0.82);
}

function startPicker(): void {
  if (picker) return;
  const host = document.createElement('div');
  host.dataset.plamoOwn = 'true';
  host.setAttribute('translate', 'no');
  host.className = 'notranslate';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      #outline{position:fixed;border:3px solid #e11d48;background:rgba(225,29,72,.08);display:none;pointer-events:none}
      #tag{position:fixed;background:#e11d48;color:#fff;font:600 12px/1.4 Segoe UI,Arial;padding:3px 7px;border-radius:3px;display:none;pointer-events:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #bar{position:fixed;display:none;gap:6px;background:#111827;padding:6px;border-radius:8px;pointer-events:auto;box-shadow:0 8px 30px rgba(0,0,0,.35)}
      button{border:0;border-radius:5px;padding:7px 10px;font:600 12px Segoe UI,Arial;cursor:pointer;background:#e5e7eb;color:#111827}
      button.primary{background:#e11d48;color:#fff}button.ghost{background:#374151;color:#fff}
    </style>
    <div id="outline"></div><div id="tag"></div><div id="bar">
      <button data-action="translate" class="primary">翻訳する</button>
      <button data-action="skip" class="ghost">翻訳しない</button>
      <button data-action="cancel">キャンセル</button>
    </div>`;
  document.documentElement.appendChild(host);
  const outline = shadow.querySelector<HTMLElement>('#outline')!;
  const tag = shadow.querySelector<HTMLElement>('#tag')!;
  const bar = shadow.querySelector<HTMLElement>('#bar')!;
  let current: Element | null = null;
  let selected: Element | null = null;

  const onMove = (event: MouseEvent): void => {
    if (selected) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || host.contains(element)) return;
    current = element;
    const rect = element.getBoundingClientRect();
    outline.style.display = 'block';
    outline.style.left = `${rect.left}px`;
    outline.style.top = `${rect.top}px`;
    outline.style.width = `${rect.width}px`;
    outline.style.height = `${rect.height}px`;
    tag.style.display = 'block';
    tag.style.left = `${Math.max(4, rect.left)}px`;
    tag.style.top = `${Math.max(4, rect.top - 24)}px`;
    tag.textContent = `${element.localName}${element.id ? `#${element.id}` : ''} — ${stableSelector(element)}`;
  };
  const onClick = (event: MouseEvent): void => {
    if (event.composedPath().includes(host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!current || host.contains(current)) return;
    selected = current;
    const rect = current.getBoundingClientRect();
    bar.style.display = 'flex';
    bar.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, rect.left))}px`;
    bar.style.top = `${Math.max(8, Math.min(window.innerHeight - 60, rect.top + 8))}px`;
  };
  const cleanup = (): void => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
    picker = null;
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') cleanup();
  };
  bar.addEventListener('click', async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    event.stopPropagation();
    const action = button.dataset.action;
    if (action === 'cancel') { cleanup(); return; }
    if (!selected || (action !== 'translate' && action !== 'skip')) { cleanup(); return; }
    const targetElement = selected;
    cleanup();
    const currentProfile = await ensureProfile();
    if (!currentProfile) return;
    const rule: RegionRule = {
      selector: stableSelector(targetElement),
      action,
      source: 'manual',
      confidence: 1,
      scope: 'profile',
    };
    await send({ type: 'profile:saveRule', profileId: currentProfile.id, rule });
    currentProfile.regions.unshift(rule);
    restoreAll();
    void start(true);
  });
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  picker = cleanup;
}

browser.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message?.type === 'ui:toggle') {
    if (status.state === 'done' || status.state === 'translating') restoreAll();
    else void start(true);
    return Promise.resolve({ ok: true });
  }
  if (message?.type === 'ui:translate') { void start(true); return Promise.resolve({ ok: true }); }
  if (message?.type === 'ui:restore') { restoreAll(); return Promise.resolve({ ok: true }); }
  if (message?.type === 'ui:pick') { startPicker(); return Promise.resolve({ ok: true }); }
  if (message?.type === 'ui:status') return Promise.resolve(status);
  return undefined;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    void start(true);
  }
});

window.setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    stopObserver();
    restoreAll();
    profile = null;
    void start(true);
  }
}, 1_000);

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',
  main() {
    void start(false);
  },
});
