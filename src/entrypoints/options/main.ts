import { LANGUAGES } from '../../lib/languages';
import { send } from '../../lib/messages';
import type { Settings } from '../../lib/types';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const protocol = $<HTMLSelectElement>('#protocol');
const endpoint = $<HTMLInputElement>('#endpoint');
const model = $<HTMLInputElement>('#model');
const apiKey = $<HTMLInputElement>('#apiKey');
const timeoutMs = $<HTMLInputElement>('#timeoutMs');
const concurrency = $<HTMLInputElement>('#concurrency');
const addSpecialTokens = $<HTMLInputElement>('#addSpecialTokens');
const targetLang = $<HTMLSelectElement>('#targetLang');
const form = $<HTMLSelectElement>('#form');
const autoTranslate = $<HTMLInputElement>('#autoTranslate');
const langChange = $<HTMLInputElement>('#langChange');
const shortTextMin = $<HTMLInputElement>('#shortTextMin');
const geminiEnabled = $<HTMLInputElement>('#geminiEnabled');
const geminiApiKey = $<HTMLInputElement>('#geminiApiKey');
const geminiEndpoint = $<HTMLInputElement>('#geminiEndpoint');
const geminiScreenshot = $<HTMLInputElement>('#geminiScreenshot');
const keyField = $<HTMLElement>('#key-field');
const probeResult = $<HTMLSpanElement>('#probe-result');
const geminiResult = $<HTMLSpanElement>('#gemini-result');
const saveResult = $<HTMLParagraphElement>('#save-result');

for (const language of LANGUAGES) {
  const option = document.createElement('option');
  option.value = language.code;
  option.textContent = `${language.label} (${language.code})`;
  targetLang.append(option);
}

let settings: Settings;

function apply(settingsValue: Settings): void {
  protocol.value = settingsValue.protocol;
  endpoint.value = settingsValue.endpoint;
  model.value = settingsValue.model;
  apiKey.value = settingsValue.apiKey;
  timeoutMs.value = String(settingsValue.timeoutMs);
  concurrency.value = String(settingsValue.concurrency);
  addSpecialTokens.checked = settingsValue.addSpecialTokens;
  targetLang.value = settingsValue.targetLang;
  form.value = settingsValue.form;
  autoTranslate.checked = settingsValue.autoTranslate;
  langChange.checked = settingsValue.langChange;
  shortTextMin.value = String(settingsValue.shortTextMin);
  geminiEnabled.checked = settingsValue.geminiEnabled;
  geminiApiKey.value = settingsValue.geminiApiKey;
  geminiEndpoint.value = settingsValue.geminiEndpoint;
  geminiScreenshot.checked = settingsValue.geminiScreenshot;
  keyField.dataset.hidden = settingsValue.protocol === 'plamo' ? 'true' : 'false';
}

function read(): Settings {
  return {
    ...settings,
    protocol: protocol.value === 'openai-chat' ? 'openai-chat' : 'plamo',
    endpoint: endpoint.value.trim(),
    model: model.value.trim(),
    apiKey: apiKey.value,
    timeoutMs: Number(timeoutMs.value) || 20_000,
    concurrency: Math.max(1, Math.min(4, Number(concurrency.value) || 2)),
    addSpecialTokens: addSpecialTokens.checked,
    targetLang: targetLang.value,
    form: form.value === 'plain' ? 'plain' : 'polite',
    autoTranslate: autoTranslate.checked,
    langChange: langChange.checked,
    shortTextMin: Math.max(1, Number(shortTextMin.value) || 2),
    geminiEnabled: geminiEnabled.checked,
    geminiApiKey: geminiApiKey.value,
    geminiEndpoint: geminiEndpoint.value.trim(),
    geminiScreenshot: geminiScreenshot.checked,
  };
}

async function init(): Promise<void> {
  settings = await send<Settings>({ type: 'settings:get' });
  apply(settings);
}

protocol.addEventListener('change', () => {
  keyField.dataset.hidden = protocol.value === 'plamo' ? 'true' : 'false';
});

$('#probe').addEventListener('click', async () => {
  probeResult.textContent = '確認中…';
  const saved = await send<Settings>({ type: 'settings:set', settings: read() });
  settings = saved;
  const result = await send<{ ok: boolean; models: string[] }>({ type: 'probe' });
  probeResult.textContent = result.ok
    ? `OK: ${settings.model}`
    : `NG: model=${settings.model} / models=${result.models.join(', ') || 'none'}`;
});

$('#gemini-test').addEventListener('click', async () => {
  geminiResult.textContent = '確認中…';
  const saved = await send<Settings>({ type: 'settings:set', settings: read() });
  settings = saved;
  try {
    const result = await send<{ lang?: string; confidence: number }>({ type: 'gemini:test' });
    geminiResult.textContent = `OK: ${result.lang ?? '?'} (${result.confidence.toFixed(2)})`;
  } catch (error) {
    geminiResult.textContent = `NG: ${error instanceof Error ? error.message : String(error)}`;
  }
});

$('#save').addEventListener('click', async () => {
  settings = await send<Settings>({ type: 'settings:set', settings: read() });
  apply(settings);
  saveResult.textContent = '保存しました。';
  window.setTimeout(() => { saveResult.textContent = ''; }, 2_000);
});

$('#clear-cache').addEventListener('click', async () => {
  await send({ type: 'cache:clear' });
  saveResult.textContent = '翻訳キャッシュを削除しました。';
});

$('#clear-profiles').addEventListener('click', async () => {
  await send({ type: 'profile:clear' });
  saveResult.textContent = '構造プロファイルを削除しました。';
});

void init();
