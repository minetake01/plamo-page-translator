import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const ext = join(root, '.output', 'chrome-mv3');
const fixture = join(root, 'test', 'fixtures', 'article.html');
const artifacts = join(root, 'artifacts', 'e2e');
const plamoEndpoint = process.env.PLAMO_ENDPOINT ?? 'http://127.0.0.1:45871/v1';
await mkdir(artifacts, { recursive: true });

let geminiRequests = 0;
let geminiHadImage = false;
const geminiKinds = [];
const server = createServer(async (request, response) => {
  if (request.url === '/decisions' && request.method === 'POST') {
    geminiRequests += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    geminiKinds.push(Object.keys(body.questions ?? {}));
    geminiHadImage = geminiHadImage || JSON.stringify(body.input).includes('"image"');
    const image = (body.input ?? []).find((part) => part?.type === 'image');
    if (image?.data) {
      await writeFile(join(artifacts, 'gemini-input.jpg'), Buffer.from(image.data, 'base64'));
    }
    const answers = {};
    for (const [id, question] of Object.entries(body.questions ?? {})) {
      const text = question?.instructions ?? '';
      answers[id] = {
        type: 'choice',
        choice: text.includes('<main>') ? 'translate' : 'skip',
        confidence: 0.95,
        probabilities: {},
      };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers, usage: { total_input_tokens: 100, total_output_tokens: 0 } }));
    return;
  }
  if (request.url === '/article.html') {
    const html = await readFile(fixture, 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  if (request.url === '/article2.html') {
    const html = (await readFile(fixture, 'utf8')).replace(
      'How regional failover works',
      'How regional failover works, part two',
    );
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  if (request.url === '/japanese.html') {
    const html = await readFile(join(root, 'test', 'fixtures', 'japanese-lang-mismatch.html'), 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const port = server.address().port;

const context = await chromium.launchPersistentContext(join(root, '.output', 'e2e-profile'), {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const stored = await worker.evaluate(async (settings) => {
    await chrome.storage.local.set({ 'plamo-settings': settings });
    return chrome.storage.local.get('plamo-settings');
  }, {
    protocol: 'plamo',
    endpoint: plamoEndpoint,
    model: 'plamo-3-translate',
    apiKey: '',
    targetLang: 'ja',
    form: 'polite',
    autoTranslate: true,
    siteDisabled: [],
    timeoutMs: 20_000,
    concurrency: 2,
    addSpecialTokens: true,
    langChange: true,
    shortTextMin: 2,
    geminiEnabled: true,
    geminiApiKey: 'test',
    geminiEndpoint: `http://127.0.0.1:${port}/decisions`,
    geminiScreenshot: true,
    testMode: true,
  });

  console.log('stored settings', JSON.stringify(stored));
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    console.log(`[page:${message.type()}]`, message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  worker.on('console', (message) => console.log(`[worker:${message.type()}]`, message.text()));
  await page.goto(`http://127.0.0.1:${port}/article.html`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => document.documentElement.dataset.plamoState === 'done', null, { timeout: 45_000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      state: document.documentElement.dataset.plamoState,
      stats: document.documentElement.dataset.plamoStats,
      h1: document.querySelector('h1')?.textContent,
      body: document.body?.textContent?.slice(0, 200),
    }));
    console.log('TIMEOUT DEBUG', JSON.stringify({ debug, errors }, null, 2));
    await page.screenshot({ path: join(artifacts, 'article-timeout.png'), fullPage: true });
    throw error;
  }
  await page.screenshot({ path: join(artifacts, 'article-after.png'), fullPage: true });

  const result = await page.evaluate(() => ({
    state: document.documentElement.dataset.plamoState,
    h1: document.querySelector('h1')?.textContent,
    firstParagraph: document.querySelector('main p')?.textContent,
    nav: document.querySelector('nav')?.textContent,
    anchor: document.querySelector('main a')?.getAttribute('href'),
    anchorCount: document.querySelectorAll('main a').length,
    strongCount: document.querySelectorAll('main strong').length,
    code: document.querySelector('main code')?.textContent,
    lang: document.querySelector('main')?.getAttribute('lang'),
  }));
  console.log(JSON.stringify({ ...result, geminiRequests, geminiHadImage, geminiKinds, errors }, null, 2));

  await page.goto(`http://127.0.0.1:${port}/article2.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.plamoState === 'done', null, { timeout: 45_000 });
  const second = await page.evaluate(() => ({
    state: document.documentElement.dataset.plamoState,
    h1: document.querySelector('h1')?.textContent,
  }));
  console.log(JSON.stringify({ second, geminiRequestsAfterSecondPage: geminiRequests }, null, 2));

  await page.goto(`http://127.0.0.1:${port}/japanese.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.plamoState === 'already-target', null, { timeout: 20_000 });
  const japanese = await page.evaluate(() => ({
    state: document.documentElement.dataset.plamoState,
    h1: document.querySelector('h1')?.textContent,
    text: document.querySelector('main')?.textContent?.slice(0, 80),
  }));
  console.log(JSON.stringify({ japanese }, null, 2));
  await page.screenshot({ path: join(artifacts, 'japanese-after.png'), fullPage: true });

  const extensionId = await worker.evaluate(() => chrome.runtime.id);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForSelector('#server-status');
  await popup.waitForTimeout(500);
  const popupText = await popup.evaluate(() => document.body.innerText);
  await popup.screenshot({ path: join(artifacts, 'popup.png') });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForSelector('#endpoint');
  const optionsEndpoint = await options.inputValue('#endpoint');
  await options.screenshot({ path: join(artifacts, 'options.png'), fullPage: true });
  console.log(JSON.stringify({ extensionId, popupText: popupText.slice(0, 200), optionsEndpoint }, null, 2));
} finally {
  await context.close();
  server.close();
}
