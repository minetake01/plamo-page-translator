import { describe, expect, it } from 'vitest';
import { applyMarkdown, restoreMarkdown, serializeInline } from './markdown';

function paragraph(html: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

describe('Markdown inline codec', () => {
  it('preserves links and emphasis by reusing DOM nodes', () => {
    const element = paragraph('This is <strong>important</strong> text with a <a href="/x">link</a>.');
    const anchor = element.querySelector('a')!;
    const strong = element.querySelector('strong')!;
    const serialized = serializeInline(Array.from(element.childNodes));
    expect(serialized.ok).toBe(true);
    expect(serialized.markdown).toContain('**important**');
    expect(serialized.markdown).toContain('[link](__PLAMO_A0__)');

    const state = applyMarkdown(
      element,
      'これは[リンク](__PLAMO_A0__)付きの**重要な**テキストです。',
      serialized,
      'ja',
      true,
    );
    expect(state).not.toBeNull();
    expect(element.querySelector('a')).toBe(anchor);
    expect(element.querySelector('strong')).toBe(strong);
    expect(anchor.getAttribute('href')).toBe('/x');
    expect(anchor.textContent).toBe('リンク');
    expect(element.textContent).toContain('重要な');
    expect(element.getAttribute('lang')).toBe('ja');

    restoreMarkdown(state!);
    expect(element.textContent).toBe('This is important text with a link.');
    expect(element.querySelector('a')).toBe(anchor);
    expect(element.hasAttribute('lang')).toBe(false);
  });

  it('maps reordered links by placeholder id', () => {
    const element = paragraph('Read <a href="/a">A</a> and <a href="/b">B</a>.');
    const first = element.querySelectorAll('a')[0]!;
    const second = element.querySelectorAll('a')[1]!;
    const serialized = serializeInline(Array.from(element.childNodes));
    const state = applyMarkdown(
      element,
      '[B](__PLAMO_A1__)の前に[A](__PLAMO_A0__)を読む。',
      serialized,
      'ja',
      true,
    );
    expect(state).not.toBeNull();
    const links = element.querySelectorAll('a');
    expect(links[0]).toBe(second);
    expect(links[1]).toBe(first);
    expect(links[0]?.textContent).toBe('B');
    expect(links[1]?.textContent).toBe('A');
  });

  it('translates image alt but restores src', () => {
    const element = paragraph('A <img src="/car.png" alt="red car"> here.');
    const image = element.querySelector('img')!;
    const serialized = serializeInline(Array.from(element.childNodes));
    const state = applyMarkdown(
      element,
      'ここに![赤い車](__PLAMO_I0__)があります。',
      serialized,
      'ja',
      true,
    );
    expect(state).not.toBeNull();
    expect(element.querySelector('img')).toBe(image);
    expect(image.getAttribute('src')).toBe('/car.png');
    expect(image.getAttribute('alt')).toBe('赤い車');
  });

  it('leaves the DOM untouched when a placeholder is missing', () => {
    const element = paragraph('A <a href="/x">link</a>.');
    const before = element.innerHTML;
    const serialized = serializeInline(Array.from(element.childNodes));
    const state = applyMarkdown(element, 'リンクだけ。', serialized, 'ja', true);
    expect(state).toBeNull();
    expect(element.innerHTML).toBe(before);
  });

  it('falls back to a typed slot for code containing backticks', () => {
    const element = paragraph('Use <code>a `b`</code> now.');
    const code = element.querySelector('code')!;
    const serialized = serializeInline(Array.from(element.childNodes));
    expect(serialized.markdown).toContain('【0】');
    const state = applyMarkdown(element, 'ここで【0】を使います。', serialized, 'ja', true);
    expect(state).not.toBeNull();
    expect(element.querySelector('code')).toBe(code);
    expect(code.textContent).toBe('a `b`');
  });

  it('refuses Markdown when the source contains slot markers', () => {
    const element = paragraph('【重要】なお知らせ');
    const serialized = serializeInline(Array.from(element.childNodes));
    expect(serialized.ok).toBe(false);
  });
});
