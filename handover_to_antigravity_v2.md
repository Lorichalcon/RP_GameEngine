# RP Game Engine 引継ぎ資料 (Antigravity 2.0 / Gemini 向け)

このドキュメントは、ClaudeCode が引き継いだ後に実装・拡張された機能と設計判断を、次世代エージェント（Antigravity 2.0 = Gemini）に共有するための仕様書兼設計図です。

旧版 `handover_to_claude_ai.md` の続編であり、当時の「3スロット・主要課題3つ」状態から大きく拡張された現在のスナップショットを記録します。

---

## 1. プロジェクト概要（現在）

- **名称**: RP Game Engine
- **技術スタック**: Vite + Vanilla JavaScript + HTML5 + CSS3 (外部 JS ライブラリなし)
- **目的**: 「SillyTavern を日本人ユーザーが使いやすい形にした、ローカルLLM/OpenAI互換 API 向け軽量RPチャットエンジン」
- **保存先**: `L:\Antigravity\RP_Game_Engine`
- **想定 LLM**: KoboldCpp / llama.cpp / Ollama 等のローカル OpenAI 互換エンドポイント (デフォルト `http://localhost:5001/v1/chat/completions`)
- **モデル想定**: Gemma3 系日本語チューン、Mistral 系、Llama3 系を想定（特に Gemma3 系の癖（プレイヤー発言生成）への耐性を重視）

---

## 2. ディレクトリ構成

| パス | 役割 |
|---|---|
| `index.html` | SPA 骨格（タブ切替・各 View・モーダル定義） |
| `src/main.js` | メインロジック（全状態管理・API連携・全ハンドラ）。約5500行のモノリス |
| `src/style.css` | 全スタイル定義（ダーク基調・パネル群・モーダル・HUD） |
| `public/sample_quest_*.json` | サンプルクエストJSON群（`rp_engine_quest_v1` schema） |
| `START_RP_ENGINE.bat` | 開発サーバー起動 + ブラウザ自動オープン |
| `IMPLEMENTATION_GUIDE.md` | クエストJSON仕様の詳細ガイド |
| `Claudeプラン.md` | 進行中の作業メモ |
| `handover_to_claude_ai.md` | **旧**引継ぎ資料（Antigravity1.0→Claude） |
| `handover_to_antigravity_v2.md` | **本資料**（Claude→Antigravity2.0） |

---

## 3. コア設計思想

| 原則 | 意味 |
|---|---|
| **AI ナレーション駆動** | ゲームロジック（戦闘判定・分岐・状態遷移）はすべて AI に委ねる。エンジン側はコンテキスト整形と表示のみ |
| **タグベース通信** | AI 出力を `[SPEAKER:]` `[STATUS:]` `[CHOICES]` `[INFO]` 等のタグで構造化。タグはパース後に本文から除去 |
| **3 層フォールバック** | (1) クエスト個別 → (2) Settings グローバル → (3) AI 任せ、の優先順位 |
| **救済優先** | 「破棄」より「ナレーションとして再解釈」「タイムアウト中断」「警告ダイアログ」のように、エラー時もユーザー体験を維持 |
| **2 段防御** | システムプロンプト指示（予防）＋ パース時フィルタ（事後）の両方で AI の癖をカバー |
| **localStorage 完結** | サーバー側 DB なし。すべて `localStorage` に保存。ファイル出力で持ち運び可能 |

---

## 4. データモデル

### 4.1 `userConfig`（プレイヤー）

```js
{
  name, personality, description, scenario,
  first_mes, mes_example, avatar /* base64 WebP */,
  sdPrompt, lorebook /* [{key, content}] */,
  player_note /* Global Notes */
}
```

### 4.2 `characterDataArray`（NPC: **20スロット固定**）

```js
Array(20).fill(null) // 各スロットは userConfig と同じ shape (null = Empty)
```

> **重要**: 旧版は 3 スロット固定。20 化に伴い、ロード時に旧データを自動マイグレーション（`null` パディング）する処理が `loadSavedParty` 内にある。

### 4.3 `chatHistory`

```js
[{
  role: 'user' | 'assistant' | 'narrator',
  content: string,                  // 原文（タグ含む）
  statusSnapshot?: {[char]: {...}}, // この時点の status_values
  infoSnapshot?: string,            // この時点の Info Panel 文字列
  isImage?: bool,
  imageData?: string                // base64 (大きい場合 localStorage から剥がされる)
}]
```

### 4.4 `apiConfig`

```js
{
  endpoint, key, model,
  tokens,        // max_tokens (デフォルト 1000)
  timeoutSec     // fetch AbortController 自動中断秒 (デフォルト 180)
}
```

### 4.5 クエスト (`rp_engine_quest_v1`)

```jsonc
{
  "spec": "rp_engine_quest_v1",
  "name": "クエスト名",
  "tags": ["..."],
  "recommended_party_size": 2,
  "dice_enabled": true,
  "char_status_params": [
    {
      "char_name": "アロナ",
      "params": [
        { "name": "好感度", "type": "variable", "initial": 70 },
        { "name": "武器",   "type": "fixed",    "initial": 0,    "description": "..." },
        { "name": "現在時刻","type": "clock",   "initial": 480 }  // ★ 新規 type
      ]
    }
  ],
  "hidden_truths": [
    { "id": 1, "content": "...", "reveal_after_event": 5 }
  ],
  "events": [{ "id": 1, "title": "...", "description": "..." }],
  "ai_instructions": "...",
  "items_clues": [...],
  "additional_settings": "...",
  "content_guidelines": "ソフトな描写ルール（任意）",          // ★ 新規
  "info_panel_template": "【現在の状況】\n日時/場所/周囲\n..."   // ★ 新規
}
```

★ = このセッションで追加されたフィールド/型

---

## 5. AI 通信パイプライン

### 5.1 送信フロー (`fetchChatCompletion(mode)`)

```
fetchChatCompletion(mode)
 ├─ members = _banterMembersOverride ?? getActivePartyMembers()
 ├─ Build systemPrompt
 │    ├─ Player Info / Character Info / Scenarios
 │    ├─ [Quest Context] active quest description, events, status_values
 │    ├─ [Player Notes] global + quest-scoped (Author's Note 相当)
 │    ├─ Response Quality Rules (前パターン避け・矛盾解決・S/M/L長さ)
 │    ├─ Info Panel directive (有効時)              ★ 新規
 │    ├─ CHOICES directive (有効時)                 ★ 新規
 │    ├─ Content Guidelines (クエスト指定時)        ★ 新規
 │    ├─ Player Switch Annotation (旧名検出時)      ★ 新規
 │    └─ Lorebook injection (キーワードマッチ済み)
 ├─ Build raw history (with summaryception injection)  ★ 新規
 │    └─ context window N=20 entries で末尾トリミング
 │       直前要約があれば先頭に挿入
 ├─ fetch(endpoint, { signal: AbortController.signal })  ★ 新規
 │    └─ timeoutSec 経過で自動 abort
 └─ return content
```

### 5.2 受信フロー (`splitAndAppendCharMessages(reply, ...)`)

```
splitAndAppendCharMessages
 ├─ 1. [INFO] 抽出 → renderInfoPanel + infoSnapshot 保存  ★ 新規
 ├─ 2. [CHOICES] 抽出 → renderChoiceButtons               ★ 新規
 ├─ 3. パーティ規模で分岐:
 │    ├─ 0人: SPEAKER タグなければ単一ナレーション
 │    ├─ 1人: SPEAKER タグなければ単一バブル
 │    └─ 複数人: [SPEAKER: name] タグでセグメント分割
 ├─ 4. 各セグメントごと:
 │    ├─ STATUS タグ抽出 + applyStatusDelta
 │    └─ スピーカー解決 (3段判定):                       ★ 新規
 │        a) findMemberBySpeakerStrict (NPCキャラ名のみ)
 │        b) isFuzzyPlayerSpeaker → ナレーション救済
 │        c) findMemberBySpeaker (緩い: description/alias)
 └─ 5. updateStatusHUD + 必要なら summaryception 更新
```

---

## 6. タグ規約

| タグ | 用途 | 処理関数 |
|---|---|---|
| `[SPEAKER: 名前]` | キャラ発言・行動の話者明示 | `splitAndAppendCharMessages` |
| `[STATUS: 好感度=+5, HP=-10]` | キャラ別ステータスの差分適用 | `parseStatusTag` / `applyStatusDelta` |
| `[CHOICES]\n1. ...\n2. ...\n[/CHOICES]` | 末尾選択肢ボタン化 | `parseChoicesTag` |
| `[INFO]\n【現在の状況】...\n[/INFO]` | Info Panel 描画 | `parseInfoTag` |
| `<think>...</think>` | 隠し思考（DeepSeek-R1等）。表示時に除去 | regex で削除 |
| `[LORE: key]` | システムプロンプト内のロア区切り（AIへの読み専用ヒント） | — |

### マクロ（本文側）

| マクロ | 展開先 |
|---|---|
| `{{user}}` | `userConfig.name` |
| `{{char}}` | 描画中キャラの名前（再描画時の文脈に応じる） |

---

## 7. 主要機能一覧（現状）

### 7.1 既存（Antigravity 1.0 時代から）
- パーティシステム（旧3スロット → **20スロット拡張済み**）
- インテリジェント・プロンプト（キャラ設定 + Lorebook 統合）
- キャラ別吹き出し（アバター付き・編集・削除）
- 掛け合い (Banter) ボタン（**メンバー選択UI追加済み**）
- 共通/個別 Lorebook（キーワード動的注入）
- パーティ JSON Export/Import
- 画像生成 (SD API 連携 / Forge Couple / BREAK構文)
- ダイスロール (D4〜D100 / NDX 任意)
- クエストシステム (events / hidden_truths / char_status_params)
- プレイヤーノート（Global + Quest 2層）
- ステータス HUD (variable %バー / fixed 数値 / **clock HH:MM**)

### 7.2 このセッションで追加された機能

詳細は次章 §8 を参照。

---

## 8. このセッションで追加した設計（重要・必読）

カテゴリ別に整理。各機能の **設計判断の根拠** を併記。

### 8.A — AI 出力制御系

#### 8.A.1 S/M/L 応答長プリセット
- ツールバーの 3 ボタン (`#response-length-group`)
- `responseLength = 'short' | 'medium' | 'long'`（localStorage 永続化）
- システムプロンプト末尾に長さ指示を注入
- **判断**: 「長すぎる/短すぎる」の手動切替頻度が高いため、トグルではなく明示3段階に

#### 8.A.2 末尾選択肢モード (`[CHOICES]`)
- Telelynx 風。ツールバー 💬 ボタンで ON/OFF
- AI が `[CHOICES]\n1. ...\n2. ...\n3. ...\n[/CHOICES]` を出力
- パース後、紫色のボタン群でチャット下部に描画。クリックで入力欄に挿入
- localStorage キー: `showChoices`

#### 8.A.3 Info Panel (`[INFO]`) — Telelynx 風状況サマリ
- ツールバー 📊 ボタンで ON/OFF
- AI が応答末尾に `[INFO]\n【現在の状況】...\n[/INFO]` を出力
- チャット履歴と入力エリアの間に sticky パネル描画
- **【セクション】見出しの自動色付け**、折りたたみ/再表示ボタン、**⟳ 手動再生成**（独立 API コールで [INFO] ブロックのみ取得）
- `chatHistory[i].infoSnapshot` に永続化 → リロードで復元
- クエスト個別テンプレ `info_panel_template` → グローバル → AI 任せの 3 段フォールバック
- localStorage キー: `infoPanelEnabled`
- **判断**: 10人以上のキャラ運用での「迷子防止」用途。要約と違い「現在の状況」だけを示す

#### 8.A.4 コンテンツガイドライン
- クエストJSONの `content_guidelines` フィールド
- AI に `<think>` 内で自己チェックさせる「ソフトルール」
- システムプロンプトに注入（強制ではなく方針提示）

#### 8.A.5 ステータスパラメーター提示構造の改善（fixed/variable 物理分離）
- **背景**: Gemma3 系がプロンプト指示「固定値は STATUS タグで変動させないこと」を守らず、`[STATUS: 武器=+1]` のような無駄な変動タグを出力していた
- **旧構造**: 全パラメーターを混在表示＋末尾に注意書き
  ```
  ・好感度【変動】（現在値: +70）: ...
  ・武器【固定・判定基準】（現在値: 0）: ...
  → 固定パラメーター（武器）は STATUS タグで変動させないでください。
  ```
- **新構造**: ブロック単位で物理的に隔離。`[A] STATUS タグで操作可能` と `[B] ⛔ 参照専用` を明示
  ```
  ═══ 【ヒナ】 ═══
  [A] ★ STATUS タグで操作可能 ★
    ・好感度（変動・-100〜100、現在: +70）: ...
    → 出力例（発言末尾）: [STATUS: 好感度=+5]

  [B] ⛔ 参照専用・絶対に STATUS タグに含めないこと ⛔
    ・武器（固定値: 0）: ベレッタM9A1...
    → これらは読み取りのみ。STATUS タグに「武器=+N」等を書くと完全に無視されます（仕様上の安全装置）。
  ```
- **二重防御**: プロンプト構造に加えて、`applyStatusDelta` 内で `paramDef.type === 'fixed'` の差分は静かに破棄（仕様上の安全装置）
- 該当箇所: `main.js` 4337 行付近

### 8.B — コンテキスト管理系

#### 8.B.1 Summaryception 方式コンテキスト要約
- SillyTavern の Summary 機能の簡易版
- `CONTEXT_WINDOW_TURNS = 10` でトリミングする時、トリミングされる古い会話を別 API コールで 300〜500 字に要約
- 要約は `contextSummary_<partyId>` に保存。次回以降のリクエストでトリム前ダミーメッセージとして挿入
- `SUMMARY_MIN_NEW_MESSAGES = 4` で再要約頻度抑制
- 失敗時は無視（graceful degradation）

#### 8.B.2 プレイヤー切替コンテキスト汚染対策（A+B 2 層防御）
- **A. 警告ダイアログ**: Character Edit の Player タブで名前変更時、`chatHistory.length > 0` なら確認ダイアログ。OKでチャットリセット
- **B. 自動注釈注入**: `playerNameHistory` (localStorage, 最大10件) を維持。`detectPreviousPlayersInChat` が `[SPEAKER: 旧名]` を chatHistory から検出すると、システムプロンプト末尾に「これは別人」注釈を自動注入
- **判断**: ユーザーがセッション途中で「ユート → ハル」に切替＋元主人公を NPC 追加した実例で AI が混同（合体ラベル `[SPEAKER: ユート（ハル博士）]`）したため対応

### 8.C — データモデル拡張系

#### 8.C.1 `clock` 型ステータス
- `type: "clock"`、`initial` は分単位 (0〜1439)
- HUD で `⏰ HH:MM` 表示
- `applyStatusDelta` で 1440 折り返し処理（HP のような上限クランプは無し）

#### 8.C.2 パーティ 20 スロット拡張
- 定数 `MAX_PARTY_SLOTS = 20`
- `characterDataArray = Array(20).fill(null)`
- Character Edit のタブを動的生成（`renderEditTabs()`）。`.slot-tabs` は横スクロール
- Party Setup Grid は既存 `repeat(auto-fit, minmax(170px, 1fr))` でそのまま対応
- 旧3スロットセーブのマイグレーション処理（`null` パディング + 超過切捨）

#### 8.C.3 `info_panel_template` フィールド
- クエスト個別のテンプレ定義。空ならAI任せ

### 8.D — UI/UX 系

#### 8.D.1 チャット入力エリア 2 段レイアウト
- 旧: 13 ボタン一列でゴチャゴチャ
- 新: `.chat-toolbar`（36px 上段）+ `.chat-input-row`（50px 下段）
- 上段: セッション操作 (export/save/load) | spacer | notes | S/M/L + choices + info
- 下段: textarea + banter + narrate + (条件付き: narrator/dice/imggen) + send
- ダイスポップオーバーは `.chat-input-row` 内に移動（`bottom: calc(100% + 0.5rem)`）

#### 8.D.2 Banter メンバー選択モーダル
- 旧: アクティブメンバー全員固定（20人いると AI 混乱）
- 新: アクティブが2人なら即実行 / 3人以上はモーダル表示
- チェックボックス選択 + 「プレイヤーも参加」オプション
- 5人超は確認ダイアログ。`banterLastSelection` localStorage で前回選択復元
- 内部実装: `_banterMembersOverride` モジュール変数 を `fetchChatCompletion` が参照

#### 8.D.3 ダイスロール: 即時送信 → 入力欄挿入へフロー変更
- **背景**: 旧フローは「ダイスクリック → 即チャット送信 → AI 自動応答」だったため、プレイヤーが「隠れてやり過ごす」のような RP 描写と組み合わせて送ることができなかった
- **新フロー**:
  1. ダイスポップオーバーのボタンクリック → ロール計算 → 黄色バブルで視覚記録
  2. **`insertIntoChatInput(text)`** で入力欄のカーソル位置に `[ダイスロール: 1d20 → 15]` を挿入
  3. プレイヤーが RP 描写を書き加え、自分で送信ボタンを押す
- 既存テキストとの間に自動でスペース挿入。`input` イベント dispatch で textarea 自動リサイズ
- **例外**: `/roll 2d6` スラッシュコマンドは旧来通り即時送信（プレイヤーが明示的に送信意図を表現したため）
- 該当箇所: `main.js` `insertIntoChatInput()` 関数 / dice-face-btn ハンドラ / カスタムロール `doCustomRoll`

### 8.E — ストレージ最適化系

#### 8.E.1 アバター WebP 自動圧縮
- 旧: 400×400 PNG 無圧縮 (1枚 150〜300KB、20人で 3〜6MB → localStorage 5MB 超過)
- 新: 256×256 WebP 0.8 (1枚 20〜40KB、20人で約 1MB)
- 実装: `canvasToCompressedDataURL(canvas, 'image/webp', 0.8)` (WebP → JPEG → PNG 順フォールバック)
- 既存PNGアバターは保持され、再編集時に自動 WebP 化（漸進的マイグレーション）

### 8.F — ロバストネス系

#### 8.F.1 プレイヤー発言ナレーション救済
- 旧: AI が `[SPEAKER: {{user}}]` を出すと**完全破棄**（Gemma3 系の癖でしばしば発生し、情景描写ごと消える）
- 新: `'ナレーション'` バブルとして再描画（破棄しない）
- 加えて、システムプロンプトに「逃げ道指示」追加: `※どうしてもプレイヤー描写したい場合は [SPEAKER: ナレーション] で客観描写として書け`

#### 8.F.2 スピーカー解決 3 段判定
- 旧: `findMemberBySpeaker` の Strategy 2 (description 部分一致) で **NPC description 内に「ユート先生」と書かれていると、プレイヤー名「ユート」がそのNPCに誤誘導**
- 新: 順序を厳密化:
  1. `findMemberBySpeakerStrict`（NPC キャラ名のみ、descriptionは見ない）
  2. `isFuzzyPlayerSpeaker`（プレイヤー曖昧マッチ、汎用名は除外）→ ナレーション救済
  3. `findMemberBySpeaker`（緩いマッチ：description/alias/単語分割）
- これでNPC衝突回避と「プレイヤー名の表記揺れ（ユート ↔ ユート先生）」対応を両立

#### 8.F.3 Fetch タイムアウト + AbortController
- KoboldCpp 等が長時間生成中にコネクション切断 → ブラウザ「typing...」永久ハング を物理的に防止
- `apiConfig.timeoutSec` (Settings UI で調整可、デフォルト180秒)
- タイムアウト時 / `Failed to fetch` 時は専用エラーメッセージで対処手順を提示
- 加えて 5 分後の自動ローディングクリア（安全網）

### 8.H — ボイス読み上げ (TTS) ナレーション対応 + UI 統一

Antigravity 1.0 が組んだ TTS 基盤（VOICEVOX / Web Speech API）に対する後発の改修群。

#### 8.H.1 ツールバートグルボタン CSS 統一
- 旧: `updateAutoplayTtsButton()` がインラインスタイル `btn.style.background = '...'` を直書き。CSS が存在しなかった
- 新: `#autoplay-tts-toggle` 用の base / hover / active クラス CSS を `style.css` に追加。緑系テーマ（rgba(80, 200, 130, ...)）で他ツールバートグルと並ぶ見た目に
- `updateAutoplayTtsButton()` は単純に `classList.toggle('active', !!autoplayTts)` のみ

#### 8.H.2 ナレーター用ボイス設定 `narratorVoice`
- **背景**: 旧実装は `findMemberBySpeaker('ナレーション', members)` が常に null → `queueTts` が呼ばれず、**ナレーション吹き出しは絶対に読み上げられない**バグ
- **新設計**: `narratorVoice = { engine, speakerId|voiceURI, pitch, speed }` を独立変数化し localStorage に永続化
- Settings 画面に「🎙️ ナレーター音声 (TTS)」セクション追加。エンジン/スピーカー/ピッチ/速度の 4 項目
- 共用ヘルパ `populateSpeakerSelect(selectEl, engine, currentVal)` を新設。キャラクター編集の `updateSpeakerSelect` と並列に使える

#### 8.H.3 `extractDialogue` ナレーションモード追加
- 旧シグネチャ: `extractDialogue(text)` → 「」『』中の発言のみ抽出（無ければ装飾記号除去した全文）
- 新シグネチャ: `extractDialogue(text, isNarration)` → `isNarration=true` のとき:
  - `<think>` `[SPEAKER:]` `[STATUS:]` `[INFO]` `[CHOICES]` 等のメタタグを除去
  - マークダウン強調記号 `**` `*` を除去（中身は残す）
  - 「」『』記号そのものを除去（中身は読む対象）
  - 連続改行を圧縮
- `queueTts` / `playNextTts` / `speakTextCore` / `speakText` すべてに `isNarration` パラメータを貫通

#### 8.H.4 ナレーション読み上げの組み込み
ナレーション吹き出しが生成される 3 経路すべてに narratorVoice での `queueTts` を仕込んだ:
1. **パーティ無し・SPEAKER タグ無し経路** (`members.length === 0`): cleaned full reply を ナレーション吹き出し化
2. **プレイヤー発言の救済経路**: AI が `[SPEAKER: {{user}}]` を出して救済された場合
3. **メイン タグベース解析**: SPEAKER タグが「ナレーション」「Narrator」「narrator」の場合 (大文字小文字違いを許容)
- 共通条件: `shouldSave && autoplayTts && narratorVoice && narratorVoice.engine !== 'none'`
- 🔊 単発再生ボタン（msg controls）でも、speaker name がナレーションなら `narratorVoice` を使う

#### 8.H.5 localStorage キー
| キー | 値 | 用途 |
|---|---|---|
| `narratorVoice` | JSON `{engine, speakerId, voiceURI, pitch, speed}` | ナレーター音声設定 |

---

### 8.G — 完全自由空間モード (Free World Mode)

「キャラぷ」の有志シミュレーション「完全自由空間」を移植した 4 機能セット。Settings 内の独立セクションに親トグル + サブトグル群を配置。

#### 8.G.1 設計思想
- **親トグル + サブトグル** の二段構成。親 OFF 時はすべて無効化
- 各機能は **独立して ON/OFF 可能**（Mary Sue だけ ON、Realism だけ ON など）
- **既存パターン流用優先**: 3 機能は system prompt directive のみ、1 機能（Living World）のみ新規 setInterval インフラ

#### 8.G.2 🛡️ メアリー・スー防止 (`marySuePrevention`) と ⚡ チートモード (`cheatMode`)
- Mary Sue 防止: 純粋な system prompt directive。実装場所: `fetchChatCompletion` 末尾の Free World 分岐内
- 「プレイヤーは原作住人と同等以下」「世界バランスを壊す行動は失敗描写で抑制」を指示
- 既存設定（plot, lorebook, etc）と矛盾しないよう「努力による成長は許容」を明示
- **⚡ チートモード（独立トグル）**: Settings の 🛡️ Mary Sue 防止 直下に配置。`isCheatModeActive()` は単純に `cheatMode` フラグを返す
  - チートモード ON → Mary Sue 防止 directive をスキップし、代わりに「チートモード許可」directive を注入（無双・最強・神視点を許容）
  - 元の「キャラぷ」では世界観入力に「チートモード」と書く仕様だったが、本エンジンでは**明示的なチェックボックス化**で「気づかず ON になっていた」事故を防いだ
  - Mary Sue 防止トグルが ON のまま、チートモードもONにできる → 後者が優先

#### 8.G.2-extra 初期設定テンプレ（introduction_dialogue）— 本編準拠
- サンプルクエストの `introduction_dialogue` に組み込み済み
- **元の「キャラぷ」本編テンプレートを完全準拠**:
  ```
  #世界観: ...
  #user設定
  - 名前:
  - 性別:
  - 年齢:
  - 種族:
  - 所属:
  - 能力:
  - 性格:
  - 得意:
  - 苦手:
  - 外見:
  #初期状況: ...
  ```
- AI 側 (`ai_instructions`) には「この構造をパースして反映」「空欄は自由補完OK」「Player タブ Description と統合」を明示
- **Player ({{user}}) タブ転記推奨**: キャラぷ本家にはペルソナ機能がないため初期設定をチャット内に書く運用だが、本エンジンは Player タブで永続化できる優位性がある。テンプレ冒頭で Player タブへの転記を推奨する案内を表示
- ユーザーがクエスト開始 → ナレーションでテンプレ表示 → 埋めて送信 → AI が #世界観/#user設定/#初期状況 をパースして世界を生成

#### 8.G.3 ✨ リアル判定モード (`realismMode`)
- 純粋な directive。緊張・疲労・経験不足・環境要因を行動結果に反映させる
- ダイス機構と直交（dice_enabled とは独立）。あくまで AI 描写の指針

#### 8.G.4 🤝 NPC 自動生成 (`npcGenerationEnabled`)
- **新関数**: `generateNpcByLLM()` — `fetchInfoPanelOnly` パターン踏襲の独立 API コール
  - AbortController + `apiConfig.timeoutSec` 流用
  - JSON 形式厳密指定（コードフェンス・コメント禁止）
  - 出力をパース → `normalizeToEngineChar()` → スロット格納
- **UI**: `renderPartySetGrid()` 内 `buildCard()` で `isEmpty && freeWorldEnabled && npcGenerationEnabled` の条件下にのみ「➕ Generate NPC」ボタンを表示
- **世界観 3段階フォールバック**: `activeQuest.template.additional_settings` → `worldTheme` (Settings) → デフォルト「現代日本の日常」
- **重複防止**: 既存キャラ名と被ったらエラーで再試行を促す
- **二重発火防止**: `_isGeneratingNpc` フラグで多重実行ガード

#### 8.G.5 🌍 生きている世界 / アイドルイベント (`livingWorldEnabled`)
- **唯一の新規インフラ**: setInterval ベースのパッシブタイマー
- **関数群**:
  - `startLivingWorldTimer()` — `setInterval(checkAndFireLivingWorldEvent, 30000)` で30秒毎チェック
  - `stopLivingWorldTimer()` — clearInterval
  - `checkAndFireLivingWorldEvent()` — 発火条件チェック → `fetchLivingWorldEvent()` 呼出 → `splitAndAppendCharMessages` で描画
  - `fetchLivingWorldEvent()` — 独立 LLM API コール（temp=0.85, max_tokens=500）
- **発火条件**（すべて満たした場合のみ発火）:
  - `freeWorldEnabled && livingWorldEnabled`
  - `chat-view` が表示中
  - `chatHistory.length > 0`
  - 最終ユーザー入力から `livingWorldIntervalSec` 秒経過（デフォルト300秒）
  - `!isSending && !_isLivingWorldFiring && !_isGeneratingNpc`
- **ナビ切替 hook**: `setupNavigation` 内で、chat-view 入退場時に `start`/`stop` を自動呼出
- **入力時リセット**: `sendMessage` 冒頭で `_lastUserInputTime = Date.now()` を更新（ユーザー操作中は発火しない）
- **発火後クールダウン**: 成功・失敗どちらも `_lastUserInputTime` を現在時刻にリセットし、次の発火まで `livingWorldIntervalSec` 秒以上の間隔を保証
- **メタフラグ**: 生成されたメッセージには `chatHistory[i].livingWorldEvent = true` を付与（将来の表示分岐用）

#### 8.G.6 サンプルクエスト
`public/sample_quest_free_world.json` を同梱:
- `recommended_party_size: 0`
- `additional_settings` に世界観プレースホルダ（現代日本の地方都市）
- `ai_instructions` にモード有効化手順
- `events / hidden_truths / char_status_params` はすべて空
- ユーザーが Quest Editor のインポート機能で読み込んで使う

---

#### 8.F.4 クエスト ID 比較の型正規化（hidden_truths 発火漏れ対策）
- **背景**: ユーザー手書き JSON で `"reveal_after_event": "5"`（文字列）と書かれた場合、`t.reveal_after_event === currentEvent.id`（厳密等価）が `"5" === 5` で `false` となり、**真実が永久に公開されない**バグ
- **対策**: 共通ヘルパで Number 正規化
  ```js
  _normalizeId(v)            // 数値化できれば Number 化、できなければ元のまま
  _idArrayIncludes(arr, id)  // 配列内ID存在チェック（型不一致対応）
  ```
- 適用箇所:
  - `advanceQuestEvent` 内の `completed_events.includes(currentEvent.id)`
  - `advanceQuestEvent` 内の `t.reveal_after_event === currentEvent.id`
  - `updateQuestHUD` のドット描画 (`qs.completed_events.includes(ev.id)`)
- **新規 ID を扱う場合のガイドライン**: §10 パターン E 参照

---

## 9. localStorage キー一覧

| キー | 用途 | 追加時期 |
|---|---|---|
| `apiEndpoint`, `apiKey`, `apiModel`, `apiTokens` | API 設定 | 旧 |
| `apiTimeoutSec` | fetch タイムアウト秒数 | 本セッション |
| `userName`, `userPersonality`, `userPersona`, `userScenario`, `userFirstMes`, `userMesExample`, `userAvatar`, `userSdPrompt`, `userLorebook`, `userPlayerNote` | プレイヤー設定 | 旧 |
| `savedParty` | NPCパーティ配列 (20スロット) | 旧→拡張 |
| `savedCommonLore` | 共通ロアブック | 旧 |
| `chatHistory_<partyId>` | パーティ別チャット履歴 | 旧 |
| `contextSummary_<partyId>` | パーティ別コンテキスト要約 | 本セッション |
| `lastSummarizedIndex_<partyId>` | 要約済み末尾インデックス | 本セッション |
| `responseLength` | `short` / `medium` / `long` | 本セッション |
| `showChoices` | 末尾選択肢モード ON/OFF | 本セッション |
| `infoPanelEnabled` | Info Panel ON/OFF | 本セッション |
| `playerNameHistory` | 旧プレイヤー名履歴 (最大10件) | 本セッション |
| `banterLastSelection` | 前回 Banter 選択メンバー | 本セッション |
| `freeWorldEnabled` | 完全自由空間モード親トグル '1'/'0' | 本セッション (Free World) |
| `marySuePrevention` | メアリー・スー防止 '1'/'0' (デフォON) | 本セッション (Free World) |
| `cheatMode` | チートモード '1'/'0' (デフォOFF・ON で Mary Sue 防止強制無効化) | 本セッション (Free World) |
| `realismMode` | リアル判定モード '1'/'0' (デフォON) | 本セッション (Free World) |
| `npcGenerationEnabled` | NPC 自動生成 '1'/'0' (デフォON) | 本セッション (Free World) |
| `livingWorldEnabled` | 生きている世界 '1'/'0' (デフォOFF) | 本セッション (Free World) |
| `livingWorldIntervalSec` | アイドルイベント最低間隔 (60-600秒) | 本セッション (Free World) |
| `worldTheme` | 世界観テンプレ文字列 | 本セッション (Free World) |
| `narratorVoice` | ナレーター用ボイス設定 JSON `{engine, speakerId, voiceURI, pitch, speed}` | 本セッション (TTS) |

---

## 10. 拡張パターン（新機能を追加する際のガイド）

### パターン A: 新しい AI 出力タグを追加したい場合
1. `parseXxxTag(content)` 関数を `parseChoicesTag` / `parseInfoTag` の近くに追加。`{ extracted, cleanedContent }` を返す
2. `splitAndAppendCharMessages` の冒頭（INFO抽出と同じレベル）で抽出
3. `fetchChatCompletion` のシステムプロンプト構築で directive を注入（トグル localStorage キー対応）
4. ツールバーにトグルボタン追加（HTML + CSS + `setupXxxToggle()`）
5. **必須**: トグル OFF 時でも誤出力されたタグは本文から除去すること

### パターン B: 新しい char_status_params 型を追加したい場合
1. `type: "newtype"` として JSON spec に追加
2. `applyStatusDelta` で型別処理分岐
3. `updateStatusHUD` で描画分岐
4. `createParamEntryElement`（エディタUI）で select option 追加
5. CSS で `.status-cell-newtype` クラス定義

### パターン C: 既存パイプラインに非破壊的フォールバックを追加したい場合
- 既存挙動を変えず、新しい状況検知時のみ動作する形を取る
- 例: `detectPreviousPlayersInChat()` → 検出時のみ注釈注入
- 例: `isFuzzyPlayerSpeaker()` → NPC マッチ失敗時のみ評価

### パターン D: 既存判定の優先順位を変える場合
- 関数を分割（厳密版/緩い版）して呼出側で順序制御
- 例: `findMemberBySpeaker` → `findMemberBySpeakerStrict` を分離して 3 段判定構成

### パターン E: クエスト JSON 由来の ID を比較する場合
- **必ず `_normalizeId()` / `_idArrayIncludes()` を経由する**こと
- ユーザー手書き JSON で `"id": "1"`（文字列）と書かれても `"id": 1` と書かれても、`===` 比較で同一視できる
- 適用候補: `event.id`, `truth.id`, `item.id`, `reveal_after_event`, `completed_events`, `revealed_truths` 等
- **エディタ側はすでに `parseInt` で数値化されている**が、JSON 直接インポートはパースされないため

### パターン F: バックグラウンドタイマー導入（Living World 参考）
1. **タイマー制御を 2 つの関数に分離**:
   - `startXxxTimer()`: `clearInterval` で既存ハンドルクリア → 条件チェック → `setInterval(check, interval)` 登録
   - `stopXxxTimer()`: ハンドルクリア + null 化
2. **ビュー切替で確実に start/stop**: `setupNavigation` 内の `data-view` 切替時に hook を入れ、chat-view 入退場で start/stop を自動化
3. **発火条件の段階的チェック**: 親トグル → サブトグル → ビュー状態 → 二重発火フラグ → AI 応答中フラグ → 時間経過、を 1 関数内で順に return で弾く
4. **二重発火防止フラグ必須**: `_isXxxFiring = true/false` で try-finally 制御
5. **失敗時もクールダウン**: 連続失敗の連発を防ぐため、try-catch どちらも最後に `_lastInputTime = Date.now()` 等でリセット
6. **タイムアウト連携**: 既存 `apiConfig.timeoutSec` の AbortController を必ず使う（独立 fetch でハングしない）
7. **入力時リセット**: ユーザー入力ハンドラ（例: `sendMessage` 冒頭）で `_lastInputTime` を更新し、操作中の発火を抑制
8. **メタフラグ**: 生成されたメッセージに `chatHistory[i].xxxEvent = true` を付与し、将来の特殊処理（表示・フィルタ）に備える

---

## 11. 既知の制約・スコープ外

| 項目 | 状況 |
|---|---|
| プレイヤー名表記揺れの完全自動同期 | スコープ外（手動で Player Notes に補足） |
| シーン自動切替によるアクティブキャラ絞り込み | スコープ外（10+人いても AI は全員の description を毎回受信） |
| localStorage → IndexedDB 移行 | 不要（WebP 圧縮で 5MB 制限内に収まる） |
| スロット数のユーザー可変設定 | 20 固定（タブUI複雑化を回避） |
| 21 人目以降の動的追加 | 不可（20 固定） |
| F.B./EX/SP のような厳密 TRPG 機械処理 | スコープ外（AI ナレーションに任せる） |
| stream: true のSSEストリーミング受信 | 未実装（実装するなら大規模リファクタ必要） |
| `[SPEAKER:]` タグなしの「Name:」前置きフォーマットでプレイヤー名検出 | フォールバック経路では未対応（タグ運用なら問題なし） |

---

## 12. 次のタスク候補（バックログ）

優先度順:

1. **Edit ボタン bug during AI streaming**: AI 生成中に Edit ボタンが消えない問題（前セッションから未対応）
2. **stream: true 実装**: 長時間生成でも逐次表示できれば fetch タイムアウト問題が大幅軽減
3. **クエスト Editor UI で `info_panel_template` 編集対応**: 現在は JSON 直接編集のみ
4. **Settings に「グローバル Info Panel テンプレ」追加**: クエスト未指定時のフォールバック先
5. **ロアブック注入量上限制御**: 20キャラ × 多数 entry でシステムプロンプトが肥大化したら対応
6. **「プレイヤー描写を確認する」UI**: ナレーション救済された旧 `[SPEAKER: {{user}}]` ブロックを視覚的にハイライトする
7. **Banter ランダムサンプリング**: 「お任せで N 人選んで」ボタン
8. **クエスト中の状況自動アーカイブ**: イベント進行のたびに「ここまでの状況サマリ」をクエスト state に保存
9. **フォールバック経路（`[SPEAKER:]` タグなし）のプレイヤー名検出**: 現状は §11 でスコープ外。"Name:" 前置きでも `isFuzzyPlayerSpeaker` 判定するよう拡張
10. **ダイス挿入時のロールバブル位置改善**: 現状はチャット履歴に追加。送信前なので「まだ送信されてない」のが視覚的に分かりにくい場合あり。半透明化等の検討
11. **`_idArrayIncludes` の全箇所適用監査**: §10 パターン E に従い、他の `===` ID 比較箇所も洗い出し（特に items_clues, ai_instructions 関連）

---

### 12.1 完了済み（Antigravity 1.0 フィードバック対応）

直近セッションで対応した修正:

- ✅ **AI プレイヤー発言 2 回目以降表示問題** → §8.F.1 / §8.F.2 で対応（NPC衝突回避 + プレイヤー曖昧マッチ + ナレーション救済の 3 段判定）
- ✅ **hidden_truths 発火漏れ（型不一致）** → §8.F.4 で対応（`_normalizeId` / `_idArrayIncludes` ヘルパ）
- ✅ **fixed/variable ステータス混同による無駄 STATUS タグ出力** → §8.A.5 で対応（プロンプト構造を [A]/[B] ブロック分離化）
- ✅ **ダイスロール RP 描写統合不可** → §8.D.3 で対応（即時送信廃止 → 入力欄挿入フロー）
- ✅ **完全自由空間モード移植**（「キャラぷ」由来 4 機能） → §8.G で対応（Mary Sue 防止 / リアル判定 / NPC 自動生成 / Living World）

---

## 13. Antigravity 2.0 への引継ぎ時の注意

- **モノリス**: `src/main.js` は約 5500 行のモノリスです。関数間の依存が密です。リファクタの誘惑に駆られても、まずは「機能追加は既存パターン C/D に従う」「触らずに済むなら触らない」方針推奨
- **正規表現の罠**: SPEAKER タグ解析、フォールバック前置き検出など、複数の正規表現が日本語特有のパターン（`、`「【】―—` 等）に依存。テストせずに変更すると壊れます
- **localStorage 容量**: 5MB が事実上の上限。20キャラ × 数百ターンのチャット履歴で割と圧迫します。新規 base64 系データを安易に保存しないこと
- **AI 指示の言語**: システムプロンプトは主に日本語。Gemma3 系日本語チューンが想定。多言語化の場合は応答長プリセット・選択肢・Info Panel ルール等すべての directive を翻訳必要
- **テスト方法**: 自動テストはない。各機能追加後は (1) `npm run build` 通過 (2) F5 でリロードして実機確認 が唯一の検証手段

---

## 14. 起動方法（再掲）

```bash
npm install        # 初回のみ
npm run dev        # 開発サーバー起動
npm run build      # プロダクションビルド (dist/)
```

または `START_RP_ENGINE.bat` で `npm run dev` + ブラウザ自動オープン。

---

## 15. 連絡先・参考

- ユーザー: Lorichalcum (lorichalcum001@gmail.com)
- 元設計: Antigravity 1.0 (Gemini ベースエージェント)
- 拡張: Claude Code (Anthropic Claude Sonnet 4.5 / Opus 4.7 多用)
- 引継ぎ完了日: 2026-05-19
- 最終改訂: 2026-05-19（Antigravity 1.0 フィードバック対応 §8.A.5 / §8.D.3 / §8.F.4 / §10 パターンE 追加）
- 最新改訂: 2026-05-19（完全自由空間モード実装 §8.G / §9 7キー追加 / §10 パターンF 追加）
- パッチ: 2026-05-19（チートモード + 初期設定 3 セクションテンプレを introduction_dialogue に組込）
- パッチ: 2026-05-19（チートモードを文字列検出→明示トグル `cheatMode` に変更）
- パッチ: 2026-05-19（introduction_dialogue を本編「キャラぷ」準拠の構造化テンプレに置換 / Player タブ転記推奨を明示）
- パッチ: 2026-05-19（TTS 改修: ナレーション読み上げ対応 / ナレーター音声 Settings / トグル CSS 統一 §8.H）

---

**次の作業に取り掛かる前に**: §10 の「拡張パターン」と §11 の「スコープ外」に必ず目を通してください。ユーザーの設計判断が反映されており、ここを無視すると往復が増えます。
