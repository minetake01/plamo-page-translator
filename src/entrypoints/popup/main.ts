import { LANGUAGES } from '../../lib/languages';
import { send } from '../../lib/messages';
import type { Settings, Status } from '../../lib/types';

let settings: Settings;
let tabId: number | undefined;
let origin = '';

const target = document.querySelector<HTMLSelectElement>('#target')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const badge = document.querySelector<HTMLSpanElement>('#badge')!;
const serverStatus = document.querySelector<HTMLParagraphElement>('#server-status')!;
const siteDisabled = document.querySelector<HTMLInputElement>('#site-disabled')!;

for (const language of LANGUAGES) {
  const option = document.createElement('option');
  option.value = language.code;
  option.textContent = `${language.label} (${language.code})`;
  target.append(option);
}

function renderStatus(next: Status): void {
  badge.dataset.state = next.state;
  badge.textContent = next.state === 'translating'
    ? `${next.translated}/${next.total}`
    : next.state === 'done' ? '完了' : next.state === 'error' ? 'エラー' : '—';
  status.textContent = next.message
    ?? (next.state === 'translating'
      ? `翻訳中… ${next.translated}/${next.total}`
      : next.state === 'done' ? `翻訳しました（${next.translated} ブロック）`
        : next.state === 'already-target' ? 'このページは翻訳先の言語です'
          : '待機中');
}

async function save(): Promise<void> {
  settings = await send<Settings>({ type: 'settings:set', settings });
  target.value = settings.targetLang;
  siteDisabled.checked = settings.siteDisabled.includes(origin);
}

async function refreshStatus(): Promise<void> {
  if (tabId === undefined) return;
  try {
    const next = await browser.tabs.sendMessage(tabId, { type: 'ui:status' }) as Status;
    renderStatus(next);
  } catch {
    renderStatus({ state: 'idle', translated: 0, total: 0, message: 'このページでは利用できません' });
  }
}

async function sendToTab(message: { type: string }): Promise<void> {
  if (tabId === undefined) return;
  try {
    await browser.tabs.sendMessage(tabId, message);
    window.setTimeout(() => void refreshStatus(), 200);
    window.setTimeout(() => void refreshStatus(), 1_200);
  } catch {
    renderStatus({ state: 'idle', translated: 0, total: 0, message: 'このページでは利用できません' });
  }
}

async function init(): Promise<void> {
  settings = await send<Settings>({ type: 'settings:get' });
  target.value = settings.targetLang;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (tab?.url) {
    try { origin = new URL(tab.url).origin; } catch { origin = ''; }
  }
  siteDisabled.checked = origin !== '' && settings.siteDisabled.includes(origin);

  const probe = await send<{ ok: boolean; models: string[] }>({ type: 'probe' }).catch(() => ({ ok: false, models: [] }));
  serverStatus.textContent = probe.ok
    ? `PLaMo: ${settings.model}`
    : `PLaMo に接続できません（${settings.endpoint}）`;
  await refreshStatus();
}

target.addEventListener('change', async () => {
  settings.targetLang = target.value;
  await save();
  await sendToTab({ type: 'ui:translate' });
});

document.querySelector('#translate')?.addEventListener('click', () => { void sendToTab({ type: 'ui:translate' }); });
document.querySelector('#restore')?.addEventListener('click', () => { void sendToTab({ type: 'ui:restore' }); });
document.querySelector('#pick')?.addEventListener('click', () => { void sendToTab({ type: 'ui:pick' }); });
document.querySelector('#options')?.addEventListener('click', () => { void browser.runtime.openOptionsPage(); });

siteDisabled.addEventListener('change', async () => {
  if (!origin) return;
  const set = new Set(settings.siteDisabled);
  if (siteDisabled.checked) set.add(origin);
  else set.delete(origin);
  settings.siteDisabled = [...set];
  await save();
  await sendToTab({ type: siteDisabled.checked ? 'ui:restore' : 'ui:translate' });
});

void init();
