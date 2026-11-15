import { beforeEach, describe, expect, it } from 'vitest';
import { buildHeuristicRegions, findTranslatableBlocks, pageOptOut, needsDecision } from './dom';

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('translate');
});

describe('pageOptOut', () => {
  it('honors the Google notranslate meta', () => {
    const meta = document.createElement('meta');
    meta.name = 'google';
    meta.content = 'notranslate';
    document.head.append(meta);
    expect(pageOptOut(document)).toBe(true);
  });

  it('is false by default', () => {
    expect(pageOptOut(document)).toBe(false);
  });
});

describe('findTranslatableBlocks', () => {
  it('keeps article blocks and skips nav, code and notranslate', () => {
    document.body.innerHTML = `
      <nav><a href="/">Home</a></nav>
      <main>
        <h1>How it works</h1>
        <p>Hello world.</p>
        <pre><code>console.log(1)</code></pre>
        <p class="notranslate">Do not translate</p>
      </main>`;
    const blocks = findTranslatableBlocks(document);
    const text = blocks.map((block) => block.textContent?.trim());
    expect(text).toContain('How it works');
    expect(text).toContain('Hello world.');
    expect(text).not.toContain('console.log(1)');
    expect(text).not.toContain('Do not translate');
    expect(text).not.toContain('Home');
  });

  it('forces a manual translate rule outside the scope', () => {
    document.body.innerHTML = `<nav><span class="force-me">Force this</span></nav><main><p>Main</p></main>`;
    const blocks = findTranslatableBlocks(document, [
      { selector: '.force-me', action: 'translate', source: 'manual', confidence: 1, scope: 'profile' },
    ]);
    expect(blocks.map((block) => block.textContent)).toContain('Force this');
  });

  it('honors profile skip rules', () => {
    document.body.innerHTML = `<main><p class="skip-me">Skip this</p><p>Translate this</p></main>`;
    const blocks = findTranslatableBlocks(document, [
      { selector: '.skip-me', action: 'skip', source: 'manual', confidence: 1, scope: 'profile' },
    ]);
    expect(blocks.map((block) => block.textContent)).toEqual(['Translate this']);
  });
});

describe('heuristic regions', () => {
  it('classifies header/nav/main/aside/footer', () => {
    document.body.innerHTML = `
      <header>Site</header>
      <nav>Home</nav>
      <main><p>Article body</p></main>
      <aside>Related</aside>
      <footer>Legal</footer>`;
    const regions = buildHeuristicRegions(document);
    expect(regions.map((region) => region.action)).toEqual([
      'skip', 'skip', 'translate', 'skip', 'skip',
    ]);
    expect(regions.every(needsDecision)).toBe(true);
  });
});
