# RP Game Engine 引継ぎ資料 (ClaudeCode用)

このドキュメントは、AntigravityからClaudeCodeへプロジェクトを引き継ぐための仕様書兼ガイドラインです。

## 1. プロジェクト概要
- **名称**: RP Game Engine
- **技術スタック**: Vite (Frontend SPA), HTML5, CSS3, Vanilla JavaScript
- **目的**: 複数人のキャラクター（最大3名）とのロールプレイを可能にする、軽量でカスタマイズ性の高いチャットUIエンジン。
- **保存先**: `l:\Antigravity\RP_Game_Engine`

## 2. ディレクトリ構成
- `index.html`: UIの骨格（SPA形式でタブ切り替え）
- `src/main.js`: メインロジック（ステート管理、API連携、チャット処理）
- `src/style.css`: スタイル定義（ダークモード、吹き出しデザイン、レスポンシブ）
- `START_RP_ENGINE.bat`: サーバー起動・ブラウザ自動開きのバッチ
- `issues_synnary.md`: 現在確認されている不具合のまとめ（最新版）
- `メモ.md`: 2026-03-17時点の開発進捗メモ

## 3. 現在の主要機能
- **パーティシステム (3スロット対応)**: 最大3人のキャラ設定を管理し、AIに「全員の役を演じる」よう自動指示。
- **インテリジェント・プロンプト**: API送信時に、各キャラの設定（Description, Scenario）と共通Loreを結合して送信。
- **チャットUI**:
  - キャラクターごとの吹き出し（アバター画像対応）。
  - メッセージのリアルタイム編集・削除。
  - キャラ同士を喋らせる「掛け合い (Banter)」ボタン。
- **設定管理**:
  - 共通Lorebook（全キャラに適用される世界観設定）。
  - 個別Lorebook（各キャラ固有の知識）。
  - パーティ全体のJSONエクスポート/インポート。

## 4. 現在解決すべき課題 (優先度順)
1. **キャラクターの識別と吹き出しの分離 (Bubble Logic)**
   - AIが複数役を演じる際、一人の発言としてまとめられてしまうことがある。
   - `[SPEAKER: Name]` タグや正規表現による名前パースを強化し、発言ごとに正しく吹き出しを分割する必要がある。
2. **{{char}} マクロの修正**
   - 現在、エディタで表示している対象ではなく、「選択中のアクティブスロット」を常に参照してしまっている。表示（レンダリング）時に文脈に合わせた置換を行うように修正が必要。
3. **Lorebook (世界観設定) の反映強化**
   - キーワードマッチングの判定が弱く、AIが無視することがある。システムプロンプト内での配置や、重要度指定のタグ付けを検討中。

## 5. 開発者(AI)への注意事項
- **依存関係**: 本プロジェクトは外部ライブラリを極力使わず、Vanilla JSで書かれています。
- **API連携**: `http://localhost:5001/v1/chat/completions` (OpenAI互換) を想定。
- **状態管理**: `localStorage` を使用。`savedParty`, `chatHistory_partyID`, `savedCommonLore` 等。

## 6. 起動方法
1. `npm install` (初回のみ)
2. `START_RP_ENGINE.bat` を実行、または `npm run dev` で起動。

---
次は、`src/main.js` 内の `splitAndAppendCharMessages` 関数と `applyMacros` 関数から着手するのがスムーズです。
