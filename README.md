# PLaMo Page Translator

[![CI](https://github.com/minetake01/plamo-page-translator/actions/workflows/ci.yml/badge.svg)](https://github.com/minetake01/plamo-page-translator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

ローカルの PLaMo 3 Translate（OpenAI 互換）で Web ページを訳文のみに置き換える
Firefox（Zen）/ Chrome 拡張。MVP 実装。

リポジトリ: https://github.com/minetake01/plamo-page-translator

## 現在できること

- ページを開くと自動翻訳。サイト単位で無効化。
- 訳文のみ。原文は DOM に保持し、OFF で復元。
- インライン要素を Markdown（URL は `__PLAMO_A0__` などのプレースホルダ）に変換し、
  リンク・強調・コード・画像・br を壊さずに再構築。
- Markdown で表せない要素は型付きスロット `【n】` にフォールバック。
- `translate=no` / `.notranslate` / `<meta name="google" content="notranslate">` を尊重。
- 日本語ページ（`lang=en` でも）をスキップ。
- 構造プロファイルを保存し、同じ構造のページでは Gemini を呼ばない。
- Gemini Decision 1 で言語判定・領域判定（任意。生成 LLM は使わない）。
- 手動ピッカーで「翻訳する/しない」を指定。
- PLaMo（PFML3）と OpenAI 互換（chat/completions）の 2 プロトコル。

## セットアップ

```powershell
pnpm install
pnpm types          # .wxt の型を生成（IDE 用）
pnpm build          # Firefox
pnpm build:chrome   # Chrome
pnpm test           # unit tests
pnpm test:e2e       # Chrome + real PLaMo + mock Gemini
```

- PLaMo の既定 endpoint は `http://127.0.0.1:45871/v1`（設定で変更可）。
  E2E では `PLAMO_ENDPOINT` で上書きできる。
- Gemini はオプション。設定画面で API キーを入れる。キーは `storage.local` のみ。
- Firefox/Zen は `about:debugging` で `.output/firefox-mv3/manifest.json` を一時読み込み。
- Chrome は `chrome://extensions` で `.output/chrome-mv3` を読み込み。
- `pnpm test:e2e` は Playwright の Chromium を使う。未導入なら
  `pnpm exec playwright-core install chromium` を 1 回実行する。
- ビルドは WXT 0.21 の TTY 待ちを避けるため `scripts/build.mjs` 経由。

### Zen のスモーク

```powershell
node test/e2e/serve-fixtures.mjs 8123
# 別ターミナル
# geckodriver を .output/geckodriver/ に置くか GECKODRIVER を設定
python test/e2e/zen-smoke.py
```

- XPI は `web-ext build --source-dir .output/firefox-mv3 --artifacts-dir .output --overwrite-dest`。
- `python` には `selenium` が必要。

## 構成

```text
plamo-page-translator/
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts    # 設定、翻訳、Gemini、プロファイル、スクショ
│  │  ├─ content.ts       # ゲート、スキャン、Markdown 再構築、ピッカー
│  │  ├─ popup/           # 翻訳 ON/OFF、サイト無効、領域選択
│  │  └─ options/         # endpoint / protocol / Gemini 設定
│  └─ lib/
│     ├─ markdown.ts      # Markdown 化・AST マッピング・復元
│     ├─ dom.ts           # 除外判定、ブロック抽出、領域ヒューリスティック
│     ├─ prompt.ts        # PFML3 / OpenAI messages
│     ├─ plamo.ts         # 翻訳 API
│     ├─ gemini.ts        # Decisions API
│     ├─ profile.ts       # スケルトン、類似度
│     └─ ...
├─ test/
│  ├─ fixtures/
│  └─ e2e/
│     ├─ smoke.mjs        # Chrome + mock Gemini
│     └─ zen-smoke.py     # Zen + Selenium
├─ scripts/build.mjs      # WXT の TTY 待ちを避けるビルドラッパー
├─ docs/                  # 設計・テスト計画
└─ artifacts/
   ├─ gemini-region-test/ # 注釈付き画像（合成・実生成）
   └─ e2e/                # E2E スクショ（gitignore）
```

## 成果物

- `artifacts/gemini-region-test/actual-input.jpg` — 拡張が Gemini に送った全体画像
- `artifacts/gemini-region-test/translated-page.png` — 実際の訳文のみ表示
- `artifacts/gemini-region-test/annotated.png` — 番号付き合成サンプル

## 既知の制限

- 原文を置換するため、サイト JS が `textContent` を読む場合は訳文が見える。
- 動的コンテンツは MutationObserver で再走査するが、再翻訳の競合は完全ではない。
- 手動ピッカーはトップフレームのみ。クロスオリジン iframe 内は各フレームの自動処理のみ。
- 全ページスクリーンショットはスクロール＋結合。固定要素は 2 枚目以降非表示。
- `labels_only`（タブ/ボタンのラベルだけ訳す）は現状 `skip` として扱う。
- Firefox/Zen は Selenium スモーク（`test/e2e/zen-smoke.py`）で確認。Chrome は Playwright で自動。
- Firefox の全ページスクショ取得は Chrome ほど検証していない。
- Gemini の生成 LLM は使わない。Decision のみ。

## License

- このリポジトリのコード: MIT（[LICENSE](LICENSE)）
- PLaMo 3 Translate のモデル重み: PLaMo Community License（このリポジトリには含まない）
