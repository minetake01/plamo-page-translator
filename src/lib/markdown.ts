export interface MdSlot {
  id: string;
  kind: 'link' | 'image' | 'slot';
  element: Element;
  translatable: boolean;
}

export interface MdTarget {
  type: 'strong' | 'em' | 'code' | 'del' | 'br';
  element: Element;
}

export interface SerializedInline {
  markdown: string;
  slots: MdSlot[];
  targets: MdTarget[];
  ok: boolean;
}

export type MdNode =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: MdNode[] }
  | { type: 'code'; text: string }
  | { type: 'link'; id: string; children: MdNode[] }
  | { type: 'image'; id: string; alt: string }
  | { type: 'br' }
  | { type: 'slot'; id: string; children: MdNode[] };

interface SerializeState {
  slots: MdSlot[];
  targets: MdTarget[];
  nextLink: number;
  nextImage: number;
  nextSlot: number;
  ok: boolean;
  source: string;
}

const PROTECTED = new Set([
  'script', 'style', 'noscript', 'template', 'code', 'kbd', 'samp', 'var',
  'img', 'br', 'wbr', 'svg', 'math', 'ruby', 'rt', 'rp', 'input', 'button',
  'select', 'option', 'textarea', 'canvas', 'video', 'audio',
]);

const SKIP = new Set(['script', 'style', 'noscript', 'template']);

const ESCAPE = /[\\*_[\]`~]/g;

export function escapeMarkdown(text: string): string {
  return text.replace(ESCAPE, '\\$&');
}

export function serializeInline(nodes: Node[]): SerializedInline {
  const state: SerializeState = {
    slots: [],
    targets: [],
    nextLink: 0,
    nextImage: 0,
    nextSlot: 0,
    ok: true,
    source: nodes.map((node) => node.textContent ?? '').join(''),
  };
  if (state.source.includes('__PLAMO_') || state.source.includes('【')) {
    state.ok = false;
  }
  const markdown = serializeNodes(nodes, state);
  if (markdown.length > 1_200 || state.slots.length > 24) state.ok = false;
  return { markdown, slots: state.slots, targets: state.targets, ok: state.ok };
}

function serializeNodes(nodes: Node[], state: SerializeState): string {
  let out = '';
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += escapeMarkdown((node as Text).data);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as Element;
    const tag = element.localName;
    if (SKIP.has(tag)) continue;

    if (tag === 'br') {
      state.targets.push({ type: 'br', element });
      out += '  \n';
      continue;
    }
    if (tag === 'img') {
      const id = `__PLAMO_I${state.nextImage++}__`;
      state.slots.push({ id, kind: 'image', element, translatable: true });
      const alt = escapeMarkdown(element.getAttribute('alt') ?? '');
      out += `![${alt}](${id})`;
      continue;
    }
    if (tag === 'a') {
      const children = serializeNodes(Array.from(element.childNodes), state);
      if (children.trim() === '') {
        const id = String(state.nextSlot++);
        state.slots.push({ id, kind: 'slot', element, translatable: false });
        out += `【${id}】`;
      } else {
        const id = `__PLAMO_A${state.nextLink++}__`;
        state.slots.push({ id, kind: 'link', element, translatable: true });
        out += `[${children}](${id})`;
      }
      continue;
    }
    if (tag === 'strong' || tag === 'b') {
      state.targets.push({ type: 'strong', element });
      out += `**${serializeNodes(Array.from(element.childNodes), state)}**`;
      continue;
    }
    if (tag === 'em' || tag === 'i') {
      state.targets.push({ type: 'em', element });
      out += `*${serializeNodes(Array.from(element.childNodes), state)}*`;
      continue;
    }
    if (tag === 'del' || tag === 's') {
      state.targets.push({ type: 'del', element });
      out += `~~${serializeNodes(Array.from(element.childNodes), state)}~~`;
      continue;
    }
    if (tag === 'code') {
      const text = element.textContent ?? '';
      if (text.includes('`') || text.includes('\n')) {
        const id = String(state.nextSlot++);
        state.slots.push({ id, kind: 'slot', element, translatable: false });
        out += `【${id}】`;
      } else {
        state.targets.push({ type: 'code', element });
        out += `\`${text}\``;
      }
      continue;
    }
    if (PROTECTED.has(tag)) {
      const id = String(state.nextSlot++);
      state.slots.push({ id, kind: 'slot', element, translatable: false });
      out += `【${id}】`;
      continue;
    }

    const id = String(state.nextSlot++);
    const hasText = (element.textContent ?? '').trim() !== '';
    state.slots.push({ id, kind: 'slot', element, translatable: hasText });
    const children = serializeNodes(Array.from(element.childNodes), state);
    out += hasText ? `【${id}】${children}【/${id}】` : `【${id}】`;
  }
  return out;
}

export class MarkdownParseError extends Error {
  override name = 'MarkdownParseError';
}

export function parseMarkdown(markdown: string): MdNode[] {
  const result = parseRange(markdown, 0, null);
  return result.nodes;
}

function parseRange(text: string, start: number, stop: string | null): { nodes: MdNode[]; index: number } {
  const nodes: MdNode[] = [];
  let i = start;
  while (i < text.length) {
    if (stop !== null && text.startsWith(stop, i)) {
      return { nodes, index: i + stop.length };
    }
    const char = text[i];
    if (char === '\\') {
      if (i + 1 >= text.length) throw new MarkdownParseError('dangling escape');
      pushText(nodes, text.charAt(i + 1));
      i += 2;
      continue;
    }
    if (text.startsWith('![', i)) {
      const close = text.indexOf('](', i + 2);
      if (close < 0) throw new MarkdownParseError('image alt not closed');
      const end = text.indexOf(')', close + 2);
      if (end < 0) throw new MarkdownParseError('image dest not closed');
      const id = text.slice(close + 2, end);
      if (!/^__PLAMO_I\d+__$/.test(id)) throw new MarkdownParseError('invalid image placeholder');
      nodes.push({ type: 'image', id, alt: text.slice(i + 2, close) });
      i = end + 1;
      continue;
    }
    if (char === '[') {
      const close = text.indexOf('](', i + 1);
      if (close < 0) throw new MarkdownParseError('link text not closed');
      const end = text.indexOf(')', close + 2);
      if (end < 0) throw new MarkdownParseError('link dest not closed');
      const id = text.slice(close + 2, end);
      if (!/^__PLAMO_A\d+__$/.test(id)) throw new MarkdownParseError('invalid link placeholder');
      const inner = parseRange(text.slice(i + 1, close), 0, null).nodes;
      nodes.push({ type: 'link', id, children: inner });
      i = end + 1;
      continue;
    }
    if (text.startsWith('**', i)) {
      const close = findClose(text, i + 2, '**');
      const inner = parseRange(text.slice(i + 2, close), 0, null).nodes;
      nodes.push({ type: 'strong', children: inner });
      i = close + 2;
      continue;
    }
    if (text.startsWith('~~', i)) {
      const close = findClose(text, i + 2, '~~');
      const inner = parseRange(text.slice(i + 2, close), 0, null).nodes;
      nodes.push({ type: 'del', children: inner });
      i = close + 2;
      continue;
    }
    if (char === '*') {
      const close = findSingleStarClose(text, i + 1);
      const inner = parseRange(text.slice(i + 1, close), 0, null).nodes;
      nodes.push({ type: 'em', children: inner });
      i = close + 1;
      continue;
    }
    if (char === '`') {
      const close = text.indexOf('`', i + 1);
      if (close < 0) throw new MarkdownParseError('code span not closed');
      nodes.push({ type: 'code', text: text.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if (char === '【') {
      const match = /^【(\d+)】/.exec(text.slice(i));
      if (match) {
        const id = match[1] ?? '';
        const whole = match[0] ?? `【${id}】`;
        const close = `【/${id}】`;
        const closeIndex = text.indexOf(close, i + whole.length);
        if (closeIndex >= 0) {
          const inner = parseRange(text.slice(i + whole.length, closeIndex), 0, null).nodes;
          nodes.push({ type: 'slot', id, children: inner });
          i = closeIndex + close.length;
        } else {
          nodes.push({ type: 'slot', id, children: [] });
          i += whole.length;
        }
        continue;
      }
    }
    if (text.startsWith('  \n', i)) {
      nodes.push({ type: 'br' });
      i += 3;
      continue;
    }
    if (char === '\n') {
      nodes.push({ type: 'br' });
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < text.length && !isSpecial(text, end)) end += 1;
    pushText(nodes, text.slice(i, end));
    i = end;
  }
  if (stop !== null) throw new MarkdownParseError(`missing ${stop}`);
  return { nodes, index: i };
}

function isSpecial(text: string, index: number): boolean {
  const char = text[index];
  return char === '\\' || char === '*' || char === '`' || char === '[' || char === '!' ||
    char === '【' || char === '\n';
}

function pushText(nodes: MdNode[], text: string): void {
  if (text === '') return;
  const last = nodes[nodes.length - 1];
  if (last?.type === 'text') last.text += text;
  else nodes.push({ type: 'text', text });
}

function findClose(text: string, start: number, marker: string): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith(marker, i)) return i;
    i += 1;
  }
  throw new MarkdownParseError(`missing ${marker}`);
}

function findSingleStarClose(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '*' && text[i + 1] !== '*') return i;
    i += 1;
  }
  throw new MarkdownParseError('missing *');
}

export function validateMarkdown(nodes: MdNode[], serialized: SerializedInline): void {
  const used = new Map<string, number>();
  const targets: Record<string, number> = { strong: 0, em: 0, code: 0, del: 0, br: 0 };
  const visit = (items: MdNode[]): void => {
    for (const node of items) {
      if (node.type === 'text') continue;
      if (node.type === 'strong' || node.type === 'em' || node.type === 'del') {
        targets[node.type] = (targets[node.type] ?? 0) + 1;
        visit(node.children);
      } else if (node.type === 'code') {
        targets.code = (targets.code ?? 0) + 1;
      } else if (node.type === 'br') {
        targets.br = (targets.br ?? 0) + 1;
      } else if (node.type === 'link' || node.type === 'image' || node.type === 'slot') {
        used.set(node.id, (used.get(node.id) ?? 0) + 1);
        if (node.type !== 'image') visit(node.children);
      }
    }
  };
  visit(nodes);

  for (const slot of serialized.slots) {
    if (used.get(slot.id) !== 1) {
      throw new MarkdownParseError(`slot ${slot.id} used ${used.get(slot.id) ?? 0} times`);
    }
  }
  for (const [id] of used) {
    if (!serialized.slots.some((slot) => slot.id === id)) {
      throw new MarkdownParseError(`unknown slot ${id}`);
    }
  }
  const expected = {
    strong: serialized.targets.filter((target) => target.type === 'strong').length,
    em: serialized.targets.filter((target) => target.type === 'em').length,
    code: serialized.targets.filter((target) => target.type === 'code').length,
    del: serialized.targets.filter((target) => target.type === 'del').length,
    br: serialized.targets.filter((target) => target.type === 'br').length,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    const actual = targets[key] ?? 0;
    if (actual !== expected[key]) {
      throw new MarkdownParseError(`target ${key} mismatch: ${actual} != ${expected[key]}`);
    }
  }
}

interface BuildState {
  slots: Map<string, MdSlot>;
  targets: MdTarget[];
  cursor: Record<string, number>;
}

export function buildNodes(nodes: MdNode[], state: BuildState): Node[] {
  const out: Node[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(document.createTextNode(node.text));
    } else if (node.type === 'br') {
      out.push(takeTarget(state, 'br'));
    } else if (node.type === 'code') {
      out.push(takeTarget(state, 'code'));
    } else if (node.type === 'link') {
      const slot = state.slots.get(node.id);
      if (!slot || slot.kind !== 'link') throw new MarkdownParseError('missing link slot');
      slot.element.replaceChildren(...buildNodes(node.children, state));
      out.push(slot.element);
    } else if (node.type === 'image') {
      const slot = state.slots.get(node.id);
      if (!slot || slot.kind !== 'image') throw new MarkdownParseError('missing image slot');
      slot.element.setAttribute('alt', node.alt.replace(/\\([\\*_[\]`~])/g, '$1'));
      out.push(slot.element);
    } else if (node.type === 'slot') {
      const slot = state.slots.get(node.id);
      if (!slot || slot.kind !== 'slot') throw new MarkdownParseError('missing typed slot');
      if (slot.translatable) slot.element.replaceChildren(...buildNodes(node.children, state));
      out.push(slot.element);
    } else {
      const target = takeTarget(state, node.type);
      target.replaceChildren(...buildNodes(node.children, state));
      out.push(target);
    }
  }
  return out;
}

function takeTarget(state: BuildState, type: MdTarget['type']): Element {
  const index = state.cursor[type] ?? 0;
  const target = state.targets.filter((candidate) => candidate.type === type)[index];
  if (!target) throw new MarkdownParseError(`missing target ${type}`);
  state.cursor[type] = index + 1;
  return target.element;
}

export interface MarkdownState {
  element: Element;
  originalNodes: Node[];
  snapshot: Snapshot;
  lang: string | null;
  dir: string | null;
}

export interface Snapshot {
  children: Map<Element, Node[]>;
  text: Map<Text, string>;
}

export function snapshotTree(nodes: Node[]): Snapshot {
  const snapshot: Snapshot = { children: new Map(), text: new Map() };
  const visit = (items: Node[]): void => {
    for (const node of items) {
      if (node.nodeType === Node.TEXT_NODE) {
        snapshot.text.set(node as Text, (node as Text).data);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        snapshot.children.set(element, Array.from(element.childNodes));
        visit(Array.from(element.childNodes));
      }
    }
  };
  visit(nodes);
  return snapshot;
}

export function restoreTree(nodes: Node[], snapshot: Snapshot): void {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const value = snapshot.text.get(text);
      if (value !== undefined) text.data = value;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const children = snapshot.children.get(element);
      if (children) element.replaceChildren(...children);
      restoreTree(Array.from(element.childNodes), snapshot);
    }
  }
}

const RTL = new Set(['ar', 'he', 'fa', 'ur']);

export function applyMarkdown(
  element: Element,
  markdown: string,
  serialized: SerializedInline,
  targetLang: string,
  changeLang: boolean,
): MarkdownState | null {
  const originalNodes = Array.from(element.childNodes);
  const snapshot = snapshotTree(originalNodes);
  try {
    const parsed = parseMarkdown(markdown);
    validateMarkdown(parsed, serialized);
    const state: BuildState = {
      slots: new Map(serialized.slots.map((slot) => [slot.id, slot])),
      targets: serialized.targets,
      cursor: {},
    };
    const nodes = buildNodes(parsed, state);
    const lang = element.getAttribute('lang');
    const dir = element.getAttribute('dir');
    element.replaceChildren(...nodes);
    if (changeLang) {
      element.setAttribute('lang', targetLang);
      if (RTL.has(targetLang)) element.setAttribute('dir', 'auto');
    }
    return { element, originalNodes, snapshot, lang, dir };
  } catch {
    restoreTree(originalNodes, snapshot);
    return null;
  }
}

export function restoreMarkdown(state: MarkdownState): void {
  restoreTree(state.originalNodes, state.snapshot);
  state.element.replaceChildren(...state.originalNodes);
  if (state.lang === null) state.element.removeAttribute('lang');
  else state.element.setAttribute('lang', state.lang);
  if (state.dir === null) state.element.removeAttribute('dir');
  else state.element.setAttribute('dir', state.dir);
}
