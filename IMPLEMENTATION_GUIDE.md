# 【改善ガイド】KoboldCPP + RP Engine 最適化

Cloudflare タイムアウト問題を解決するための3ステップガイドです。

---

## 📋 全体の進行状況

| ステップ | タイトル | 効果 | 難易度 |
|---------|--------|------|------|
| **1** | KoboldCPP パラメータ調整 | 生成速度 +30〜40% | 🟢 簡単 |
| **2** | ngrok トンネル切り替え | タイムアウト耐性UP | 🟡 中程度 |
| **3** | ストリーミング実装 | タイムアウト完全回避 | 🟠 少し複雑 |

---

## 🚀 ステップ1：KoboldCPP パラメータ最適化

### 目標
- GPU層を **45 → 62** に増加（より多くの計算をGPU側で実行）
- コンテキストを **16384 → 8192** に縮小（速度向上）
- `--noshift` を削除（古い履歴を自動削除）

### 実装

**ファイル**: `koboldcpp_optimized.py` （既に作成済み）

1. Google Colab を開く
2. 既存の Colab セルを**削除**
3. `koboldcpp_optimized.py` の内容を新しいセルにコピー
4. **実行ボタン** をクリック

### 結果の確認

実行終了後、コンソールに以下のように表示されます：

```
📊 改善されたリソース配分:
   GPU層: 62 (L4の24GB VRAMでより多くをGPU処理)
   コンテキスト: 8192トークン (速度向上)
   KVキャッシュ: int8量子化（メモリ節約）
```

**期待される改善**: 生成時間が 100秒超 → 60〜80秒程度に短縮

---

## 🔗 ステップ2：ngrok に切り替え

### 目標
- Cloudflare トンネルを **ngrok** に切り替え
- より安定したタイムアウト耐性
- ストリーミングに強い

### 前提条件

ngrok アカウント作成が必要です（無料）

1. https://dashboard.ngrok.com に登録
2. Auth Token をコピー

### 実装

`koboldcpp_optimized.py` の以下の部分を編集：

```python
# --- 5. ngrok トンネル設定 ---
def start_ngrok_tunnel():
    try:
        # このトークンを自分のトークンに置き換える
        ngrok.set_auth_token("your_ngrok_token_here")
        
        # ...以下は変わらず
```

### 結果

実行すると、コンソールに以下が表示：

```
🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥
【RP_ENGINE用 ngrok エンドポイント】
https://xxxx-xx-xxx-xx-xx.ngrok.io/v1/chat/completions
🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥

💡 このURLを Settings → API Endpoint に設定してください。
```

### RP Engine 側の設定

1. RP Engine の **Settings** を開く
2. **API Endpoint** に上記のURL を入力
3. 保存

**期待される改善**: Cloudflare より長いタイムアウト（低減）

---

## ⚡ ステップ3：ストリーミング実装

### 目標
- API から **トークンを1つずつ受け取る** 仕様に変更
- Cloudflare の 100秒制限を回避
- UX 向上（テキストがリアルタイムに表示）

### 実装

**ファイル**: `streaming_fetchChatCompletion.js`

#### 方法A：完全置換（推奨）

1. `main.js` を開く
2. `fetchChatCompletion` 関数全体（2883行目〜3176行目）を削除
3. `streaming_fetchChatCompletion.js` の関数全体をコピー
4. 同じ位置に貼付け
5. 関数名を `fetchChatCompletionStreaming` → `fetchChatCompletion` に変更

#### 方法B：部分置換（保守的）

`fetchChatCompletion` 関数の以下の部分（3133行目〜3144行目）だけを置き換え：

```javascript
// ========== 【ここから改善版】ストリーミング対応 fetch =========
var payload = {
    model: apiConfig.model,
    messages: messages,
    temperature: 0.8,
    max_tokens: apiConfig.tokens,
    stream: true  // 🔑 ストリーミング有効化
};

// ... 以降、ファイルの該当部分をコピー
```

### 動作確認

1. RP Engine を起動
2. API Endpoint が正しく設定されていることを確認
3. キャラクターが応答を開始
4. テキストが **トークン単位でリアルタイムに表示** されることを確認

### トラブルシューティング

**問題**: API が 404 エラーを返す

```
Error: API Error 404
```

**原因**: エンドポイントが `/v1/chat/completions` ではない

**対策**: 
- RP Engine Settings → API Endpoint を確認
- ngrok URL が正しいか確認
- `{URL}/v1/chat/completions` の形式か確認

---

**問題**: ストリーミングが機能しない（テキストが一気に表示される）

**原因**: KoboldCPP が `/api/extra/generate/stream` ではなく `/v1/chat/completions?stream=true` を使用している

**対策**: 
- KoboldCPP バージョンを最新に更新
- または、エンドポイントを `/api/extra/generate/stream` に変更

---

## 📊 期待される改善

| 項目 | 改善前 | 改善後 |
|------|------|------|
| **生成時間** | 100〜150秒 | 60〜90秒 |
| **Cloudflare タイムアウト** | 頻繁に発生 | ほぼ発生しない |
| **UX** | 全文待つ | リアルタイム表示 |
| **ネットワーク安定性** | Cloudflare（不安定）| ngrok（安定） |

---

## 🛠️ 検証チェックリスト

各ステップ後に以下を確認してください：

### ステップ1 後
- [ ] KoboldCPP のログで `GPU layers: 62` と表示
- [ ] コンテキストサイズが `8192` と表示
- [ ] 起動完了まで 10 秒以内

### ステップ2 後
- [ ] ngrok エンドポイント URL が表示
- [ ] RP Engine の Settings に URL が設定済み
- [ ] API 呼び出しが成功（エラーなし）

### ステップ3 後
- [ ] キャラクター応答がリアルタイム表示
- [ ] テキストが 1 トークンずつ追加される
- [ ] 100秒以上の長考でもタイムアウトしない

---

## 💡 さらなる最適化（オプション）

### A. max_tokens を削減

`main.js` の `apiConfig` で：

```javascript
tokens: 2048  // または 1024（長めの応答が必要なければ）
```

より短い応答 = 高速化

### B. temperature を調整

```javascript
temperature: 0.7  // 0.8 → 0.7 に低下（若干安定化）
```

### C. GPU層をさらに増加

Colab のリソースが十分あれば：

```python
--gpulayers 70  # 62 → 70 に増加
```

（メモリ不足でエラーが出たら 62 に戻す）

---

## 📞 トラブルシューティング

### Q. ngrok を使わずに改善できる？
A. ステップ1だけでも 30〜40% の高速化が期待できます。タイムアウト完全回避には ngrok またはストリーミング（ステップ3）が必要です。

### Q. ストリーミングなしでできる？
A. ステップ1 + ステップ2 で対応可能ですが、100秒以上の応答は依然リスクがあります。

### Q. Colab を再起動したら設定は？
A. すべてリセットされます。毎回 Colab コードを実行してください。

---

## 最後に

実装中に質問や問題があれば、気軽に聞いてください！
一緒に改善していきましょう。🚀
