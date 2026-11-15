# PLaMo Page Translator — サイト評価ハーネス計画

対象: [設計 v2](design-v2.md)
目的: GitHub / Amazon / Wikipedia / ニュース / ドキュメントなど複数サイトで、
翻訳適用後のスクリーンショットと DOM 指標を収集し、目視と自動チェックで評価する。

---

## 0. 結論

1. **Chrome は Playwright で自動化**する。拡張を persistent context に読み込み、
   before/after の全ページスクリーンショット、DOM 指標、Gemini 使用量を収集する。
2. **Zen は `web-ext` + 手動スモーク**。Playwright Firefox は拡張を正式サポートしないため、
   同じチェックリストを手動で回す。
3. **Gemini は既定でモック**。実 API は `LIVE_GEMINI=1` のときだけ使う。
   テストランナー側で **20 req/min** にスロットルする（拡張側の制限ではない）。
   キーは環境変数 `GEMINI_API_KEY` から読み、リポジトリ・ログ・レポートに残さない。
4. **サイトコーパスは「回帰用の固定リスト」と「ランダム探索」を分ける**。
   固定リストで before/after と期待値を管理し、ランダムは目視探索に使う。
5. **レポートは HTML + JSON**。サイトごとに before/after、領域オーバーレイ、指標、
   目視評価欄を並べる。

---

## 1. 評価の対象

### 1.1 機能チェック

| 項目 | 見るもの |
|---|---|
| インライン保持 | `a` / `strong` / `em` / `code` / `img` / `br` が翻訳後も残る。href が変わらない |
| 訳文のみ | 原文が消え、訳文が入る。OFF で完全復元 |
| 言語判定 | 日本語ページが翻訳されない。`lang=en` の日本語ページも翻訳されない |
| 領域判定 | タブ、メニュー、ファイル名、コード、メタデータが翻訳されない |
| 取りこぼし | 本文、見出し、キャプション、引用が翻訳される |
| 文脈 | 孤立語がページ文脈に合う。文脈なしの短文は原文のまま |
| レイアウト | オーバーフロー、重なり、極端な空白、固定ヘッダーの崩れがない |
| 動的コンテンツ | 遅延読み込み、無限スクロール、SPA 遷移に追従 |
| 性能 | 最初の訳文、完了時間、Long Task、メモリ |
| Gemini | 初回だけ呼ばれる。2 ページ目は 0 回。使用トークンを記録（拡張側の上限なし） |
| 失敗時 | PLaMo 停止、Gemini 失敗、429 でも原文が残り、ページが壊れない |

### 1.2 目視評価（5 段階）

- 訳質（自然さ・正確さ）
- 用語の一貫性
- 対訳/訳文のみの読みやすさ
- レイアウト
- 不要翻訳の少なさ
- 取りこぼしの少なさ

---

## 2. サイトコーパス

### 2.1 固定コーパス（回帰用）

`test/e2e/sites.json` に持つ。URL は実行時に差し替え可能。

| id | カテゴリ | 例 | 期待 |
|---|---|---|---|
| `github-repo` | コードホスト | `https://github.com/microsoft/TypeScript` | README/本文は翻訳、ファイル一覧・タブ・コードは skip |
| `github-issue` | コードホスト | `https://github.com/microsoft/TypeScript/issues` | Issue 本文/コメントは翻訳、ラベル/ファイル名は skip |
| `github-file` | コードホスト | `https://github.com/microsoft/TypeScript/blob/main/README.md` | コードは skip、説明文は翻訳 |
| `amazon-product` | EC | Amazon の商品ページ（ASIN は実行時指定） | 商品説明は翻訳、価格/レビュー日付/ナビは skip。bot 遮断は `BLOCKED` 記録 |
| `amazon-search` | EC | Amazon の検索結果 | 商品タイトルは翻訳、フィルタ/タブは skip。bot 遮断は `BLOCKED` |
| `wikipedia-en` | 百科 | `https://en.wikipedia.org/wiki/Translation` | 本文/見出しは翻訳、ナビ/サイドバーは skip |
| `wikipedia-ja` | 百科 | `https://ja.wikipedia.org/wiki/翻訳` | **翻訳しない**（日本語ページ） |
| `mdn` | ドキュメント | `https://developer.mozilla.org/en-US/docs/Web/API/Translation_API` | 本文/コード例、コードは skip |
| `react-docs` | ドキュメント | `https://react.dev/learn` | 本文/コード、ナビは skip |
| `zenn` | ブログ | `https://zenn.dev/` の記事 | 本文/見出し、タグ/日付は skip |
| `qiita` | ブログ | `https://qiita.com/` の記事 | 本文/コード、目次は skip |
| `bbc-news` | ニュース | `https://www.bbc.com/news` の記事 | 本文/見出し、ナビ/広告は skip |
| `reuters` | ニュース | `https://www.reuters.com/` の記事 | 本文/見出し、ナビは skip |
| `asahi` | ニュース（日本語） | `https://www.asahi.com/` の記事 | **翻訳しない** |
| `youtube` | 動画 | 公開動画の視聴ページ | タイトル/説明は翻訳、コメント/ナビは skip |
| `reddit` | 掲示板 | `https://www.reddit.com/r/translator/` | 投稿本文/コメントは翻訳、ナビは skip |
| `aws-docs` | タブあり | AWS のドキュメントページ | 本文は翻訳、タブ/目次/コードは skip |
| `local-inline` | ローカル fixture | `fixtures/inline.html` | リンク/強調/コード/画像/br が壊れない |
| `local-markdown` | ローカル fixture | `fixtures/markdown.html` | Markdown 化、URL プレースホルダ、`*`/`[` のリテラル、span フォールバック |
| `local-lang-mismatch` | ローカル fixture | `fixtures/lang-mismatch.html` | `lang=en` でも日本語本文は翻訳しない |
| `local-mixed` | ローカル fixture | `fixtures/mixed.html` | 日本語ページ内の英語引用の扱い |
| `local-tabs` | ローカル fixture | `fixtures/tabs.html` | タブ/ファイル名が翻訳されない |
| `local-dynamic` | ローカル fixture | `fixtures/dynamic.html` | 1 秒後の追加段落を翻訳 |
| `local-shadow` | ローカル fixture | `fixtures/shadow.html` | open Shadow DOM を翻訳、closed は対象外 |
| `local-iframe` | ローカル fixture | `fixtures/iframe.html` | same-origin/srcdoc を翻訳 |

### 2.2 ランダム探索

- `test/e2e/urls.random.json` に 50〜100 個の URL を置く。
- `--random N` で N 件を抽出。期待値は設定せず、before/after と目視メモだけ残す。
- クロールはしない。1 サイト 1〜2 ページ、リクエスト間隔を空ける。
- robots.txt / 利用規約に従う。ログインが必要なページは対象外。

### 2.3 Amazon / GitHub の注意

- Amazon は bot 遮断・CAPTCHA・地域リダイレクトがある。`BLOCKED` / `REDIRECTED` を
  失敗ではなく「スキップ」として記録する。
- GitHub は未ログインで Issue/ファイル/README が見えるページを使う。
  ログイン必須の設定画面は対象外。
- ニュースサイトは cookie 同意バナーが出る。バナーは翻訳対象外として記録し、
  無理に閉じない（ページを変更しない）。

---

## 3. ハーネス構成

```text
test/e2e/
├─ sites.json
├─ urls.random.json
├─ run.mjs                 # Playwright ランナー
├─ settings.mjs            # 拡張設定の投入
├─ tag-inline.mjs          # インライン要素に一時 ID を付ける
├─ metrics.mjs             # DOM 指標
├─ report.mjs              # HTML/JSON レポート
├─ mock-gemini.mjs         # Decisions API のモック
├─ mock-plamo.mjs          # /v1/completions のモック（任意）
├─ fixtures/
└─ artifacts/
   └─ <timestamp>/
      ├─ report.html
      ├─ summary.json
      └─ <site-id>/
         ├─ before.png
         ├─ after.png
         ├─ overlay.png
         ├─ metrics.json
         └─ console.log
```

- `before.png` / `after.png` は**全ページ**（`page.screenshot({ fullPage: true })`）。
  高さ上限を超える場合はビューポート分割。
- `overlay.png` はデバッグ設定で領域の action を色分けしたもの。
- `metrics.json` に DOM 指標・タイミング・Gemini 使用量。
- レポートはローカルで開く。スクリーンショットはコミットしない。

---

## 4. Chrome 自動化

### 4.1 起動

```js
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false, // Chrome の拡張は headed を既定にする
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ],
});
```

- `extDir` は `.output/chrome-mv3`。
- Service Worker を取得し、`chrome.storage.local` にテスト設定を入れる。

### 4.2 設定

```js
await sw.evaluate(async (settings) => {
  await chrome.storage.local.set(settings);
}, {
  endpoint: process.env.PLAMO_ENDPOINT ?? 'http://127.0.0.1:45871/v1',
  model: 'plamo-3-translate',
  targetLang: 'ja',
  autoTranslate: true,
  geminiEnabled: true,
  geminiEndpoint: 'http://127.0.0.1:8011/decisions', // モック
  geminiApiKey: 'test',
  geminiMaxRequestsPerMinute: 20,
  testMode: true,
});
```

- `testMode: true` のとき、content script は `data-plamo-state="ready"` で待機し、
  `window.dispatchEvent(new Event('plamo:start'))` で翻訳を開始する。
- これにより、テストがインライン要素に一時 ID を付けてから翻訳を開始できる。

### 4.3 1 サイトの流れ

1. `siteEnabled=false` でページを開く（自動翻訳 OFF）。
2. `before.png` を撮る。
3. `a, strong, em, code, img, br` に `data-e2e-id` を付ける。
4. `siteEnabled=true` / `testMode=true` でリロード。
5. `data-plamo-state="ready"` を待つ。
6. `plamo:start` を dispatch。
7. `data-plamo-state="done"` を待つ（タイムアウト 30 秒）。
8. `after.png`、`overlay.png` を撮る。
9. DOM 指標と `data-plamo-stats` を収集。
10. 次のサイトへ。

- 遅延読み込みのため、開始前にページを数回スクロールして高さを確定させる。
- 無限スクロールは 3 画面まで。
- SPA は `page.goto` 後に `networkidle` + 1 秒待つ。

### 4.4 プロトコルモード

同じ fixture を 2 モードで回す。

| モード | モック | 確認 |
|---|---|---|
| `plamo` | `/v1/completions` | PFML3、`stop`、`add_special_tokens`、context/glossary |
| `openai-chat` | `/v1/chat/completions` | messages、target language 指示、PLaMo 固有フィールドを送らない |

- 既定は `plamo`。
- `openai-chat` では `stop` / `chat_template_kwargs` / `add_special_tokens` が
  リクエストに含まれないことを assert する。
- どちらも同じ Markdown / スロットの再構築結果になることを確認する。

### 4.5 拡張のテストフック

content script はテスト時に次を公開する（本番では無効）。

- `document.documentElement.dataset.plamoState` = `ready | translating | done | error`
- `document.documentElement.dataset.plamoStats` = JSON:
  ```json
  {
    "units": 128,
    "translated": 120,
    "skipped": 8,
    "failed": 0,
    "profileHit": true,
    "geminiCalls": 0,
    "geminiRegions": 0,
    "geminiQuestions": 0,
    "geminiTokens": 0,
    "firstTranslationMs": 420,
    "doneMs": 3800
  }
  ```
- `window` の `plamo:start` イベントで開始。

---

## 5. 指標

### 5.1 自動チェック

| 指標 | 方法 | 合格 |
|---|---|---|
| インライン保持 | `data-e2e-id` の要素が after に存在し、`href` が同じ | 100% |
| 復元 | OFF 後の `textContent` が before と一致 | 完全一致 |
| 日本語ページ | `data-plamo-stats.translated === 0` | 0 |
| タブ/ファイル名 | before/after のテキストが同じ | 対象要素すべて |
| 翻訳カバレッジ | `translated / (translated + skipped)` | 本文領域で 90% 以上 |
| オーバーフロー | `scrollWidth > clientWidth + 2` の増加 | 0 |
| 固定ヘッダー | `position:fixed` の重複・消失 | なし |
| コンソール | pageerror / console.error | 0 |
| 性能 | `firstTranslationMs < 1500`, `doneMs < 15000` | 目標 |
| Gemini | 2 ページ目で `geminiCalls === 0` | 0 |
| Gemini 質問数 | 記事本文の途中の段落が `geminiRegions` に含まれない | 含まれない |
| 使用量 | `geminiTokens` / `geminiCalls` を記録 | 記録される |

### 5.2 目視チェック

- before/after を並べて、次を 5 段階で記録:
  - 訳質
  - 用語
  - 読みやすさ
  - レイアウト
  - 不要翻訳
  - 取りこぼし
- 気づいた要素は `notes` に selector とスクリーンショット位置を書く。
- 必要なら手動ピッカーで `translate`/`skip` を追加し、再実行して改善を確認。

### 5.3 失敗分類

| 分類 | 意味 |
|---|---|
| `OK` | 期待どおり |
| `LAYOUT` | オーバーフロー・重なり・固定要素の崩れ |
| `INLINE` | インライン要素の欠落・href 変更 |
| `OVER_TRANSLATE` | タブ/ファイル名/コード/メタデータが翻訳された |
| `UNDER_TRANSLATE` | 本文/見出しが翻訳されない |
| `WRONG_LANG` | 日本語ページを翻訳した、または英語ページを翻訳しない |
| `SLOT_FAIL` | スロット検証失敗で原文のまま |
| `GEMINI` | Gemini の判定ミス/失敗 |
| `BLOCKED` | bot 遮断・ログイン要求・リダイレクト |
| `TIMEOUT` | 翻訳が完了しない |

---

## 6. レポート

`report.html` のカード:

```text
[site id] [status] [profile hit/miss] [gemini calls/tokens]
┌─────────────── before ───────────────┐ ┌─────────────── after ────────────────┐
│                                      │ │                                      │
└──────────────────────────────────────┘ └──────────────────────────────────────┘
overlay.png（領域の action を色分け）
metrics: inline 100%, coverage 94%, overflow 0, first 420ms, done 3.8s
notes: ...
```

- `summary.json` に全サイトの status、metrics、notes を集約。
- `report.html` は画像を相対パスで参照。ローカルで開く。
- 失敗サイトだけフィルタできる。
- 目視評価の入力欄は HTML の `<textarea>`（保存は手動でも可）。

---

## 7. Gemini の扱い

### 7.1 既定はモック

`mock-gemini.mjs` は `POST /decisions` を受け、`questions` のキーと `instructions` から
決定的な回答を返す。**モック・テストフック・20 req/min の固定値は dev/test ビルドだけ**に入れ、
production ビルドからは外す（§13.1）。

- `r2` のような本文領域 → `translate`
- `r0`/`r1`/`r3`/`r4` → `skip`
- 言語質問 → `ja`/`en`
- `usage` は固定値。

これで E2E は API キーなし・課金なしで回す。

### 7.2 実 API

```powershell
$env:GEMINI_API_KEY = '...'   # リポジトリに保存しない
$env:LIVE_GEMINI = '1'
pnpm test:e2e -- --live-gemini --max-rpm 20
```

- 1 サイト 1 リクエスト（全リージョンを 1 リクエストにまとめる）。
- 20 req/min を超えないよう、ランナー側でもスロットルする。
- 実測: 1200×900 + 5 リージョン + 5 質問 = 1,392 トークン。
- 失敗・429 は `GEMINI` として記録し、ヒューリスティックで続行。

### 7.3 キャリブレーション

- 10〜20 ページを手動でラベル付け（領域ごとに translate/skip）。
- しきい値（confidence 0.65、トップ 2 差 0.15）を変えて precision/recall を見る。
- 画像あり/なし、`resolution` low/medium/high を比較。
- 結果を `test/e2e/gemini-calibration.md` に残す。

---

## 8. Firefox / Zen

### 8.1 開発

```powershell
pnpm wxt build -b firefox
npx web-ext run --source-dir .output/firefox-mv3 --firefox="C:\Program Files\Zen Browser\zen.exe"
```

- 一時アドオンで起動。
- `about:debugging` から手動で読み込んでもよい。

### 8.2 手動スモーク

固定コーパスのうち 8 サイトを選び、次を確認:

- 自動翻訳が動く
- サイト無効化が効く
- 日本語ページが翻訳されない
- タブ/ファイル名が翻訳されない
- インライン要素が壊れない
- OFF で復元
- 手動ピッカー
- Gemini の初回判定（実キー、1 サイト 1 リクエスト）

スクリーンショットは OS のスクリーンショットでもよいが、`before.png`/`after.png` を
`artifacts/manual/<date>/` に置くとレポートに使える。

### 8.3 Playwright Firefox の制約

- Playwright の Firefox は拡張のロードを正式サポートしない。
- Chrome で DOM ロジックを自動化し、Zen は手動で確認する。
- Zen 固有の API 欠落（`webRequest` など）は使わない。

---

## 9. 実行コマンド

```powershell
# ユニット/DOM
pnpm test

# E2E（モック Gemini、Chrome headed）
pnpm test:e2e -- --mock-gemini

# 固定コーパスだけ
pnpm test:e2e -- --mock-gemini --sites github-repo,github-issue,amazon-product,wikipedia-en,mdn

# 任意 URL
pnpm test:e2e -- --mock-gemini --urls https://example.com,https://github.com/...

# ランダム探索
pnpm test:e2e -- --mock-gemini --random 5

# 実 Gemini（テストランナー側で 20 req/min）
$env:GEMINI_API_KEY = '...'
pnpm test:e2e -- --live-gemini --max-rpm 20 --sites github-repo,wikipedia-en
```

- `artifacts/` は `.gitignore`。
- レポートは `artifacts/<timestamp>/report.html`。

---

## 10. 受け入れ条件

- 固定コーパスの `OK` が 80% 以上（初回。改善ループで 90% へ）。
- `INLINE` / `WRONG_LANG` / `OVER_TRANSLATE` が 0。
- 日本語ページ 3 サイトで `translated === 0`。
- 2 ページ目（類似構造）で `geminiCalls === 0`。
- Gemini 実 API の使用がテストランナーの 20 req/min 以内。拡張側の上限はなし。
- before/after レポートを目視で確認できる。
- 失敗サイトに `BLOCKED` / `TIMEOUT` の理由が残る。

---

## 11. リスク

| リスク | 対策 |
|---|---|
| Amazon の bot 遮断 | `BLOCKED` として記録。商品ページは ASIN を差し替え。保存 HTML fixture も用意 |
| ログイン必須ページ | 対象外。公開ページだけ |
| 無限スクロール | 3 画面で打ち切り |
| 全ページスクショが巨大 | 高さ上限・分割・JPEG 圧縮 |
| サイトの A/B テスト | 同じ URL でも構造が変わる。`needsReview` と手動再学習 |
| 翻訳結果のばらつき | 温度 0。目視評価は複数回の中央値 |
| Gemini のコスト | モック既定、実 API はテストランナーで 20 req/min。拡張側の上限なし |
| スクショに機密 | ローカル保存、`.gitignore`、必要なら黒塗り |
| テストが遅い | 固定コーパスを 10〜15 サイトに絞る。夜間はフル |

---

## 12. 実装順

1. `sites.json` とローカル fixture。
2. Playwright ランナー + 拡張ロード + 設定投入。
3. before/after スクリーンショット + `data-plamo-state`。
4. DOM 指標（inline / skip / overflow / coverage）。
5. HTML レポート。
6. モック Gemini。
7. 実 Gemini（20 req/min）+ キャリブレーション。
8. Zen 手動チェックリスト。
