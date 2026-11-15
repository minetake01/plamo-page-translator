# PLaMo 3 Translate ページ翻訳拡張 — 設計 v2（Firefox/Zen・訳文のみ・Gemini 判定）

対象: `F:\llm_servers` の vLLM + `pfnet/plamo-3-translate-0.8b-W4A16`
（現行 `http://127.0.0.1:45871/v1`。endpoint は設定で変更可能）
前提: [設計 v1](design-v1.md) の調査（HTML 仕様、CORS、PLaMo API、既存拡張の評価）を引き継ぐ。
関連: [サイト評価ハーネス計画](test-plan.md)
調査日: 2026-11-15 / 実機: Windows 11 + Zen 1.24.1b（Gecko 159.0.1）+ vLLM 0.33.0 + RTX 5070 Ti

---

## 0. 改訂サマリ

v1 からの変更点:

| 項目 | v1 | v2 |
|---|---|---|
| 対象ブラウザ | Chrome/Edge 中心 | **Firefox（Zen）を第一対象、Chrome も対応** |
| 表示 | 対訳デフォルト | **訳文のみ**（原文を置換し、OFF で完全復元） |
| 起動 | 手動 + サイト別 | **自動翻訳**。サイトごとに無効化 |
| DOM 戦略 | 原文を残す対訳 | **Markdown 化（URL プレースホルダ）＋ 型付きスロットのフォールバックで置換** |
| 言語判定 | `lang` + ローカル | **`lang` を信用しない**。ページ/ブロック単位で判定。Gemini Decision 1 を第二意見に使う |
| 領域判定 | ヒューリスティック + 手動 | **構造認識 + スクリーンショット + Gemini Decision 1** + 手動ピッカー |
| Gemini 対象 | 全領域 | **判断が必要な領域だけ**。記事の途中の段落は送らない |
| 学習 | なし | **構造プロファイルを類似ページ間で共有**。Gemini は初回/不確実時だけ |
| 追加 API | なし | **Gemini Decisions API（`gemini-decision-1`）** |
| 孤立語 | 文脈なし | **ページ文脈（タイトル・見出し・周辺文）を PLaMo の `context` に渡す** |
| Gemini 接続 | プロキシ前提 | **API キーを拡張に保存して background から直接呼ぶ**（プロキシは上級者向け） |
| プロトコル | PLaMo 固定 | **`plamo`（PFML3）と `openai-chat` の 2 モード**。モデル名は設定 |
| 開発用機能 | 混在 | **モック・テストフック・20 req/min は dev ビルドだけ**。本番から外す |
| 評価 | 手動 | **サイトコーパス + before/after スクリーンショット + HTML レポート** |

---

## 1. 確定した要件

### 1.1 機能要件

1. **Firefox（Zen）と Chrome で動く**。Firefox は MV3 のイベントページ、
   Chrome は MV3 の Service Worker として実装する（WXT で両ターゲットをビルド）。
2. ページを開いたら**自動で翻訳**する。ただし**サイトごとに無効化**できる。
   ターゲット言語は設定で変更できる（既定は日本語）。
3. 表示は**訳文のみ**。原文は DOM から消すが、OFF で**完全に復元**できる。
4. **インライン要素（リンク・強調・コード・画像・改行）を壊さない**。
5. **日本語ページを不必要に翻訳しない**。`lang` 属性が誤っていても、本文が日本語なら翻訳しない。
6. **翻訳する領域/しない領域**を正しく判定する。タブメニュー、ファイル名、コード、メタデータは翻訳しない。
7. **孤立した単語・短いラベル**は、ページ文脈を渡して訳す。文脈がない場合は無理に訳さない。
8. **手動で DOM 領域を選択**し、「翻訳する/しない」を指定できる。
9. **同じような構造のページ**では、領域定義を共有し、Gemini を毎回呼ばない。
10. Gemini は**言語検出**と**画像による領域判定**に使う。使わなくてもローカル判定で動く。

### 1.2 非機能要件

- ページ内容は、設定した PLaMo サーバ（既定 127.0.0.1）と、Gemini を有効にした場合のみ Google に送る。
- Gemini のスクリーンショット送信は**オプトイン**。機密入力は黒塗りする。
- Gemini の呼び出しは**初回の構造学習と不確実な領域だけ**。
  拡張側の日次トークン上限・レート制限は設けない。API 側の 429 に従ってバックオフする。
- 翻訳に失敗してもページを壊さない。原文を残してエラー表示する。
- ページの DOM を必要以上に変更しない。`innerHTML` は使わない。
- Firefox のイベントページ/Chrome の Service Worker の両方で動く。

---

## 2. 全体アーキテクチャ

```text
┌──────────────────────── ページ（content script, isolated world） ────────────────────────┐
│                                                                                         │
│  Gate: サイト無効 / meta notranslate / html translate=no / ページ言語 == target        │
│    │                                                                                    │
│    ▼                                                                                    │
│  Structure: スケルトン抽出 → Profile 照合（完全一致/類似）                              │
│    │                          │                                                         │
│    │ hit                      │ miss                                                    │
│    ▼                          ▼                                                         │
│  Region Rules 適用          Heuristic Region Tree → 不確実領域だけ Gemini へ             │
│    │                          │                                                         │
│    └──────────────┬───────────┘                                                         │
│                   ▼                                                                     │
│  Unit Scanner: translate 領域内のブロック/インラインランを抽出                           │
│                   │                                                                     │
│                   ▼                                                                     │
│  Inline Codec: Markdown + URL プレースホルダ / スロットフォールバック                    │
│                   │                                                                     │
│                   ▼                                                                     │
│  Queue → Port → background                                                              │
│                   │                                                                     │
│                   ▼                                                                     │
│  Rebuild: 訳文 + 元のインライン要素を再配置 → 原文を WeakMap に保存                      │
│                   │                                                                     │
│                   ▼                                                                     │
│  Observer: Mutation/Intersection/SPA → 差分だけ再処理                                    │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                      │ runtime.connect
┌──────────────────────── background（Firefox: event page / Chrome: SW） ──────────────────┐
│  Settings / Site Rules / Profiles（IndexedDB）                                           │
│  PLaMo Client: PFML3 + /v1/completions + 検証 + キャッシュ                                │
│  Gemini Client: /v1beta/decisions（言語判定・領域判定）                                   │
│  Screenshot Service: tabs.captureVisibleTab → content で注釈 → Gemini                    │
│  Scheduler: グローバル並列 2、優先度、タイムアウト、リトライ                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 なぜ background に通信を集約するか

- コンテンツスクリプトの fetch はページ origin 扱いで CORS の制約を受ける（vLLM は ACAO を返さない）。
- Chrome の Local Network Access は、必要な host permission を持つ拡張の拡張ページ/SW からの通信を対象外としている。
- Firefox の背景ページは host permission があれば cross-origin fetch できる。
- スクリーンショットの取得は `tabs.captureVisibleTab`（拡張 API）なので、どのみち background が必要。
- **プロファイルの保存・照合は background** が行う。content script は `skeletonHash` と特徴量を送り、
  適用する `RegionRule[]` を受け取る。content script から拡張の IndexedDB は直接触れないため。
- 言語検出（CLD3）と Gemini 呼び出しも background に集約する。

---

## 3. 訳文のみ DOM 変換（インライン保持）

### 3.1 単位は「ブロック」ではなく「インラインラン」

訳文のみにすると、原文を残せない。テキストノードを個別に置換すると、次のような文が壊れる。

```html
<p>This is <strong>important</strong> text with a <a href="/x">link</a>.</p>
```

- テキストノード単位: `"This is "`, `"important"`, `" text with a "`, `"link"`, `"."` を別々に訳す → 文脈が消える。
- `innerHTML` 再構築: モデルがタグを壊す（v1 §1.5 で実測）。イベントリスナーも消える。
- 要素ごと置換: `<strong>` や `<a>` の DOM ノードが消え、サイト JS の参照が切れる。

そこで、**ブロック内の連続するインライン領域（inline run）を 1 単位**とし、
インライン要素を **Markdown**（またはフォールバックの型付きスロット）に変換して PLaMo に渡す。

```text
原文:
  This is <strong>important</strong> text with a <a href="/x">link</a>.

テンプレート:
  This is **important** text with a [link](__PLAMO_A0__).

訳文（例）:
  これは[リンク](__PLAMO_A0__)付きの**重要な**テキストです。
```

- モデルは Markdown の構文を保持したまま、中のテキストを訳す。
- 訳文内のリンク/画像は**プレースホルダ ID** で対応付ける。語順が変わっても壊れない。
- `<strong>` / `<a>` の DOM ノードは**元のオブジェクトを再利用**する。href もイベントリスナーも維持される。
- Markdown で表せない要素は、§3.2 の型付きスロットにフォールバックする。

**インラインランの切り方**

- 親要素の子ノードを順に見て、テキスト/インライン要素が連続する区間を 1 ランとする。
- ブロックレベル要素（`display: block` / `list-item` / `table-cell` / `flex` / `grid` など）が現れたらランを切る。
- 親がインライン要素だけなら、親の全子ノードが 1 ラン。
- `<div>Text<div>block</div>More text</div>` のように混在する場合は、`Text` と `More text` がそれぞれ別ラン。
- ランは親の子ノードの連続区間なので、先頭に `<!--plamo:unit:id-->` のアンカーを置けば、
  ブロック構造を変えずに訳文を挿入・復元できる。
- `display: flex` / `grid` のコンテナ直下のテキストノードは、原則翻訳しない。
  訳文を挿入すると新しい flex/grid アイテムが増え、レイアウトが壊れるため。
  必要な場合は `labels_only` でボタン/ラベルの要素単位に訳す。
- `display: contents` の要素は通過し、その子を同じランの一部として扱う。

### 3.1.1 Markdown コーデック（第一候補）

インライン要素は **Markdown に変換して翻訳させる**のが第一候補。PLaMo 0.8B で実測した。

```text
inline run
  → Markdown serializer（URL/src は __PLAMO_AN__ / __PLAMO_IN__ に退避）
  → PLaMo（または OpenAI 互換）
  → Markdown parser
  → validate（プレースホルダ・要素数・型・ネスト）
  → 元の DOM 要素にマッピングして再構築
  → 失敗時は型付きスロット → テキスト単位 → 原文
```

| 入力 | 出力 | 判定 |
|---|---|---|
| `This is **important** text with a [link](https://example.com).` | `これは[リンク](https://example.com)付きの**重要な**テキストです。` | ○ |
| ``Use `npm install` to install the **package**.`` | `` `npm install` を使用して **パッケージ** をインストールしてください。`` | ○ |
| `**注意**: [詳細はこちら](https://example.com/news)` | `**注意**: [詳細はこちら](https://example.com/news)` | ○ |
| `**bold and *italic* text**` | `**太字および*斜体*テキスト**` | ○ |
| `![A red car](https://example.com/car.png)` | `![赤い車](https://example.com/car.png)` | ○（alt は翻訳、src は保持） |
| `[link](https://example.com/a_(b))` | `[link](https://example.com/a_(b))` | ○（括弧付き URL） |
| `Read [A](__PLAMO_A0__) and [B](__PLAMO_A1__) before [C](__PLAMO_A2__).` | `[C](__PLAMO_A2__)の前に[A](__PLAMO_A0__)と[B](__PLAMO_A1__)を読んでください。` | ○（語順が変わっても ID で対応） |
| `` `a ` b` `` | パース不能 | ✗ → 型付きスロットへ |
| `<span class="hl">highlighted</span>` | 保持されることもあるが不安定 | △ → 型付きスロットへ |

**Markdown 化の対応表**

| DOM | Markdown | 備考 |
|---|---|---|
| `strong` / `b` | `**...**` | 要素は再利用 |
| `em` / `i` | `*...*` | 要素は再利用 |
| `code` | `` `...` `` | バッククォートを含む場合はスロット |
| `del` / `s` | `~~...~~` | 要素は再利用 |
| `a` | `[text](__PLAMO_AN__)` | URL はプレースホルダ。href は元から復元 |
| `img` | `![alt](__PLAMO_IN__)` | alt は翻訳、src は元から復元 |
| `br` | ハードブレーク（行末 2 スペース + 改行） | 位置で対応 |
| `span` / `abbr` / `time` / `mark` / カスタム要素 | `【n】...【/n】` または `【n】` | 型付きスロット |

**プレースホルダ**

- `__PLAMO_AN__` = `<a>` の URL（href）
- `__PLAMO_IN__` = `<img>` の src
- `【n】` = Markdown で表せないインライン要素（型付きスロット）
- プレースホルダは**ASCII**にする。`⟦aN⟧` のような非 ASCII は markdown-it の URL 正規化で
  percent-encode される可能性がある。`__PLAMO_A0__` は実測で保持された。
- プレースホルダ ID → 元の要素・属性の対応表を保持する。
- **URL / src はモデルの出力から取らない**。必ず元の対応表から復元する。
  モデルが URL を書き換えても、ページには元の URL が入る。
- `a` の `title` は Markdown に含めず、元の属性を保持する。翻訳が必要なら別パス。

**パースと再構築**

1. 原文のテキストを Markdown 特殊文字（`\ * _ [ ] ` ~`）からバックスラッシュでエスケープする。
   実測では `\*literal\*` がそのまま保持された。
2. `markdown-it`（`html:false`, `linkify:false`, `typographer:false`）で AST にパースする。
3. 検証:
   - `__PLAMO_AN__` / `__PLAMO_IN__` がすべて 1 回ずつ存在する。
   - `a` / `img` の数が元と一致する。
   - `strong` / `em` / `code` / `del` の数と種類が元と一致する。
   - 生の HTML が混入していない。
4. マッピング:
   - `link` → プレースホルダ ID で元の `<a>` を特定。子を再構築。href は元の値。
   - `image` → プレースホルダ ID で元の `<img>` を特定。alt は訳文、src は元の値。
   - `strong` / `em` / `code` / `del` → 同種の元要素を順番に割り当てる。
   - `br` → 元の `<br>` を順番に割り当てる。
   - `text` → 新しいテキストノード。
5. 要素は**元の DOM ノードを再利用**する。href・イベントリスナー・属性は維持される。
6. 検証に失敗したら、**型付きスロット方式**（§3.2）にフォールバックする。
   それも失敗したらテキストセグメント単位、最後は原文のまま。

**なぜ raw HTML ではなく Markdown か**

- HTML はタグ属性の破損（`<span class>` が `<a>` に化ける）が実測で起きた。
- Markdown は書式の意味が明確で、モデルが構文を保持しやすい。
- リンク URL はプレースホルダで保護できる。
- 人間がデバッグしやすい。

**注意**

- Markdown は `span` のクラス、`abbr` の title、`time` の datetime、`ruby` などを表現できない。
  これらは型付きスロットに落とす。
- `code` の中にバッククォートがある場合は Markdown コードスパンが壊れる。スロットにする。
- 原文に Markdown 特殊文字が多い場合は、エスケープの取りこぼしを避けるためスロット方式を選ぶ。
- 画像の alt は翻訳するが、装飾画像・ロゴは領域判定で skip にする。

### 3.2 スロットの種類（Markdown のフォールバック）

以下は、Markdown で表現できない要素・Markdown の検証に失敗した場合のフォールバック。

| 種類 | 例 | テンプレート | 再構築 |
|---|---|---|---|
| translatable inline | `a`, `strong`, `em`, `b`, `i`, `u`, `s`, `mark`, `small`, `sub`, `sup`, `abbr`, `cite`, `q`, `time`, `span` | `【n】…【/n】` | 要素を再利用し、中身を訳文で再構築 |
| protected inline | `code`, `kbd`, `samp`, `var`, `img`, `br`, `wbr`, `svg`, `math`, `ruby`, `rt`, `rp`, `input`, `button`（UI 扱い） | `【n】`（閉じなし） | 要素をそのまま移動。中身は変更しない |
| テキスト | — | そのまま | 新しいテキストノードを作る |

- `button` は領域判定が `labels_only` のときだけ、テキストノードを直接翻訳する（スロットにしない）。
- `code` の中身は翻訳しない。文中の `<code>npm install</code>` は保護スロットとして残す。
- `br` は保護スロット。モデルが移動しても、その位置に `<br>` を置く。
- `img` の `alt` は別パスで翻訳する（領域が translate のとき）。

### 3.3 テンプレート生成

```ts
type Slot = {
  id: number
  kind: 'translatable' | 'protected'
  element: Element
  parent: number | null       // 元のネスト親スロット
}

type Markers = { open: string; close: string }
type BuildContext = { nextId: number; slots: Slot[]; markers: Markers }

function buildTemplate(nodes: Node[], ctx: BuildContext, parent: number | null = null): string {
  let text = ''
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += escapeMarkers(node.data, ctx.markers)
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue   // comment など
    const el = node as Element
    const id = ctx.nextId++
    const { open, close } = ctx.markers
    if (isProtectedInline(el)) {
      ctx.slots.push({ id, kind: 'protected', element: el, parent })
      text += `${open}${id}${close}`
    } else if (isTranslatableInline(el) && hasText(el)) {
      ctx.slots.push({ id, kind: 'translatable', element: el, parent })
      const inner = buildTemplate(Array.from(el.childNodes), ctx, id)
      text += `${open}${id}${close}${inner}${open}/${id}${close}`
    } else {
      ctx.slots.push({ id, kind: 'protected', element: el, parent })
      text += `${open}${id}${close}`
    }
  }
  return text
}

// 使い方
const markers = chooseMarkers(runNodes.map(n => n.textContent).join(''))
const ctx: BuildContext = { nextId: 0, slots: [], markers }
const template = buildTemplate(runNodes, ctx)
```

- `nextId` は**ユニット全体で共有**する。ネストした要素でも ID が衝突しない。
- `chooseMarkers` は `【】` → `{{}}` → `[[ ]]` の順に、本文に含まれない組を選ぶ。
  どの候補も本文に含まれる場合は、`【P7A-0】` のような短い接頭辞付きマーカーを使う。
- `escapeMarkers` は選択したマーカーと `<|plamo:` を無害化する。
- 1 リクエストの上限: **24 スロット / 1200 文字**。超える場合はユニットを分割するか、フォールバック（§3.6）。

実際の PFML3 は、`input` にこのテンプレートを入れ、`context` と `glossary` を付け足す:

```text
<|plamo:tag|>dataset<|plamo:msg|>translation
<|plamo:tag|>context<|plamo:msg|>{ページ文脈}
<|plamo:tag|>input<|plamo:msg|>This is 【0】important【/0】 text with a 【1】link【/1】.
<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>
```

### 3.4 再構築

```ts
type InlineRun = {
  parent: Element
  anchor: Comment
  nodes: Node[]                 // 元の連続ノード（detach して保持）
  slots: Slot[]
  snapshot: Snapshot
  translatedNodes: Node[]       // 挿入した訳文ノード
  markers: { open: string; close: string }
}

type Snapshot = {
  children: Map<Element, Node[]> // 各要素の元の子ノード
  text: Map<Text, string>        // 各テキストの元データ
}

type Part =
  | { type: 'text'; text: string }
  | { type: 'slot'; id: number; children: Part[] }

function snapshot(nodes: Node[], snap: Snapshot): void {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      snap.text.set(node as Text, (node as Text).data)
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      snap.children.set(node as Element, Array.from(node.childNodes))
      snapshot(Array.from(node.childNodes), snap)
    }
  }
}

function restoreTree(nodes: Node[], snap: Snapshot): void {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text
      if (snap.text.has(text)) text.data = snap.text.get(text)!
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      const children = snap.children.get(el)
      if (children) el.replaceChildren(...children)
      restoreTree(Array.from(el.childNodes), snap)
    }
  }
}

function materialize(parts: Part[], slots: Slot[]): Node[] {
  const out: Node[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      out.push(document.createTextNode(part.text))
      continue
    }
    const slot = slots[part.id]
    if (slot.kind === 'protected') {
      out.push(slot.element)                     // 元のノードをそのまま移動
    } else {
      const children = materialize(part.children, slots)
      slot.element.replaceChildren(...children)  // 元の子は snapshot に保存済み
      out.push(slot.element)
    }
  }
  return out
}

function rebuild(run: InlineRun, translated: string): void {
  snapshot(run.nodes, run.snapshot)
  const tree = parseTemplate(translated, run.markers) // text と slot(id, children) の木
  validate(tree, run.slots)                            // 全 ID が 1 回ずつ、nesting 正しい

  // 元ノードを DOM から外す。要素は materialize で再利用する。
  run.nodes.forEach(node => (node as ChildNode).remove())

  try {
    const nodes = materialize(tree, run.slots)
    run.translatedNodes = nodes
    run.anchor.after(...nodes)                         // アンカーの後ろに挿入
  } catch (error) {
    restore(run)                                       // 失敗したら原文に戻す
    throw error
  }
}

function restore(run: InlineRun): void {
  run.translatedNodes.forEach(node => (node as ChildNode).remove())
  restoreTree(run.nodes, run.snapshot)
  run.anchor.after(...run.nodes)
  restoreAttributes(run)
}
```

- `run` は親要素の子ノードの連続区間。先頭に `<!--plamo:unit:id-->` のアンカーを置く。
- **スナップショットは DOM を触る前**に取る。翻訳に失敗したら、`run.nodes` を detach する前に何もしない。
- `materialize` は translatable slot の要素を**再利用**する。`replaceChildren` で中身だけ変える。
- 元の要素に付いたイベントリスナー・カスタムプロパティは維持される。
- 元の子ノードは `Snapshot` に保持し、`restore` で再帰的に戻す。
- `translatedNodes` には、再利用した要素と新しいテキストノードが混在する。
  `restore` でそれらを remove してから、元ノードをアンカー位置に戻す。
- 英語・フランス語などスペース区切り言語では、`materialize` の後に
  隣接するテキスト/スロット境界の空白を補正する（`normalizeSpacing`）。
  日本語・中国語では空白を入れない。

### 3.5 スロット方式の実測（フォールバック）

PLaMo 0.8B で確認した結果:

| マーカー | 結果 |
|---|---|
| `⟦0⟧…⟦/0⟧` | 保持されるが、`documentation` / `package` などが英字のまま残ることがある |
| `[[0]]…[[/0]]` | 保持されるが、短い英単語が訳されないことがある |
| `{{0}}…{{/0}}` | 保持され、`クイック` / `キツネ` / `レイジー` と訳された |
| `【0】…【/0】` | 保持され、内容も訳された。**スロットのフォールバックで第一候補** |
| PUA 文字 `\uE000` | トークナイズで壊れた |
| `<x0>…</x0>` | 保持されるが、短い語が英字のまま残ることがある |

- 10 スロットの長文では **1 つ落ちる**ことがあった。→ 必ず検証し、失敗時はフォールバックする。
- スロットの順序は入れ替わる（日本語の語順）。→ ID で対応付ける。
- `【0】` は自己終了（protected）でも保持された。
- 日本語→英語では、隣接スロットの間に空白が入らないことがある。→ 英語などスペース区切り言語では再構築時に境界の空白を補正する。

### 3.6 検証とフォールバック

`parseTemplate` は次を検証する。

1. すべての `【n】` に閉じがある（translatable）、または閉じがない（protected）。
2. 同じ ID が 2 回以上開かない。
3. 交差（`【0】【1】【/0】【/1】`）がない。
4. 元テンプレートの全 ID がちょうど 1 回現れる。
5. 未知の ID がない。
6. translatable slot の訳文が空でない（元のテキストが非空のとき）。
   `【0】【/0】` のように中身が消えた場合は失敗とする。
7. protected slot に子がない（`【0】…【/0】` になっていたら失敗）。
8. **スロットのネスト親が元と同じ**。`【0】` の外にあった `【1】` が内側に移動していたら失敗。
   これを守らないと、`p > a` のような直接子セレクタが壊れる。

失敗時の順序:

1. **別マーカーで 1 回だけ再試行**（`【】` → `{{}}` → `[[ ]]`）。
2. **テキストセグメント単位の翻訳**にフォールバックする。
   - インライン要素は動かさず、各テキストノード（連続するテキスト）を個別に翻訳する。
   - 文脈は `context` に渡す。語順は不自然になるが、構造は壊れない。
3. それでも失敗したら、そのユニットは**原文のまま**にする。ページ全体は止めない。

フォールバックしたユニットは `partial` として記録し、デバッグ UI で確認できる。

### 3.7 復元

- 復元は `InlineRun.snapshot` と `InlineRun.nodes` で行う（§3.4）。
- 翻訳前に `snapshot(run.nodes)` で全要素の子ノードとテキストの `data` を保存する。
- `lang` / `dir` を変更した場合は、`Map<Element, {lang, dir}>` に元値を保存する。
- OFF / サイト無効 / 手動 skip で、訳文ノードを remove し、`restoreTree` で子ノードを戻し、
  元ノードをアンカー位置に再挿入する。
- サイトが再レンダリングして要素が切断された場合は、`isConnected` を確認して復元を諦める
  （ページ側が新しい DOM を持っている）。

### 3.8 `lang` / `dir` の扱い

- 翻訳したユニットの要素に `lang="{target}"` を設定する。元の `lang` は保存し、復元時に戻す。
- RTL 言語（`ar`, `he`, `fa`, `ur`）なら `dir="auto"` を設定する。
- ページ全体の `lang` は変えない。
- これは「訳文の読み上げ言語」を正しくするため。サイト CSS の `:lang()` が変わるリスクはあるが、
  原文を残さない訳文のみモードでは、原文の言語のままにしておく方が不正確。
- **`lang` の変更は既定 ON**。サイト CSS が `:lang(en)` でレイアウトを変える場合に備え、
  設定で OFF にできる。
- **レンジユニット**（ブロック内の一部の連続ノードだけを訳す場合）は、親ブロックに未翻訳の兄弟が残る。
  その場合は親の `lang` を変えず、訳文ノードを含む最も近い要素にだけ `lang` を付けるか、
  `lang` の変更を諦める。誤った `lang` を全体に付けるより安全。

### 3.9 サイト JS / フレームワークとの相性

- テキストノードの `data` を変えるだけでも、サイト JS が `textContent` を読むと翻訳後の文字列を見る。
  これは訳文のみモードの本質的なトレードオフ。OFF で戻せることを保証する。
- インライン要素の DOM ノードは**再利用**する。`replaceChildren` で中身だけ入れ替えるため、
  要素に付いたイベントリスナー・カスタムプロパティは維持される。
- ただし要素の**順序**は訳文の語順に変わる。サイト JS が「子要素の順序」に依存している場合は壊れうる。
  - その場合は領域を `skip` にするか、サイトプロファイルで `translate` を外す。
  - デバッグ UI に「この要素を原文に戻す」を用意する。
- React/Vue が再レンダリングすると、翻訳した DOM は元に戻る。MutationObserver が検知して再翻訳する。
  - 再翻訳ループを避けるため、自分が挿入したノードには `data-plamo-own` を付ける。
  - サイト側の再レンダリングと競合する場合は、その領域を `skip` にする。

### 3.10 テキスト抽出と短文ポリシー

- ユニットのテキストは、インラインラン内のテキストノードを連結して作る。
- 空白は正規化する。`<br>` は保護スロットとして残す。
- 次の場合は翻訳しない:
  - 2 文字未満。
  - URL / メール / ファイルパス / UUID / バージョン / 16 進 / `{{var}}` が大半。
  - コード比率が高い。
  - 数字・記号・絵文字だけ。
- 短い語（2〜5 文字）は、`translate` 領域内で、かつ文脈（見出し・周辺文）がある場合だけ翻訳する。
  タブ・メニュー・ファイル名は領域判定で `skip` になるので、ここには来ない。
- 文脈がない孤立語は、無理に訳さず原文のままにする（誤訳より安全）。

### 3.11 属性の翻訳

本文だけでなく、次の属性も翻訳する（領域が `translate` のとき）。

| 属性 | 既定 | 備考 |
|---|---|---|
| `title` | ON | ツールチップ。短い場合は文脈を渡す |
| `alt`（img/area/input） | ON | 画像の代替テキスト。アクセシビリティ |
| `placeholder` | ON | 入力欄のヒント。`value` は触らない |
| `aria-label` / `aria-description` | OFF | サイト JS がセレクタ/テストに使う。設定で ON |
| `value`（button/reset） | OFF | フォーム状態を壊さない |
| `download` / `srcdoc` / `style` | OFF | 再帰処理・サイト CSS を壊す |

- 属性の翻訳はスロットを使わない。プレーンテキストとして PLaMo に渡す。
- 元の値を `WeakMap<Element, Map<string,string>>` に保存し、OFF で戻す。
- 属性値が URL・ファイル名・コードの場合はスキップする。

### 3.12 文脈（context）— 孤立語を訳さないための中心機構

PLaMo は `context` 要素を受け取れる。これを**ページ文脈**として渡す。

```text
context =
  title
  + " / " + meta description（あれば）
  + " / " + 最も近い h1
  + " / " + 最も近い h2/h3
  + （ユニットが 80 文字未満なら）前後の兄弟ブロックのテキスト 200 文字
```

- 300 文字程度に切り詰める。HTML は入れず、プレーンテキストにする。
- ユニットが短い（< 80 文字）ほど、周辺文を厚めに入れる。
- ユニットが長い場合は、タイトル + 見出しだけで十分。
- `context` は翻訳キャッシュのキーに含める。同じ文でも文脈が違えば別訳。
- ターゲットが `ja` のときは `form` を指定する（既定 `polite`、技術文書は `plain` も選べる）。
- 文脈が空で、ユニットが 5 文字未満の場合は翻訳しない（誤訳より安全）。

実測（PLaMo 0.8B）:

| 入力 | context | 訳 |
|---|---|---|
| `bank` | `They sat on the bank of the river...` | `岸辺` |
| `bank` | `I need to deposit money at the bank.` | `銀行` |
| `Home` | `Website navigation menu.` | `ホーム` |

この機構により、タブや見出しの短い語でも、ページの話題に合った訳になる。
用語集（`glossary`）も併用する。

### 3.13 用語集

- グローバル用語集とサイト別用語集を持つ。
- ユニットに出現する用語だけを最大 20 件、PFML3 の `glossary` 要素として渡す。
- PLaMo の書式:
  `<|plamo:tag|>glossary<|plamo:index|>source<|plamo:item|>target...`
- 用語集は翻訳キャッシュのキーに含める。
- ブランド名・製品名・ファイル名は、ユーザーが `skip` 用語として登録できる。
- 用語の自動抽出は v1 では行わない（コストと誤りのため）。手動 + インポート/エクスポート。

---

## 4. 言語判定（`lang` を信じない）

### 4.1 問題

- `<html lang="en">` でも本文が日本語、というページがある。
- 日本語ページの一部に `<span lang="en">` が付いているが、中身は日本語、ということがある。
- Firefox の内蔵翻訳は `[lang]:not([lang|="docLang"])` で除外するため、正しい言語の領域を取りこぼす。
- 逆に、`lang` を信じてページ全体を翻訳すると、母語のページを不必要に翻訳する。

### 4.2 方針

**`lang` はヒントにだけ使い、判定はテキストから行う。**

1. ページ全体:
   - 本文サンプル（`main`/`article` を優先、最大 2000 文字）を取る。
   - `browser.i18n.detectLanguage`（CLD3）で検出する。API の可用性を考え、実行は background で行う。
   - 検出結果が信頼でき、トップ言語がターゲットなら**ページ全体を翻訳しない**。
     母語ページ内の外国語ブロックを訳したい場合は、手動ピッカーでその領域を
     `translate` にする（設定項目は増やさない）。
   - ターゲットが日本語の場合、サンプルにひらがな/カタカナが一定数（目安 5%）含まれていれば、
     CLD3 の結果より優先して「日本語」と判定する。技術用語の多い英語ページを誤判定しないため。
   - `lang` と検出結果が食い違う場合は、検出結果を優先する。
   - 検出が不確実、または `lang` と食い違う場合は Gemini Decision 1 に聞く（§4.3）。
2. ブロック単位:
   - 文字種で判定する。
     - ひらがな/カタカナ → 日本語
     - ハングル → 韓国語
     - 漢字のみ → ページ言語が `ja`/`zh` ならそれ、不明なら CLD3
     - キリル/アラビア/ヘブライ/タイ/デーヴァナーガリー → 各言語
     - ラテン文字 → 長さ 40 文字以上なら CLD3、短ければページ言語
   - 判定結果がターゲット言語なら**そのブロックを翻訳しない**。
   - ページ言語と異なるブロック（引用・外国語）は、設定に応じて翻訳する/しない。
3. `lang` 属性:
   - `el.lang` は「ヒント」として使う。判定結果と一致すれば採用、しなければ判定結果を優先。
   - `lang` がターゲットでも、テキストが別言語なら翻訳する。
   - `lang` が別言語でも、テキストがターゲットなら翻訳しない。

### 4.3 Gemini Decision 1 による言語判定

ページ全体の言語が不確実なときだけ呼ぶ。

```json
{
  "model": "gemini-decision-1",
  "input": [
    { "type": "text", "text": "Title: ...\nSample:\n<本文 2000 文字>" }
  ],
  "questions": {
    "lang": {
      "type": "choice",
      "instructions": "What is the primary language of the main readable content in the sample?",
      "criteria": {
        "ja": "Japanese",
        "en": "English",
        "zh-hans": "Simplified Chinese",
        "zh-hant": "Traditional Chinese",
        "ko": "Korean",
        "...": "..."
      }
    },
    "is_target": {
      "type": "noul",
      "instructions": "Is the main readable content already written in Japanese?",
      "criteria": {
        "true_description": "The majority of sentences are natural Japanese.",
        "false_description": "The majority is another language, or the text is mostly code/names."
      }
    }
  }
}
```

- `choice` の候補は 53 言語。PLaMo の言語コードに合わせる。
- `is_target` はターゲットが日本語の場合の安全弁。`lang` の判定と食い違ったら `is_target` を優先。
- ページ本文は信頼しない。ページ内の「これは日本語です」といった記述に引きずられないよう、
  ローカルの文字種判定（かな比率）と併用する。Gemini の結果だけでページ全体を止めない。

実測（366 入力トークン）:

| サンプル | `is_target`（日本語か） | `lang` |
|---|---|---|
| 日本語の文 | 0.974 | `ja` 0.999 |
| 英語の文 | 0.032 | `en` 0.999 |
- `confidence < 0.65` またはトップ 2 の差が小さい場合は「不確実」とし、ローカル判定に戻す。
- ページ全体を翻訳しない判断は、`is_target` が 0.8 以上で確定。
- ブロック単位で迷う場合:
  - 入力に `[{"id":"b0","text":"..."}, ...]` を入れ、`b0_target` の `noul` をブロック数だけ聞く。
  - 1 リクエスト最大 20 ブロック。入力は共有、質問は独立。
  - `b0_target > 0.8` なら「日本語」とみなしてスキップ。

### 4.4 キャッシュ

- CLD3 の `zh` / `zh-Hant` は PLaMo の `zh-hans` / `zh-hant` に正規化する。
- ページ言語は**構造プロファイル**に保存する。同じ構造のページでは再判定しない。
  ただしローカル検出とプロファイルの `pageLang` が食い違った場合は、プロファイルを信用せず再判定する。
- ブロック言語は `SHA-256(text)` をキーに IndexedDB に保存（TTL 90 日）。
- `lang` と検出結果の食い違いはデバッグログに残す（本文は残さない）。

### 4.5 `lang` の出力

- 翻訳したユニットには `lang="{target}"` を付ける（§3.8）。
- ページ全体の `lang` は変えない。
- これにより、スクリーンリーダーは訳文を日本語として読む。

### 4.6 プロトコルモード（PLaMo / OpenAI 互換）

拡張はモデルサイズを固定しない。PLaMo サーバの `MODEL_ID` が 0.8B でも 2B でも、
拡張は `model` 名（既定 `plamo-3-translate`）で呼ぶだけ。
既定は 0.8B 構成のサーバ（`F:\llm_servers`）を指す。サイズを変えるときはサーバ側の
`MODEL_ID` を変え、`SERVED_MODEL_NAME` は固定のままにする。

設定:

```ts
type Protocol = 'plamo' | 'openai-chat'

type ProviderConfig = {
  protocol: Protocol
  endpoint: string        // http://127.0.0.1:45871/v1 など
  model: string           // plamo-3-translate / gpt-4.1-mini / ...
  apiKey?: string         // OpenAI 互換用。PLaMo ローカルでは不要
  timeoutMs: number
  addSpecialTokens?: boolean  // plamo モードのみ
}
```

**`plamo` モード（既定）**

- `POST {endpoint}/completions` に PFML3 を送る。
- `temperature: 0`, `stop: ["<|plamo:tag|>", "<|plamo:bos|>"]`,
  `add_special_tokens: true`（vLLM）。
- `context` / `glossary` / `form` を PFML3 の構造要素として渡す。
- 応答は `choices[0].text`。終端トークンを除去する。
- llama.cpp など BOS 自動付与サーバでは `addSpecialTokens: false`。

**`openai-chat` モード**

- `POST {endpoint}/chat/completions` に messages を送る。
- system: 「You are a translation engine. Translate the user text into {target}.
  Output only the translation. Preserve Markdown syntax and placeholders.」
- user: テンプレート文字列（Markdown / プレースホルダ入り）。
- PLaMo 固有の `stop` / `add_special_tokens` / `chat_template_kwargs` は送らない。
- `context` は system か user の先頭にテキストとして入れる（PLaMo の構造要素ではない）。
- 応答は `choices[0].message.content`。
- OpenAI 互換サーバが `response_format` をサポートする場合だけ JSON を使う。既定は plain text。

**切り替え**

- 設定画面で `protocol` を選ぶ。既定は `plamo`。
- `endpoint` の `/models` を probe し、`model` がなければエラー。
- `apiKey` は `openai-chat` のときだけ使う。PLaMo ローカルでは `EMPTY` でよい。
- テストでは両モードをモックサーバで確認する。

---

## 5. 領域判定（構造 + 画像 + Gemini）

### 5.1 構造認識

ページを「リージョン」の木として捉える。

- リージョン候補:
  - セマンティック要素: `main`, `article`, `nav`, `header`, `footer`, `aside`, `section`
  - ARIA ランドマーク: `[role=main]`, `[role=navigation]`, `[role=banner]`, `[role=contentinfo]`, `[role=complementary]`, `[role=search]`, `[role=tablist]`, `[role=menu]`
  - 構造化データ: `[itemprop=articleBody]`, `[itemscope]`
  - 上記を含むブロックコンテナ（深さ 4〜6 まで）
- 各リージョンの特徴:
  - `level`（トップレベル = 0）
  - `tag`, `role`, `id`, 安定クラス
  - バウンディングボックス（正規化）
  - `textLength`, `paragraphCount`, `sentenceCount`
  - `linkDensity`（リンクテキスト長 / 全テキスト長）
  - `codeDensity`（`code`/`pre`/等幅フォントの文字数 / 全文字数）
  - `punctuationDensity`
  - `uiLabelScore`（短いラベル・`role=tab`/`button`/`menuitem`・大文字が多い）
  - `formControlCount`
  - `fontSize`, `fontWeight`（見出し判定）
  - `position`（fixed/sticky はナビ/バナー候補）
- 初期アクション:
  - `main`/`article`/`[role=main]`/`[itemprop=articleBody]` → `translate`
  - `nav`/`header`/`footer`/`aside`/`[role=navigation]`/`[role=banner]`/`[role=contentinfo]` → `skip`
  - `pre`/`code`/`kbd`/`samp`/`var`/`[class*=highlight]`/`[class*=language-]` → `skip`
  - `[role=tablist]`/`[role=tab]`/`[role=menu]`/`[role=menubar]`/`[role=toolbar]` → `skip`
  - `input`/`select`/`textarea`/`option` → `skip`
  - `time`/`[datetime]`/`.byline`/`.author`/`.date`/`.timestamp`/`.filename`/`.file-name`/`.path` → `skip`
  - `[class*=cookie]`/`[class*=consent]`/`[class*=advert]`/`[class*=sponsor]`/`[class*=promo]` → `skip`
  - `[class*=comment]` → 保留（コメントは本文のことがある）
  - `sidebar`/`related`/`recommend` → `skip`（設定で変更可）
- コンテンツ密度:
  - `textLength >= 200 && linkDensity < 0.3 && paragraphCount >= 2` → `translate`
  - `textLength < 20 && linkDensity > 0.5` → `skip`
  - `codeDensity > 0.3` → `skip`
- 確信度の目安:
  - セマンティック要素/role で決まる: 0.9
  - クラス名 + 密度で決まる: 0.7
  - 密度だけ: 0.6
  - どれにも当てはまらない: 0.4（`descend` か Gemini へ）
- **skip 判定の安全弁**: `skip` 候補でも `textLength > 500 && linkDensity < 0.3` なら
  `descend` にして子を見る。ヘッダー/サイドバーに見えるが本文が入っているケースを救う。
- `header` でも `h1` を含み、段落が 200 文字以上あれば `descend`（記事ヘッダーの見出し・リード）。

### 5.2 リージョンアクション

| アクション | 意味 |
|---|---|
| `translate` | 配下の翻訳ユニットを翻訳する |
| `skip` | 配下を翻訳しない |
| `labels_only` | ボタン/タブ/ラベルのテキストだけ翻訳する（レイアウトを変えない） |
| `descend` | 自分は判定せず、子リージョンを判定する |

- 迷ったら `descend`。子に分けた方が安全。
- `labels_only` はユーザーが「タブも訳したい」と明示したときだけ。既定は `skip`。
- 優先順位は **manual > Gemini > heuristic > default**。
  `skip` 領域の内側に manual `translate` がある場合は、その子だけ処理する（skip で全部を切り捨てない）。

### 5.3 Gemini による画像判定

新規プロファイルでは、**判断が必要なリージョンだけ**を Gemini に送る。既存プロファイルでは送らない。

ページ中盤が記事だけで、翻訳する/しないを新しく決める必要がない場合は、その領域を**含めない**。
`main` の下の段落は親の `translate` を継承するので、質問も矩形も作らない。

**判断が必要なリージョン**:

```text
needsDecision(r):
  if r.level === 0: return true                  # トップレベルのレイアウト
  if r.manualRule: return false                  # 手動で決まっている
  if r.inheritedAction && r.confidence >= 0.85 && !r.boundary:
      return false                               # 親の translate/skip を継承
  if r.action !== r.parentAction: return true    # 親と違う
  if r.confidence < 0.85: return true            # 不確実
  if r.mixedContent: return true                 # 混在
  if r.newlyAdded: return true                   # プロファイルにない新領域
  return false
```

- `inheritedAction`: 親/プロファイルから継承した action。
- `boundary`: セマンティック/ランドマークの境界、または action が変わる境界。
- `mixedContent`: 子に block 要素が混在し、role が一様でない。
- `newlyAdded`: 既存プロファイルにルールがない新領域。
- `main` 全体が `translate` で確信できるなら、その中の `p` は送らない。
- 記事の途中に引用・コード・埋め込みがあり、親と扱いが違う場合だけ送る。
- `decisionRegions = flatten(regions).filter(needsDecision)`。
  `decisionRegions.length === 0` なら **Gemini を呼ばない**（プロファイルだけ作る）。
- 1 リクエスト最大 30 リージョン。超える場合はトップレベル/不確実を優先。
- スクリーンショットの矩形も `decisionRegions` だけに描く。記事の途中の段落には番号を振らない。
- テキストアウトラインも `decisionRegions` だけ。番号のない記事段落は画像に写るが、
  質問リストには出さない。余計な質問でモデルを混乱させない。
- 例: 記事ページが header / nav / main / footer だけで、main が一様な本文なら、
  質問は R0〜R3 の 4 問。main の中の 30 段落は送らない。

- 送るもの:
  - **ページ全体のスクリーンショット 1 枚**（領域の切り抜きではない）。
    全候補リージョンに番号付きの矩形を描く。
  - リージョンのテキストアウトライン（ID、タグ、role、box、テキスト先頭 80 文字、linkDensity など）。
- 画像は**全質問で共有**する。番号ごとに画像を切り出すと、周囲の文脈が消えて判断できない。
  `R0` の質問も `R1` の質問も、同じ全体画像を見る。
- ページが極端に長い場合だけ、**全幅の連続セグメント**（上・中・下、20% オーバーラップ）に分ける。
  領域ごとの切り抜きはしない。各セグメントにも周囲の文脈が残る。
- 質問:
  - 各リージョンに `choice` を 1 つ。
    - `translate`: 本文・見出し・キャプション・引用など、読むための内容
    - `skip`: ナビ、タブ、メニュー、ファイル名、コード、メタデータ、広告、クッキー
    - `labels_only`: UI ラベルだが訳すと便利（レイアウトは変えない）
    - `descend`: 混在。子を判定する
  - ページ言語が不確実なら `lang` の `choice` も 1 つ。

#### 「翻訳すべき番号のリスト」を出力させない

スクリーンショットに `R0`〜`R29` を描くのは有効。ただし **Gemini Decision 1 に番号リストを自由出力させない**。

基本は、**番号ごとに 1 問を並べる**こと。

```json
"questions": {
  "r0": { "type": "choice", "instructions": "Region R0 is the header ... Should it be translated?", "criteria": { ... } },
  "r1": { "type": "choice", "instructions": "Region R1 is the tab bar ... Should it be translated?", "criteria": { ... } },
  "r2": { "type": "choice", "instructions": "Region R2 is the article body ... Should it be translated?", "criteria": { ... } }
}
```

- 質問キーがそのまま領域番号になる。回答も `answers.r0`, `answers.r1`, … で返る。
- モデルは質問キーを見ないので、`instructions` に「Region R1 は…」と必ず書く。
- 画像の `R1` ラベルと、質問の `r1` を対応させる。
- これを番号分繰り返すだけ。1 リクエスト最大 1,000 問なので、30 リージョンでも余裕がある。
- 入力（画像＋アウトライン）は 1 回だけ課金される。質問を増やしても、入力の再課金はない。

- Decision 1 は生成モデルではなく、**質問ごとに型付きの回答（確率）を返す**モデル。
  自由文のリストを返させる設計にすると、存在しない番号・重複・欠落・順序のパースが必要になり、
  確率・confidence を使う利点も失う。
- 正しい形は、**リージョンごとに 1 問**（`choice` または `noul`）を投げ、
  返ってきた `answers` をコードで集計する。

```json
{
  "answers": {
    "r0": { "type": "choice", "choice": "skip", "confidence": 0.98 },
    "r1": { "type": "choice", "choice": "labels_only", "confidence": 0.72 },
    "r2": { "type": "choice", "choice": "translate", "confidence": 0.91 }
  }
}
```

```ts
const translateIds = Object.entries(answers)
  .filter(([, a]) => a.type === 'choice'
    && (a.choice === 'translate' || a.choice === 'labels_only')
    && a.confidence >= 0.65)
  .map(([id]) => id)
// → ['r1', 'r2']
```

- **二値で十分なら `noul` でもよい**。その場合は「Should region R1 be translated?」を
  番号分並べ、`noul >= 0.8` を採用する。`labels_only` / `descend` を区別したいなら `choice`。
- 番号は**画像とテキストをつなぐための識別子**。モデルは質問キーを見ないので、
  `instructions` に「Region R12 は…」と書く。
- 画像内の番号は補助。**テキストのアウトライン（ID・タグ・role・box・密度）が主**。
  小さい番号が読みにくいページでも、テキスト側で同定できる。
- どうしても「番号の集合」が欲しい場合は、上のコードで作る。モデルに書かせない。
- 1 リクエストで最大 1,000 問。30 リージョンなら 30 問。入力（画像＋アウトライン）は 1 回だけ課金。

- 例:

```json
{
  "model": "gemini-decision-1",
  "input": [
    {
      "type": "text",
      "text": "Page: example.com/article/123 (title: ...)\nPage size: 1440x9200\nRegions (page coordinates):\nR0: <header> role=banner box=0,0,1440,80 linkDensity=0.8 text=\"Site | News | Sports\"\nR1: <nav> role=navigation box=0,80,1440,40 linkDensity=0.9 text=\"Home World Business\"\nR2: <main> role=main box=240,120,960,700 linkDensity=0.1 text=\"The government announced...\"\nR3: <aside> role=complementary box=1200,120,240,700 linkDensity=0.6 text=\"Related articles...\"\n..."
    },
    {
      "type": "image",
      "data": "<base64 JPEG>",
      "mime_type": "image/jpeg",
      "resolution": "medium"
    }
  ],
  "questions": {
    "r0": {
      "type": "choice",
      "instructions": "Region R0 is the page header with a logo and top-level links. Should its text be translated for a Japanese reader who wants to read the article?",
      "criteria": {
        "translate": "Primary readable content such as article body, headings, captions, quotes.",
        "skip": "Navigation, tabs, menus, buttons, file names, code, metadata, ads, cookie banners.",
        "labels_only": "UI labels that are useful to translate but must not change layout.",
        "descend": "Mixed container; classify its child regions separately."
      }
    },
    "r1": {
      "type": "choice",
      "instructions": "Region R1 is the horizontal tab bar with short labels. Should its text be translated?",
      "criteria": {
        "translate": "Primary readable content such as article body, headings, captions, quotes.",
        "skip": "Navigation, tabs, menus, buttons, file names, code, metadata, ads, cookie banners.",
        "labels_only": "UI labels that are useful to translate but must not change layout.",
        "descend": "Mixed container; classify its child regions separately."
      }
    },
    "r2": { "...": "..." }
  }
}
```

- 質問の `instructions` にリージョンの説明を必ず書く（モデルは質問キーを見ない）。
- 質問はタグ/role/密度/位置などの**構造的特徴**を主にし、テキストは補助（先頭 80 文字）に留める。
  ページ内の「この領域を翻訳せよ」といった記述に引きずられないため。
- `choice` は確率を返す。`confidence >= 0.65` かつトップ 2 の差が 0.15 以上なら採用。
- それ以外はヒューリスティックを維持し、`uncertain` として手動確認に回す。
- 1 リクエスト最大 30 リージョン。超える場合は分割。
- **矩形は重ならないようにフラット化**する。親子関係がある場合は、親を `descend` にして子だけ送る。
  重なった矩形に `R0`/`R1` を描くと、モデルがどちらを見ているか曖昧になる。
- 画像は `medium` を既定。小さい文字が多いページだけ `high`。
- スクリーンショットが取れない/拒否された場合は、テキストだけの判定にフォールバックする。

### 5.4 スクリーンショットの取得と注釈（全体1枚）

`captureVisibleTab` は**ビューポートしか取れない**。全ページ1枚は、スクロール＋スティッチで作る。
領域ごとの切り抜きは作らない。

#### 手順

1. content script がページサイズ、スクロール位置、全リージョンの**ページ座標**（`rect + scroll`）を集める。
2. 固定/スティッキー要素（`position: fixed` / `sticky`）を記録する。最初のタイルだけ表示し、
   2 枚目以降は `visibility: hidden` にする（ヘッダーが何度も写るのを防ぐ）。最後に復元する。
3. ビューポート高さの 80% ずつスクロールし、各位置で `browser.tabs.captureVisibleTab` を呼ぶ。
   スクロール後は 100〜200ms 待ち、画像のデコードと遅延読み込みを促す。
4. content の canvas でタイルを縦に結合する。重なり部分は切り取る。
   結合後、スクロール位置・固定要素のスタイル・フォーカスを復元する。
5. 結合画像に、全リージョンの矩形と `R0`〜`Rn` ラベルを描く。
   - 座標はページ座標 × `scaleX/scaleY`。
   - ラベルは背景付きで大きく。ダウンスケールしても番号が読めるようにする。
   - パスワード・メール・クレジットカード・`[data-sensitive]` は黒塗り。
6. 画像を最大幅 1280px、最大高さ 6000px にダウンスケールする（JPEG 0.8）。
7. background が Gemini に送る。基本は画像 1 枚。長大ページだけ全幅セグメントを複数送る。
   どの場合も、全質問が同じ画像セットを見る。

#### 固定ヘッダー・クッキーバナー

- `position: fixed` / `sticky` は最初のタイルにだけ写す。2 枚目以降は非表示にする。
- クッキーバナー・チャットウィジェット・モーダルも同じ扱い。閉じない（ページを変更しない）。
- 固定要素を隠すとレイアウトが変わるページでは、重複を許容するか、その要素を最初のタイルから除外する。
  完璧な結合より、**ページを壊さない**ことを優先する。

#### 長大ページ

- 高さが 12,000px を超える場合は、**上・中・下の全幅セグメント**（20% オーバーラップ）に分ける。
  領域ごとの切り抜きはしない。各セグメントに周囲の文脈が残る。
- セグメントも 1 リクエストにまとめて送れる（`input` に複数 image）。質問は全セグメント共通。
- ダウンスケールで文字が読めなくなっても、**領域の位置・大きさ・周囲のレイアウト**は判断できる。
  細部はテキストアウトライン（タグ・role・密度・先頭 80 文字）で補う。
- 無限スクロールは途中で打ち切る（高さ上限）。下部はヒューリスティック。

#### 失敗時

- 権限・制限ページ・キャプチャ失敗 → **ビューポート全体の 1 枚**（領域切り抜きではない）にフォールバック。
- それも失敗 → テキストアウトラインだけで判定。
- キャプチャに 3 秒以上かかる → ビューポートに切り替え、翻訳を止めない。

#### プライバシー

- 全ページ画像は初回の構造学習だけ。毎ページ送らない。
- 画面外も含むため、機密ページではスクリーンショット送信を OFF にする。
- 画像は保存しない。プロファイルにはアクションだけ保存する。

### 5.5 手動選択

#### UI

- ポップアップ/ショートカットから「領域を選択」を起動。
- オーバーレイは **Shadow DOM** に置き、ページ CSS の影響を避ける。`z-index` は最大。
- ページ全体に透明なオーバーレイ（`pointer-events: none`）を置き、`document` の capture フェーズで
  `mousemove` / `click` / `keydown` を監視する。
- ホバー中の要素に枠とラベルを表示:
  - `p.article-body` / `translate` / `heuristic 0.9`
  - `nav.tabs` / `skip` / `gemini 0.95`
- クリックで選択。ツールバーを表示:
  - 「翻訳する」「翻訳しない」「ラベルのみ」「キャンセル」
  - 「同じ構造のページにも適用」チェック（既定 ON）
  - ツールバーは `pointer-events: auto` にし、クリックを `stopPropagation` する。
- `Esc` で終了。`Alt`+クリックで親要素、`Shift`+クリックで複数選択。
- ページ側のクリックハンドラを止める（capture + `preventDefault` + `stopImmediatePropagation`）。
- 選択中は自動翻訳を一時停止する。

#### 保存

- ルール:
  ```ts
  type ManualRule = {
    selector: string
    fingerprint: ElementFingerprint
    action: 'translate' | 'skip' | 'labels_only'
    scope: 'url' | 'profile'
    urlPattern?: string
    createdAt: number
  }
  ```
- `scope: 'profile'` なら構造プロファイルに保存し、類似ページに適用。**既定 ON**。
  - ただし、現在のプロファイル照合が類似度 0.82 以上・解決率 70% 以上のときだけ profile に保存する。
    弱い場合は URL スコープに落とし、UI に「このページだけに適用」と表示する。
  - 誤共有を避けるための品質ガード。
- `scope: 'url'` なら URL パターンにだけ適用。
- セレクタが一意でない場合は、フィンガープリントで候補を絞る。
  - `scope: 'profile'` は、同じフィンガープリントを持つ要素すべてに適用する（カード一覧など）。
  - `scope: 'url'` は、最初に一致した要素だけに適用する。
- 保存後、対象サブツリーだけ即時再処理する（`skip` なら復元、`translate` なら翻訳）。

#### セレクタ生成

```ts
type ElementFingerprint = {
  tag: string
  role?: string
  classes: string[]        // 安定したクラスだけ
  id?: string              // 安定した id だけ
  childCount: number
  depth: number
  box?: [number, number, number, number]  // 正規化
  textHash?: string        // 一意なウィジェット用。領域ルートには入れない
}
```

- 優先順:
  1. 安定した `id`（ランダム/hash でない、長さ 50 未満）
  2. `[data-testid]` / `[data-test]` / `[itemprop]` / `[role]`
  3. セマンティックな祖先 + `tag` + 安定クラス
  4. `:nth-of-type` は深さ 3 まで
- クラスフィルタ:
  - 除外: `css-`, `sc-`, `jsx-`, `emotion-`, `svelte-`, 8 文字以上の hex、数字が多いトークン、長さ 30 超。
  - 保持: `article`, `content`, `nav`, `tabs`, `sidebar`, `comment`, `code` など意味のある語。
- `querySelectorAll(selector).length === 1` を検証。複数なら候補を追加。
- Shadow DOM 内の要素は、**ホストまでのセレクタ + ShadowRoot 内のセレクタ**の 2 段で保存する。
  `host.shadowRoot.querySelector(inner)` で解決する。closed shadow root は対象外。
- フィンガープリント:
  - `tag`, `role`, 安定クラス, `childCount`, `depth`, 正規化 box
  - 領域ルートには `textHash` を入れない（本文が変わるため）
  - 一意なウィジェットには `textHash` を入れる

### 5.6 翻訳してほしくない/ほしいのデバッグ

- ピッカーでホバーすると、次を表示:
  - 現在のアクション
  - 判定元（manual / gemini / heuristic / default）
  - 確信度
  - スキップ理由（`nav`, `code`, `file-name`, `lang-target`, `short-text`, `slot-failed` など）
- 「翻訳する」「翻訳しない」で上書きし、プロファイルに保存。
- これにより「翻訳してほしいのにされない」「翻訳してほしくないのにされる」をその場で直せる。

| 症状 | 主な原因 | 対策 |
|---|---|---|
| タブメニューが訳される | タブが `main` 内にある / role がない | `[role=tablist]` 判定、手動 skip、プロファイル |
| ファイル名が訳される | リンク一覧やコード表 | 拡張子/パス正規表現、`code` 判定、手動 skip |
| 本文が訳されない | `lang` 不一致で除外 / 短文判定 / Shadow DOM | 言語判定をテキスト優先に、閾値調整、手動 translate |
| インライン要素が消える | スロット検証失敗 / DOM 再構築 | フォールバック、原文復元、デバッグ表示 |
| 孤立語が変な訳 | 文脈なし | `context` に周辺文、短ければスキップ |
| 同じページで毎回 Gemini | プロファイル未保存/不一致 | プロファイル保存、類似度調整、手動ルール |

---

## 6. 構造プロファイルの共有

### 6.1 目的

同じサイトの似たページ（Wikipedia の記事、GitHub の Issue、ニュース記事、ブログ）で、
領域定義を再利用する。Gemini は初回の構造学習だけ。

例:

- Wikipedia の記事 A で「本文は translate、ナビ/サイドバーは skip」を学習 →
  記事 B は同じ `/wiki/*` 構造なので、Gemini なしで同じルールを適用。
- GitHub の Issue A で「Issue 本文とコメントは translate、ファイル名とコードは skip」を学習 →
  Issue B はコメント数が違っても、タグ/role の特徴量で類似プロファイルに一致。
- タブメニューの skip ルールを `scope: 'profile'` で保存 →
  同じサイトの別ページでもタブは翻訳されない。

### 6.2 スケルトン

本文テキストを除いた DOM の骨格を作る。

```ts
type SkeletonNode = {
  tag: string
  role?: string
  id?: string            // 安定したものだけ
  classes: string[]      // 安定したクラスだけ
  children: SkeletonNode[]
}
```

- 対象: `body` から深さ 8、最大 500 要素。
- 除外: `script`, `style`, `noscript`, `template`, `svg`, `canvas`, `[aria-hidden=true]`。
- テキストは含めない。`alt`/`title` も含めない。
- 動的クラス/ID は正規化して落とす。
- シリアライズして SHA-256 → `skeletonHash`。

### 6.3 特徴ベクトル

完全一致しない類似ページのために、軽い特徴量も持つ。

- タグ頻度（正規化）
- role 頻度
- 安定クラス集合
- ランドマーク数（main/article/nav/aside/header/footer）
- 深さヒストグラム
- リンク密度/テキスト密度のバケット

類似度:

```text
score = 0.45 * cosine(tagFreq)
      + 0.20 * jaccard(roleSet)
      + 0.20 * jaccard(classSet)
      + 0.15 * landmarkMatch
```

- `score >= 0.82` を候補とする。
- 候補のルールを解決し、**70% 以上**のルールが要素に一致すれば採用。
- 一致しなければ新規プロファイルを作る。

### 6.4 プロファイル

```ts
type SiteProfile = {
  id: string
  schemaVersion: number
  origin: string
  pathPattern: string          // /wiki/*, /issues/*, /blog/*/*/*
  viewportClass: 'narrow' | 'wide'
  skeletonHash: string
  features: FeatureVector
  pageLang?: string
  regions: RegionRule[]
  createdAt: number
  updatedAt: number
  hits: number
  lastUrl: string
  needsReview?: boolean       // Gemini 失敗/低確信で作られたプロファイル
}

type RegionRule = {
  selector: string
  fingerprint: ElementFingerprint
  action: 'translate' | 'skip' | 'labels_only' | 'descend'
  source: 'manual' | 'gemini' | 'heuristic'
  confidence: number
  scope: 'profile' | 'url'
  urlPattern?: string          // scope: 'url' のときだけ
}
```

- `pathPattern` は動的セグメントを `*` に置換して作る。
  - `/wiki/Article` → `/wiki/*`
  - `/issues/123` → `/issues/*`
  - `/blog/2026/11/15/foo` → `/blog/*/*/*/*`
  - クエリは落とす。
- `viewportClass` は幅 900px 未満を `narrow`、以上を `wide`。レイアウトが変わるため。
- プロファイルは IndexedDB。設定は `browser.storage.local`。
- エクスポート/インポートは JSON。`storage.sync` は容量が小さいので任意。

### 6.5 照合フロー

```text
onPageLoad:
  { hash, features } = buildSkeleton(document)
  matched = await port.matchProfile({
      origin: location.origin, hash, features,
      viewportClass: currentWidth < 900 ? 'narrow' : 'wide',
      url: location.href,
  })
  if matched and applyRules(matched) >= 0.7:
      return matched

  // 新規/再学習
  regions = heuristicRegions()
  decisionRegions = flatten(regions).filter(needsDecision)
  if geminiEnabled and budget and decisionRegions.length:
      answers = geminiClassify(screenshot, decisionRegions)
      merge(regions, answers)
  profile = await port.saveProfile({
      origin: location.origin, hash, features,
      viewportClass: currentWidth < 900 ? 'narrow' : 'wide',
      pathPattern: toPathPattern(location.href),
      regions,
  })
  return profile
```

- 照合は background の `matchProfile` で行う。content は `skeletonHash` と特徴量を送り、
  `RegionRule[]` と `pageLang` を受け取る。
- `applyRules` はセレクタ → フィンガープリントの順で要素を解決する。
- `scope: 'url'` のルールは `urlPattern` が現在の URL に一致するときだけ適用する。
- 解決できないルールが 30% を超えたら、そのプロファイルは使わず再学習。
- 手動ルールは `source: 'manual'` として最優先。Gemini の結果で上書きしない。

### 6.6 いつ Gemini を呼ぶか

| 状況 | Gemini |
|---|---|
| プロファイル完全一致 | 呼ばない |
| 類似プロファイル（score ≥ 0.82、解決率 ≥ 70%） | 呼ばない |
| 新規構造 | **判断が必要な領域だけ**呼ぶ。記事の途中の段落は送らない |
| プロファイルがあるが新領域 | その領域が判断必要なら呼ぶ |
| ページ言語が不確実 | 言語判定だけ呼ぶ |
| 手動で領域を指定 | 呼ばない |
| ユーザーが「再学習」 | 呼ぶ |

### 6.7 プロファイルの更新

- 手動ルールを追加したら `updatedAt` を更新し、`source: 'manual'` を優先。
- ページ構造が大きく変わった（類似度 < 0.82）場合は新規プロファイル。
- `schemaVersion` が上がったら全プロファイルを無効化（移行はしない）。
- ユーザーが「このページを再学習」したら、そのプロファイルの領域を Gemini で作り直す。
- Gemini が失敗してヒューリスティックだけのプロファイルは `needsReview: true`。
  次回の類似ページで静かに再学習する。ポップアップに「要確認」を出す。

---

## 7. Gemini Decisions API クライアント

**本設計で Gemini は Decisions API のみ。生成 LLM は使わない。**
`gemini-decision-1` はテキストを生成せず、閉じた選択肢に対する確率を返すモデル。

| 用途 | API / モデル | 出力 |
|---|---|---|
| ページ/ブロックの言語判定 | Decisions / `gemini-decision-1` | `choice` / `noul` の確率 |
| 領域の translate/skip/labels_only/descend | Decisions / `gemini-decision-1` | `choice` の確率 |
| 翻訳 | PLaMo `/v1/completions`（または OpenAI 互換） | 訳文 |
| 要約・用語抽出・HTML 生成・自由文分類 | **使わない** | — |

生成 LLM を使わない理由:

- Decision は出力トークン 0、低レイテンシ、確率付きで分岐しやすい。
- 翻訳は PLaMo に閉じる。ページ本文を Google の生成モデルに渡さない。
- 領域判定は閉じた 4 択で足りる。自由文の JSON をパースする必要がない。
- コストとプライバシーの面で、送信先を「PLaMo（翻訳）」「Gemini Decisions（判定）」に限定できる。

将来 LLM を足す候補（v1 ではやらない）:

- ページ全体の文脈要約を PLaMo の `context` に渡す。
- 用語集の自動抽出。
- 自由文での構造説明やセレクタ生成。
- 翻訳の後編集・フォールバック。

いずれも別モデル・別設定・別コストになる。v1 ではタイトル/見出し/周辺文の
ローカル文脈と、手動ピッカーで足りる想定。

### 7.1 エンドポイント

```http
POST https://generativelanguage.googleapis.com/v1beta/decisions
x-goog-api-key: <API key>
Content-Type: application/json

{
  "model": "gemini-decision-1",
  "input": "...",
  "questions": { ... }
}
```

- モデル ID は `gemini-decision-1` 固定。
- CORS は拡張 origin を許可する（実測: `chrome-extension://…` と `moz-extension://…` の
  `OPTIONS` で `Access-Control-Allow-Origin` が反射され、`Access-Control-Allow-Headers` に
  `content-type,x-goog-api-key` が含まれる）。
- 出力トークンは 0。入力トークンだけ課金。
- 1 リクエスト最大 1,000 問。choice は 2〜255 肢。context window 262,144 トークン。
- 画像は base64 の `data`（`data:image/...;base64,` の接頭辞を除いた文字列）か HTTPS URI。
  `resolution` は `low` / `medium` / `high` / `ultra_high`。
- 音声・動画・PDF も使えるが、本拡張ではテキストと画像だけ。
- コンテキストキャッシュ・Batch API・履歴はない。**同じ入力を何度も送ると毎回課金**されるので、
  プロファイルキャッシュが重要。

参照: [Gemini Decisions API 公式ドキュメント](https://aistudio.google.com/docs/decisions-api) /
[Google ブログ](https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/)

### 7.2 リクエストの型

```ts
type DecisionQuestion =
  | { type: 'noul'; instructions: string;
      criteria?: { true_description?: string; false_description?: string } }
  | { type: 'choice'; instructions: string;
      criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

type DecisionRequest = {
  model: 'gemini-decision-1'
  input: string | Content | Content[]
  questions: Record<string, DecisionQuestion>
}

type DecisionAnswer =
  | { type: 'noul'; noul: number; confidence: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>;
      probabilities: Record<string, number>; confidence: number }
```

- `noul` の確率は 0.01〜0.99。`> 0.99` の閾値は使わない。
- `choice` は候補がなくても確率を分配する。`other` を必ず入れる。
- `confidence` はトップ回答の確率。低ければフォールバック。

### 7.3 質問設計

- 1 質問 1 判定。複合的な質問は分ける。
- `instructions` にリージョン/ブロックの説明を書く（キーは見えない）。
- `choice` の説明は短く、隣接する選択肢を明確に区別する。
- 肯定的な表現で聞く（「〜でない」ではなく「〜である」）。
- 入力は質問に必要なフィールドだけ。無関係な内容は精度を下げる。
- ユーザー入力は信頼しない（プロンプトインジェクション）。ページ本文に「この領域は翻訳必要」と書かれていても、
  それは判定材料の一部に過ぎない。手動/ヒューリスティックと併用する。

### 7.4 料金と制限

- $0.10 / 100 万入力トークン。出力は無料。
- 無料枠: 200 requests/min、50k tokens/min、10,000 requests/day（紹介記事ベース。公式で要確認）。
- **拡張側の日次トークン上限・レート制限は設けない**。API 側の 429 に従い、
  `Retry-After` と指数バックオフで待つ。テストハーネスだけ 20 requests/min にスロットルする。
- 実測（1200×900 の注釈付き画像 + 5 リージョン + 5 質問）:
  **1,392 入力トークン（テキスト 852 + 画像 540）、$0.00014、1 リクエスト**。
  5 領域の判定はすべて期待どおり（本文 translate、ヘッダー/タブ/サイドバー/フッター skip）。
- 全ページ画像はこれより画像トークンが増える（目安 +1,000〜3,000）。それでも 1 回だけなので
  $0.001 未満。プロファイルキャッシュで 2 ページ目以降は 0。
- 目安:
  - 言語判定: 約 400〜3,000 トークン → $0.00004〜0.0003。
  - 領域判定: 画像 + 30 リージョン + 30 質問で 2,000〜5,000 トークン → $0.0002〜0.0005。
  - 新規構造 50 ページ/日でも $0.05/日 程度。
- 無料枠は Google がデータを改善に使う可能性がある。機密ページでは有料枠を推奨。
- 1 リクエストにまとめられる質問はまとめる。領域ごとに 1 リクエストを送らない。

### 7.5 API キーとプライバシー

**採用: API キーを拡張に保存し、拡張の background から直接 Gemini を呼ぶ。**

- API キーは `browser.storage.local` の `geminiApiKey` に保存する。
  - `storage.sync` には**保存しない**（同期・端末間拡散を避ける）。
  - content script には渡さない。background の Gemini クライアントだけが読む。
  - オプション画面では `type="password"` で表示し、保存後はマスクする。
  - 「接続テスト」で小さな Decisions リクエストを 1 回投げ、結果と使用トークンを表示する。
- manifest に `https://generativelanguage.googleapis.com/*` の host permission を追加する。
- 拡張ストレージは暗号化されない。端末が侵害された場合、キーは読まれうる。
  - キーは Gemini API の利用に限定し、他の Google API 権限を付けない。
  - 漏えい時は Google AI Studio でキーを無効化・再発行する。
  - キーを console / エラーメッセージ / レポート / スクリーンショットに出さない。
  - Chrome Web Store / AMO で配布する場合、API キーを同梱しない。
    初回セットアップでユーザーが入力する。
- 上級者向けに「ローカルプロキシ経由」も残す:
  - `geminiEndpoint` を `http://127.0.0.1:8011/decisions` に変更。
  - キーはプロキシの環境変数に置き、拡張には保存しない。
  - DSH のプラグインや小さな Node/Python サービスで実装できる。
  - 直接呼びが CORS/規制で通らない場合の逃げ道。
- スクリーンショット送信はオプトイン。初回に説明を出す。
- 次の要素は黒塗りし、テキストも送らない:
  - `input[type=password]`
  - `input[type=email]`
  - `[autocomplete^=cc-]`
  - `[data-sensitive]`
- クロスオリジン iframe の中身は黒塗りできない（DOM に触れない）。
  機密性の高いページでは、スクリーンショット送信を OFF にするか Gemini を無効化する。
- URL は origin + path pattern だけ送る。クエリ・フラグメントは送らない。
- スクリーンショットは保存しない。プロファイルにはアクションだけ保存する。

### 7.6 失敗時

- 401/403: API キー無効。Gemini を無効化し、UI に表示。
- 429: `Retry-After` に従う。無ければ指数バックオフ。拡張側の上限は設けない。
- 400 safety: そのページの Gemini 判定を中止し、ヒューリスティックへ。
- ネットワークエラー: 1 回再試行。ダメならヒューリスティック。
- Gemini が落ちても翻訳は止めない。

---

## 8. Firefox / Zen / Chrome 実装

### 8.1 対象環境

- Zen 1.24.1b（Gecko 159.0.1、`C:\Program Files\Zen Browser`）。
- Zen は Firefox ベースで、AMO の拡張をインストールできる。
- 一部の Firefox API が Zen で欠けている報告がある（`webRequest.onBeforeSendHeaders` など）。
  本拡張は `webRequest` を使わない。`tabs`, `storage`, `menus`, `runtime`, `contentScripts` の範囲に留める。
- Firefox の MV3 は `background.scripts`（イベントページ）。`service_worker` はサポートされない。
  Chrome と兼用するなら `background` に `scripts` と `service_worker` の両方を書く。

### 8.2 manifest（Firefox 優先）

```json
{
  "manifest_version": 3,
  "name": "PLaMo Page Translator",
  "version": "0.1.0",
  "browser_specific_settings": {
    "gecko": {
      "id": "plamo-page-translator@local",
      "strict_min_version": "128.0"
    }
  },
  "permissions": ["storage", "menus", "activeTab"],
  "host_permissions": [
    "<all_urls>",
    "http://127.0.0.1/*",
    "https://generativelanguage.googleapis.com/*"
  ],
  "background": {
    "scripts": ["background.js"],
    "service_worker": "background.js",
    "type": "module"
  },
  "action": { "default_popup": "popup.html", "default_icon": "icon-48.png" },
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "all_frames": true,
      "match_about_blank": true,
      "match_origin_as_fallback": true,
      "run_at": "document_idle",
      "js": ["content.js"],
      "css": ["content.css"]
    }
  ],
  "commands": {
    "toggle-translation": {
      "suggested_key": { "default": "Alt+T" },
      "description": "Toggle page translation"
    },
    "pick-region": {
      "suggested_key": { "default": "Alt+Shift+P" },
      "description": "Pick a region to translate or skip"
    }
  },
  "icons": { "48": "icon-48.png", "96": "icon-96.png" }
}
```

- `captureVisibleTab` は `<all_urls>` または `activeTab` が必要。両方あるので可。
- `http://127.0.0.1/*` は**任意のローカルポート**にマッチする（match pattern にポートは含めない）。
  PLaMo のポートが 45871 → 8000 に変わっても manifest を変えなくてよい。
- `match_origin_as_fallback` は Firefox でもサポートされている（MDN）。効かない場合でも
  `match_about_blank` で about:blank / srcdoc を拾う。
- `activeTab` はユーザー操作時のみの権限。`<all_urls>` があるので実質不要だが、capture の保険。
- `tabs` パーミッションは付けない（閲覧履歴の警告を避ける）。`sender.tab` から windowId を取る。

### 8.3 背景ページのライフサイクル

- Firefox のイベントページは数秒のアイドルでアンロードされる。
  ただし**メッセージポートが開いている間はアンロードされない**（MDN）。
- content script は 1 フレーム 1 ポートを張り、ページが開いている間は接続を維持する。
- ページを閉じるとポートが切れ、背景ページはアイドルで停止する。
- 状態は `storage.local` / IndexedDB に保存する。グローバル変数に依存しない。
- Chrome の SW は 30 秒で停止する。PLaMo の 1 リクエストは 20 秒タイムアウトにし、
  応答ごとにタイマーがリセットされるようにする。長い処理は分割する。

### 8.4 スクリーンショット

- `browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 })`。
- 返る data URL はビューポート。デバイスピクセル比/ズームで画像サイズが変わるので、
  `scaleX = image.width / window.innerWidth` で正規化する。
- content script で canvas に描く（Firefox/Chrome 共通）。
- 画面外は撮れない。可視領域だけ Gemini に送る。
- 取得失敗（権限/制限ページ）はテキスト判定にフォールバック。

### 8.5 署名とインストール

- 開発: `about:debugging` → 「一時的なアドオンを読み込む」で `manifest.json` を指定。
- 常用: AMO の unlisted 署名（Mozilla アカウント）を得て `.xpi` をインストール。
- Zen の設定で署名無効化は推奨しない（更新・安全のため）。
- 検証コマンドの例:
  ```powershell
  pnpm wxt build -b firefox
  npx web-ext lint --source-dir .output/firefox-mv3
  npx web-ext run --source-dir .output/firefox-mv3 --firefox="C:\Program Files\Zen Browser\zen.exe"
  ```
- 常用なら `npx web-ext sign --channel=unlisted` で署名済み `.xpi` を作る。
- Firefox MV3 では host permission がユーザー承認制になる場合がある。
  初回セットアップで `browser.permissions.contains({ origins: ['<all_urls>'] })` を確認し、
  未許可なら「全サイトへのアクセスを許可」ボタンから `browser.permissions.request` を呼ぶ。
  自動翻訳は、許可が取れるまで動かさない。

### 8.6 Chrome 対応

- WXT で `-b firefox` と `-b chrome` をビルド。`browser` / `chrome` の API 差は WXT のラッパーで吸収。
- `background` に `scripts` と `service_worker` の両方を書く。
  Firefox は scripts（イベントページ）、Chrome は service_worker を使う。
  Chrome 121 以降は MV3 の `background.scripts` を無視する。それ以前の Chrome は
  `scripts` があると MV3 拡張をロードしないので、Chrome 用は `service_worker` だけのビルドにする。
- Chrome の Service Worker は 30 秒アイドルで停止する。PLaMo の 1 リクエストは 20 秒タイムアウト、
  応答ごとにタイマーがリセットされる。長い処理は分割する。
- content script との長命ポートで結果を push する。SW が落ちたら再接続し、未完了ユニットを再送する。
- Chrome の SW には DOM/canvas がない。**スクリーンショットの結合・注釈は content script の canvas** で行う
  （Firefox と共通）。`OffscreenCanvas` は不要。
- `chrome.tabs.captureVisibleTab` は `<all_urls>` または `activeTab` が必要。manifest は両方を持つ。
- Chrome Web Store 配布時は `<all_urls>` が審査で厳しい。`optional_host_permissions` にして
  初回にサイト単位の許可を取る。個人利用の unpacked なら `<all_urls>` でよい。
- API キーは Chrome Web Store 版に同梱しない。初回にユーザーが入力する。
- Chrome の `chrome.storage.local` / IndexedDB は SW から使える。プロファイル・キャッシュも同じ。
- Chrome のテストは Playwright + 拡張ロード（headed）で行う。Firefox/Zen は `web-ext` + 手動。
- Chrome 137+ の headless は拡張の挙動が不安定なため、テストは headed を既定にする。

---

## 9. UI / UX

### 9.1 ポップアップ

- ヘッダ: `PLaMo Page Translator` / サーバ状態 / Gemini 状態。
- 現在のページ:
  - 「翻訳中… 42/128」
  - 「このページは日本語のため翻訳していません」
  - 「プロファイル適用中（類似度 0.91）」
  - 「Gemini で構造を学習しました」
- ボタン:
  - 「翻訳を解除」/「もう一度翻訳」
  - 「このサイトで自動翻訳を無効化」
  - 「領域を選択」
  - 「このページを再学習」
- 設定へのリンク。

### 9.2 オプション

- 翻訳エンジン: `protocol`（`plamo` / `openai-chat`）、endpoint、model、API key（OpenAI 互換のみ）、
  timeout、並列度、`add_special_tokens`（plamo のみ）。
- 翻訳: ターゲット言語（変更可能。既定 日本語）、`form`（ja のみ）、短文ポリシー、
  `lang` を変更する（既定 ON）。母語ページ内の外国語ブロックは、手動ピッカーで個別に指定する。
- Gemini:
  - 有効/無効
  - API キー（既定: 拡張に保存して直接呼ぶ）
  - 上級者向け: プロキシ URL
  - 全体スクリーンショット送信の可否
  - 使用量表示（今日の呼び出し回数・トークン・概算費用。制限はしない）
  - 「接続テスト」
- サイトルール:
  - ドメインごとの自動翻訳 ON/OFF
  - プロファイル一覧（origin、pathPattern、最終使用、ルール数）
  - プロファイルの削除/エクスポート/インポート
- デバッグ:
  - スキップ理由のログ
  - スロット失敗のログ
  - Gemini リクエストのメタデータ（本文は出さない）

### 9.3 初回セットアップ

1. 全サイトへのアクセス許可（`<all_urls>`）。未許可ならここで許可を取る。
2. PLaMo サーバの接続テスト（`/v1/models`）。
3. ターゲット言語（日本語）。
4. Gemini を使うか:
   - 「使わない（ローカルのみ）」
   - 「使う（API キーを入力）」
   - 「使う（ローカルプロキシ）」
5. スクリーンショット送信の説明と同意。
6. テストページで動作確認。

### 9.4 自動翻訳の流れ

```text
page load (document_idle)
  → サイト無効? → 終了
  → meta notranslate / html translate=no? → 終了（手動なら確認）
  → ページ言語判定（プロファイル or ローカル or Gemini）
  → ターゲット言語? → 「日本語ページ」表示して終了
  → プロファイル照合
      hit → ルール適用 → 翻訳
      miss → ヒューリスティック → 不確実だけ Gemini → プロファイル保存 → 翻訳
  → バッジ更新
```

- 初回の新規構造では、Gemini 判定の間 1〜2 秒待つことがある。ステータスを表示する。
- プロファイルがあるページは待ちなしで翻訳を開始する。
- ページが重い場合は、可視領域から翻訳する。

### 9.5 サイト無効化

- ポップアップの「このサイトで自動翻訳を無効化」で `origin` 単位のルールを保存。
- 無効化中は content script がスキャンしない。バッジも出さない。
- 手動で「1 回だけ翻訳」は可能。
- サイトルールはオプションで一覧・削除できる。

### 9.6 手動選択の流れ

```text
Alt+Shift+P（または右クリックメニュー「領域を選択」）
  → オーバーレイ表示
  → ホバーで要素 + 現在の判定 + 理由を表示
  → クリックで選択
  → ツールバー: 翻訳する / 翻訳しない / ラベルのみ / キャンセル
  → 「同じ構造のページにも適用」を選ぶ
  → プロファイル更新 → 対象だけ即時再処理
```

---

## 10. データ / キャッシュ

### 10.1 IndexedDB ストア

| ストア | キー | 値 | TTL |
|---|---|---|---|
| `translations` | SHA-256(prompt + text + lang + context + glossary) | 訳文 | 30 日 |
| `langCache` | SHA-256(text) | 言語コード + confidence | 90 日 |
| `profiles` | profile id | SiteProfile | schema 変更まで |
| `geminiCache` | SHA-256(request JSON) | answers | 30 日 |
| `usage` | 日付 | calls/tokens | 400 日 |

- 翻訳キャッシュのキーには `promptRevision` を含める。プロンプトを変えたら全無効。
- `context` と `glossary` もキーに含める。同じ文でも文脈が違えば別訳。
- エラー・キャンセル・`length` はキャッシュしない。
- プロファイルは本文を含まない。セレクタとアクションだけ。
- プロファイルは origin あたり最大 50 件。超えたら最終使用が古いものから削除。
- 翻訳キャッシュは 5 万件 / 50MB を上限に、古いものから削除。
- `geminiCache` のキーは画像 base64 を含めず、テキストアウトライン + 質問 + 画像サイズで作る
  （保存量を抑えるため）。プロファイルが主キャッシュで、これは再試行用。

### 10.2 メモリ

- content script: `WeakMap<Element, UnitState>`、`Map<sourceHash, translation>`。
- background: `Map<cacheKey, Promise<string>>` で in-flight dedupe。
- ページを閉じたら content の状態は GC。background のメモリは LRU で上限。

### 10.3 プロファイルのエクスポート

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-11-15T...",
  "profiles": [ ... ]
}
```

- 共有・バックアップ用。インポート時は `schemaVersion` を検証。
- 他人のプロファイルをインポートする場合は、origin が一致するものだけ適用。

---

## 11. 処理フロー（詳細）

### 11.1 ページゲート

```ts
async function gate(tabId, frameId) {
  if (siteDisabled(location.origin)) return { action: 'stop', reason: 'site-disabled' }
  if (hasGoogleNotranslateMeta() && !force) return { action: 'stop', reason: 'meta-notranslate' }
  if (document.documentElement.translate === false && !force) return { action: 'stop', reason: 'html-no-translate' }

  const pageLang = await detectPageLanguage()
  if (pageLang === targetLang) return { action: 'stop', reason: 'already-target' }

  return { action: 'translate', pageLang }
}
```

### 11.2 プロファイル照合と領域決定

```ts
async function learnOrLoad() {
  const skeleton = buildSkeleton(document)
  const exact = findExactProfile(skeleton)
  if (exact && applyRules(exact) >= 0.7) return exact

  const similar = findSimilarProfile(skeleton)
  if (similar && applyRules(similar) >= 0.7) return similar

  const regions = buildHeuristicRegions()
  const uncertain = regions.filter(r => r.confidence < 0.7)
  if (gemini.enabled && gemini.budget.ok && uncertain.length > 0) {
    const shot = await captureAndAnnotate(uncertain)
    const answers = await gemini.classifyRegions(shot, uncertain)
    merge(regions, answers)
  }
  return saveProfile(regions, skeleton)
}
```

### 11.3 ユニット抽出

```ts
function collectUnits(region) {
  if (region.action === 'skip') return []
  if (region.action === 'labels_only') return collectLabels(region)
  // translate or descend
  const units = []
  for (const run of findInlineRuns(region.element)) {
    if (shouldTranslate(run)) units.push(run)
  }
  return units
}
```

### 11.4 翻訳と再構築

```ts
async function translateUnit(run) {
  const { text, slots } = buildTemplate(run.nodes)
  if (text.trim().length < 2) return
  const context = buildContext(run)
  const translated = await port.request({
    text, slots: slots.length, context,
    targetLang, sourceLang: run.lang ?? 'auto',
  })
  const tree = parseTemplate(translated)
  if (!validate(tree, slots)) return fallback(run, context)
  applyRebuild(run, tree, slots)
}
```

### 11.5 監視

- `MutationObserver`:
  - `childList`, `subtree`, `characterData`, `attributes`（`style`/`class`/`hidden`/`lang`）。
  - 自分が挿入したノード（`data-plamo-own`）は無視。
  - **再構築中は `disconnect()` し、完了後に `observe()` に戻す。**
    インライン要素は再利用するため `data-plamo-own` を付けられず、移動が mutation として見えるため。
  - 150〜300ms デバウンス。
- `IntersectionObserver`:
  - 可視領域 + 600px を優先。
- Shadow DOM:
  - open の `shadowRoot` を再帰的にスキャンし、root ごとに `MutationObserver` を張る。
  - closed は `chrome.dom.openOrClosedShadowRoot` が使える場合だけ。既定は対象外。
- iframe:
  - `all_frames` で各フレームが独立にスキャンする。親から cross-origin 内容は触れない。
- テストフック（`testMode` のときだけ）:
  - `document.documentElement.dataset.plamoState = 'ready' | 'translating' | 'done' | 'error'`
  - `document.documentElement.dataset.plamoStats = JSON.stringify({...})`
  - `window` の `plamo:start` イベントで翻訳開始。
  - Playwright が before/after を撮る前に、インライン要素へ一時 ID を付けるための待機点。
- SPA:
  - `navigation` API（Firefox 102+?）または `popstate` + URL ポーリング。
  - URL 変更でプロファイルを再照合。
- 非表示:
  - `checkVisibility()` で判定。`display:none` は後で再評価。

---

## 12. テスト

### 12.1 ユニット

- Markdown コーデック:
  - 強調、斜体、リンク、画像、コード、打ち消し、br、ネスト。
  - URL プレースホルダの復元（モデルが URL を書き換えても元に戻る）。
  - 複数リンクの語順入れ替え。
  - リテラル `*` / `[` / `` ` `` のエスケープ。
  - `span class` / `abbr` / `ruby` のスロットフォールバック。
  - Markdown パース失敗時のスロット → テキスト → 原文の順。
- スロットテンプレート:
  - テキストのみ、リンク、強調、コード、画像、br、ネスト。
  - マーカー衝突（本文に `【` がある）。
  - 24 スロット超。
- パース/検証:
  - 正常、閉じ忘れ、重複、交差、未知 ID、欠落。
- 再構築:
  - 要素の同一性（`a` が同じオブジェクト）。
  - href / イベントリスナーの維持。
  - 語順の入れ替え。
  - 復元。
- 言語判定:
  - `lang=en` だが日本語本文。
  - 日本語ページの英語引用。
  - 中国語簡体/繁体。
  - 短いラテン語。
- プロトコル:
  - `plamo`: PFML3、`stop`、`add_special_tokens`、context/glossary。
  - `openai-chat`: messages、target language 指示、PLaMo 固有フィールドを含まない。
- プロファイル:
  - 同一テンプレートの別ページで完全一致。
  - 動的クラス/ID を無視。
  - セレクタ失敗時のフィンガープリント。
  - 類似度 0.82 の境界。
- Gemini:
  - リクエスト JSON の形（input/ questions / image）。
  - 回答のパース、confidence 閾値。
  - 429/401/400 safety。
  - 拡張側の日次/レート上限がないこと。
  - キャッシュヒットで呼ばない。

### 12.2 DOM テスト（happy-dom / jsdom）

- fixture:
  - `article.html`: 見出し、段落、リンク、強調、コード、画像、引用。
  - `mixed.html`: 日本語ページに英語引用。
  - `nav.html`: タブ、メニュー、ファイル一覧、パンくず。
  - `code.html`: コードブロック、インラインコード。
  - `dynamic.html`: 1 秒後に段落追加、テキスト変更。
  - `spa.html`: pushState 遷移。
  - `shadow.html`: open/closed Shadow DOM。
  - `iframe.html`: same-origin/cross-origin/srcdoc。
- 検証:
  - インライン要素が壊れない。
  - タブ/ファイル名/コードが翻訳されない。
  - 日本語ブロックが翻訳されない。
  - 手動 skip/translate が効く。
  - OFF で完全復元。

### 12.3 E2E

詳細なサイトコーパス・スクリーンショット評価・レポート形式は
[サイト評価ハーネス計画](test-plan.md) に分離した。

- Chromium + Playwright + モック PLaMo + モック Gemini。
  - 拡張を persistent context で読み込む。
  - `translations` を検証。
  - Markdown fixture（強調・リンク・画像・コード・br・リテラル記号・span フォールバック）。
  - 全ページ画像に**判断が必要な領域だけ**番号が描かれる。
  - `plamo` / `openai-chat` の両モード。
  - スクリーンショット送信の有無。
  - プロファイルキャッシュ（2 ページ目で Gemini 0 回）。
- Firefox/Zen:
  - `web-ext run --firefox="C:\Program Files\Zen Browser\zen.exe"` で一時アドオン。
  - 手動スモーク: 記事ページ、タブメニュー、ファイル一覧、日本語ページ、手動ピッカー。
  - Playwright Firefox は拡張非対応のため、E2E は Chromium + 手動 Zen。

### 12.4 ライブ

- PLaMo 実サーバで 10 ページ。
- Gemini 実 API で 3 ページ（キーがある場合）。料金は 1 セント未満。
- 翻訳品質、レイアウト、速度、復元を評価。

### 12.5 パフォーマンス

- 1000 ユニットのページで:
  - スキャン < 100ms
  - 最初の訳文 < 1.5s
  - Long Task 50ms 超なし
  - メモリ < 80MB
- プロファイル照合 < 20ms。
- スクリーンショット注釈 < 100ms。

### 12.6 受け入れ条件

| 条件 | 合格基準 |
|---|---|
| インライン保持 | fixture の全リンク/強調/コード/画像/br が翻訳後も同じ要素で残る |
| 復元 | OFF で元のテキスト・子ノード・属性に完全に戻る |
| 母語ページ | `lang=en` の日本語ページが翻訳されない |
| タブ/ファイル名 | タブメニュー、ファイル一覧、コードが翻訳されない |
| 孤立語 | 文脈付きで訳され、文脈がない短文は原文のまま |
| 手動選択 | skip/translate が即時反映され、類似ページにも適用される |
| プロファイル | 2 ページ目で Gemini 呼び出し 0 回 |
| Gemini なし | ローカル判定だけで翻訳が完了する |
| Zen | 自動翻訳、サイト無効、手動ピッカー、復元が動く |
| 失敗時 | サーバ停止/Gemini 失敗でも原文が残り、ページが壊れない |

---

## 13. 実装計画

### Phase 0: スパイク（1〜2 日）

- Firefox の一時アドオンで、PLaMo に直接 `【】` スロット翻訳を投げる。
- 3 つの fixture（記事、タブ、コード）でインライン保持と復元を確認。
- Gemini はまだ繋がない。プロファイルもまだ。
- 判定: スロット方式が実用か。0.8B の訳質か。

### Phase 1: コア（3〜4 日）

- WXT + TypeScript で Firefox MV3。
- content: ゲート、スキャン、スロット、再構築、復元。
- background: PLaMo クライアント、PFML3、キュー、キャッシュ。
- ポップアップ: 翻訳 ON/OFF、サイト無効、進捗。
- ローカル言語判定。

### Phase 2: 構造と手動（3〜4 日）

- リージョンツリー、ヒューリスティック、プロファイル。
- 手動ピッカー、セレクタ生成、フィンガープリント。
- 類似ページ照合。
- デバッグ表示（スキップ理由）。

### Phase 2.5: サイト評価ハーネス（1〜2 日）

- `sites.json` とローカル fixture。
- Playwright + Chrome 拡張 + before/after スクリーンショット。
- HTML レポート。
- モック Gemini。
- 詳細: [サイト評価ハーネス計画](test-plan.md)。

### Phase 3: Gemini（3〜4 日）

- Decisions API クライアント、言語判定、領域判定。
- スクリーンショット取得・注釈・黒塗り。
- 使用量表示、失敗時フォールバック、429 バックオフ。
- プロファイル学習とキャッシュ。

### Phase 4: 仕上げ（2〜3 日）

- E2E、パフォーマンス、アクセシビリティ。
- Firefox 署名、README、初回セットアップ。
- 10 ページのライブ評価。

### 13.1 開発用機能の分離（あとで外す）

以下は**開発/テストビルドだけ**に入れ、本番ビルドからは外す。

- `mock-gemini` / `mock-plamo` は `test/` に置き、production の entrypoint から import しない。
- `testMode`、`data-plamo-state` / `data-plamo-stats`、`plamo:start` イベント、
  領域デバッグオーバーレイは `import.meta.env.DEV` / `__DEV__` で囲む。
  本番ビルドでは tree-shaking で消す。
- 20 requests/min は**テストハーネスだけ**のスロットル。本番の拡張には
  日次・分間の制限を入れない。テスト用の固定値は dev config にだけ置く。
- モック用の設定項目（`geminiEndpoint` の localhost など）は本番 UI に出さない。
- 「開発用機能を外す」ときに、リトライ・429 バックオフは残す。拡張側の上限は追加しない。
- テスト計画の [サイト評価ハーネス](test-plan.md) も dev 依存。

---

## 14. リスクと未確認

### リスク

| リスク | 影響 | 対策 |
|---|---|---|
| スロットの欠落/破損 | 文が壊れる | 検証、別マーカー再試行、テキスト単位フォールバック、fail closed |
| 訳文のみでサイト JS が壊れる | ページ機能の不具合 | 原文ノードを保存して復元、サイト無効、領域 skip |
| React/Vue の再レンダリング | 訳文が消える/競合 | MutationObserver で再翻訳、skip 設定 |
| Gemini のコスト/プライバシー | 課金・情報送信 | 初回のみ、スクリーンショット任意、黒塗り、ローカルプロキシ |
| Gemini の判定ミス | 誤った領域 | confidence 閾値、ヒューリスティック併用、手動上書き |
| プロファイルの誤共有 | 別ページで誤動作 | origin + pathPattern + 類似度、解決率、手動優先 |
| Zen の API 非互換 | 動かない機能 | webRequest を使わない、主要 API だけ、実機テスト |
| Firefox の署名 | 常用インストール | AMO unlisted、一時アドオンで開発 |
| 0.8B の訳質 | 不自然な訳 | context/glossary、2B へ切替、手動 skip |
| スクリーンショットに機密 | 情報漏洩 | 黒塗り、送信同意、撮らない選択肢 |
| 全ページ結合の破綻 | ヘッダー重複・継ぎ目・欠落 | 固定要素を 2 枚目以降非表示、20% オーバーラップ、失敗時ビューポート |
| 全ページ画像が大きい | トークン増・文字が読めない | 1280×6000 に縮小、長ければ全幅セグメント、テキストアウトライン併用 |
| `lang` 変更で CSS 崩れ | レイアウト | 設定で `lang` 変更を無効化、復元 |

### 未確認

1. Zen 1.24.1b で `tabs.captureVisibleTab` が期待どおりの画像サイズ/形式を返すか。
2. Firefox MV3 の `match_origin_as_fallback` が Zen で効くか（効かなくても `match_about_blank` で一部可）。
3. Gemini Decision 1 の日本語/多言語の言語判定精度。プロンプトと閾値の調整が必要。
4. Gemini Decision 1 が**全ページ画像**の注釈付きリージョン ID を正しく読めるか。
   ダウンスケール・長大ページの分割で調整が必要。
5. 無料枠のデータ利用条件（紹介記事ベース）。公式規約を確認。
6. Markdown の再構築が、複雑なインライン（複数リンク、`span`、`abbr`、`ruby`）で
   どこまで安定するか。URL プレースホルダの検証を含めて fixture で確認。
7. 全ページ結合の固定ヘッダー・遅延画像・継ぎ目の品質。
8. サイトごとの `lang` 変更の影響。fixture で確認。

---

## 15. 決定事項

### 決定済み

1. **Gemini は API キーを拡張に保存して直接呼ぶ**。background だけがキーを読む。
2. **スクリーンショットは全体 1 枚**。領域の切り抜きは送らない。
   判断が必要な領域だけに番号を描き、番号ごとに 1 問を並べる。
3. **拡張側の日次トークン上限・レート制限は設けない**。
   テストハーネスだけ 20 requests/min にスロットルする（本番コードには入れない）。
4. **Chrome も対応する**。Firefox は `background.scripts`、Chrome は `service_worker`。
5. **テストはサイトコーパス + before/after スクリーンショット + HTML レポート**。
6. **ターゲット言語は変更可能**。既定は日本語。
7. **`lang` は変更する**（既定 ON）。
8. **手動ルールの「同じ構造のページにも適用」は既定 ON**。
   ただし類似度 0.82 / 解決率 70% の品質ガードを満たすときだけ profile に保存。
9. **プロトコルは `plamo` / `openai-chat` の 2 モード**。既定は `plamo`。
   `model` の既定は `plamo-3-translate`。0.8B/2B はサーバ側の `MODEL_ID` で決める。
10. **インラインは Markdown 第一候補**。Markdown で表せない要素だけ型付きスロット。

### 残り

1. **開発用機能を外す時期**: モック/テストフックを dev ビルドだけに閉じ込めたうえで、
   リリース前に `__DEV__` を完全に落とすタイミング。
   設計上の未決事項はなし。実装開始可能。

---

## 付録 A: 参照 URL

**Gemini Decisions**

- 公式ドキュメント — https://aistudio.google.com/docs/decisions-api
- Google ブログ — https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/
- Gemini Decision 1 モデル — https://aistudio.google.com/docs/models/gemini-decision-1
- 料金/制限の紹介 — https://flaviocopes.pages.dev/gemini-decisions-api/

**Firefox / Zen**

- Zen 公式（拡張） — https://github.com/zen-browser/docs/blob/main/content/docs/user-manual/extensions.mdx
- Firefox `background` — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
- Firefox 背景スクリプト — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts
- `tabs.captureVisibleTab` — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab
- `content_scripts` — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts
- `i18n.detectLanguage` — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/i18n/detectLanguage

**PLaMo / HTML**

- 設計 v1（HTML 仕様、PLaMo API、既存拡張の評価） — [design-v1.md](design-v1.md)
- PLaMo モデルカード — https://huggingface.co/pfnet/plamo-3-translate-0.8b-W4A16
- WHATWG `translate` — https://html.spec.whatwg.org/multipage/dom.html#the-translate-attribute
- Google `notranslate` — https://developers.google.com/search/blog/2008/10/helping-you-break-language-barrier
