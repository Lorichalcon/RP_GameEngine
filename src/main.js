import './style.css'
import { parseChoicesTag, parseInfoTag, collapseRunawayRepetition, looksRunawayRepetition, parseImageTags } from './parsers.js'
import {
    isImageLibrarySupported, saveDirHandle, loadDirHandle, clearDirHandle, verifyPermission,
    pickImageFolder, scanImageFiles, getImageUrl, getImageDataUrl, revokeAllImageUrls,
    loadCatalog, serializeCatalog, getCatalogKey, findByTag,
    mergeScanIntoCatalog, findDuplicateTags
} from './imageLibrary.js'

// ======== コンテキストウィンドウ設定 ========
// LLMへの送信時に保持するチャット履歴のターン数（user+assistantの1往復=1ターン）。
// chatHistory本体（UI表示・保存用）はこの定数に影響されず全件保持される。
// 送信時のみ末尾Nターンに絞り、システムプロンプトは常に先頭固定でトリミング対象外。
// 値を小さくするほど長期記憶を失うが、AI動作の安定性が増す。
const CONTEXT_WINDOW_TURNS = 10;            // 直近10ターン = 20エントリ送信
const CONTEXT_WINDOW_ENTRIES = CONTEXT_WINDOW_TURNS * 2;

// ======== パーティスロット数 ========
// Player + 20 NPC スロット。20以上にすると localStorage 5MB 制限と
// system prompt のトークン消費がきびしくなるため上限値として固定。
// アバターは 256×256 WebP 自動圧縮されるため 20人で約1MB に収まる。
const MAX_PARTY_SLOTS = 20;

// ======== 汎用プレースホルダー（画像未設定キャラ用の中立シルエット）========
// 画像未設定時のフォールバック。以前は public/placeholder.png（フランドール画像）を
// 使っていたが、特定キャラに依存しない中立シルエットSVGに統一した。
const UNKNOWN_CHAR_SVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23666' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z'/></svg>";

let characterDataArray = Array(MAX_PARTY_SLOTS).fill(null);
let commonLorebook = [];
let chatHistory = [];
// API Configuration stored in localStorage or defaults
let apiConfig = {
    endpoint: localStorage.getItem('apiEndpoint') || 'http://localhost:5001/v1/chat/completions',
    key: localStorage.getItem('apiKey') || 'none',
    model: localStorage.getItem('apiModel') || 'local-model',
    tokens: parseInt(localStorage.getItem('apiTokens')) || 1000,
    // fetch 自動中断タイムアウト（秒）。KoboldCpp 等のハング検知用。
    // 0 を指定するとタイムアウト無効。デフォルト180秒で「LLMが完了したのに応答届かない」を防ぐ。
    timeoutSec: parseInt(localStorage.getItem('apiTimeoutSec')) || 180
};

let userConfig = {
    name:        localStorage.getItem('userName')        || 'User',
    personality: localStorage.getItem('userPersonality') || '',
    description: localStorage.getItem('userPersona')     || '',  // 旧キー流用でバックコンパット
    scenario:    localStorage.getItem('userScenario')    || '',
    first_mes:   localStorage.getItem('userFirstMes')    || '',
    mes_example: localStorage.getItem('userMesExample')  || '',
    avatar:      localStorage.getItem('userAvatar')      || '',
    sdPrompt:    localStorage.getItem('userSdPrompt')    || '',
    lorebook:    JSON.parse(localStorage.getItem('userLorebook') || '[]'),
    player_note: localStorage.getItem('userPlayerNote')  || '',   // Global プレイヤーノート
    voice:       JSON.parse(localStorage.getItem('userVoice')    || '{"engine":"none","voiceURI":"","speakerId":0,"pitch":1.0,"speed":1.0}')
};
const PLAYER_NOTE_MAX = 4000;
// 'short' | 'medium' | 'long' — AI応答の長さプリセット。localStorage に永続化。
let responseLength = localStorage.getItem('responseLength') || 'medium';

// 末尾選択肢モード（AIが各応答末尾に2〜3個の選択肢を提示）。localStorage に永続化。
let showChoices = localStorage.getItem('showChoices') === '1';

// ======== Info Panel (Telelynx式・状況サマリ) ========
// AIが各応答に [INFO]...[/INFO] ブロックを出力し、チャット下部の専用パネルに描画。
// 10+ キャラ運用での「迷子防止」用途。localStorage に永続化。
let infoPanelEnabled = localStorage.getItem('infoPanelEnabled') === '1';
let lastInfoSnapshot = '';        // 直近のinfoテキスト（chatHistory にも保存）
let _isInfoRefreshing = false;   // 手動更新中フラグ（二重発火防止）

// ======== 完全自由空間モード (Free World Mode) ========
// 「キャラぷ」の有志シミュレーション「完全自由空間」を移植した 4 機能セット。
// 親トグル freeWorldEnabled が ON のときのみ各サブ機能が実効。
let freeWorldEnabled       = localStorage.getItem('freeWorldEnabled')       === '1'; // 親トグル: デフォOFF
let marySuePrevention      = localStorage.getItem('marySuePrevention')      !== '0'; // デフォON
let cheatMode              = localStorage.getItem('cheatMode')              === '1'; // デフォOFF (ON で Mary Sue 防止を強制無効化)
let realismMode            = localStorage.getItem('realismMode')            !== '0'; // デフォON
let npcGenerationEnabled   = localStorage.getItem('npcGenerationEnabled')   !== '0'; // デフォON
let livingWorldEnabled     = localStorage.getItem('livingWorldEnabled')     === '1'; // デフォOFF
let livingWorldIntervalSec = parseInt(localStorage.getItem('livingWorldIntervalSec')) || 300;
let universeReportEnabled  = localStorage.getItem('universeReportEnabled')  !== '0'; // デフォON: 初回テンプレ入力時に世界観確認を返す
let worldTheme             = localStorage.getItem('worldTheme')             || '';
let _livingWorldTimerHandle = null;
let _lastUserInputTime      = Date.now();
let _isLivingWorldFiring    = false;
let _isGeneratingNpc        = false;

// ======== コンテキスト要約（Summaryception方式） ========
// 古い会話をLLMで要約し、トリミング時に先頭に注入することで長期記憶を維持する。
let contextSummary = '';            // 現在のローリング要約テキスト
let lastSummarizedIndex = 0;       // chatHistory 内で要約済みの末尾インデックス
const SUMMARY_MIN_NEW_MESSAGES = 4; // 要約更新をトリガーする最低新規トリミングメッセージ数
let _isSummarizing = false;        // 要約生成中フラグ（二重発火防止）

let editTarget = 'player'; // 'player' | 0..MAX_PARTY_SLOTS-1
let isRegenerating = false; // 再生成中フラグ（グローバル）
let playerNarrationMode = false; // プレイヤーナレーションモード

// ======== TTS (音声合成・自動読み上げ) 設定 ========
let autoplayTts = localStorage.getItem('autoplayTts') === '1'; // 自動読み上げ有効フラグ
let currentTtsAudio = null; // 現在再生中の VOICEVOX Audio オブジェクト
let voicevoxSpeakers = []; // VOICEVOX のスピーカー一覧キャッシュ

let ttsQueue = [];
let isPlayingTts = false;

// ナレーター用ボイス設定（ナレーション吹き出し読み上げ時に使用）
// キャラ別 voice 設定とは別系統。Settings で設定。
let narratorVoice = (function() {
    try {
        const raw = localStorage.getItem('narratorVoice');
        if (raw) return JSON.parse(raw);
    } catch (e) { /* noop */ }
    return { engine: 'none', speakerId: '', voiceURI: '', pitch: 1.0, speed: 1.0 };
})();

// ======== ストリーミング応答 ========
// SSE (stream: true) で生成途中をリアルタイム表示。非対応バックエンドへは自動フォールバック。
let streamingEnabled = localStorage.getItem('streamingEnabled') !== '0'; // デフォON

// ======== 純チャットモード (Pure Chat) ========
// RP用のプロンプト注入（Player Info / SPEAKER / クエスト / Lore / ペルソナ等）を
// 一切行わず、Kobold と素のアシスタントチャットをする。
// 履歴・要約は専用バケット (pure_chat__) に分離され、RPセッションを汚染しない。
let pureChatMode = localStorage.getItem('pureChatMode') === '1';
let pureChatSystemPrompt = localStorage.getItem('pureChatSystemPrompt')
    || 'あなたは親切で有能なAIアシスタントです。ユーザーの言語に合わせて自然に応答してください。';

// ======== 🖼️ 事前登録画像ライブラリ ========
// 画像実体はローカルフォルダ参照（File System Access API）、カタログのみ localStorage。
let imageLibraryEnabled = localStorage.getItem('imageLibraryEnabled') === '1';
let imageTagInjectMax   = parseInt(localStorage.getItem('imageTagInjectMax')) || 60;
let imageMaxPerTurn     = parseInt(localStorage.getItem('imageMaxPerTurn')) || 2;
let imageCatalog        = loadCatalog();
let _imgDirHandle       = null;   // 現在のディレクトリハンドル
let _imgDirGranted      = false;  // 読み取り権限が有効か
// チャット描画の世代トークン。チャット欄をクリアするたびに進める。
// 画像挿入は非同期（ファイル読み出しを挟む）ため、待っている間に画面が
// 作り直されたら結果を破棄する。これが無いと再描画のたびに画像が重複する。
let _chatRenderToken    = 0;
function bumpChatRenderToken() { _chatRenderToken++; }

function saveImageCatalog() {
    return safeSetItem(getCatalogKey(), serializeCatalog(imageCatalog));
}

/** 起動時: 保存済みハンドルを復元（権限は非対話で確認。'prompt' なら要ユーザー操作） */
async function restoreImageDirHandle() {
    if (!isImageLibrarySupported()) return;
    const handle = await loadDirHandle();
    if (!handle) return;
    _imgDirHandle = handle;
    _imgDirGranted = await verifyPermission(handle, false);
    updateImageLibraryStatus();
}

function updateImageLibraryStatus() {
    const el = document.getElementById('imglib-status');
    if (!el) return;
    if (!isImageLibrarySupported()) {
        el.textContent = '⚠️ このブラウザは非対応です（Chrome / Edge が必要。https または localhost で開いてください）';
        el.dataset.state = 'error';
        return;
    }
    if (!_imgDirHandle) {
        el.textContent = 'フォルダが未選択です。「📂 画像フォルダを選択」から選んでください。';
        el.dataset.state = 'none';
        return;
    }
    const dupCount = findDuplicateTags(imageCatalog).length;
    el.innerHTML = '📂 <strong>' + escapeHTML(_imgDirHandle.name) + '</strong>'
        + '　|　登録 <strong>' + imageCatalog.length + '</strong> 件'
        + (dupCount > 0 ? '　|　<span style="color:#ffa726;">⚠️ タグ重複 ' + dupCount + ' 件</span>' : '')
        + (_imgDirGranted
            ? '　|　<span style="color:#4caf50;">読み取り許可あり</span>'
            : '　|　<span style="color:#ffa726;">許可の再取得が必要（操作時に確認されます）</span>');
    el.dataset.state = _imgDirGranted ? 'ok' : 'warn';
}

/** 権限が無ければ対話的に要求する（ユーザー操作起点で呼ぶこと） */
async function ensureImageDirPermission() {
    if (!_imgDirHandle) return false;
    if (_imgDirGranted) return true;
    _imgDirGranted = await verifyPermission(_imgDirHandle, true);
    updateImageLibraryStatus();
    return _imgDirGranted;
}

/**
 * 画像フォルダの許可が切れている場合に、チャット画面から復帰するためのバナーを出す。
 * 権限要求はユーザーのクリック起点でしか通らないため、ボタンを踏ませる必要がある。
 */
function showImagePermissionBanner() {
    if (document.getElementById('imglib-permission-banner')) return;
    const history = document.getElementById('chat-history');
    if (!history) return;
    const bar = document.createElement('div');
    bar.id = 'imglib-permission-banner';
    bar.className = 'imglib-permission-banner';
    bar.innerHTML = '🖼️ 画像フォルダへのアクセス許可が必要です '
        + '<button id="imglib-permission-btn">許可する</button>';
    history.appendChild(bar);
    history.scrollTop = history.scrollHeight;
    bar.querySelector('#imglib-permission-btn').addEventListener('click', async () => {
        const ok = await ensureImageDirPermission();
        if (ok) {
            bar.remove();
            showToast('🖼️ 画像フォルダを読み込めるようになりました');
            renderChatFromHistory(); // 表示できなかった画像を再解決
        } else {
            showToast('許可が得られませんでした', 'error');
        }
    });
}

function renderImageLibraryTable() {
    const tbody = document.getElementById('imglib-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!imageCatalog.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="imglib-empty">まだ登録がありません。</td></tr>';
        return;
    }
    imageCatalog.forEach((entry, idx) => {
        const tr = document.createElement('tr');

        // サムネイル（遅延読込: 権限があるときのみ）
        const tdThumb = document.createElement('td');
        const img = document.createElement('img');
        img.className = 'imglib-thumb';
        img.alt = entry.tag;
        tdThumb.appendChild(img);
        if (_imgDirGranted) {
            getImageUrl(_imgDirHandle, entry.file, entry.subDir).then(url => { if (url) img.src = url; });
        }
        tr.appendChild(tdThumb);

        const mkInput = (value, field, placeholder) => {
            const td = document.createElement('td');
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.value = value || '';
            inp.placeholder = placeholder || '';
            inp.className = 'imglib-input';
            inp.addEventListener('input', () => { imageCatalog[idx][field] = inp.value; });
            td.appendChild(inp);
            return td;
        };

        tr.appendChild(mkInput(entry.tag, 'tag', 'tag_name'));
        tr.appendChild(mkInput(entry.description, 'description', '例: 照れて笑っている'));
        tr.appendChild(mkInput(entry.character, 'character', 'キャラ名（任意）'));

        // レイヤー
        const tdLayer = document.createElement('td');
        const sel = document.createElement('select');
        sel.className = 'imglib-input';
        [['reactive', 'reactive'], ['state', 'state']].forEach(([v, label]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = label;
            sel.appendChild(o);
        });
        sel.value = entry.layer || 'reactive';
        sel.addEventListener('change', () => { imageCatalog[idx].layer = sel.value; });
        tdLayer.appendChild(sel);
        tr.appendChild(tdLayer);

        tr.appendChild(mkInput(entry.eventId, 'eventId', '例: 3'));

        // 削除
        const tdDel = document.createElement('td');
        const del = document.createElement('button');
        del.className = 'imglib-del-btn';
        del.textContent = '🗑';
        del.title = 'この登録を削除（ファイル自体は消えません）';
        del.addEventListener('click', () => {
            imageCatalog.splice(idx, 1);
            saveImageCatalog();
            renderImageLibraryTable();
            updateImageLibraryStatus();
        });
        tdDel.appendChild(del);
        tr.appendChild(tdDel);

        tbody.appendChild(tr);
    });
}

function setupImageLibraryView() {
    const pickBtn   = document.getElementById('imglib-pick-folder-btn');
    const rescanBtn = document.getElementById('imglib-rescan-btn');
    const charBtn   = document.getElementById('imglib-set-char-btn');
    const dupBtn    = document.getElementById('imglib-check-dup-btn');
    const saveBtn   = document.getElementById('imglib-save-btn');

    if (pickBtn && !pickBtn._bound) {
        pickBtn._bound = true;
        pickBtn.addEventListener('click', async () => {
            try {
                revokeAllImageUrls();
                _imgDirHandle = await pickImageFolder();
                _imgDirGranted = true;
                const scanned = await scanImageFiles(_imgDirHandle);
                const { catalog, added } = mergeScanIntoCatalog(imageCatalog, scanned);
                imageCatalog = catalog;
                saveImageCatalog();
                renderImageLibraryTable();
                updateImageLibraryStatus();
                showToast('📂 ' + scanned.length + ' 件の画像を検出（新規 ' + added + ' 件を追加）');
            } catch (e) {
                if (e && e.name === 'AbortError') return; // ユーザーがキャンセル
                showToast('フォルダを選択できません: ' + e.message, 'error');
            }
        });
    }

    if (rescanBtn && !rescanBtn._bound) {
        rescanBtn._bound = true;
        rescanBtn.addEventListener('click', async () => {
            if (!_imgDirHandle) { showToast('先にフォルダを選択してください', 'error'); return; }
            if (!(await ensureImageDirPermission())) { showToast('読み取り許可が得られませんでした', 'error'); return; }
            try {
                const scanned = await scanImageFiles(_imgDirHandle);
                const { catalog, added } = mergeScanIntoCatalog(imageCatalog, scanned);
                imageCatalog = catalog;
                saveImageCatalog();
                renderImageLibraryTable();
                updateImageLibraryStatus();
                showToast(added > 0 ? '🔄 新規 ' + added + ' 件を追加しました' : '🔄 新しい画像はありませんでした');
            } catch (e) {
                showToast('スキャン失敗: ' + e.message, 'error');
            }
        });
    }

    if (charBtn && !charBtn._bound) {
        charBtn._bound = true;
        charBtn.addEventListener('click', () => {
            let n = 0;
            imageCatalog.forEach(e => { if (e.subDir && !e.character) { e.character = e.subDir; n++; } });
            saveImageCatalog();
            renderImageLibraryTable();
            showToast(n > 0 ? '👥 ' + n + ' 件にキャラ名を設定しました' : '対象がありませんでした（既に設定済み）');
        });
    }

    if (dupBtn && !dupBtn._bound) {
        dupBtn._bound = true;
        dupBtn.addEventListener('click', () => {
            const dups = findDuplicateTags(imageCatalog);
            showToast(dups.length ? '⚠️ 重複タグ: ' + dups.join(', ') : '✅ タグの重複はありません',
                      dups.length ? 'error' : 'success');
            updateImageLibraryStatus();
        });
    }

    if (saveBtn && !saveBtn._bound) {
        saveBtn._bound = true;
        saveBtn.addEventListener('click', () => {
            if (saveImageCatalog()) {
                updateImageLibraryStatus();
                showToast('💾 カタログを保存しました（' + imageCatalog.length + ' 件）');
            }
        });
    }

    // 🩺 表示診断: 画像が出ない原因を上から順に潰して特定する
    const diagBtn = document.getElementById('imglib-diagnose-btn');
    if (diagBtn && !diagBtn._bound) {
        diagBtn._bound = true;
        diagBtn.addEventListener('click', async () => {
            const lines = [];
            const fail = (msg) => { lines.push('❌ ' + msg); };
            const ok   = (msg) => { lines.push('✅ ' + msg); };

            // 1. ブラウザ対応
            if (!isImageLibrarySupported()) fail('このブラウザは非対応です（Chrome / Edge が必要）');
            else ok('ブラウザ対応OK');

            // 2. 機能の有効化（← 最も多い原因）
            if (!imageLibraryEnabled) fail('画像ライブラリが【無効】です → Settings → 🖼️ 画像ライブラリ を ON にして「Save Settings」');
            else ok('画像ライブラリ 有効');

            // 3. フォルダ選択
            if (!_imgDirHandle) fail('画像フォルダが未選択です → 「📂 画像フォルダを選択」');
            else ok('フォルダ: ' + _imgDirHandle.name);

            // 4. 読み取り許可（ここで対話的に要求する）
            if (_imgDirHandle) {
                const granted = await ensureImageDirPermission();
                if (!granted) fail('フォルダの読み取り許可がありません（ダイアログで「許可」を選んでください）');
                else ok('読み取り許可あり');
            }

            // 5. カタログ件数
            if (!imageCatalog.length) fail('カタログが空です → 「🔄 再スキャン」');
            else ok('登録 ' + imageCatalog.length + ' 件');

            // 6. 先頭エントリの実ファイル読み出しテスト
            if (_imgDirHandle && _imgDirGranted && imageCatalog.length) {
                const e = imageCatalog[0];
                const url = await getImageUrl(_imgDirHandle, e.file, e.subDir);
                if (!url) fail('ファイルを読めません: ' + (e.subDir ? e.subDir + '/' : '') + e.file);
                else ok('ファイル読み出しOK（' + e.tag + '）');
            }

            console.log('[ImageLib] 診断結果:\n' + lines.join('\n'));
            const firstFail = lines.find(l => l.startsWith('❌'));
            showToast(firstFail
                ? firstFail.replace('❌ ', '🩺 ')
                : '🩺 すべて正常です。チャットで {img:' + (imageCatalog[0] ? imageCatalog[0].tag : 'タグ名') + '} を試してください',
                firstFail ? 'error' : 'success');
        });
    }

    renderImageLibraryTable();
    updateImageLibraryStatus();
}

function updatePureChatToggleUI() {
    const btn = document.getElementById('pure-chat-toggle');
    if (!btn) return;
    btn.classList.toggle('active', pureChatMode);
    btn.title = pureChatMode
        ? '💬 純チャットモード ON（クリックでRPモードに戻る）'
        : '純チャットモード: RP設定を一切注入せず素のAIチャット（履歴はRPと別枠保存）';
}

/** 純チャット⇄RPの切替。履歴バケットが変わるため画面を再構築する */
function setPureChatMode(on) {
    if (pureChatMode === !!on) return;
    pureChatMode = !!on;
    localStorage.setItem('pureChatMode', pureChatMode ? '1' : '0');
    updatePureChatToggleUI();
    // 旧バケットのUI残骸をクリア
    clearChoiceButtons();
    lastInfoSnapshot = '';
    renderInfoPanel('');
    // 新バケットの要約・履歴を読み込んで再描画
    loadContextSummary();
    restoreChatFromStorage();
    refreshSummaryPanelIfOpen();
    showToast(pureChatMode
        ? '💬 純チャットモード ON — RP設定なしの素のチャット（履歴は別枠）'
        : '🎭 RPモードに戻りました');
}

function setupPureChatToggle() {
    const btn = document.getElementById('pure-chat-toggle');
    if (!btn || btn._bound) return;
    btn._bound = true;
    btn.addEventListener('click', () => setPureChatMode(!pureChatMode));
    updatePureChatToggleUI();
}

// 繰り返しペナルティ（暴走リピート抑制）。frequency/presence_penalty として送信。
// 0 で無効。0.3 前後が無難（高すぎると語彙が不自然に散る）。
let repetitionPenalty = (function() {
    const v = parseFloat(localStorage.getItem('repetitionPenalty'));
    return isNaN(v) ? 0.3 : v;
})();

/** 生成途中テキストをチャット欄に仮表示する */
function updateStreamingPreview(text) {
    const history = document.getElementById('chat-history');
    if (!history) return;
    let el = document.getElementById('streaming-preview');
    if (!el) {
        el = document.createElement('div');
        el.id = 'streaming-preview';
        el.className = 'streaming-preview';
        el.innerHTML = '<div class="streaming-preview-label">✍️ 生成中…</div><div class="streaming-preview-text"></div>';
        history.appendChild(el);
    }
    const t = el.querySelector('.streaming-preview-text');
    if (t) t.textContent = text;
    history.scrollTop = history.scrollHeight;
}

function removeStreamingPreview() {
    const el = document.getElementById('streaming-preview');
    if (el) el.remove();
}

/**
 * SSE ストリームを読み切って全文を返す。
 * - チャンク受信ごとにプレビュー更新
 * - timeoutSec 秒間チャンクが来なければ停滞とみなし abort（生成が続く限り中断しない）
 * - 中断時に途中まで生成済みなら部分テキストを返す（全損を防ぐ）
 */
async function _readSseStreamToText(response, abortCtrl) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let stallTimer = null;
    let runawayAborted = false;     // 暴走リピート検出による中断か
    let lastRunawayCheckLen = 0;    // 直近のリピートチェック時の文字数
    const resetStall = () => {
        if (!apiConfig.timeoutSec || apiConfig.timeoutSec <= 0) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            console.warn('[stream] no chunk for ' + apiConfig.timeoutSec + 's → abort');
            abortCtrl.abort();
        }, apiConfig.timeoutSec * 1000);
    };
    resetStall();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetStall();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 不完全な最終行は次チャンクへ持ち越し
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr === '[DONE]') continue;
                try {
                    const data = JSON.parse(jsonStr);
                    const delta = data.choices && data.choices[0] && data.choices[0].delta;
                    if (delta && typeof delta.content === 'string') {
                        fullContent += delta.content;
                        updateStreamingPreview(fullContent);
                    }
                } catch (e) { /* 分割途中の行はスキップ */ }
            }
            // 暴走リピート検出: 末尾が同一短単位の連続なら早期中断（トークン浪費を防ぐ）
            if (fullContent.length - lastRunawayCheckLen >= 40) {
                lastRunawayCheckLen = fullContent.length;
                if (looksRunawayRepetition(fullContent.slice(-160))) {
                    console.warn('[stream] runaway repetition detected → abort');
                    runawayAborted = true;
                    abortCtrl.abort();
                    break;
                }
            }
        }
    } catch (err) {
        if (err.name === 'AbortError' && fullContent) {
            if (runawayAborted) {
                // 暴走分は後段の collapseRunawayRepetition で畳まれる。注記は付けない。
                console.warn('[stream] returning content after runaway abort');
                return fullContent;
            }
            console.warn('[stream] aborted mid-generation, returning partial content');
            return fullContent + '\n\n（…タイムアウトにより途中で打ち切られました）';
        }
        throw err;
    } finally {
        if (stallTimer) clearTimeout(stallTimer);
        try { reader.releaseLock(); } catch (e) { /* noop */ }
        removeStreamingPreview();
    }
    return fullContent;
}

// ======== 音声入力 (Speech-to-Text) ========
// Web Speech API（ブラウザ内蔵・無料）優先、ローカル Whisper サーバーへ切替可。
// ハンズフリー連続聴取で、無音区間ごとに認識結果を入力欄へ「挿入のみ」する。
// ⚠️ getUserMedia / SpeechRecognition は https または localhost でのみ動作する。
let sttEnabled        = localStorage.getItem('sttEnabled') === '1';        // mic ボタン表示
let sttEngine         = localStorage.getItem('sttEngine') || 'webspeech';  // 'webspeech' | 'whisper'
let sttLang           = localStorage.getItem('sttLang') || 'ja-JP';
let sttAutoSend       = localStorage.getItem('sttAutoSend') === '1';       // 既定 OFF（挿入のみ）
let sttSilenceMs      = parseInt(localStorage.getItem('sttSilenceMs')) || 1500; // Whisper VAD 無音判定
let whisperEndpoint   = localStorage.getItem('whisperEndpoint') || 'http://localhost:5001/v1/audio/transcriptions';
let _sttActive        = false;  // ハンズフリー聴取中か
let _recognition      = null;   // SpeechRecognition インスタンス（webspeech）
let _whisperCtx       = null;   // { stream, recorder, audioCtx, analyser, ... }（whisper）

// 認識結果を入力欄へ追記（挿入のみ。auto-send が ON なら送信もトリガー）
function appendTranscriptToInput(text) {
    const input = document.getElementById('chat-input');
    if (!input || !text) return;
    const sep = (input.value && !/\s$/.test(input.value)) ? ' ' : '';
    input.value += sep + text;
    input.dispatchEvent(new Event('input')); // textarea 高さ自動調整トリガー
    if (sttAutoSend) {
        const sendBtn = document.getElementById('send-btn');
        if (sendBtn && !sendBtn.disabled) sendBtn.click();
    }
}

// interim（認識途中）の灰色ライブ表示。textarea は汚さない。
function updateSttInterim(text) {
    const el = document.getElementById('stt-interim');
    if (!el) return;
    if (text && text.trim()) {
        el.textContent = '🎤 ' + text;
        el.style.display = '';
    } else {
        el.textContent = '';
        el.style.display = 'none';
    }
}

function updateSttMicBtnUI() {
    const btn = document.getElementById('stt-mic-btn');
    if (!btn) return;
    btn.style.display = sttEnabled ? '' : 'none';
    btn.classList.toggle('active', _sttActive);
    btn.title = _sttActive ? '🎤 音声入力 ON（クリックで停止）' : '🎤 音声入力を開始';
}

function toggleSTT() { _sttActive ? stopSTT() : startSTT(); }

function startSTT() {
    if (_sttActive) return;
    _sttActive = true;
    updateSttMicBtnUI();
    if (sttEngine === 'whisper') _startWhisperSTT();
    else                        _startWebSpeechSTT();
}

function stopSTT() {
    _sttActive = false;
    if (_recognition) { try { _recognition.stop(); } catch (e) {} _recognition = null; }
    if (_whisperCtx)  { _stopWhisperSTT(); }
    updateSttInterim('');
    updateSttMicBtnUI();
}

// ===== Web Speech 経路（ブラウザ内蔵・無音検出はエンジン任せ） =====
function _startWebSpeechSTT() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        showToast('このブラウザは音声入力に非対応です（Chrome / Edge 推奨）', 'error');
        stopSTT();
        return;
    }
    _recognition = new SR();
    _recognition.lang = sttLang;
    _recognition.continuous = true;
    _recognition.interimResults = true;
    _recognition.onresult = (e) => {
        // TODO(echo): autoplayTts 再生中は AI の声を拾うため、将来 isPlayingTts 中は一時停止する
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) final += r[0].transcript;
            else           interim += r[0].transcript;
        }
        if (final) appendTranscriptToInput(final.trim()); // 無音で確定 → 挿入
        updateSttInterim(interim);
    };
    _recognition.onerror = (e) => {
        console.warn('[STT] webspeech error:', e.error);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            showToast('マイク権限が拒否されています。ブラウザの設定でマイクを許可してください', 'error');
            stopSTT();
        } else if (e.error === 'network') {
            showToast('音声認識にはネット接続が必要です（Web Speech は音声を Google へ送信）', 'error');
            stopSTT();
        }
        // 'no-speech' / 'aborted' 等は onend の自動再開に任せる
    };
    _recognition.onend = () => {
        // continuous でも無音で勝手に終了する実装があるため、active の間は再開してハンズフリー継続
        if (_sttActive && _recognition) {
            try { _recognition.start(); } catch (e) { /* 連続 start の例外は無視 */ }
        }
    };
    try {
        _recognition.start();
        showToast('🎤 音声入力 ON（話すと入力欄に文字が入ります）');
    } catch (e) {
        showToast('音声認識を開始できません: ' + e.message, 'error');
        stopSTT();
    }
}

// ===== Whisper 経路（クライアント VAD で無音検出 → セグメントを POST） =====
async function _startWhisperSTT() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('このブラウザ/接続ではマイクを使用できません（https か localhost が必要）', 'error');
        stopSTT();
        return;
    }
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        showToast('マイクにアクセスできません: ' + e.message, 'error');
        stopSTT();
        return;
    }
    if (!_sttActive) { stream.getTracks().forEach(t => t.stop()); return; } // 起動中に停止された

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    let recorder = null;
    let chunks = [];
    let speaking = false;
    let silenceStart = 0;
    let vadTimer = null;
    const SILENCE_RMS = 0.012; // 無音とみなす RMS しきい値（経験値）

    const startSegment = () => {
        chunks = [];
        try {
            recorder = new MediaRecorder(stream);
        } catch (e) {
            showToast('録音を開始できません: ' + e.message, 'error');
            stopSTT();
            return false;
        }
        recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
        recorder.onstop = async () => {
            const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
            chunks = [];
            if (blob.size > 1200 && _sttActive) { // 極小（ノイズのみ）はスキップ
                updateSttInterim('（認識中…）');
                try {
                    const text = await _transcribeWhisper(blob);
                    if (text) appendTranscriptToInput(text);
                } catch (e) {
                    console.warn('[STT] whisper transcribe failed:', e);
                    showToast('Whisper 認識失敗: ' + e.message, 'error');
                }
                updateSttInterim('');
            }
            // セグメント完了 → active の間は次セグメント録音を再開
            if (_sttActive && recorder) { try { recorder.start(); } catch (e) {} }
        };
        recorder.start();
        return true;
    };

    const rmsOf = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
        }
        return Math.sqrt(sum / buf.length);
    };

    const tick = () => {
        if (!_sttActive) return;
        const rms = rmsOf();
        if (rms > SILENCE_RMS) {
            speaking = true;
            silenceStart = 0;
            updateSttInterim('（録音中…）');
        } else if (speaking) {
            if (!silenceStart) silenceStart = performance.now();
            else if (performance.now() - silenceStart >= sttSilenceMs) {
                // 発話後に一定時間無音 → セグメント確定
                speaking = false;
                silenceStart = 0;
                if (recorder && recorder.state === 'recording') recorder.stop(); // → onstop で transcribe
            }
        }
        vadTimer = setTimeout(tick, 100);
    };

    _whisperCtx = {
        stream, audioCtx,
        stopAll: () => {
            if (vadTimer) clearTimeout(vadTimer);
            try { if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); } } catch (e) {}
            try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
            try { audioCtx.close(); } catch (e) {}
        }
    };

    if (!startSegment()) return;
    showToast('🎤 音声入力 ON（Whisper・話すと入力欄に文字が入ります）');
    tick();
}

async function _transcribeWhisper(blob) {
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', 'whisper-1');
    form.append('language', (sttLang.split('-')[0] || 'ja'));
    const headers = {};
    if (apiConfig.key) headers['Authorization'] = 'Bearer ' + apiConfig.key;
    const res = await fetch(whisperEndpoint, { method: 'POST', body: form, headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return (data.text || '').trim();
}

function _stopWhisperSTT() {
    if (_whisperCtx && _whisperCtx.stopAll) {
        try { _whisperCtx.stopAll(); } catch (e) { /* noop */ }
    }
    _whisperCtx = null;
}

// mic ボタンのクリックハンドラ単独セットアップ（init から呼ぶ）
function setupSpeechInput() {
    const btn = document.getElementById('stt-mic-btn');
    if (!btn || btn._sttBound) return;
    btn._sttBound = true;
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        toggleSTT();
    });
    updateSttMicBtnUI();
}

// ======== Web Search (検索結果を裏で system prompt に注入) ========
let webSearchEnabled       = localStorage.getItem('webSearchEnabled') === '1';
let webSearchProvider      = localStorage.getItem('webSearchProvider') || 'auto'; // 'tavily' | 'ddg' | 'auto'
let tavilyApiKey           = localStorage.getItem('tavilyApiKey') || '';
let webSearchAutoTrigger   = localStorage.getItem('webSearchAutoTrigger') !== '0'; // デフォ ON
let webSearchCooldownSec   = parseInt(localStorage.getItem('webSearchCooldownSec')) || 10;
let webSearchMaxResults    = parseInt(localStorage.getItem('webSearchMaxResults')) || 5;
let webSearchShowDebug     = localStorage.getItem('webSearchShowDebug') === '1';
let _webSearchCache        = new Map(); // query → { results, timestamp }
let _lastWebSearchTime     = 0;
let _forceSearchNextSend   = false; // 🔍 ボタンによる強制
let _pendingWebSearchInjection = ''; // sendMessage → fetchChatCompletion へのバトン
const WEB_SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 時間

// ======== AI Memo (AIが [MEMO: 〜] タグで自動記録できるメモ欄) ========
// ======== Persona Mode ({{user}}の多面ペルソナを呼称・一人称で使い分ける) ========
// 「別キャラへの切替」(detectPreviousPlayersInChat) とは別概念。
// こちらは「同一人物が見せる複数の顔」を扱う。
let personaModeEnabled = localStorage.getItem('personaModeEnabled') === '1';
let personaDefinitions = localStorage.getItem('personaDefinitions') || '';

// ======== NPC 発言保証（複数キャラ時、シーン中心の NPC に最低一言を促す） ========
// 全 NPC を毎ターン登場させるのではなく「中心 N 人」だけ喋らせて棒立ちを防ぐ。
// 残りは登場させないことでコンテキスト負荷を抑える。
let npcMinDialogueEnabled = localStorage.getItem('npcMinDialogueEnabled') === '1'; // デフォOFF
let npcDialogueMax = parseInt(localStorage.getItem('npcDialogueMax')) || 3;        // 中心人物の上限

let aiMemoEnabled = localStorage.getItem('aiMemoEnabled') === '1';
let aiMemoList = (function() {
    try {
        const raw = localStorage.getItem('aiMemoList');
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        }
    } catch (e) { /* noop */ }
    return []; // [{ text, ts, source }]
})();
const AI_MEMO_MAX = 200;
const AI_MEMO_INJECT_RECENT = 30;

function saveAiMemos() {
    try { localStorage.setItem('aiMemoList', JSON.stringify(aiMemoList)); }
    catch (e) { /* noop */ }
}

function addAiMemo(text, source) {
    if (!text) return;
    const trimmed = String(text).trim();
    if (!trimmed) return;
    aiMemoList.push({ text: trimmed, ts: Date.now(), source: source || 'ai' });
    if (aiMemoList.length > AI_MEMO_MAX) {
        aiMemoList.splice(0, aiMemoList.length - AI_MEMO_MAX);
    }
    saveAiMemos();
    // Settings 画面が開いていれば textarea を更新
    const ta = document.getElementById('ai-memo-textarea');
    if (ta && document.activeElement !== ta) ta.value = aiMemoListToText();
    const cnt = document.getElementById('ai-memo-count');
    if (cnt) cnt.textContent = String(aiMemoList.length);
}

function aiMemoListToText() {
    return aiMemoList.map(m => m.text).join('\n');
}

function textToAiMemoList(text) {
    const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
    return lines.map(t => ({ text: t, ts: Date.now(), source: 'user' }));
}

/**
 * AI 応答テキストから [MEMO: 〜] タグを抽出し aiMemoList に追加。
 * 戻り値はタグを除去したテキスト（チャット表示用にクリーンにする）。
 * 改行を含む可能性があるため [\s\S] で複数行対応。
 */
function parseAndStoreAiMemoTags(text) {
    if (!aiMemoEnabled || !text) return text;
    const re = /\[MEMO:\s*([\s\S]+?)\]/g;
    let count = 0;
    const cleaned = text.replace(re, (match, content) => {
        addAiMemo(content, 'ai');
        count++;
        return ''; // 表示文からタグ除去
    });
    if (count > 0) console.log('[AiMemo] ' + count + ' entries parsed');
    return cleaned;
}

/**
 * Universe Report 応答を検出し、「学習量: 低い」の場合に世界観名で自動 Web Search → AI Memo 化。
 * 発火条件:
 *   - webSearchEnabled かつ aiMemoEnabled (両方 ON)
 *   - 応答に "📓学習量: 低い / ほぼ知識なし / 不明" 等が含まれる
 *   - 応答に "🌎️世界観: 〜" の行がある
 *   - 同じ世界観で過去に自動検索済みなら重複スキップ
 * fire-and-forget: 呼び出し側は await しない。
 */
function detectUniverseReportAndAutoSearch(replyText) {
    if (!replyText) return;
    if (!webSearchEnabled || !aiMemoEnabled) return;
    const learningMatch = replyText.match(/📓[\s️]*学習量[:：]\s*([^\n]+)/);
    if (!learningMatch) return;
    const learning = learningMatch[1].trim();
    if (!/低い|ほぼ知識なし|不明|low|none|unknown/i.test(learning)) return;
    const worldMatch = replyText.match(/🌎[\s️️]*世界観[:：]\s*([^\n]+)/);
    if (!worldMatch) return;
    const worldName = worldMatch[1].trim().replace(/^[『「]|[』」]$/g, '');
    if (!worldName || worldName.length > 80) return;
    const tagPrefix = '[Auto Search: ' + worldName + ']';
    if (aiMemoList.some(m => (m.text || '').startsWith(tagPrefix))) {
        console.log('[AutoSearch] already searched for:', worldName);
        return;
    }
    (async () => {
        const badgeQuery = '🤖自動: ' + worldName;
        console.log('[AutoSearch] Low learning detected (' + learning + ') → searching:', worldName);
        appendWebSearchBadge(badgeQuery, 'searching');
        try {
            const query = worldName + ' あらすじ 登場人物 設定';
            const r = await performWebSearch(query, { bypassCooldown: true });
            if (r.results && r.results.length) {
                updateWebSearchBadge(badgeQuery, 'done', r.results.length + ' 件 → AI Memo に記録');
                r.results.slice(0, 4).forEach((x, i) => {
                    const text = (x.snippet || x.title || '').replace(/\s+/g, ' ').slice(0, 400);
                    if (text) addAiMemo(tagPrefix + ' [' + (i + 1) + '] ' + text, 'auto-search');
                });
            } else {
                updateWebSearchBadge(badgeQuery, 'error', r.error ? String(r.error).slice(0, 60) : '失敗');
            }
        } catch (e) {
            console.warn('[AutoSearch] error:', e);
            updateWebSearchBadge(badgeQuery, 'error', String(e).slice(0, 60));
        }
    })();
}

function formatAiMemoForPrompt() {
    // メモが空でも、AI Memo 有効なら必ず指示を注入する（AI に機能の存在を知らせる）
    if (!aiMemoEnabled) return '';
    let s = '\n\n========== AI Memo (継続記憶システム / 必須使用) ==========\n';
    s += '🚨 重要: 以下に該当する情報が応答内に出てきたら、必ず応答中のどこかに [MEMO: 内容] タグを書き加えてください。\n';
    s += '・世界観・作品の核心設定（ルール、組織構造、世界の理）\n';
    s += '・キャラクターの素性、能力、秘密、関係性\n';
    s += '・約束・伏線・過去の重要な出来事\n';
    s += '・Web Search 結果から判明した重要事実\n';
    s += '・プレイヤーが明示した設定や事実\n\n';
    s += '【記法】応答中のどこに書いてもよい（ナレーションの中でも、行末でも）。タグ自体はユーザー表示時に自動除去されます。\n';
    s += '【例】[MEMO: 御子神典明は鬼神で、東方不敗・アカーシャと並ぶ三大妖怪の一柱]\n';
    s += '【例】[MEMO: ナナシは相良一族当主候補で、悪魔召喚士として陽海学園に編入]\n';
    s += '【例】[MEMO: ロザリオとバンパイア主要キャラ: 赤夜萌香(吸血鬼), 黒乃胡夢(サキュバス), 仙童紫(魔女), 白雪みぞれ(雪女), 朱染心愛(人間)]\n\n';
    if (aiMemoList.length) {
        s += '【既存メモ - 参照して矛盾しない応答をすること】\n';
        const recent = aiMemoList.slice(-AI_MEMO_INJECT_RECENT);
        recent.forEach(m => { s += '・' + m.text + '\n'; });
    } else {
        s += '【既存メモ】まだ記録なし。この応答で必ず1つ以上の [MEMO: 〜] を残してください。\n';
    }
    s += '===========================================================\n';
    return s;
}

/**
 * ユーザー入力から検索が必要か判定する。
 * 戻り値: { trigger, query } or null
 */
function shouldPerformWebSearch(userMessage) {
    if (!webSearchEnabled) { console.log('[WebSearch] disabled'); return null; }
    if (pureChatMode) return null; // 純チャットは注入経路がないため検索しない
    if (!userMessage) return null;
    // 1. 明示トリガー [search:〜]（RP本文中に埋め込まれていても発動・クールダウン無視）
    const m = userMessage.match(/\[search:\s*([^\]\n]+)\]/i);
    if (m) {
        const q = m[1].replace(/[　\s]+/g, ' ').trim();
        console.log('[WebSearch] explicit trigger:', q);
        return { trigger: 'explicit', query: q, bypassCooldown: true };
    }
    // 2. 🔍 ボタンによる強制（クールダウン無視）
    if (_forceSearchNextSend) {
        _forceSearchNextSend = false;
        updateWebSearchToggleBtnUI();
        console.log('[WebSearch] manual (toggle) trigger:', userMessage.slice(0, 50));
        return { trigger: 'manual', query: userMessage.slice(0, 200).trim(), bypassCooldown: true };
    }
    // 3. キーワードルール（自動）
    if (!webSearchAutoTrigger) return null;
    const patterns = [
        /最新の|現在の|今(の|現在|どう)|直近の|本日の|今日の|今週の/,
        /ニュース|事件|速報|アップデート|リリース/,
        /って何\??|とは何\??|ですか\?|どう違|どこ(に|で|の)|いつ(ある|まで|から)|何時/,
        /検索して|調べて|教えて(.{0,5})?(最新|現在|今|事実)/,
    ];
    if (patterns.some(p => p.test(userMessage))) {
        return { trigger: 'auto', query: userMessage.slice(0, 200) };
    }
    return null;
}

async function _searchTavily(query, signal) {
    if (!tavilyApiKey) throw new Error('Tavily API キーが未設定です');
    const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: tavilyApiKey,
            query,
            max_results: webSearchMaxResults,
            include_answer: true,
            search_depth: 'basic'
        }),
        signal
    });
    if (!res.ok) throw new Error('Tavily API HTTP ' + res.status);
    const data = await res.json();
    const out = [];
    if (data.answer) {
        out.push({ title: 'Tavily Answer', url: '', snippet: String(data.answer) });
    }
    (data.results || []).forEach(r => {
        out.push({
            title: r.title || '',
            url: r.url || '',
            snippet: r.content || r.snippet || ''
        });
    });
    return out;
}

async function _searchDuckDuckGo(query, signal) {
    const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query)
        + '&format=json&no_redirect=1&no_html=1';
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error('DuckDuckGo API HTTP ' + res.status);
    const data = await res.json();
    const out = [];
    if (data.AbstractText) {
        out.push({
            title: data.Heading || 'DuckDuckGo Abstract',
            url: data.AbstractURL || '',
            snippet: data.AbstractText
        });
    }
    if (data.Answer) {
        out.push({ title: 'Instant Answer', url: '', snippet: String(data.Answer) });
    }
    const flat = [];
    (data.RelatedTopics || []).forEach(t => {
        if (t.Text) flat.push(t);
        if (Array.isArray(t.Topics)) t.Topics.forEach(t2 => { if (t2.Text) flat.push(t2); });
    });
    flat.slice(0, webSearchMaxResults).forEach(t => {
        out.push({
            title: (t.Text || '').split(' - ')[0].slice(0, 80),
            url: t.FirstURL || '',
            snippet: t.Text || ''
        });
    });
    return out.slice(0, webSearchMaxResults);
}

/**
 * 検索実行。キャッシュ / クールダウン / プロバイダー選択 / fetch を処理。
 * 戻り値: { results, fromCache, provider } or { results: null, error, secondsLeft? }
 */
async function performWebSearch(query, opts) {
    opts = opts || {};
    // 3a. キャッシュチェック
    const cached = _webSearchCache.get(query);
    if (cached && (Date.now() - cached.timestamp) < WEB_SEARCH_CACHE_TTL_MS) {
        return { results: cached.results, fromCache: true, provider: cached.provider };
    }
    // 3b. クールダウンチェック（bypassCooldown オプションで無効化可能）
    if (!opts.bypassCooldown) {
        const since = (Date.now() - _lastWebSearchTime) / 1000;
        if (_lastWebSearchTime > 0 && since < webSearchCooldownSec) {
            return { results: null, error: 'cooldown', secondsLeft: Math.ceil(webSearchCooldownSec - since) };
        }
    }
    _lastWebSearchTime = Date.now();

    // 3c. プロバイダー選択
    let provider = webSearchProvider;
    if (provider === 'auto') provider = (tavilyApiKey ? 'tavily' : 'ddg');

    // 3d. fetch (AbortController + timeoutSec)
    const ctrl = new AbortController();
    const timeoutSec = (typeof apiConfig !== 'undefined' && apiConfig.timeoutSec) ? apiConfig.timeoutSec : 60;
    const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
    try {
        let results;
        if (provider === 'tavily') results = await _searchTavily(query, ctrl.signal);
        else                       results = await _searchDuckDuckGo(query, ctrl.signal);
        _webSearchCache.set(query, { results, timestamp: Date.now(), provider });
        return { results, fromCache: false, provider };
    } catch (e) {
        return { results: null, error: e.message || String(e) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 検索結果を system prompt に注入する文字列形式に整形。
 */
function formatWebSearchForPrompt(query, results) {
    if (!results || !results.length) return '';
    let s = '\n\n========== Web Search Results ==========\n'
        + '以下はユーザー入力「' + query + '」に関連する直近のウェブ検索結果です。\n'
        + 'これを参考にして応答してよいが、ロールプレイの没入感を損なわないよう自然に織り込むこと。\n'
        + '出典 URL は必要時のみキャラの発言外（ナレーション内）に明示する。\n\n';
    results.forEach((r, i) => {
        s += '[' + (i + 1) + '] ' + (r.title || '(no title)') + '\n';
        if (r.url) s += 'URL: ' + r.url + '\n';
        if (r.snippet) s += r.snippet + '\n';
        s += '\n';
    });
    s += '========================================\n';
    return s;
}

// バッジ DOM 操作（チャットメッセージリストに 🔍 通知を表示）
function appendWebSearchBadge(query, state) {
    const list = document.getElementById('chat-messages') || document.getElementById('chat-list');
    if (!list) return null;
    const badge = document.createElement('div');
    badge.className = 'web-search-badge';
    badge.dataset.state = state || 'searching';
    badge.dataset.query = query;
    const stateLabel = state === 'searching' ? '検索中' : '検索';
    badge.innerHTML = '🔍 ' + stateLabel + ': '
        + '<span class="ws-query"></span> '
        + '<span class="ws-status">…</span>';
    badge.querySelector('.ws-query').textContent = query;
    if (webSearchShowDebug) {
        badge.style.cursor = 'pointer';
        badge.addEventListener('click', () => {
            const cached = _webSearchCache.get(query);
            if (!cached) return;
            const pre = badge.querySelector('pre.ws-debug');
            if (pre) { pre.remove(); return; }
            const p = document.createElement('pre');
            p.className = 'ws-debug';
            p.style.cssText = 'font-size:0.75em; max-height:200px; overflow:auto; white-space:pre-wrap; background:rgba(0,0,0,0.3); padding:0.5em; margin-top:0.5em;';
            p.textContent = JSON.stringify(cached.results, null, 2);
            badge.appendChild(p);
        });
    }
    list.appendChild(badge);
    badge.scrollIntoView({ block: 'end' });
    return badge;
}

function updateWebSearchBadge(query, state, statusText) {
    const list = document.getElementById('chat-messages') || document.getElementById('chat-list');
    if (!list) return;
    const badges = list.querySelectorAll('.web-search-badge');
    for (let i = badges.length - 1; i >= 0; i--) {
        const b = badges[i];
        if (b.dataset.query === query) {
            b.dataset.state = state;
            const status = b.querySelector('.ws-status');
            if (status) status.textContent = statusText || (state === 'done' ? '✓' : state === 'error' ? '失敗' : '');
            return;
        }
    }
}

function updateWebSearchToggleBtnUI() {
    const btn = document.getElementById('web-search-toggle-btn');
    if (!btn) return;
    btn.style.display = webSearchEnabled ? '' : 'none';
    btn.classList.toggle('active', !!_forceSearchNextSend);
    btn.title = _forceSearchNextSend
        ? '🔍 強制検索 ON（次回送信で検索発動）'
        : '🔍 次回送信で強制検索する';
}

// 🔍 トグルボタンのクリックハンドラ単独セットアップ
// （setupSettings は Settings 画面を開かない限り走り切らない可能性に備え、
//   init() から独立して呼ぶ）
function setupWebSearchToggleBtn() {
    const btn = document.getElementById('web-search-toggle-btn');
    if (!btn) {
        console.warn('[WebSearch] toggle button not found in DOM');
        return;
    }
    if (btn._webSearchBound) return;
    btn._webSearchBound = true;
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        _forceSearchNextSend = !_forceSearchNextSend;
        console.log('[WebSearch] toggle clicked → _forceSearchNextSend =', _forceSearchNextSend);
        updateWebSearchToggleBtnUI();
    });
    updateWebSearchToggleBtnUI();
    console.log('[WebSearch] toggle button bound');
}

async function fetchVoicevoxSpeakers() {
    try {
        const response = await fetch('http://localhost:50021/speakers');
        if (!response.ok) throw new Error('VOICEVOX speakers fetch failed');
        voicevoxSpeakers = await response.json();
        console.log('[TTS] VOICEVOX speakers loaded:', voicevoxSpeakers.length);
        return voicevoxSpeakers;
    } catch (e) {
        console.warn('[TTS] VOICEVOX is not available (or not running on port 50021):', e.message);
        voicevoxSpeakers = [];
        return [];
    }
}

// VOICEVOX 接続診断: バージョン取得を試みて結果を返す
// 戻り値: { ok: bool, message: string, version?: string, speakerCount?: number }
async function checkVoicevoxConnection() {
    try {
        const verRes = await fetch('http://localhost:50021/version');
        if (!verRes.ok) {
            return { ok: false, message: 'HTTP ' + verRes.status + ' — VOICEVOX エンジンが応答していません' };
        }
        const version = await verRes.json();
        // バージョン取れたらスピーカーも再フェッチ
        await fetchVoicevoxSpeakers();
        return {
            ok: true,
            message: '✅ 接続 OK (v' + version + ', スピーカー ' + voicevoxSpeakers.length + ' 件)',
            version: version,
            speakerCount: voicevoxSpeakers.length
        };
    } catch (e) {
        // typical: "Failed to fetch" = 接続不可、CORS、エンジン未起動
        let hint = '';
        if (e.message && e.message.includes('Failed to fetch')) {
            hint = '\n対処:\n  ① VOICEVOX を起動（GUI を開くだけでなくエンジンも動作している必要あり）\n  ② http://localhost:50021/version を直接ブラウザで開いて応答するか確認\n  ③ ポート番号が 50021 か確認（VOICEVOX 設定 → エンジン）\n  ④ CORS 設定を確認（VOICEVOX 設定 → 詳細 → CORS）';
        }
        return { ok: false, message: '❌ ' + (e.message || '不明なエラー') + hint };
    }
}

// Settings の VOICEVOX 状態表示を更新
async function updateVoicevoxStatusDisplay() {
    const textEl = document.getElementById('voicevox-status-text');
    if (!textEl) return;
    textEl.textContent = '確認中...';
    textEl.style.color = 'var(--text-secondary)';
    const result = await checkVoicevoxConnection();
    textEl.textContent = result.message.split('\n')[0]; // 1行目だけ表示
    textEl.style.color = result.ok ? '#80e0a0' : '#ff8080';
    // スピーカー一覧が更新されたので、ナレーター voice select も再描画
    const nvSpeakerEl = document.getElementById('narrator-voice-speaker');
    const nvEngineEl = document.getElementById('narrator-voice-engine');
    if (nvSpeakerEl && nvEngineEl && nvEngineEl.value === 'voicevox') {
        const currentSpeaker = (narratorVoice && narratorVoice.speakerId !== undefined) ? String(narratorVoice.speakerId) : '';
        populateSpeakerSelect(nvSpeakerEl, 'voicevox', currentSpeaker);
    }
}

// 現在の Settings 入力値（保存前）から voice config を組み立てて speakText で再生
async function testNarratorVoice() {
    const nvEngineEl  = document.getElementById('narrator-voice-engine');
    const nvSpeakerEl = document.getElementById('narrator-voice-speaker');
    const nvPitchEl   = document.getElementById('narrator-voice-pitch');
    const nvSpeedEl   = document.getElementById('narrator-voice-speed');
    if (!nvEngineEl) return;

    const engine = nvEngineEl.value || 'none';
    if (engine === 'none') {
        alert('エンジンを「Web Speech API」または「VOICEVOX」に設定してください。');
        return;
    }
    const spVal = nvSpeakerEl ? nvSpeakerEl.value : '';
    if (!spVal) {
        alert('スピーカーが選択されていません。エンジンを変更後、リストから 1 つ選んでください。');
        return;
    }
    const pitch = nvPitchEl ? parseFloat(nvPitchEl.value) || 1.0 : 1.0;
    const speed = nvSpeedEl ? parseFloat(nvSpeedEl.value) || 1.0 : 1.0;
    const testVoice = {
        engine,
        speakerId: (engine === 'voicevox') ? spVal : '',
        voiceURI:  (engine === 'webspeech') ? spVal : '',
        pitch, speed
    };

    // 既存キュー/再生を停止
    if (currentTtsAudio) {
        try { currentTtsAudio.pause(); } catch(e){}
        currentTtsAudio = null;
    }
    window.speechSynthesis.cancel();
    ttsQueue = [];
    isPlayingTts = false;

    // 直接 speakTextCore を呼んで詳細エラーを拾う
    const testText = 'テスト再生です。聞こえますか？';
    try {
        await new Promise((resolve, reject) => {
            // speakTextCore 内でエラー時に onEnd を呼ぶので、別途エラーキャッチが必要
            // 一旦 try-catch でラップした関数を作る
            (async () => {
                try {
                    await speakTextCoreWithError(testText, testVoice, true);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            })();
        });
    } catch (e) {
        alert('🔊 テスト再生エラー:\n' + e.message);
    }
}

// speakTextCore のエラーをちゃんと throw するバージョン（診断用）
async function speakTextCoreWithError(text, voiceConfig, isNarration) {
    if (!voiceConfig || voiceConfig.engine === 'none') throw new Error('voice config が none です');
    const dialogue = extractDialogue(text, !!isNarration);
    if (!dialogue) throw new Error('読み上げ対象のテキストが空です（メタタグ除去後に何も残らなかった）');

    const pitch = voiceConfig.pitch !== undefined ? parseFloat(voiceConfig.pitch) : 1.0;
    const speed = voiceConfig.speed !== undefined ? parseFloat(voiceConfig.speed) : 1.0;

    if (voiceConfig.engine === 'webspeech') {
        return new Promise((resolve, reject) => {
            if (!('speechSynthesis' in window)) {
                reject(new Error('このブラウザは Web Speech API に対応していません'));
                return;
            }
            const utterance = new SpeechSynthesisUtterance(dialogue);
            if (voiceConfig.voiceURI) {
                const voices = window.speechSynthesis.getVoices();
                const voice = voices.find(v => v.voiceURI === voiceConfig.voiceURI);
                if (voice) utterance.voice = voice;
            }
            utterance.pitch = pitch;
            utterance.rate = speed;
            utterance.onend = () => resolve();
            utterance.onerror = (e) => reject(new Error('Web Speech エラー: ' + (e.error || '不明')));
            window.speechSynthesis.speak(utterance);
        });
    }

    if (voiceConfig.engine === 'voicevox') {
        const speakerId = voiceConfig.speakerId !== undefined ? parseInt(voiceConfig.speakerId) : 0;
        if (isNaN(speakerId)) throw new Error('speakerId が数値に変換できません: ' + voiceConfig.speakerId);

        let queryRes;
        try {
            const queryUrl = `http://localhost:50021/audio_query?text=${encodeURIComponent(dialogue)}&speaker=${speakerId}`;
            queryRes = await fetch(queryUrl, { method: 'POST' });
        } catch (e) {
            throw new Error('VOICEVOX に接続できません: ' + e.message + '\n→ エンジンが起動しているか確認');
        }
        if (!queryRes.ok) throw new Error('VOICEVOX audio_query 失敗: HTTP ' + queryRes.status);
        const queryJson = await queryRes.json();
        queryJson.pitchScale = pitch - 1.0;
        queryJson.speedScale = speed;

        let synthRes;
        try {
            synthRes = await fetch(`http://localhost:50021/synthesis?speaker=${speakerId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(queryJson)
            });
        } catch (e) {
            throw new Error('VOICEVOX synthesis 接続失敗: ' + e.message);
        }
        if (!synthRes.ok) throw new Error('VOICEVOX synthesis 失敗: HTTP ' + synthRes.status);

        const wavBlob = await synthRes.blob();
        if (!wavBlob || wavBlob.size === 0) throw new Error('VOICEVOX から空の音声データが返りました');

        const audioUrl = URL.createObjectURL(wavBlob);
        return new Promise((resolve, reject) => {
            currentTtsAudio = new Audio(audioUrl);
            currentTtsAudio.onended = () => resolve();
            currentTtsAudio.onerror = (e) => reject(new Error('Audio 再生エラー（ブラウザ autoplay 制限の可能性）'));
            // 再生試行 — autoplay 制限に引っかかると Promise reject
            const playPromise = currentTtsAudio.play();
            if (playPromise && playPromise.catch) {
                playPromise.catch(err => {
                    reject(new Error('audio.play() 失敗: ' + (err.message || err.name) + '\n→ ブラウザの autoplay 制限の可能性。ページ上で何か操作してから再試行してください。'));
                });
            }
        });
    }

    throw new Error('未知のエンジン: ' + voiceConfig.engine);
}

function getWebSpeechVoices() {
    const allVoices = window.speechSynthesis.getVoices();
    const jaVoices = allVoices.filter(v => v.lang.includes('ja') || v.lang.includes('JP'));
    return jaVoices.length > 0 ? jaVoices : allVoices;
}

// 指定された select 要素にエンジン別スピーカー一覧を populate する汎用版
// （キャラクター編集と Settings ナレーター音声で共用）
function populateSpeakerSelect(selectEl, engine, currentSpeakerVal) {
    if (!selectEl) return;
    selectEl.innerHTML = '';

    if (engine === 'none') {
        selectEl.disabled = true;
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '音声なし';
        selectEl.appendChild(opt);
        return;
    }

    selectEl.disabled = false;

    if (engine === 'webspeech') {
        const voices = getWebSpeechVoices();
        if (voices.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '利用可能なSpeech APIボイスがありません';
            selectEl.appendChild(opt);
        } else {
            voices.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v.voiceURI;
                opt.textContent = `${v.name} (${v.lang})`;
                if (v.voiceURI === currentSpeakerVal) opt.selected = true;
                selectEl.appendChild(opt);
            });
        }
    } else if (engine === 'voicevox') {
        if (voicevoxSpeakers.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'VOICEVOXに接続できませんでした';
            selectEl.appendChild(opt);
        } else {
            voicevoxSpeakers.forEach(s => {
                s.styles.forEach(style => {
                    const opt = document.createElement('option');
                    opt.value = style.id;
                    opt.textContent = `${s.name} (${style.name})`;
                    if (String(style.id) === String(currentSpeakerVal)) opt.selected = true;
                    selectEl.appendChild(opt);
                });
            });
        }
    }
}

function updateSpeakerSelect(engine, currentSpeakerVal) {
    const select = document.getElementById('edit-char-voice-speaker');
    if (!select) return;
    select.innerHTML = '';
    
    if (engine === 'none') {
        select.disabled = true;
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '音声なし';
        select.appendChild(opt);
        return;
    }
    
    select.disabled = false;
    
    if (engine === 'webspeech') {
        const voices = getWebSpeechVoices();
        if (voices.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '利用可能なSpeech APIボイスがありません';
            select.appendChild(opt);
        } else {
            voices.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v.voiceURI;
                opt.textContent = `${v.name} (${v.lang})`;
                if (v.voiceURI === currentSpeakerVal) {
                    opt.selected = true;
                }
                select.appendChild(opt);
            });
        }
    } else if (engine === 'voicevox') {
        if (voicevoxSpeakers.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'VOICEVOXに接続できませんでした';
            select.appendChild(opt);
        } else {
            voicevoxSpeakers.forEach(s => {
                s.styles.forEach(style => {
                    const opt = document.createElement('option');
                    opt.value = style.id;
                    opt.textContent = `${s.name} (${style.name})`;
                    if (String(style.id) === String(currentSpeakerVal)) {
                        opt.selected = true;
                    }
                    select.appendChild(opt);
                });
            });
        }
    }
}

function updateAutoplayTtsButton() {
    const btn = document.getElementById('autoplay-tts-toggle');
    if (!btn) return;
    // .active クラスだけで切替（CSS 側で色・グロー処理）
    btn.classList.toggle('active', !!autoplayTts);
}

// 読み上げ対象テキスト抽出。
// - 通常モード (isNarration=false): 「」『』""内のセリフのみ抽出。なければ *() （）を除去した全文。
// - ナレーションモード (isNarration=true): 全文を読み上げる。装飾系記号と内側の「」マークだけ除去。
function extractDialogue(text, isNarration) {
    if (!text) return '';
    if (isNarration) {
        let cleaned = text;
        // 思考タグ・SPEAKER タグ・STATUS タグ等のメタ情報を除去
        cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
        cleaned = cleaned.replace(/\[SPEAKER:\s*[^\]]+\]/gi, '');
        cleaned = cleaned.replace(/\[STATUS:[^\]]+\]/gi, '');
        cleaned = cleaned.replace(/\[INFO\][\s\S]*?\[\/INFO\]/gi, '');
        cleaned = cleaned.replace(/\[CHOICES\][\s\S]*?\[\/CHOICES\]/gi, '');
        cleaned = cleaned.replace(/\{img:[^}]*\}/gi, ''); // 画像タグは読み上げない
        // マークダウン強調記号と動作記号を除去
        cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '$1');
        cleaned = cleaned.replace(/\*(.*?)\*/g, '$1');
        // 「」『』そのものの記号は除去（中身は読む）
        cleaned = cleaned.replace(/[「『""」』""]/g, '');
        // 連続改行を1つに圧縮
        cleaned = cleaned.replace(/\n{2,}/g, '\n').trim();
        return cleaned;
    }

    // 通常モード（キャラ発言）: 「」内の「実際に声に出すセリフ」だけ抽出。
    // 『』（）※ 等（心の声・強調・作品名）は読み上げ対象外とする。
    // ※ セリフと強調で同じ「」を使うと区別できないため、AI 側に
    //    「発話は「」、強調・心の声は（）や※」と書き分けさせる directive を併用する。
    const bracketsRegex = /「([^」]*)」/g;
    let matches = [];
    let match;
    while ((match = bracketsRegex.exec(text)) !== null) {
        if (match[1] && match[1].trim()) {
            matches.push(match[1].trim());
        }
    }

    if (matches.length > 0) {
        return matches.join(' ');
    }

    // フォールバック: 「」がなければ装飾記号・心の声を除去した全文（旧来挙動）
    let cleaned = text;
    cleaned = cleaned.replace(/\*.*?\*/g, '');
    cleaned = cleaned.replace(/\(.*?\)/g, '');
    cleaned = cleaned.replace(/（.*?）/g, '');
    cleaned = cleaned.replace(/『.*?』/g, ''); // 強調・作品名も除外
    return cleaned.trim();
}

// 長文を TTS 用に句読点・改行で分割する。
// VOICEVOX は長文を1リクエストで投げると途中で切れるため、チャンク化して逐次再生する。
// maxLen を超える単一文は読点(、)で強制分割し、それも無ければ maxLen で機械的に切る。
function splitForTts(text, maxLen) {
    if (!text) return [];
    maxLen = maxLen || 120;
    // 文末記号（。！？!? と改行）の直後で区切る
    const sentences = text.split(/(?<=[。！？!?\n])/);
    const chunks = [];
    let buf = '';
    for (let s of sentences) {
        if (!s) continue;
        if (buf && (buf + s).length > maxLen) {
            chunks.push(buf);
            buf = s;
        } else {
            buf += s;
        }
        // 単一文が maxLen 超 → 読点で分割、無ければ機械切り
        while (buf.length > maxLen) {
            let cut = buf.lastIndexOf('、', maxLen);
            cut = (cut > 0) ? cut + 1 : maxLen;
            chunks.push(buf.slice(0, cut));
            buf = buf.slice(cut);
        }
    }
    if (buf.trim()) chunks.push(buf);
    return chunks.map(c => c.trim()).filter(c => c);
}

function playNextTts() {
    if (ttsQueue.length === 0) {
        isPlayingTts = false;
        return;
    }

    isPlayingTts = true;
    const { text, voiceConfig, isNarration } = ttsQueue.shift();

    speakTextCore(text, voiceConfig, () => {
        playNextTts();
    }, isNarration);
}

// queueTts(text, voiceConfig, isNarration=false)
// isNarration=true のときは extractDialogue がナレーションモード（全文読み）になる
function queueTts(text, voiceConfig, isNarration) {
    if (!voiceConfig || voiceConfig.engine === 'none') return;
    ttsQueue.push({ text, voiceConfig, isNarration: !!isNarration });
    if (!isPlayingTts) {
        playNextTts();
    }
}

async function speakTextCore(text, voiceConfig, onEnd, isNarration) {
    if (!voiceConfig || voiceConfig.engine === 'none') {
        if (onEnd) onEnd();
        return;
    }

    const dialogue = extractDialogue(text, !!isNarration);
    if (!dialogue) {
        if (onEnd) onEnd();
        return;
    }

    const pitch = voiceConfig.pitch !== undefined ? parseFloat(voiceConfig.pitch) : 1.0;
    const speed = voiceConfig.speed !== undefined ? parseFloat(voiceConfig.speed) : 1.0;

    if (voiceConfig.engine === 'webspeech') {
        // 長文はチャンク分割して逐次発話（途中切れ防止）
        const chunks = splitForTts(dialogue, 200);
        let ci = 0;
        const speakChunk = () => {
            if (ci >= chunks.length) { if (onEnd) onEnd(); return; }
            const utterance = new SpeechSynthesisUtterance(chunks[ci++]);
            if (voiceConfig.voiceURI) {
                const voices = window.speechSynthesis.getVoices();
                const voice = voices.find(v => v.voiceURI === voiceConfig.voiceURI);
                if (voice) utterance.voice = voice;
            }
            utterance.pitch = pitch;
            utterance.rate = speed;
            utterance.onend = () => speakChunk();
            utterance.onerror = () => speakChunk(); // エラーでも次チャンクへ
            window.speechSynthesis.speak(utterance);
        };
        speakChunk();
    } else if (voiceConfig.engine === 'voicevox') {
        const speakerId = voiceConfig.speakerId !== undefined ? parseInt(voiceConfig.speakerId) : 0;
        // 長文はチャンク分割して逐次合成・再生（VOICEVOX の途中切れ対策）
        const chunks = splitForTts(dialogue, 120);
        let ci = 0;
        const playChunk = async () => {
            if (ci >= chunks.length) { if (onEnd) onEnd(); return; }
            const chunk = chunks[ci++];
            try {
                const queryUrl = `http://localhost:50021/audio_query?text=${encodeURIComponent(chunk)}&speaker=${speakerId}`;
                const queryRes = await fetch(queryUrl, { method: 'POST' });
                if (!queryRes.ok) throw new Error('VOICEVOX audio_query failed');
                const queryJson = await queryRes.json();

                queryJson.pitchScale = pitch - 1.0;
                queryJson.speedScale = speed;

                const synthUrl = `http://localhost:50021/synthesis?speaker=${speakerId}`;
                const synthRes = await fetch(synthUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(queryJson)
                });
                if (!synthRes.ok) throw new Error('VOICEVOX synthesis failed');
                const wavBlob = await synthRes.blob();
                const audioUrl = URL.createObjectURL(wavBlob);
                currentTtsAudio = new Audio(audioUrl);

                currentTtsAudio.onended = () => { URL.revokeObjectURL(audioUrl); playChunk(); };
                currentTtsAudio.onerror = () => { URL.revokeObjectURL(audioUrl); playChunk(); };

                currentTtsAudio.play();
            } catch (e) {
                console.error('[TTS] VOICEVOX playback failed:', e.message);
                playChunk(); // 失敗しても次チャンクへ進める
            }
        };
        playChunk();
    }
}

// 単発再生（🔊ボタンクリックなど）。既存キューと再生を停止してから新規再生。
/**
 * スピーカー名と該当 NPC データから TTS で使う voice config を解決する。
 *
 * 優先順位:
 *   1. ナレーション話者（'ナレーション' / 'Narrator' / 'narrator'）→ narratorVoice (isNarration=true)
 *   2. NPC 専用 voice が設定されている → realMember.voice
 *   3. キャラ専用 voice なし & narratorVoice が設定済み → narratorVoice をデフォルトとして使う
 *   4. どれもなし → null（無音）
 *
 * 戻り値: { voice, isNarration } or null
 */
/**
 * 有効なナレーター音声設定を返す。
 * モジュール変数 narratorVoice が未保存（engine='none'）の場合は
 * Settings DOM から直接読み取ってフォールバックとする。
 * これにより「Save Settings を押さなくても」テスト再生と同じ設定で動作する。
 */
function getEffectiveNarratorVoice() {
    if (narratorVoice && narratorVoice.engine && narratorVoice.engine !== 'none') {
        return narratorVoice;
    }
    // DOM フォールバック（Settings が開かれ値が入力されているが未保存の場合）
    const nvEngineEl  = document.getElementById('narrator-voice-engine');
    const nvSpeakerEl = document.getElementById('narrator-voice-speaker');
    const nvPitchEl   = document.getElementById('narrator-voice-pitch');
    const nvSpeedEl   = document.getElementById('narrator-voice-speed');
    if (nvEngineEl && nvEngineEl.value && nvEngineEl.value !== 'none') {
        const engine = nvEngineEl.value;
        const spVal  = nvSpeakerEl ? nvSpeakerEl.value : '';
        return {
            engine,
            speakerId: engine === 'voicevox' ? spVal : '',
            voiceURI:  engine === 'webspeech' ? spVal : '',
            pitch: nvPitchEl ? parseFloat(nvPitchEl.value) || 1.0 : 1.0,
            speed: nvSpeedEl ? parseFloat(nvSpeedEl.value) || 1.0 : 1.0,
        };
    }
    return null;
}

function resolveTtsVoice(speakerName, realMember) {
    const isNarSpeaker = (
        speakerName === 'ナレーション'
        || speakerName === 'Narrator'
        || speakerName === 'narrator'
        || speakerName === 'ナレーター'
    );
    const effectiveNarrator = getEffectiveNarratorVoice();
    if (isNarSpeaker) {
        if (effectiveNarrator) {
            return { voice: effectiveNarrator, isNarration: true };
        }
        return null;
    }
    // キャラ専用 voice 優先
    if (realMember && realMember.voice && realMember.voice.engine && realMember.voice.engine !== 'none') {
        return { voice: realMember.voice, isNarration: false };
    }
    // フォールバック: キャラ専用 voice 未設定 → narratorVoice をデフォルトとして使う
    // （isNarration=false なのでセリフ「」内のみ読み上げる）
    if (effectiveNarrator) {
        return { voice: effectiveNarrator, isNarration: false };
    }
    return null;
}

async function speakText(text, voiceConfig, isNarration) {
    if (currentTtsAudio) {
        currentTtsAudio.pause();
        currentTtsAudio = null;
    }
    window.speechSynthesis.cancel();

    ttsQueue = [];
    isPlayingTts = false;

    queueTts(text, voiceConfig, !!isNarration);
}

// Banter で掛け合いに参加するメンバーを明示選択した場合のオーバーライド配列。
// null のときは getActivePartyMembers() の結果をそのまま使う（旧来の挙動）。
// fetchChatCompletion('banter' | 'banter_player') 内で参照される。
let _banterMembersOverride = null;

// ======== DICE ROLL (xoroshiro128+) ========
class Xoroshiro128Plus {
    constructor(seed = Date.now()) {
        // 128bit 状態を 32bit×4 で保持
        this._s = [
            seed >>> 0,
            (seed / 0x100000000) >>> 0,
            0x9e3779b9,
            0x6c62272e
        ];
    }
    _rotl32(x, k) {
        return ((x << k) | (x >>> (32 - k))) >>> 0;
    }
    next() {
        const [s0, s1, s2, s3] = this._s;
        const result = (s0 + s3) >>> 0;
        const t = (s1 << 9) >>> 0;
        this._s[2] = (this._s[2] ^ s0) >>> 0;
        this._s[3] = (this._s[3] ^ s1) >>> 0;
        this._s[1] = (this._s[1] ^ s2) >>> 0;
        this._s[0] = (this._s[0] ^ s3) >>> 0;
        this._s[2] = (this._s[2] ^ t) >>> 0;
        this._s[3] = this._rotl32(this._s[3], 11);
        return result;
    }
    // 1..sides の整数を返す（rejection sampling で均一性確保）
    roll(sides) {
        // sides が 2 の累乗の場合、0x100000000 % sides === 0 となり
        // (0x100000000 - 0) >>> 0 = 0 にラップして無限ループになるため直接 % を使う
        // （2^32 が sides で割り切れる場合は全ての乱数値が均一に使える）
        const mod = 0x100000000 % sides;
        if (mod === 0) {
            return (this.next() % sides) + 1;
        }
        const limit = (0x100000000 - mod) >>> 0;
        let r;
        do { r = this.next(); } while (r >= limit);
        return (r % sides) + 1;
    }
}
const rng = new Xoroshiro128Plus();

// "2d6", "d20", "1d100" → {count, sides} or null
function parseDiceNotation(str) {
    const m = str.trim().match(/^(\d+)?[dD](\d+)$/);
    if (!m) return null;
    const sides = parseInt(m[2], 10);
    const count = m[1] ? parseInt(m[1], 10) : 1;
    if (sides < 2 || sides > 100 || count < 1 || count > 20) return null;
    return { count, sides };
}

function rollDiceNotation(count, sides) {
    const rolls = Array.from({ length: count }, () => rng.roll(sides));
    const total = rolls.reduce((a, b) => a + b, 0);
    return { rolls, total };
}

// チャット入力欄にテキストを挿入（カーソル位置 or 末尾）。送信はしない。
// ダイスロールボタン等から呼ばれ、RP 描写と組み合わせて送信する用途。
function insertIntoChatInput(text) {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const currentValue = input.value || '';
    // 既存テキストとの間に空白を入れる（前後ともテキストがあるとき）
    let prefix = currentValue.substring(0, start);
    let suffix = currentValue.substring(end);
    let insertText = text;
    if (prefix && !/\s$/.test(prefix)) insertText = ' ' + insertText;
    if (suffix && !/^\s/.test(suffix)) insertText = insertText + ' ';
    input.value = prefix + insertText + suffix;
    // カーソルを挿入後の位置に
    const newPos = (prefix + insertText).length;
    input.focus();
    try { input.setSelectionRange(newPos, newPos); } catch (e) { /* noop */ }
    // textarea の高さ自動調整トリガー
    input.dispatchEvent(new Event('input'));
}

function appendDiceMessage(notation, rolls, total) {
    const container = document.getElementById('chat-history');
    const div = document.createElement('div');
    const isError = rolls.length === 0;
    div.className = 'chat-msg dice-roll' + (isError ? ' dice-error' : '');
    const detail = isError
        ? `「${notation}」は無効な記法です (例: d20, 2d6)`
        : rolls.length > 1
            ? `[${rolls.join(', ')}] = ${total}`
            : `${total}`;
    div.innerHTML = `
      <div class="dice-bubble">
        <span class="dice-icon">${isError ? '⚠️' : '🎲'}</span>
        ${isError ? '' : `<span class="dice-notation">${notation}</span><span class="dice-arrow">→</span>`}
        <span class="dice-result">${detail}</span>
      </div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// ======== NARRATOR ========
let narratorConfig = {
    enabled:     JSON.parse(localStorage.getItem('narratorEnabled') || 'false'),
    name:        localStorage.getItem('narratorName')  || 'ナレーター',
    style:       localStorage.getItem('narratorStyle') || 'あなたは三人称の全知ナレーターです。RPシーンの情景・キャラクターの行動・感情・場の空気を文学的かつ臨場感のある日本語の地の文で描写してください。台詞は書かず、地の文のみで完結させること。',
    autoTrigger: JSON.parse(localStorage.getItem('narratorAutoTrigger') || 'false')
}; // 👈 ここに「 }; 」を追加してナレーター設定を閉じます！

// SD Image Generation Configuration
let sdConfig = {
    enabled:        JSON.parse(localStorage.getItem('sdEnabled') || 'false'),
    endpoint:       localStorage.getItem('sdEndpoint')       || 'http://localhost:5001',
    width:          parseInt(localStorage.getItem('sdWidth')  || '512'),
    height:         parseInt(localStorage.getItem('sdHeight') || '512'),
    steps:          parseInt(localStorage.getItem('sdSteps')  || '20'),
    cfgScale:       parseFloat(localStorage.getItem('sdCfgScale') || '7'),
    sampler:        localStorage.getItem('sdSampler')        || 'Euler a',
    negativePrompt: localStorage.getItem('sdNegativePrompt') || 'lowres, bad anatomy, bad hands, text, error, cropped, worst quality, low quality, blurry',
    autoGenerate:       JSON.parse(localStorage.getItem('sdAutoGenerate') || 'false'),
    promptPrefix:       localStorage.getItem('sdPromptPrefix')   || 'score_9, score_8_up, score_7_up, masterpiece, best quality',
    allowNsfw:          JSON.parse(localStorage.getItem('sdAllowNsfw') || 'false'),
    useForgeCoupleMode: JSON.parse(localStorage.getItem('sdUseForgeCoupleMode') || 'false'),
    imgGenMode:         localStorage.getItem('sdImgGenMode') || 'auto'  // 'auto' | 'multi' | 'scene'
};

// 画像生成対象: スロット別の可視性 { "slot0": true, "slot1": true, "slot2": true, "user": true }
let sdCharVisible = JSON.parse(localStorage.getItem('sdCharVisible') || '{}');
function isSdCharVisible(key) {
    return sdCharVisible[key] !== false; // デフォルトtrue
}
function toggleSdCharVisible(key) {
    sdCharVisible[key] = !isSdCharVisible(key);
    localStorage.setItem('sdCharVisible', JSON.stringify(sdCharVisible));
}

// ======== QUEST SYSTEM ========
let savedQuests = [];
let activeQuest = null; // null when no quest is running

function createEmptyQuest() {
    return {
        spec: "rp_engine_quest_v1",
        id: "quest_" + Date.now(),
        metadata: {
            name: "新しいクエスト",
            tags: [],
            author: "",
            recommended_party_size: 2
        },
        selection_text: "",
        prologue_overview: "",
        ai_instructions: [],
        background: "",
        events: [],
        additional_settings: [],
        hidden_truths: [],
        items_clues: [],
        introduction_dialogue: "",
        char_status_params: [],  // [{ character, params: [{ name, description, initial_value }] }]
        dice_enabled: false
    };
}

// ======== クエストデータの正規化 ========
// 旧フォーマット（文字列）と新フォーマット（配列）の不整合を吸収するマイグレーション関数
function normalizeQuestTemplate(template) {
    if (!template) return template;
    // 配列であるべきフィールドを保証する（旧データが文字列や null の場合に対応）
    const arrayFields = ['ai_instructions', 'events', 'hidden_truths', 'items_clues', 'char_status_params', 'additional_settings'];
    arrayFields.forEach(key => {
        if (!Array.isArray(template[key])) {
            // 文字列として保存されていた場合はコンテンツとして1要素の配列に変換
            if (typeof template[key] === 'string' && template[key].trim()) {
                template[key] = [{ header: '', content: template[key].trim(), title: template[key].trim() }];
            } else {
                template[key] = [];
            }
        }
    });
    return template;
}

function loadQuests() {
    try {
        const data = localStorage.getItem('savedQuests');
        if (data) {
            savedQuests = JSON.parse(data);
            // 旧フォーマットのクエストデータを正規化
            if (Array.isArray(savedQuests)) {
                savedQuests.forEach(q => normalizeQuestTemplate(q));
            }
        }
    } catch (e) {
        console.error('Failed to load quests:', e);
        savedQuests = [];
    }
    try {
        const aq = localStorage.getItem('activeQuest');
        if (aq) {
            activeQuest = JSON.parse(aq);
            // activeQuest.template も正規化
            if (activeQuest && activeQuest.template) {
                normalizeQuestTemplate(activeQuest.template);
            }
        }
    } catch (e) {
        console.error('Failed to load active quest:', e);
        activeQuest = null;
    }
}


function saveQuests() {
    localStorage.setItem('savedQuests', JSON.stringify(savedQuests));
}

function saveActiveQuest() {
    if (activeQuest) {
        localStorage.setItem('activeQuest', JSON.stringify(activeQuest));
    } else {
        localStorage.removeItem('activeQuest');
    }
}

function addQuest(quest) {
    savedQuests.push(quest);
    saveQuests();
}

function updateQuest(quest) {
    const idx = savedQuests.findIndex(q => q.id === quest.id);
    if (idx !== -1) {
        savedQuests[idx] = quest;
        saveQuests();
    }
}

function deleteQuest(questId) {
    savedQuests = savedQuests.filter(q => q.id !== questId);
    saveQuests();
}

function exportQuest(quest) {
    const exportObj = { spec: "rp_engine_quest_v1", quest_data: quest };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj, null, 2));
    const a = document.createElement('a');
    a.setAttribute("href", dataStr);
    a.setAttribute("download", (quest.metadata.name || "quest") + ".json");
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function importQuestFromFile(file, callback) {
    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const json = JSON.parse(event.target.result);
            let questData;
            if (json.spec === "rp_engine_quest_v1" && json.quest_data) {
                questData = json.quest_data;
            } else if (json.spec === "rp_engine_quest_v1" && json.metadata) {
                questData = json;
            } else {
                alert('認識できないクエストファイル形式です。');
                return;
            }
            // Assign a new ID to avoid collisions
            questData.id = "quest_" + Date.now();
            addQuest(questData);
            if (callback) callback(questData);
        } catch (err) {
            alert('JSONファイルの解析に失敗しました。');
        }
    };
    reader.readAsText(file);
}
// ======== END QUEST SYSTEM DATA ========

// Character/User Macro Replacement Utility
function applyMacros(text, charName = null) {
    if (!text) return '';
    let result = text;
    // Replace {{user}} with player name
    result = result.replace(/{{user}}/gi, userConfig.name);

    // Determine which character name to use for {{char}}
    // Priority: 1) explicitly passed charName, 2) sole party member, 3) leave unreplaced
    let targetCharName = charName;
    if (!targetCharName) {
        const members = getActivePartyMembers();
        if (members.length === 1) {
            targetCharName = members[0].name;
        }
        // If multiple members and no charName specified, don't replace {{char}}
        // to avoid substituting the wrong character's name
    }

    if (targetCharName) {
        result = result.replace(/{{char}}/gi, targetCharName);
    }
    return result;
}

async function init() {
    hardenFormFields(); // 最初に実行: ブラウザのフォーム位置復元によるズレを防ぐ
    setupNavigation();
    setupSettings();
    setupSdSettings();
    setupNarratorSettings();
    setupAvatarCropModal();
    setupPartySet();
    setupCharacterEdit();
    setupChat();
    loadQuests();
    setupQuestUI();
    setupQuestHUD();
    setupPlayerNotes();
    setupGuidedRegenModal();
    setupResponseLength();
    setupShowChoicesToggle();
    setupInfoPanel();
    setupSettingsAccordion();
    setupWebSearchToggleBtn();
    setupSpeechInput();
    setupSummaryPanel();
    setupPureChatToggle();
    setupImageLibraryView();
    // 画像フォルダのハンドル復元は必ず待つ。
    // await しないと、後続の restoreChatFromStorage() が走る時点で _imgDirHandle が
    // まだ null のため、本文タグ由来の画像がリロード時に表示されなくなる。
    await restoreImageDirHandle();
    updateQuestHUD();
    updateImggenButtonVisibility();
    
    try {
        const savedParty = localStorage.getItem('savedParty');
        if (savedParty) {
            characterDataArray = JSON.parse(savedParty);
            // 旧セーブ（3スロット等）→ MAX_PARTY_SLOTS にマイグレーション
            // 既存キャラは保持し、不足分を null で埋める
            if (!Array.isArray(characterDataArray)) characterDataArray = [];
            while (characterDataArray.length < MAX_PARTY_SLOTS) {
                characterDataArray.push(null);
            }
            // 万一スロット数超過の場合は切り捨て
            if (characterDataArray.length > MAX_PARTY_SLOTS) {
                characterDataArray = characterDataArray.slice(0, MAX_PARTY_SLOTS);
            }
            // 各キャラの voice マイグレーション
            characterDataArray.forEach(char => {
                if (char && !char.voice) {
                    char.voice = { engine: 'none', voiceURI: '', speakerId: 0, pitch: 1.0, speed: 1.0 };
                }
            });
        } else {
            // 初回起動: 最初の3スロットだけサンプル placeholder を入れて UX 維持
            // 残り 17 スロットは null（Empty）のまま
            for (let i = 0; i < 3; i++) {
                characterDataArray[i] = {
                    name: `Slot ${i+1} Empty`,
                    tags: ["Draft"],
                    personality: "Unknown",
                    description: "Character description goes here...",
                    scenario: "A new scenario...",
                    first_mes: i === 0 ? "Hello!" : "",
                    mes_example: "",
                    avatar: "",
                    lorebook: [],
                    voice: { engine: 'none', voiceURI: '', speakerId: 0, pitch: 1.0, speed: 1.0 }
                };
            }
        }

        const savedCommonLore = localStorage.getItem('savedCommonLore');
        if (savedCommonLore) {
            commonLorebook = JSON.parse(savedCommonLore);
        }

        renderPartySheet();

        // Use party ID for chat history (getPartyId() と同じロジックを使用)
        loadContextSummary(); // 要約復元（chatHistory 読込前でも partyId が確定していれば OK）
        restoreChatFromStorage();
        renderPartySetGrid();
        updateEditTabNames();

        // party-sheet-grid内の動的ボタンのイベント委譲
        const partyGrid = document.getElementById('party-sheet-grid');
        if (partyGrid) {
            partyGrid.addEventListener('click', function(e) {
                // 🎨 フォーカス画像生成ボタン
                const focusBtn = e.target.closest('.focus-imggen-btn');
                if (focusBtn) {
                    const charIdx = parseInt(focusBtn.getAttribute('data-char-idx'));
                    triggerFocusImageGeneration(charIdx);
                    return;
                }
                // 📷/🚫 画像生成対象トグルボタン
                const visBtn = e.target.closest('.sd-visible-toggle');
                if (visBtn) {
                    const slotKey = visBtn.getAttribute('data-slot-key');
                    toggleSdCharVisible(slotKey);
                    visBtn.textContent = isSdCharVisible(slotKey) ? '📷' : '🚫';
                }
            });
        }

        // TTS関連の初期化
        await fetchVoicevoxSpeakers();
        window.speechSynthesis.onvoiceschanged = () => {
            console.log('[TTS] Web Speech API voices loaded');
        };
        const toggleBtn = document.getElementById('autoplay-tts-toggle');
        if (toggleBtn) {
            updateAutoplayTtsButton();
            toggleBtn.addEventListener('click', () => {
                autoplayTts = !autoplayTts;
                localStorage.setItem('autoplayTts', autoplayTts ? '1' : '0');
                updateAutoplayTtsButton();
            });
        }
    } catch (error) {
        console.error('Core error in init():', error);
        const view = document.getElementById('character-view');
        if (view) view.innerHTML = '<div class="error">アプリの初期化に失敗しました。コンソールを確認してください。</div>';
    }
}

// ---- SPA Navigation ----
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(function(item) {
        item.addEventListener('click', function() {
            navItems.forEach(function(n) { n.classList.remove('active'); });
            item.classList.add('active');
            
            document.querySelectorAll('.view-section').forEach(function(v) { v.classList.add('hidden'); });
            
            const targetId = item.getAttribute('data-view');
            if (targetId) {
                document.getElementById(targetId).classList.remove('hidden');

                if(targetId === 'chat-view') {
                    scrollToBottom();
                    // Living World タイマー開始（モード ON 時のみ実効）
                    if (typeof startLivingWorldTimer === 'function') startLivingWorldTimer();
                } else {
                    // チャット画面以外に移動 → タイマー停止
                    if (typeof stopLivingWorldTimer === 'function') stopLivingWorldTimer();
                    // 音声入力もチャット離脱時は停止（マイク開放）
                    if (_sttActive) stopSTT();
                    // 画像ライブラリ画面: 入るたびにサムネイル・状態を最新化
                    if (targetId === 'image-library-view') {
                        ensureImageDirPermission().then(() => {
                            renderImageLibraryTable();
                            updateImageLibraryStatus();
                        });
                    }
                }
            }
        });
    });

    // ===== モバイル: ハンバーガードロワー =====
    const menuBtn = document.getElementById('mobile-menu-btn');
    const backdrop = document.getElementById('mobile-backdrop');
    const sidebar = document.querySelector('aside');
    const closeDrawer = () => {
        if (sidebar) sidebar.classList.remove('open');
        if (backdrop) backdrop.classList.add('hidden');
    };
    if (menuBtn && sidebar) {
        menuBtn.addEventListener('click', () => {
            const opening = !sidebar.classList.contains('open');
            sidebar.classList.toggle('open', opening);
            if (backdrop) backdrop.classList.toggle('hidden', !opening);
        });
    }
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    // ビュー選択でドロワーを閉じる（デスクトップでは class が無いため no-op）
    navItems.forEach(item => item.addEventListener('click', closeDrawer));

    // Alt+1〜7 でビュー高速切替（入力中でも Alt 併用なので誤爆しない）
    const viewOrder = ['character-view', 'chat-view', 'party-set-view', 'char-edit-view', 'quest-view', 'lore-view', 'image-library-view', 'settings-view'];
    document.addEventListener('keydown', function(e) {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const idx = parseInt(e.key, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= viewOrder.length) return;
        const target = document.querySelector('.nav-item[data-view="' + viewOrder[idx] + '"]');
        if (target) {
            e.preventDefault();
            target.click();
        }
    });

    // Reset Chat Button
    const resetBtn = document.getElementById('reset-chat-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', function() {
            let msg = '現在の会話履歴を削除して、最初からやり直しますか？';
            if (activeQuest) {
                msg += '\n\n※ アクティブなクエスト「' + activeQuest.template.metadata.name + '」も終了されます。';
            }
            if (confirm(msg)) {
                if (activeQuest) {
                    activeQuest = null;
                    saveActiveQuest();
                    updateQuestHUD();
                }
                localStorage.removeItem('chatHistory_' + getPartyId());
                initializeChat(characterDataArray);
                alert('会話をリセットしました。');
            }
        });
    }
}

// ---- localStorage 容量ガード ----
// QuotaExceededError を握りつぶさず、ユーザーに分かる形で通知する。
// 大物（チャット履歴・パーティ）の保存に使用。
function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        console.error('[storage] setItem failed:', key, e);
        showToast('⚠️ ストレージ容量が上限です。保存に失敗しました（古いセッションの削除を推奨）', 'error');
        return false;
    }
}

// Settings のストレージ使用量メーターを更新
function updateStorageMeter() {
    const el = document.getElementById('storage-meter');
    if (!el) return;
    let totalBytes = 0;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            totalBytes += (k.length + (localStorage.getItem(k) || '').length) * 2; // UTF-16
        }
    } catch (e) { /* noop */ }
    const mb = totalBytes / (1024 * 1024);
    const pct = Math.min(100, (mb / 5) * 100);
    const fill = el.querySelector('.storage-meter-fill');
    const text = el.querySelector('.storage-meter-text');
    if (fill) {
        fill.style.width = pct.toFixed(1) + '%';
        fill.style.background = pct > 80 ? '#f44336' : (pct > 60 ? '#ffa726' : '#4caf50');
    }
    if (text) text.textContent = mb.toFixed(2) + ' MB / 約5 MB（' + pct.toFixed(0) + '%）';
}

// ---- Toast 通知（alert の非ブロッキング代替） ----
let _toastTimer = null;
function showToast(message, type) {
    let el = document.getElementById('app-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'app-toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.dataset.type = type || 'success';
    el.classList.add('visible');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('visible'), 2500);
}

// ---- フォーム復元シールド ----
// ブラウザ（Chrome/Firefox）はリロード・タブ復元時に未送信フォーム値を自動復元するが、
// name 属性の無いコントロールは「ページ内の出現位置」で照合される。
// バージョン更新で Settings にセクションを途中挿入すると、旧レイアウト時代に記録された値が
// 位置ズレした別の欄に復元され、内容がぐちゃぐちゃになる（例: 世界観テンプレが純チャット欄に入る）。
// 対策: 全コントロールに name(=id) を与えて位置照合を無効化し、autocomplete=off で復元自体も抑止する。
function hardenFormFields() {
    document.querySelectorAll('input[id], textarea[id], select[id]').forEach(el => {
        if (!el.getAttribute('name')) el.setAttribute('name', el.id);
        el.setAttribute('autocomplete', 'off');
    });
}

// ---- Settings Accordion (各 h2 セクションを折り畳み可能にする) ----
function setupSettingsAccordion() {
    const panel = document.querySelector('#settings-view .settings-panel');
    if (!panel || panel._accordionInitialized) return;
    panel._accordionInitialized = true;

    // 保存済み状態の読み込み（タイトル → collapsed bool）
    let savedState = {};
    try { savedState = JSON.parse(localStorage.getItem('settingsAccordionState') || '{}'); }
    catch (e) { savedState = {}; }

    const saveState = () => {
        try { localStorage.setItem('settingsAccordionState', JSON.stringify(savedState)); }
        catch (e) { /* noop */ }
    };

    const headers = Array.from(panel.querySelectorAll(':scope > h2'));
    headers.forEach((h2, idx) => {
        // タイトルキー（絵文字含む生テキスト）
        const key = (h2.textContent || ('section-' + idx)).trim();
        // 次の h2 (または末尾) までの兄弟要素を収集して wrap
        const body = document.createElement('div');
        body.className = 'settings-section-body';
        let node = h2.nextSibling;
        const collected = [];
        while (node) {
            const next = node.nextSibling;
            if (node.nodeType === 1 && node.tagName === 'H2') break;
            collected.push(node);
            node = next;
        }
        collected.forEach(n => body.appendChild(n));
        h2.parentNode.insertBefore(body, h2.nextSibling);

        // ヘッダーをクリック可能に
        h2.classList.add('settings-section-header');
        // インジケーター（▶/▼ は CSS で表現）
        h2.setAttribute('role', 'button');
        h2.setAttribute('tabindex', '0');

        // 初期状態: 保存があればそれ、なければデフォルト全閉じ（API Settings のみ開く）
        const defaultCollapsed = (idx !== 0); // 先頭(API Settings)はデフォルト開く
        const collapsed = (key in savedState) ? !!savedState[key] : defaultCollapsed;
        if (collapsed) {
            h2.classList.add('collapsed');
            body.classList.add('collapsed');
        }

        const toggle = () => {
            const isCollapsed = h2.classList.toggle('collapsed');
            body.classList.toggle('collapsed', isCollapsed);
            savedState[key] = isCollapsed;
            saveState();
        };
        h2.addEventListener('click', toggle);
        h2.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
    });

    // すべて展開 / 折りたたみ ボタン
    const expandBtn   = document.getElementById('settings-expand-all-btn');
    const collapseBtn = document.getElementById('settings-collapse-all-btn');
    const setAll = (collapsed) => {
        headers.forEach(h2 => {
            const body = h2.nextElementSibling;
            if (!body || !body.classList.contains('settings-section-body')) return;
            h2.classList.toggle('collapsed', collapsed);
            body.classList.toggle('collapsed', collapsed);
            const key = (h2.textContent || '').trim();
            savedState[key] = collapsed;
        });
        saveState();
    };
    if (expandBtn   && !expandBtn._bound)   { expandBtn._bound   = true; expandBtn.addEventListener('click', () => setAll(false)); }
    if (collapseBtn && !collapseBtn._bound) { collapseBtn._bound = true; collapseBtn.addEventListener('click', () => setAll(true));  }
}

// ---- Settings Logic ----
function setupSettings() {
    document.getElementById('api-url').value = apiConfig.endpoint;
    document.getElementById('api-key').value = apiConfig.key;
    document.getElementById('api-model').value = apiConfig.model;
    document.getElementById('api-tokens').value = apiConfig.tokens;
    const timeoutInput = document.getElementById('api-timeout');
    if (timeoutInput) timeoutInput.value = apiConfig.timeoutSec;

    // ===== ストリーミング設定の読み込み =====
    const streamingEl = document.getElementById('streaming-enabled');
    if (streamingEl) streamingEl.checked = streamingEnabled;

    // ===== 繰り返しペナルティ設定の読み込み =====
    const repPenEl = document.getElementById('repetition-penalty');
    if (repPenEl) repPenEl.value = repetitionPenalty;

    // ===== 純チャットモード設定の読み込み =====
    const pureChatPromptEl = document.getElementById('pure-chat-system-prompt');
    if (pureChatPromptEl) pureChatPromptEl.value = pureChatSystemPrompt;

    // ===== 画像ライブラリ設定の読み込み =====
    const imgLibEnabledEl = document.getElementById('image-library-enabled');
    const imgTagMaxEl     = document.getElementById('image-tag-inject-max');
    const imgPerTurnEl    = document.getElementById('image-max-per-turn');
    if (imgLibEnabledEl) imgLibEnabledEl.checked = imageLibraryEnabled;
    if (imgTagMaxEl)     imgTagMaxEl.value       = imageTagInjectMax;
    if (imgPerTurnEl)    imgPerTurnEl.value      = imageMaxPerTurn;

    // ===== 音声入力 (STT) 設定の読み込み =====
    const sttEnabledEl   = document.getElementById('stt-enabled');
    const sttEngineEl    = document.getElementById('stt-engine');
    const sttLangEl      = document.getElementById('stt-lang');
    const whisperEpEl    = document.getElementById('whisper-endpoint');
    const sttSilenceEl   = document.getElementById('stt-silence-ms');
    const sttAutoSendEl  = document.getElementById('stt-auto-send');
    if (sttEnabledEl)  sttEnabledEl.checked  = sttEnabled;
    if (sttEngineEl)   sttEngineEl.value     = sttEngine;
    if (sttLangEl)     sttLangEl.value       = sttLang;
    if (whisperEpEl)   whisperEpEl.value     = whisperEndpoint;
    if (sttSilenceEl)  sttSilenceEl.value    = sttSilenceMs;
    if (sttAutoSendEl) sttAutoSendEl.checked = sttAutoSend;

    // ===== ストレージ使用量メーター =====
    updateStorageMeter();

    // ===== ナレーター用ボイス設定の読み込み =====
    const nvEngineEl   = document.getElementById('narrator-voice-engine');
    const nvSpeakerEl  = document.getElementById('narrator-voice-speaker');
    const nvPitchEl    = document.getElementById('narrator-voice-pitch');
    const nvSpeedEl    = document.getElementById('narrator-voice-speed');
    if (nvEngineEl)  nvEngineEl.value  = narratorVoice.engine || 'none';
    if (nvPitchEl)   nvPitchEl.value   = (narratorVoice.pitch !== undefined) ? narratorVoice.pitch : 1.0;
    if (nvSpeedEl)   nvSpeedEl.value   = (narratorVoice.speed !== undefined) ? narratorVoice.speed : 1.0;
    if (nvSpeakerEl) {
        const initialSpeakerVal = (narratorVoice.engine === 'webspeech')
            ? (narratorVoice.voiceURI || '')
            : (narratorVoice.speakerId !== undefined ? String(narratorVoice.speakerId) : '');
        populateSpeakerSelect(nvSpeakerEl, narratorVoice.engine || 'none', initialSpeakerVal);
    }
    // エンジン変更時にスピーカー一覧を再描画
    if (nvEngineEl && nvSpeakerEl) {
        nvEngineEl.addEventListener('change', () => {
            populateSpeakerSelect(nvSpeakerEl, nvEngineEl.value, '');
        });
    }
    // VOICEVOX 再確認ボタン
    const recheckBtn = document.getElementById('voicevox-recheck-btn');
    if (recheckBtn) {
        recheckBtn.addEventListener('click', updateVoicevoxStatusDisplay);
    }
    // テスト再生ボタン
    const testBtn = document.getElementById('narrator-voice-test-btn');
    if (testBtn) {
        testBtn.addEventListener('click', testNarratorVoice);
    }
    // 初期状態確認（バックグラウンドで実行）
    updateVoicevoxStatusDisplay();

    // ===== 完全自由空間モード設定の読み込み =====
    const fwEl   = document.getElementById('free-world-enabled');
    const msEl   = document.getElementById('mary-sue-prevention');
    const cmEl   = document.getElementById('cheat-mode');
    const rmEl   = document.getElementById('realism-mode');
    const npcEl  = document.getElementById('npc-generation-enabled');
    const lwEl   = document.getElementById('living-world-enabled');
    const lwIntEl = document.getElementById('living-world-interval');
    const wtEl   = document.getElementById('world-theme');
    const urEl   = document.getElementById('universe-report-enabled');
    if (fwEl)    fwEl.checked   = freeWorldEnabled;
    if (msEl)    msEl.checked   = marySuePrevention;
    if (cmEl)    cmEl.checked   = cheatMode;
    if (rmEl)    rmEl.checked   = realismMode;
    if (npcEl)   npcEl.checked  = npcGenerationEnabled;
    if (lwEl)    lwEl.checked   = livingWorldEnabled;
    if (lwIntEl) lwIntEl.value  = livingWorldIntervalSec;
    if (wtEl)    wtEl.value     = worldTheme;
    if (urEl)    urEl.checked   = universeReportEnabled;

    // ===== Web Search 設定の読み込み =====
    const wsEnabledEl   = document.getElementById('web-search-enabled');
    const wsProviderEl  = document.getElementById('web-search-provider');
    const wsTavilyKeyEl = document.getElementById('tavily-api-key');
    const wsAutoEl      = document.getElementById('web-search-auto-trigger');
    const wsCooldownEl  = document.getElementById('web-search-cooldown');
    const wsMaxEl       = document.getElementById('web-search-max-results');
    const wsDebugEl     = document.getElementById('web-search-show-debug');
    if (wsEnabledEl)   wsEnabledEl.checked  = webSearchEnabled;
    if (wsProviderEl)  wsProviderEl.value   = webSearchProvider;
    if (wsTavilyKeyEl) wsTavilyKeyEl.value  = tavilyApiKey;
    if (wsAutoEl)      wsAutoEl.checked     = webSearchAutoTrigger;
    if (wsCooldownEl)  wsCooldownEl.value   = webSearchCooldownSec;
    if (wsMaxEl)       wsMaxEl.value        = webSearchMaxResults;
    if (wsDebugEl)     wsDebugEl.checked    = webSearchShowDebug;

    // 🔍 ボタンの表示状態を Settings 復元時にも反映
    // (クリックハンドラ自体は init() の setupWebSearchToggleBtn() で bind 済み)
    updateWebSearchToggleBtnUI();

    // ===== チャット要約プロンプト設定の読み込み =====
    const sumPresetEl = document.getElementById('summary-prompt-preset');
    const sumTextEl   = document.getElementById('summary-prompt-text');
    const sumMaxEl    = document.getElementById('summary-max-tokens');
    if (sumPresetEl) sumPresetEl.value = summaryPromptPreset;
    if (sumTextEl)   sumTextEl.value   = getActiveSummaryPrompt(); // 現在有効な内容を表示
    if (sumMaxEl)    sumMaxEl.value    = summaryMaxTokens;
    // プリセット変更 → エディタに該当プロンプトを流し込み
    if (sumPresetEl && sumTextEl && !sumPresetEl._bound) {
        sumPresetEl._bound = true;
        sumPresetEl.addEventListener('change', () => {
            if (sumPresetEl.value === 'default')  sumTextEl.value = SUMMARY_PROMPT_DEFAULT;
            else if (sumPresetEl.value === 'telelynx') sumTextEl.value = SUMMARY_PROMPT_TELELYNX;
            else if (sumPresetEl.value === 'custom' && summaryPromptCustom.trim()) sumTextEl.value = summaryPromptCustom;
            // custom でカスタム未保存なら現在の表示内容をそのまま維持（編集の起点にする）
        });
        // エディタ編集 → プリセットを custom へ自動切替（プリセット汚染防止）
        sumTextEl.addEventListener('input', () => {
            if (sumPresetEl.value !== 'custom'
                && sumTextEl.value !== SUMMARY_PROMPT_DEFAULT
                && sumTextEl.value !== SUMMARY_PROMPT_TELELYNX) {
                sumPresetEl.value = 'custom';
            }
        });
    }

    // ===== ペルソナ・モード設定の読み込み =====
    const personaEnabledEl = document.getElementById('persona-mode-enabled');
    const personaDefsEl    = document.getElementById('persona-definitions');
    if (personaEnabledEl) personaEnabledEl.checked = personaModeEnabled;
    if (personaDefsEl)    personaDefsEl.value       = personaDefinitions;

    // ===== NPC 発言保証設定の読み込み =====
    const npcMinDlgEl  = document.getElementById('npc-min-dialogue-enabled');
    const npcDlgMaxEl  = document.getElementById('npc-dialogue-max');
    if (npcMinDlgEl) npcMinDlgEl.checked = npcMinDialogueEnabled;
    if (npcDlgMaxEl) npcDlgMaxEl.value   = npcDialogueMax;

    // ===== AI Memo 設定の読み込み =====
    const aiMemoEnabledEl = document.getElementById('ai-memo-enabled');
    const aiMemoTextarea  = document.getElementById('ai-memo-textarea');
    const aiMemoCount     = document.getElementById('ai-memo-count');
    const aiMemoSaveBtn   = document.getElementById('ai-memo-save-btn');
    const aiMemoClearBtn  = document.getElementById('ai-memo-clear-btn');
    if (aiMemoEnabledEl) aiMemoEnabledEl.checked = aiMemoEnabled;
    if (aiMemoTextarea)  aiMemoTextarea.value    = aiMemoListToText();
    if (aiMemoCount)     aiMemoCount.textContent = String(aiMemoList.length);
    if (aiMemoSaveBtn && !aiMemoSaveBtn._bound) {
        aiMemoSaveBtn._bound = true;
        aiMemoSaveBtn.addEventListener('click', () => {
            aiMemoList = textToAiMemoList(aiMemoTextarea ? aiMemoTextarea.value : '');
            saveAiMemos();
            if (aiMemoCount) aiMemoCount.textContent = String(aiMemoList.length);
            showToast('📝 AI Memo を保存しました（' + aiMemoList.length + ' 件）');
        });
    }
    if (aiMemoClearBtn && !aiMemoClearBtn._bound) {
        aiMemoClearBtn._bound = true;
        aiMemoClearBtn.addEventListener('click', () => {
            if (!confirm('AI Memo を全削除します。よろしいですか？')) return;
            aiMemoList = [];
            saveAiMemos();
            if (aiMemoTextarea) aiMemoTextarea.value = '';
            if (aiMemoCount) aiMemoCount.textContent = '0';
        });
    }

    document.getElementById('save-settings-btn').addEventListener('click', function() {
        apiConfig.endpoint = document.getElementById('api-url').value;
        apiConfig.key = document.getElementById('api-key').value;
        apiConfig.model = document.getElementById('api-model').value;
        apiConfig.tokens = parseInt(document.getElementById('api-tokens').value) || 1000;
        if (timeoutInput) {
            const t = parseInt(timeoutInput.value);
            apiConfig.timeoutSec = (isNaN(t) || t < 0) ? 180 : t;
        }

        localStorage.setItem('apiEndpoint', apiConfig.endpoint);
        localStorage.setItem('apiKey', apiConfig.key);
        localStorage.setItem('apiModel', apiConfig.model);
        localStorage.setItem('apiTokens', apiConfig.tokens);
        localStorage.setItem('apiTimeoutSec', String(apiConfig.timeoutSec));

        // ===== ストリーミング設定の保存 =====
        if (streamingEl) streamingEnabled = !!streamingEl.checked;
        localStorage.setItem('streamingEnabled', streamingEnabled ? '1' : '0');

        // ===== 繰り返しペナルティ設定の保存 =====
        if (repPenEl) {
            const v = parseFloat(repPenEl.value);
            repetitionPenalty = (isNaN(v) || v < 0) ? 0 : (v > 2 ? 2 : v);
        }
        localStorage.setItem('repetitionPenalty', String(repetitionPenalty));

        // ===== 純チャットモード設定の保存 =====
        if (pureChatPromptEl) pureChatSystemPrompt = pureChatPromptEl.value;
        localStorage.setItem('pureChatSystemPrompt', pureChatSystemPrompt);

        // ===== 画像ライブラリ設定の保存 =====
        if (imgLibEnabledEl) imageLibraryEnabled = !!imgLibEnabledEl.checked;
        if (imgTagMaxEl) {
            const v = parseInt(imgTagMaxEl.value);
            imageTagInjectMax = (isNaN(v) || v < 5) ? 60 : (v > 200 ? 200 : v);
        }
        if (imgPerTurnEl) {
            const v = parseInt(imgPerTurnEl.value);
            imageMaxPerTurn = (isNaN(v) || v < 1) ? 2 : (v > 5 ? 5 : v);
        }
        localStorage.setItem('imageLibraryEnabled', imageLibraryEnabled ? '1' : '0');
        localStorage.setItem('imageTagInjectMax', String(imageTagInjectMax));
        localStorage.setItem('imageMaxPerTurn', String(imageMaxPerTurn));

        // ===== 音声入力 (STT) 設定の保存 =====
        const prevSttEnabled = sttEnabled;
        if (sttEnabledEl)  sttEnabled    = !!sttEnabledEl.checked;
        if (sttEngineEl)   sttEngine     = sttEngineEl.value || 'webspeech';
        if (sttLangEl)     sttLang       = sttLangEl.value || 'ja-JP';
        if (whisperEpEl)   whisperEndpoint = whisperEpEl.value.trim() || whisperEndpoint;
        if (sttSilenceEl) {
            const v = parseInt(sttSilenceEl.value);
            sttSilenceMs = (isNaN(v) || v < 500) ? 1500 : (v > 5000 ? 5000 : v);
        }
        if (sttAutoSendEl) sttAutoSend   = !!sttAutoSendEl.checked;
        localStorage.setItem('sttEnabled',      sttEnabled ? '1' : '0');
        localStorage.setItem('sttEngine',       sttEngine);
        localStorage.setItem('sttLang',         sttLang);
        localStorage.setItem('whisperEndpoint', whisperEndpoint);
        localStorage.setItem('sttSilenceMs',    String(sttSilenceMs));
        localStorage.setItem('sttAutoSend',     sttAutoSend ? '1' : '0');
        // 設定変更を即時反映: OFF にしたら聴取停止、mic ボタン表示を更新
        if (prevSttEnabled && !sttEnabled && _sttActive) stopSTT();
        if (typeof updateSttMicBtnUI === 'function') updateSttMicBtnUI();

        // ===== ナレーター用ボイス設定の保存 =====
        if (nvEngineEl) {
            const engine = nvEngineEl.value || 'none';
            narratorVoice.engine = engine;
            const spVal = nvSpeakerEl ? nvSpeakerEl.value : '';
            if (engine === 'webspeech') {
                narratorVoice.voiceURI = spVal;
                narratorVoice.speakerId = '';
            } else if (engine === 'voicevox') {
                narratorVoice.speakerId = spVal;
                narratorVoice.voiceURI = '';
            } else {
                narratorVoice.voiceURI = '';
                narratorVoice.speakerId = '';
            }
            const pv = nvPitchEl ? parseFloat(nvPitchEl.value) : 1.0;
            const sv = nvSpeedEl ? parseFloat(nvSpeedEl.value) : 1.0;
            narratorVoice.pitch = (isNaN(pv) || pv < 0.5) ? 1.0 : (pv > 2.0 ? 2.0 : pv);
            narratorVoice.speed = (isNaN(sv) || sv < 0.5) ? 1.0 : (sv > 2.0 ? 2.0 : sv);
            localStorage.setItem('narratorVoice', JSON.stringify(narratorVoice));
        }

        // ===== 完全自由空間モード設定の保存 =====
        const prevFreeWorld   = freeWorldEnabled;
        const prevLivingWorld = livingWorldEnabled;
        if (fwEl)    freeWorldEnabled       = !!fwEl.checked;
        if (msEl)    marySuePrevention      = !!msEl.checked;
        if (cmEl)    cheatMode              = !!cmEl.checked;
        if (rmEl)    realismMode            = !!rmEl.checked;
        if (npcEl)   npcGenerationEnabled   = !!npcEl.checked;
        if (lwEl)    livingWorldEnabled     = !!lwEl.checked;
        if (lwIntEl) {
            const v = parseInt(lwIntEl.value);
            livingWorldIntervalSec = (isNaN(v) || v < 60) ? 60 : (v > 600 ? 600 : v);
        }
        if (wtEl)    worldTheme = wtEl.value;
        if (urEl)    universeReportEnabled  = !!urEl.checked;

        localStorage.setItem('freeWorldEnabled',       freeWorldEnabled       ? '1' : '0');
        localStorage.setItem('marySuePrevention',      marySuePrevention      ? '1' : '0');
        localStorage.setItem('cheatMode',              cheatMode              ? '1' : '0');
        localStorage.setItem('realismMode',            realismMode            ? '1' : '0');
        localStorage.setItem('npcGenerationEnabled',   npcGenerationEnabled   ? '1' : '0');
        localStorage.setItem('livingWorldEnabled',     livingWorldEnabled     ? '1' : '0');
        localStorage.setItem('livingWorldIntervalSec', String(livingWorldIntervalSec));
        localStorage.setItem('worldTheme',             worldTheme);
        localStorage.setItem('universeReportEnabled',  universeReportEnabled  ? '1' : '0');

        // Free World または Living World の状態が変わったらタイマーを再起動
        if (prevFreeWorld !== freeWorldEnabled || prevLivingWorld !== livingWorldEnabled) {
            stopLivingWorldTimer();
            // chat-view がアクティブなら再開
            const chatView = document.getElementById('chat-view');
            if (chatView && !chatView.classList.contains('hidden')) {
                startLivingWorldTimer();
            }
        }
        // NPC Generate ボタンの表示状態を更新
        if (typeof renderPartySetGrid === 'function') renderPartySetGrid();

        // ===== Web Search 設定の保存 =====
        const prevWebSearchEnabled = webSearchEnabled;
        if (wsEnabledEl)   webSearchEnabled    = !!wsEnabledEl.checked;
        if (wsProviderEl)  webSearchProvider   = wsProviderEl.value || 'auto';
        if (wsTavilyKeyEl) tavilyApiKey        = wsTavilyKeyEl.value || '';
        if (wsAutoEl)      webSearchAutoTrigger = !!wsAutoEl.checked;
        if (wsCooldownEl) {
            const v = parseInt(wsCooldownEl.value);
            webSearchCooldownSec = (isNaN(v) || v < 0) ? 10 : (v > 300 ? 300 : v);
        }
        if (wsMaxEl) {
            const v = parseInt(wsMaxEl.value);
            webSearchMaxResults = (isNaN(v) || v < 1) ? 5 : (v > 10 ? 10 : v);
        }
        if (wsDebugEl) webSearchShowDebug = !!wsDebugEl.checked;

        localStorage.setItem('webSearchEnabled',     webSearchEnabled     ? '1' : '0');
        localStorage.setItem('webSearchProvider',    webSearchProvider);
        localStorage.setItem('tavilyApiKey',         tavilyApiKey);
        localStorage.setItem('webSearchAutoTrigger', webSearchAutoTrigger ? '1' : '0');
        localStorage.setItem('webSearchCooldownSec', String(webSearchCooldownSec));
        localStorage.setItem('webSearchMaxResults',  String(webSearchMaxResults));
        localStorage.setItem('webSearchShowDebug',   webSearchShowDebug   ? '1' : '0');

        if (prevWebSearchEnabled && !webSearchEnabled) {
            // OFF になったらキャッシュと強制フラグをクリア
            _forceSearchNextSend = false;
            _webSearchCache.clear();
        }
        updateWebSearchToggleBtnUI();

        // ===== チャット要約プロンプト設定の保存 =====
        if (sumPresetEl) summaryPromptPreset = sumPresetEl.value || 'default';
        if (sumTextEl && summaryPromptPreset === 'custom') summaryPromptCustom = sumTextEl.value;
        if (sumMaxEl) {
            const sv = parseInt(sumMaxEl.value);
            summaryMaxTokens = (isNaN(sv) || sv < 200) ? 400 : (sv > 4000 ? 4000 : sv);
        }
        localStorage.setItem('summaryPromptPreset', summaryPromptPreset);
        localStorage.setItem('summaryPromptCustom', summaryPromptCustom);
        localStorage.setItem('summaryMaxTokens', String(summaryMaxTokens));

        // ===== ペルソナ・モード設定の保存 =====
        if (personaEnabledEl) personaModeEnabled = !!personaEnabledEl.checked;
        if (personaDefsEl)    personaDefinitions = personaDefsEl.value;
        localStorage.setItem('personaModeEnabled', personaModeEnabled ? '1' : '0');
        localStorage.setItem('personaDefinitions', personaDefinitions);

        // ===== NPC 発言保証設定の保存 =====
        if (npcMinDlgEl) npcMinDialogueEnabled = !!npcMinDlgEl.checked;
        if (npcDlgMaxEl) {
            const v = parseInt(npcDlgMaxEl.value);
            npcDialogueMax = (isNaN(v) || v < 1) ? 3 : (v > 6 ? 6 : v);
        }
        localStorage.setItem('npcMinDialogueEnabled', npcMinDialogueEnabled ? '1' : '0');
        localStorage.setItem('npcDialogueMax', String(npcDialogueMax));

        // ===== AI Memo 設定の保存 =====
        if (aiMemoEnabledEl) aiMemoEnabled = !!aiMemoEnabledEl.checked;
        localStorage.setItem('aiMemoEnabled', aiMemoEnabled ? '1' : '0');
        // textarea の内容も同時保存（明示の Save ボタンを押さなくても反映）
        if (aiMemoTextarea) {
            aiMemoList = textToAiMemoList(aiMemoTextarea.value);
            saveAiMemos();
            if (aiMemoCount) aiMemoCount.textContent = String(aiMemoList.length);
        }

        updateStorageMeter();
        showToast('✅ Settings を保存しました');
    });
}

// ======== SD IMAGE GENERATION ========

function setupSdSettings() {
    // Load current values into form
    const elEnabled = document.getElementById('sd-enabled');
    const elEndpoint = document.getElementById('sd-endpoint');
    const elWidth = document.getElementById('sd-width');
    const elHeight = document.getElementById('sd-height');
    const elSteps = document.getElementById('sd-steps');
    const elCfgScale = document.getElementById('sd-cfg-scale');
    const elSampler = document.getElementById('sd-sampler');
    const elPromptPrefix = document.getElementById('sd-prompt-prefix');
    const elNegPrompt = document.getElementById('sd-negative-prompt');
    const elAllowNsfw = document.getElementById('sd-allow-nsfw');
    const elAutoGen = document.getElementById('sd-auto-generate');
    const elForgeCouple = document.getElementById('sd-forge-couple');
    const elImgGenMode = document.getElementById('sd-imggen-mode');

    if (!elEnabled) return; // guard

    elEnabled.checked = sdConfig.enabled;
    elEndpoint.value = sdConfig.endpoint;
    elWidth.value = sdConfig.width;
    elHeight.value = sdConfig.height;
    elSteps.value = sdConfig.steps;
    elCfgScale.value = sdConfig.cfgScale;
    elSampler.value = sdConfig.sampler;
    elPromptPrefix.value = sdConfig.promptPrefix;
    elNegPrompt.value = sdConfig.negativePrompt;
    elAllowNsfw.checked = sdConfig.allowNsfw;
    elAutoGen.checked = sdConfig.autoGenerate;
    if (elForgeCouple) elForgeCouple.checked = sdConfig.useForgeCoupleMode;
    if (elImgGenMode) elImgGenMode.value = sdConfig.imgGenMode;

    document.getElementById('save-sd-btn').addEventListener('click', function() {
        sdConfig.enabled = elEnabled.checked;
        sdConfig.endpoint = elEndpoint.value.replace(/\/+$/, ''); // trim trailing slash
        sdConfig.width = parseInt(elWidth.value) || 512;
        sdConfig.height = parseInt(elHeight.value) || 512;
        sdConfig.steps = parseInt(elSteps.value) || 20;
        sdConfig.cfgScale = parseFloat(elCfgScale.value) || 7;
        sdConfig.sampler = elSampler.value || 'Euler a';
        sdConfig.promptPrefix = elPromptPrefix.value;
        sdConfig.negativePrompt = elNegPrompt.value;
        sdConfig.allowNsfw = elAllowNsfw.checked;
        sdConfig.autoGenerate = elAutoGen.checked;
        sdConfig.useForgeCoupleMode = elForgeCouple ? elForgeCouple.checked : false;
        sdConfig.imgGenMode = elImgGenMode ? elImgGenMode.value : 'auto';

        localStorage.setItem('sdEnabled', JSON.stringify(sdConfig.enabled));
        localStorage.setItem('sdEndpoint', sdConfig.endpoint);
        localStorage.setItem('sdWidth', sdConfig.width);
        localStorage.setItem('sdHeight', sdConfig.height);
        localStorage.setItem('sdSteps', sdConfig.steps);
        localStorage.setItem('sdCfgScale', sdConfig.cfgScale);
        localStorage.setItem('sdSampler', sdConfig.sampler);
        localStorage.setItem('sdPromptPrefix', sdConfig.promptPrefix);
        localStorage.setItem('sdNegativePrompt', sdConfig.negativePrompt);
        localStorage.setItem('sdAllowNsfw', JSON.stringify(sdConfig.allowNsfw));
        localStorage.setItem('sdAutoGenerate', JSON.stringify(sdConfig.autoGenerate));
        localStorage.setItem('sdUseForgeCoupleMode', JSON.stringify(sdConfig.useForgeCoupleMode));
        localStorage.setItem('sdImgGenMode', sdConfig.imgGenMode);

        // Update imggen button visibility
        updateImggenButtonVisibility();

        alert('SD Settings saved!');
    });

    document.getElementById('test-sd-btn').addEventListener('click', testSdConnection);
}

function updateImggenButtonVisibility() {
    const btn = document.getElementById('imggen-btn');
    if (btn) {
        btn.style.display = sdConfig.enabled ? 'flex' : 'none';
    }
    // フォーカスボタン・可視性トグルも連動
    document.querySelectorAll('.focus-imggen-btn, .sd-visible-toggle').forEach(b => {
        b.style.display = sdConfig.enabled ? '' : 'none';
    });
    // User行の表示/非表示
    document.querySelectorAll('.sd-user-visibility-row').forEach(r => {
        r.style.display = sdConfig.enabled ? '' : 'none';
    });
}

async function testSdConnection() {
    try {
        // Try a minimal txt2img request as KoboldCPP may not support /sd-models
        const res = await fetch(sdConfig.endpoint + '/sdapi/v1/txt2img', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: 'test',
                negative_prompt: '',
                width: 64,
                height: 64,
                steps: 1,
                cfg_scale: 1
            })
        });
        if (res.ok) {
            const data = await res.json();
            if (data.images && data.images.length > 0) {
                alert('SD API接続成功！ 画像生成が利用可能です。');
            } else {
                alert('SD API応答はありましたが、画像データが含まれていません。');
            }
        } else {
            alert('SD API接続失敗: HTTP ' + res.status);
        }
    } catch (e) {
        alert('SD API接続失敗: ' + e.message + '\n\n確認事項:\n・Forge が起動しているか\n・SD API Endpoint の URL が正しいか\n・Forge 起動時に --cors-allow-origins="*" を付けているか');
    }
}

async function generateImage(prompt, negativePrompt) {
    const finalPrompt = sdConfig.promptPrefix
        ? sdConfig.promptPrefix + ', ' + prompt
        : prompt;
    const payload = {
        prompt: finalPrompt,
        negative_prompt: negativePrompt || sdConfig.negativePrompt,
        width: sdConfig.width,
        height: sdConfig.height,
        steps: sdConfig.steps,
        cfg_scale: sdConfig.cfgScale,
        sampler_name: sdConfig.sampler
    };

    // ── Forge Couple モード: BREAKセグメントを画像の空間領域に割り当て ──
    // 最初のBREAK前がグローバル（シーン描写）、以降が各キャラの領域（Horizontal分割）
    if (sdConfig.useForgeCoupleMode) {
        const breakCount = finalPrompt.split(' BREAK ').length - 1;
        if (breakCount > 0) {
            payload.alwayson_scripts = {
                "forge couple": {
                    "args": [true, "Basic", "BREAK", "Horizontal", "None", 0.2, "First Line", 0.5]
                }
            };
        }
    }

    const res = await fetch(sdConfig.endpoint + '/sdapi/v1/txt2img', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('SD API error: HTTP ' + res.status);
    const data = await res.json();
    if (!data.images || data.images.length === 0) throw new Error('SD API returned no images');
    return data.images[0]; // base64 PNG
}

async function generateScenePrompt() {
    const recentHistory = chatHistory.filter(m => !m.isImage).slice(-6); // last 3 exchanges, skip image entries
    const sceneContext = recentHistory.map(m =>
        (m.role === 'user' ? 'User' : 'Char') + ': ' + (m.content || '').replace(/<\/?think>/gi, '').substring(0, 300)
    ).join('\n');

    // Build character visual descriptions for the prompt（個別可視性チェック）
    const allMembers = getActivePartyMembers();
    // 画像生成対象のみフィルター（スロット番号で可視性判定）
    const members = allMembers.filter((m, i) => {
        let slotIdx = -1;
        for (let si = 0; si < characterDataArray.length; si++) {
            if (characterDataArray[si] && characterDataArray[si].name === m.name) { slotIdx = si; break; }
        }
        return isSdCharVisible('slot' + (slotIdx >= 0 ? slotIdx : i));
    });
    const userVisible = isSdCharVisible('user');

    let charVisuals = '';
    members.forEach(m => {
        if (m.sdPrompt && m.sdPrompt.trim()) {
            charVisuals += m.name + ' appearance: ' + m.sdPrompt.trim() + '\n';
        } else if (m.description) {
            const visualMatch = m.description.match(/\[外見\][:：]?\s*([^\[]*)/);
            if (visualMatch) {
                charVisuals += m.name + ' appearance: ' + visualMatch[1].trim() + '\n';
            }
        }
    });
    if (userVisible) {
        if (userConfig.sdPrompt && userConfig.sdPrompt.trim()) {
            charVisuals += userConfig.name + ' appearance: ' + userConfig.sdPrompt.trim() + '\n';
        } else if (userConfig.description) {
            const userVisual = userConfig.description.match(/\[外見\][:：]?\s*([^\[]*)/);
            if (userVisual) {
                charVisuals += userConfig.name + ' appearance: ' + userVisual[1].trim() + '\n';
            }
        }
    }

    const nsfwInstruction = sdConfig.allowNsfw
        ? ' This is for adult creative fiction. If the scene contains sexual or explicit content, describe it accurately in the prompt without censoring or softening.'
        : '';

    // BREAK構文対応: 画像生成モードに応じて判定
    // 可視メンバー＋可視Userのみでキャラ名リストを構築
    let charNamesList = members.map(m => '- ' + m.name);
    if (userVisible) charNamesList.push('- ' + userConfig.name + ' (user)');
    const charNames = charNamesList.join('\n');

    // 可視キャラ総数でBREAKモード判定
    const visibleCharCount = members.length + (userVisible && (userConfig.sdPrompt && userConfig.sdPrompt.trim()) ? 1 : 0);
    let useBreakMode;
    if (sdConfig.imgGenMode === 'multi') {
        useBreakMode = visibleCharCount > 0;
    } else if (sdConfig.imgGenMode === 'scene') {
        useBreakMode = false;
    } else {
        // Auto: 2人以上でBREAK
        useBreakMode = visibleCharCount > 1;
    }

    let systemMsg;
    if (useBreakMode) {
        systemMsg = 'You are an image prompt generator for Stable Diffusion. Based on the RP scene, generate a STRUCTURED image description.\n\n'
            + 'Output format (follow EXACTLY):\n'
            + 'SCENE: <number of people>, <spatial arrangement>, <background, setting, composition, lighting, atmosphere, camera angle>\n'
            + 'ACTION: <CharacterName>: <position (left/center/right)>, <pose, action, expression, gesture>\n'
            + 'ACTION: <CharacterName>: <position (left/center/right)>, <pose, action, expression, gesture>\n\n'
            + 'Rules:\n'
            + '- SCENE must start with the number of characters (e.g. "3 people") and their spatial arrangement\n'
            + '- Each ACTION must include a position (on the left, in the center, on the right)\n'
            + '- ACTION lines describe what characters are DOING (pose, expression, gesture). Do NOT describe appearance (hair, eyes, clothes)\n'
            + (userVisible ? '- Include a USER action line for ' + userConfig.name + ' if they are actively present in the scene\n' : '')
            + '- Output ONLY the structured format, nothing else\n'
            + '/no_think' + nsfwInstruction + '\n\n'
            + 'Character names for reference:\n' + charNames + '\n';
    } else {
        // 1キャラ＆ユーザーSD未設定: 従来モード
        systemMsg = 'You are an image prompt generator for Stable Diffusion. Based on the RP scene below, write a single detailed prompt in English. Focus on visual elements: characters, poses, expressions, setting, lighting, atmosphere, art style. Output ONLY the prompt text, nothing else. Do not include negative prompt. /no_think' + nsfwInstruction + '\n\n'
            + (charVisuals ? 'Character visual references:\n' + charVisuals + '\n' : '');
    }

    const res = await fetch(apiConfig.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiConfig.key && apiConfig.key !== 'none' ? { 'Authorization': 'Bearer ' + apiConfig.key } : {})
        },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [
                { role: 'system', content: systemMsg },
                { role: 'user', content: sceneContext }
            ],
            max_tokens: 1200,
            temperature: 0.7
        })
    });
    if (!res.ok) throw new Error('LLM API error: HTTP ' + res.status);
    const data = await res.json();
    let raw = data.choices[0].message.content.trim();
    // Remove complete <think>...</think> blocks (Qwen3 etc.)
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Remove truncated <think> blocks (when max_tokens cuts off before </think>)
    raw = raw.replace(/<think>[\s\S]*/gi, '').trim();
    if (!raw) throw new Error('プロンプト生成に失敗しました（思考ブロックのみ）。再試行してください。');

    // BREAK構文: 構造化出力をパースしてBREAKプロンプトを構築
    if (useBreakMode) {
        const sceneLine = raw.match(/^SCENE:\s*(.+)$/mi);
        const actionLines = [...raw.matchAll(/^ACTION:\s*([^:]+):\s*(.+)$/gmi)];

        if (sceneLine && actionLines.length > 0) {
            // --- キャラ人数・性別カウント（可視メンバーのみ対象） ---
            let girlCount = 0;
            let boyCount = 0;
            actionLines.forEach(match => {
                const cName = match[1].trim();
                let sdV = '';
                const mem = findMemberBySpeaker(cName, members);
                if (mem) {
                    sdV = (mem.sdPrompt && mem.sdPrompt.trim()) || '';
                } else if (userVisible && (cName.toLowerCase().includes(userConfig.name.toLowerCase())
                           || userConfig.name.toLowerCase().includes(cName.toLowerCase()))) {
                    sdV = (userConfig.sdPrompt && userConfig.sdPrompt.trim()) || '';
                }
                if (/\b(1boy|boy|male|man|1guy|guy)\b/i.test(sdV)) boyCount++;
                else if (/\b(1girl|girl|female|woman)\b/i.test(sdV)) girlCount++;
                else girlCount++; // アニメ系モデルのデフォルト
            });

            // --- 構図タグ生成 ---
            let compositionTags = '';
            if (actionLines.length > 1) {
                const parts = [];
                if (girlCount > 0) parts.push(girlCount + (girlCount === 1 ? 'girl' : 'girls'));
                if (boyCount > 0) parts.push(boyCount + (boyCount === 1 ? 'boy' : 'boys'));
                parts.push('group shot');
                compositionTags = parts.join(', ') + ', ';
            }

            // --- 位置ラベル ---
            const positionLabels = actionLines.length === 2
                ? ['on the left', 'on the right']
                : actionLines.length >= 3
                    ? ['on the left', 'in the center', 'on the right']
                    : [];

            // --- BREAKプロンプト構築 ---
            let breakPrompt = compositionTags + sceneLine[1].trim();

            actionLines.forEach((match, idx) => {
                const charName = match[1].trim();
                const action = match[2].trim();

                // sdPromptを探す（NPC → user フォールバック）— 可視メンバーのみ
                let sdVisual = '';
                const member = findMemberBySpeaker(charName, members);
                if (member) {
                    sdVisual = (member.sdPrompt && member.sdPrompt.trim()) ? member.sdPrompt.trim()
                        : (member.description ? (member.description.match(/\[外見\][:：]?\s*([^\[]*)/)?.[1]?.trim() || '') : '');
                } else if (userVisible && (charName.toLowerCase().includes(userConfig.name.toLowerCase())
                           || userConfig.name.toLowerCase().includes(charName.toLowerCase()))) {
                    sdVisual = (userConfig.sdPrompt && userConfig.sdPrompt.trim()) ? userConfig.sdPrompt.trim()
                        : (userConfig.description ? (userConfig.description.match(/\[外見\][:：]?\s*([^\[]*)/)?.[1]?.trim() || '') : '');
                }

                const posTag = positionLabels[idx] || '';
                if (sdVisual) {
                    breakPrompt += ' BREAK ' + sdVisual + ', ' + action + (posTag ? ', ' + posTag : '');
                } else {
                    breakPrompt += ' BREAK ' + charName + ', ' + action + (posTag ? ', ' + posTag : '');
                }
            });

            return breakPrompt;
        }
        // パース失敗: フォールバック（rawをそのまま返す）
    }

    return raw;
}

async function generateCharacterFocusPrompt(char) {
    const recentHistory = chatHistory.filter(m => !m.isImage).slice(-6);
    const sceneContext = recentHistory.map(m =>
        (m.role === 'user' ? 'User' : 'Char') + ': ' +
        (m.content || '').replace(/<\/?think>/gi, '').substring(0, 300)
    ).join('\n');

    // キャラの外見タグ（sdPrompt優先、なければdescription[外見]から）
    let charVisual = '';
    if (char.sdPrompt && char.sdPrompt.trim()) {
        charVisual = char.sdPrompt.trim();
    } else if (char.description) {
        const vm = char.description.match(/\[外見\][:：]?\s*([^\[]*)/);
        if (vm) charVisual = vm[1].trim();
    }

    const nsfwInstruction = sdConfig.allowNsfw
        ? ' Adult content is allowed if present in scene.'
        : '';

    const systemMsg =
        `You are a Stable Diffusion prompt generator for a single character portrait.\n`
      + `Based on the RP scene, output EXACTLY TWO lines:\n`
      + `SCENE: <background, setting, lighting, camera angle>\n`
      + `ACTION: ${char.name}: <current pose, expression, gesture>\n\n`
      + `Rules:\n`
      + `- SCENE = environment and camera only (no characters mentioned)\n`
      + `- ACTION = ${char.name}'s pose and expression only (no appearance description)\n`
      + `- Output only these 2 lines, nothing else\n`
      + `/no_think${nsfwInstruction}`;

    const res = await fetch(apiConfig.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiConfig.key && apiConfig.key !== 'none'
                ? { 'Authorization': 'Bearer ' + apiConfig.key } : {})
        },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [
                { role: 'system', content: systemMsg },
                { role: 'user',   content: sceneContext }
            ],
            max_tokens: 200,
            temperature: 0.7
        })
    });

    if (!res.ok) throw new Error('LLM API error: HTTP ' + res.status);
    const data = await res.json();
    let raw = (data.choices?.[0]?.message?.content || '').trim();

    // 思考タグ除去
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
             .replace(/<think>[\s\S]*/gi, '').trim();

    // SCENE / ACTION パース
    const sceneMatch  = raw.match(/SCENE:\s*(.+)/i);
    const actionMatch = raw.match(/ACTION:\s*[^:]+:\s*(.+)/i);

    const scenePart  = sceneMatch  ? sceneMatch[1].trim()  : 'indoors, soft lighting, upper body shot';
    const actionPart = actionMatch ? actionMatch[1].trim() : '';

    // BREAK構文: [状況・背景] BREAK [キャラ外見, アクション, solo]
    // → キャラ説明が新チャンク先頭に来て強調される
    const charPart = [charVisual, actionPart, 'solo'].filter(Boolean).join(', ');
    return `${scenePart} BREAK ${charPart}`;
}

// ======== NARRATOR ========

function appendNarrationMessage(text, msgIndex = -1) {
    const chatContainer = document.getElementById('chat-history');
    var narratorSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23c0a0ff' d='M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z'/></svg>";

    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg char narrator';
    msgDiv.setAttribute('data-index', msgIndex);

    const avatarImg = document.createElement('img');
    avatarImg.src = narratorSvg;
    avatarImg.alt = narratorConfig.name;
    avatarImg.className = 'msg-avatar';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';

    // 編集・削除コントロール
    const controls = document.createElement('div');
    controls.className = 'msg-controls';

    const editBtn = document.createElement('button');
    editBtn.className = 'msg-control-btn edit-btn';
    editBtn.title = 'Edit';
    editBtn.textContent = '🖊';
    controls.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'msg-control-btn delete-btn';
    deleteBtn.title = 'Delete';
    deleteBtn.textContent = '🗑';
    controls.appendChild(deleteBtn);

    contentDiv.appendChild(controls);

    const nameEl = document.createElement('div');
    nameEl.className = 'msg-speaker-name';
    nameEl.textContent = narratorConfig.name;
    contentDiv.appendChild(nameEl);

    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.textContent = text;
    contentDiv.appendChild(textEl);

    msgDiv.appendChild(avatarImg);
    msgDiv.appendChild(contentDiv);
    chatContainer.appendChild(msgDiv);

    editBtn.addEventListener('click', () => editMessage(msgDiv, msgIndex));
    deleteBtn.addEventListener('click', () => deleteMessage(msgIndex, null));

    scrollToBottom();
    return msgDiv;
}

async function triggerNarration() {
    if (!narratorConfig.enabled) return;

    const btn = document.getElementById('narrator-btn');
    if (btn) { btn.disabled = true; }

    // 生成中プレースホルダー
    const placeholder = document.createElement('div');
    placeholder.className = 'chat-msg narration-msg narration-generating';
    placeholder.innerHTML = '<div class="narration-name">' + escapeHTML(narratorConfig.name) + '</div>'
        + '<div class="narration-text">…</div>';
    document.getElementById('chat-history').appendChild(placeholder);
    scrollToBottom();

    try {
        const text = await generateNarration();
        placeholder.remove();

        // chatHistoryに保存（role: 'narrator'）
        chatHistory.push({ role: 'narrator', content: text });
        saveChatHistory();
        appendNarrationMessage(text, chatHistory.length - 1);
    } catch (e) {
        placeholder.remove();
        appendMessage('char', '[ナレーションエラー] ' + e.message, 'System', false);
    } finally {
        if (btn) { btn.disabled = false; }
    }
}

async function generateNarration() {
    // 直近の会話履歴（ナレーション除く）
    const recentHistory = chatHistory.filter(m => !m.isImage).slice(-8);
    const contextText = recentHistory.map(m => {
        if (m.role === 'narrator') return '(前の場面描写): ' + (m.content || '');
        return (m.role === 'user' ? userConfig.name : 'キャラ') + ': '
            + (m.content || '').replace(/<\/?think>/gi, '').substring(0, 400);
    }).join('\n');

    const members = getActivePartyMembers();
    const charNames = members.map(m => m.name).join('、');

    const systemMsg = narratorConfig.style
        + '\n\n登場キャラクター: ' + charNames + (charNames ? '、' : '') + userConfig.name + ' (プレイヤー)'
        + '\n\n直近の会話を踏まえて、今この瞬間の場面を短く地の文で描写してください（3〜5文程度）。'
        + '\n台詞（「」）は絶対に書かないこと。/no_think';

    const res = await fetch(apiConfig.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiConfig.key && apiConfig.key !== 'none'
                ? { 'Authorization': 'Bearer ' + apiConfig.key } : {})
        },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [
                { role: 'system', content: systemMsg },
                { role: 'user',   content: contextText || '（会話なし）' }
            ],
            max_tokens: narratorConfig.maxTokens,
            temperature: 0.9
        })
    });

    if (!res.ok) throw new Error('LLM API error: HTTP ' + res.status);
    const data = await res.json();
    let raw = (data.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
             .replace(/<think>[\s\S]*/gi, '').trim();
    if (!raw) throw new Error('ナレーション生成に失敗しました。');
    return raw;
}

function setupNarratorSettings() {
    const elEnabled   = document.getElementById('narrator-enabled');
    const elName      = document.getElementById('narrator-name');
    const elStyle     = document.getElementById('narrator-style');
    const elAutoTrig  = document.getElementById('narrator-auto-trigger');
    const elMaxTokens = document.getElementById('narrator-max-tokens');
    const saveBtn     = document.getElementById('save-narrator-btn');

    if (!elEnabled || !saveBtn) return;

    elEnabled.checked   = narratorConfig.enabled;
    elName.value        = narratorConfig.name;
    elStyle.value       = narratorConfig.style;
    elAutoTrig.checked  = narratorConfig.autoTrigger;
    elMaxTokens.value   = narratorConfig.maxTokens;

    const updateNarratorBtnVisibility = () => {
        const btn = document.getElementById('narrator-btn');
        if (btn) btn.style.display = narratorConfig.enabled ? '' : 'none';
    };

    saveBtn.addEventListener('click', () => {
        narratorConfig.enabled     = elEnabled.checked;
        narratorConfig.name        = elName.value.trim() || 'ナレーター';
        narratorConfig.style       = elStyle.value.trim();
        narratorConfig.autoTrigger = elAutoTrig.checked;
        narratorConfig.maxTokens   = parseInt(elMaxTokens.value) || 400;

        localStorage.setItem('narratorEnabled',     JSON.stringify(narratorConfig.enabled));
        localStorage.setItem('narratorName',         narratorConfig.name);
        localStorage.setItem('narratorStyle',        narratorConfig.style);
        localStorage.setItem('narratorAutoTrigger',  JSON.stringify(narratorConfig.autoTrigger));
        localStorage.setItem('narratorMaxTokens',    narratorConfig.maxTokens);

        updateNarratorBtnVisibility();
        alert('ナレーター設定を保存しました。');
    });

    updateNarratorBtnVisibility();
}


/**
 * 画像バブルを描画する。
 * @param {string} base64 base64文字列。opts.isUrl=true のときは URL / DataURL をそのまま使う
 * @param {string} prompt キャプション
 * @param {{isUrl?:boolean}} opts isUrl=true で事前登録画像モード（SD再生成ボタンを出さない）
 */
function appendImageMessage(base64, prompt, opts) {
    const isUrl = !!(opts && opts.isUrl);
    const chatContainer = document.getElementById('chat-history');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg image-msg' + (isUrl ? ' library-image' : '');

    const container = document.createElement('div');
    container.className = 'image-msg-container';

    const img = document.createElement('img');
    img.src = isUrl ? base64 : ('data:image/png;base64,' + base64);
    img.alt = isUrl ? (prompt || 'Library image') : 'Generated scene';
    img.className = 'generated-image';

    const promptText = document.createElement('div');
    promptText.className = 'image-prompt-text';
    promptText.textContent = prompt;

    const regenBtn = document.createElement('button');
    regenBtn.className = 'regen-image-btn';
    regenBtn.title = '再生成';
    regenBtn.textContent = '\u{1F504}';
    regenBtn.addEventListener('click', async function() {
        regenBtn.disabled = true;
        regenBtn.textContent = '...';
        try {
            const newBase64 = await generateImage(prompt);
            img.src = 'data:image/png;base64,' + newBase64;
            // Update in chatHistory
            const idx = parseInt(msgDiv.getAttribute('data-index'));
            if (!isNaN(idx) && chatHistory[idx] && chatHistory[idx].isImage) {
                chatHistory[idx].imageData = newBase64;
                saveChatHistory();
            }
        } catch (e) {
            alert('再生成エラー: ' + e.message);
        } finally {
            regenBtn.disabled = false;
            regenBtn.textContent = '\u{1F504}';
        }
    });

    const editPromptBtn = document.createElement('button');
    editPromptBtn.className = 'edit-prompt-btn';
    editPromptBtn.title = 'プロンプトを編集して再生成';
    editPromptBtn.textContent = '✏️';
    editPromptBtn.addEventListener('click', function() {
        openPromptEditModal(prompt, async function(newPrompt) {
            try {
                regenBtn.disabled = true;
                const newBase64 = await generateImage(newPrompt);
                img.src = 'data:image/png;base64,' + newBase64;
                promptText.textContent = newPrompt;
                const idx = parseInt(msgDiv.getAttribute('data-index'));
                if (!isNaN(idx) && chatHistory[idx] && chatHistory[idx].isImage) {
                    chatHistory[idx].imageData = newBase64;
                    chatHistory[idx].content = '[Generated Image]\nPrompt: ' + newPrompt;
                    saveChatHistory();
                }
            } catch (e) {
                alert('再生成エラー: ' + e.message);
            } finally {
                regenBtn.disabled = false;
            }
        });
    });

    container.appendChild(img);
    // 事前登録画像の説明文は「AI がどの画像を選ぶかの手がかり」であり、
    // 読者に見せるキャプションではないので表示しない（alt 属性には残す）。
    if (!isUrl) {
        container.appendChild(promptText);
        // 事前登録画像は SD 再生成の対象外なので、生成系ボタンも付けない
        container.appendChild(regenBtn);
        container.appendChild(editPromptBtn);
    }
    msgDiv.appendChild(container);
    chatContainer.appendChild(msgDiv);
    // 事前登録画像は挿入位置を呼び出し側が調整するため、ここでは自動スクロールしない
    // （過去メッセージへの挿入で画面が最下部へ飛ぶのを防ぐ）
    if (!isUrl) scrollToBottom();

    return msgDiv;
}

/**
 * 本文を {img:タグ} の位置で分割し、その場所に画像を挟んで container に描画する。
 * 画像要素は同期的に正しい位置へ作り、src だけを後から非同期で埋める。
 * こうすることで「待っている間に末尾へ付く」「再描画と競合して重複する」が原理的に起きない。
 */
function buildTextWithInlineImages(container, text) {
    const re = /\{img:\s*([a-zA-Z0-9_\-ぁ-んァ-ヶ一-龠]+)\s*\}/g;
    let last = 0;
    let m;
    const addText = (s) => {
        if (!s) return;
        const span = document.createElement('span');
        span.className = 'msg-text-part';
        span.innerHTML = escapeHTML(s);
        container.appendChild(span);
    };
    while ((m = re.exec(text)) !== null) {
        addText(text.slice(last, m.index));
        const im = document.createElement('img');
        im.className = 'library-inline-image';
        im.setAttribute('data-img-tag', m[1]);
        im.alt = m[1];
        container.appendChild(im);
        resolveLibraryImageSrc(im, m[1]); // 非同期で src を埋める
        last = m.index + m[0].length;
    }
    addText(text.slice(last));
}

/** インライン画像要素の src を、カタログとフォルダから解決して埋める */
async function resolveLibraryImageSrc(imgEl, tag) {
    const drop = () => { if (imgEl && imgEl.parentNode) imgEl.remove(); };
    const entry = findByTag(imageCatalog, tag);
    if (!entry) {
        console.warn('[ImageLib] unknown tag:', tag,
            '| 登録済みタグ:', imageCatalog.map(e => e.tag).join(', ') || '(なし)');
        drop();
        return;
    }
    if (!_imgDirHandle) { drop(); return; }
    if (!_imgDirGranted) {
        _imgDirGranted = await verifyPermission(_imgDirHandle, false);
        if (!_imgDirGranted) {
            drop();
            showImagePermissionBanner();
            return;
        }
    }
    const url = await getImageUrl(_imgDirHandle, entry.file, entry.subDir);
    if (!url) { drop(); return; }
    imgEl.src = url;
    imgEl.alt = entry.description || tag;
}

/**
 * 事前登録画像をタグ指定でチャットに挿入する。
 * 履歴には imageData ではなく imageTag（参照）を保存するため、
 * saveChatHistory の imageData 剥奪を受けず、リロード後も画像が復元できる。
 * @param {string} tag カタログのタグ
 * @param {number} forcedIndex 復元時の既存インデックス（-1 なら新規追加）
 */
async function appendLibraryImage(tag, forcedIndex = -1, opts) {
    const quiet = !!(opts && opts.quiet); // 履歴復元時は通知を抑制（大量に出るため）
    const token = _chatRenderToken;       // 待機中に再描画されたかを判定するため控える
    const entry = findByTag(imageCatalog, tag);
    if (!entry) {
        console.warn('[ImageLib] unknown tag:', tag,
            '| 登録済みタグ:', imageCatalog.map(e => e.tag).join(', ') || '(なし)');
        if (!quiet) showToast('🖼️ 未登録のタグ「' + tag + '」— Image Library で登録を確認してください', 'error');
        return null;
    }
    if (!_imgDirHandle) {
        console.warn('[ImageLib] no folder selected');
        if (!quiet) showToast('🖼️ 画像フォルダが未選択です — Image Library で選択してください', 'error');
        return null;
    }
    if (!_imgDirGranted) {
        // 権限要求はユーザー操作起点でしか通らないため、ここでは非対話で確認のみ
        _imgDirGranted = await verifyPermission(_imgDirHandle, false);
        if (!_imgDirGranted) {
            console.warn('[ImageLib] folder permission not granted');
            // 権限は要ユーザー操作。チャット内に復帰ボタンを出す（復元時も一度だけ出す）
            showImagePermissionBanner();
            return null;
        }
    }
    const url = await getImageUrl(_imgDirHandle, entry.file, entry.subDir);
    if (!url) {
        if (!quiet) showToast('🖼️ 画像を読めません: ' + (entry.subDir ? entry.subDir + '/' : '') + entry.file
            + '（ファイル名が変わっていませんか）', 'error');
        return null;
    }

    // ファイル読み出しを待っている間に画面が作り直されていたら、この結果は捨てる
    if (token !== _chatRenderToken) return null;

    let idx = forcedIndex;
    if (forcedIndex < 0) {
        chatHistory.push({
            role: 'assistant',
            content: '[Library Image]\nTag: ' + tag,
            isImage: true,
            imageTag: tag   // ← 復元キー。imageData は持たせない
        });
        saveChatHistory();
        idx = chatHistory.length - 1;
    }

    const esc = (window.CSS && CSS.escape) ? CSS.escape(tag) : tag;
    const hist = document.getElementById('chat-history');

    // 本文タグ由来なら、対応するメッセージの吹き出しの中に埋め込む
    const ownerBubbles = hist
        ? hist.querySelectorAll('.chat-msg[data-index="' + idx + '"]:not(.image-msg)')
        : [];
    if (ownerBubbles.length > 0) {
        const target = ownerBubbles[ownerBubbles.length - 1].querySelector('.msg-content');
        if (target) {
            // 同じ吹き出しに同じタグの画像が既にあるなら二重に出さない
            if (target.querySelector('.library-inline-image[data-img-tag="' + esc + '"]')) return null;
            const im = document.createElement('img');
            im.className = 'library-inline-image';
            im.src = url;
            im.alt = entry.description || tag;
            im.setAttribute('data-img-tag', tag);
            target.appendChild(im);
            return im;
        }
    }

    // 対応する吹き出しが無い場合（旧方式の独立エントリ・クエストイベント画像）は
    // 従来どおり単独の画像ブロックとして表示する
    const dupSel = '#chat-history .chat-msg.library-image[data-owner-index="' + idx + '"][data-img-tag="' + esc + '"]';
    if (document.querySelector(dupSel)) return null;

    const div = appendImageMessage(url, entry.description || tag, { isUrl: true });
    div.setAttribute('data-index', idx);
    div.setAttribute('data-owner-index', idx);
    div.setAttribute('data-img-tag', tag);
    // 独立エントリは自分の並び順（直前メッセージの後ろ）へ移動する
    if (hist && idx > 0) {
        const prev = hist.querySelectorAll('.chat-msg[data-index="' + (idx - 1) + '"]');
        if (prev.length > 0) prev[prev.length - 1].insertAdjacentElement('afterend', div);
    }
    return div;
}

function openPromptEditModal(currentPrompt, onGenerate) {
    const modal = document.getElementById('prompt-edit-modal');
    const textarea = document.getElementById('prompt-edit-textarea');
    textarea.value = currentPrompt;
    modal.classList.remove('hidden');
    textarea.focus();

    function cleanup() {
        modal.classList.add('hidden');
        const genBtn = document.getElementById('prompt-edit-generate-btn');
        const canBtn = document.getElementById('prompt-edit-cancel-btn');
        genBtn.replaceWith(genBtn.cloneNode(true));
        canBtn.replaceWith(canBtn.cloneNode(true));
    }

    document.getElementById('prompt-edit-generate-btn').addEventListener('click', async function() {
        const newPrompt = textarea.value.trim();
        if (!newPrompt) return;
        cleanup();
        await onGenerate(newPrompt);
    }, { once: true });

    document.getElementById('prompt-edit-cancel-btn').addEventListener('click', function() {
        cleanup();
    }, { once: true });

    modal.addEventListener('click', function(e) {
        if (e.target === modal) cleanup();
    }, { once: true });
}

async function triggerImageGeneration(manualPrompt) {
    if (!sdConfig.enabled) {
        alert('画像生成が無効です。Settingsで有効にしてください。');
        return;
    }
    const btn = document.getElementById('imggen-btn');
    if (btn) btn.disabled = true;

    try {
        // Show generating message
        const genMsg = document.createElement('div');
        genMsg.className = 'chat-msg image-msg generating';
        genMsg.innerHTML = '<div class="image-msg-container"><div class="image-generating-text">シーン画像を生成中...</div></div>';
        document.getElementById('chat-history').appendChild(genMsg);
        scrollToBottom();

        let prompt;
        if (manualPrompt) {
            prompt = manualPrompt;
        } else {
            prompt = await generateScenePrompt();
        }

        const base64 = await generateImage(prompt);

        // Remove generating message
        genMsg.remove();

        // Append image to chat
        const msgDiv = appendImageMessage(base64, prompt);

        // Save to chatHistory
        chatHistory.push({
            role: 'assistant',
            content: '[Generated Image]\nPrompt: ' + prompt,
            isImage: true,
            imageData: base64
        });
        const newIdx = chatHistory.length - 1;
        msgDiv.setAttribute('data-index', newIdx);
        saveChatHistory();

    } catch (e) {
        // Remove any generating message
        const genEl = document.querySelector('.image-msg.generating');
        if (genEl) genEl.remove();
        appendMessage('char', '[画像生成エラー] ' + e.message, 'System', false);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function triggerFocusImageGeneration(charIdx) {
    if (!sdConfig.enabled) return;
    const char = getActivePartyMembers()[charIdx];
    if (!char) return;

    const btn = document.querySelector(`.focus-imggen-btn[data-char-idx="${charIdx}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    try {
        const genMsg = document.createElement('div');
        genMsg.className = 'chat-msg image-msg generating';
        genMsg.innerHTML = '<div class="image-msg-container"><div class="image-generating-text">'
            + escapeHTML(char.name) + 'のフォーカス画像を生成中...</div></div>';
        document.getElementById('chat-history').appendChild(genMsg);
        scrollToBottom();

        const prompt  = await generateCharacterFocusPrompt(char);
        const base64  = await generateImage(prompt);

        genMsg.remove();
        const msgDiv = appendImageMessage(base64, prompt);
        chatHistory.push({
            role: 'assistant',
            content: '[Generated Image]\nPrompt: ' + prompt,
            isImage: true,
            imageData: base64
        });
        const newIdx = chatHistory.length - 1;
        msgDiv.setAttribute('data-index', newIdx);
        saveChatHistory();
    } catch(e) {
        const genEl = document.querySelector('.image-msg.generating');
        if (genEl) genEl.remove();
        appendMessage('char', '[フォーカス画像エラー] ' + e.message, 'System', false);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🎨'; }
    }
}

// ---- Editor Logic ----
// ======== SAVE HELPERS ========

function saveUserConfig() {
    localStorage.setItem('userName',        userConfig.name);
    localStorage.setItem('userPersonality', userConfig.personality);
    localStorage.setItem('userPersona',     userConfig.description);
    localStorage.setItem('userScenario',    userConfig.scenario    || '');
    localStorage.setItem('userFirstMes',    userConfig.first_mes   || '');
    localStorage.setItem('userMesExample',  userConfig.mes_example);
    if (userConfig.avatar) localStorage.setItem('userAvatar', userConfig.avatar);
    localStorage.setItem('userSdPrompt',  userConfig.sdPrompt  || '');
    localStorage.setItem('userLorebook', JSON.stringify(userConfig.lorebook || []));
    localStorage.setItem('userPlayerNote', userConfig.player_note || '');
    localStorage.setItem('userVoice', JSON.stringify(userConfig.voice || { engine: 'none', voiceURI: '', speakerId: 0, pitch: 1.0, speed: 1.0 }));
}

// ======== 完全自由空間モード: チートモード判定 ========
// Settings のチートモード・トグルが ON のとき Mary Sue 防止を強制無効化する。
// 元の「キャラぷ」では世界観入力に「チートモード」と書く仕様だったが、本エンジンでは
// 明示的なチェックボックス化で「気づかず ON になっていた」事故を防ぐ。
function isCheatModeActive() {
    return !!cheatMode;
}

// ======== プレイヤー名履歴（プレイヤー切替後のAI混乱対策） ========
// セッション途中でプレイヤーキャラを切り替えた場合、chatHistory には旧プレイヤー名の
// [SPEAKER:] ブロックが残ったままになる。AIは「旧名 = 主人公」「新名 = 主人公」の
// 矛盾を抱えたまま生成するため、合体ラベル（例: 「優戸（ハル博士）」）等の混乱を起こす。
// これを防ぐため、旧プレイヤー名を localStorage に記録し、システムプロンプトに
// 「これは別人です」と明示する注釈を自動注入する。

const PLAYER_NAME_HISTORY_MAX = 10;

function recordPlayerNameInHistory(oldName) {
    if (!oldName || typeof oldName !== 'string') return;
    const trimmed = oldName.trim();
    if (!trimmed || trimmed === 'User' || trimmed === 'Player' || trimmed === 'user' || trimmed === 'player') return;
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem('playerNameHistory') || '[]');
        if (!Array.isArray(history)) history = [];
    } catch (e) { history = []; }
    // 同名なら末尾に持ってくる（最近性更新）
    history = history.filter(n => n !== trimmed);
    history.push(trimmed);
    if (history.length > PLAYER_NAME_HISTORY_MAX) {
        history = history.slice(-PLAYER_NAME_HISTORY_MAX);
    }
    try {
        localStorage.setItem('playerNameHistory', JSON.stringify(history));
    } catch (e) { /* localStorage full は無視 */ }
}

function getPlayerNameHistory() {
    try {
        const h = JSON.parse(localStorage.getItem('playerNameHistory') || '[]');
        return Array.isArray(h) ? h : [];
    } catch (e) { return []; }
}

// chatHistory 内に旧プレイヤー名の [SPEAKER:] ブロックが残っているかを検出。
// 現在のプレイヤー名と異なり、かつ chatHistory に SPEAKER タグとして出現する名前を返す。
function detectPreviousPlayersInChat() {
    const detected = [];
    if (!chatHistory || chatHistory.length === 0) return detected;
    const history = getPlayerNameHistory();
    if (history.length === 0) return detected;
    const currentName = (userConfig.name || '').trim();

    const haystack = chatHistory.map(m => (m && m.content) || '').join('\n');
    history.forEach(oldName => {
        if (!oldName || oldName === currentName) return;
        // [SPEAKER: 旧名] と [SPEAKER:旧名] の両パターンを検出
        const pattern = new RegExp('\\[SPEAKER:\\s*' + oldName.replace(/[.*+?^${}()|[\\\]\\\\]/g, '\\$&'), 'i');
        if (pattern.test(haystack)) detected.push(oldName);
    });
    return detected;
}

function getEditTargetData() {
    if (editTarget === 'player') return userConfig;
    return characterDataArray[editTarget] || null;
}

function setEditTargetData(data) {
    if (editTarget === 'player') {
        userConfig.name        = data.name        || 'User';
        userConfig.personality = data.personality || '';
        userConfig.description = data.description || '';
        userConfig.scenario    = data.scenario    || '';
        userConfig.first_mes   = data.first_mes   || '';
        userConfig.mes_example = data.mes_example || '';
        userConfig.avatar      = data.avatar      || userConfig.avatar || '';
        userConfig.sdPrompt    = data.sdPrompt    || '';
        userConfig.lorebook    = data.lorebook    || [];
        userConfig.voice       = data.voice       || userConfig.voice || { engine: 'none', voiceURI: '', speakerId: 0, pitch: 1.0, speed: 1.0 };
        saveUserConfig();
    } else {
        characterDataArray[editTarget] = data;
        safeSetItem('savedParty', JSON.stringify(characterDataArray));
    }
}

// ======== PARTY SET VIEW ========

function setupPartySet() {
    // Party Export
    document.getElementById('export-party-btn').addEventListener('click', function() {
        const exportObj = {
            spec: "rp_engine_party_v1",
            party: characterDataArray,
            common_lore: commonLorebook,
            user_config: userConfig
        };
        var blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'party_export_' + Date.now() + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    // Party Import
    document.getElementById('import-party-file').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const json = JSON.parse(event.target.result);
                if (json.spec === "rp_engine_party_v1") {
                    characterDataArray = json.party;
                    commonLorebook = json.common_lore || [];
                    if (json.user_config) {
                        userConfig.name        = json.user_config.name        || 'User';
                        userConfig.personality = json.user_config.personality || '';
                        userConfig.description = json.user_config.description || json.user_config.persona || '';
                        userConfig.scenario    = json.user_config.scenario    || '';
                        userConfig.first_mes   = json.user_config.first_mes   || '';
                        userConfig.mes_example = json.user_config.mes_example || '';
                        userConfig.avatar      = json.user_config.avatar      || '';
                        userConfig.sdPrompt    = json.user_config.sdPrompt    || '';
                        userConfig.lorebook    = json.user_config.lorebook    || [];
                        saveUserConfig();
                    }
                    safeSetItem('savedParty', JSON.stringify(characterDataArray));
                    localStorage.setItem('savedCommonLore', JSON.stringify(commonLorebook));
                    renderPartySheet();
                    renderPartySetGrid();
                    updateEditTabNames();
                    alert('Party imported!');
                } else {
                    alert('Invalid party export file.');
                }
            } catch(err) {
                alert('Failed to parse JSON file.');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    renderPartySetGrid();
}

function renderPartySetGrid() {
    const grid = document.getElementById('party-set-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Helper: build one slot card
    function buildCard(label, data, slotKey, isPlayer) {
        const card = document.createElement('div');
        card.className = 'party-set-card';

        const avatarPlaceholder = isPlayer
            ? "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23aaa' d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>"
            : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23666' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z'/></svg>";

        const avatarSrc = (data && data.avatar) ? data.avatar : avatarPlaceholder;
        const name = (data && data.name) ? data.name : (isPlayer ? 'User' : '(空)');
        const personality = (data && data.personality) ? data.personality : '';
        const isEmpty = !data || !data.name || data.name.includes('Empty');

        // ➕ Generate NPC ボタン: 空スロット かつ Free World + NPC Generation 両方 ON のみ表示
        const showGenerateBtn = !isPlayer && isEmpty && freeWorldEnabled && npcGenerationEnabled;
        const generateBtnHtml = showGenerateBtn
            ? '<button class="primary-btn psc-btn psc-generate-btn" data-slot="' + slotKey + '" title="世界観に合わせた NPC を LLM で自動生成">➕ Generate NPC</button>'
            : '';

        card.innerHTML = `
            <div class="psc-label">${label}</div>
            <img class="psc-avatar" src="${avatarSrc}" alt="${escapeHTML(name)}">
            <div class="psc-name">${escapeHTML(name)}</div>
            <div class="psc-personality">${escapeHTML(personality).substring(0, 40)}</div>
            <div class="psc-actions">
                <label class="secondary-btn psc-btn">Import<input type="file" accept=".json" class="psc-import-file" data-slot="${slotKey}" hidden></label>
                <button class="primary-btn psc-btn psc-edit-btn" data-slot="${slotKey}">Edit</button>
                ${!isPlayer ? '<button class="danger-btn psc-btn psc-clear-btn" data-slot="' + slotKey + '">Clear</button>' : ''}
                ${generateBtnHtml}
            </div>
        `;
        return card;
    }

    // Player card
    grid.appendChild(buildCard('Player ({{user}})', userConfig, 'player', true));
    // NPC slot cards
    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
        grid.appendChild(buildCard('Slot ' + (i+1), characterDataArray[i], String(i), false));
    }

    // Wire import file inputs
    grid.querySelectorAll('.psc-import-file').forEach(input => {
        input.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            const slotKey = this.getAttribute('data-slot');
            const reader = new FileReader();
            reader.onload = function(event) {
                try {
                    const json = JSON.parse(event.target.result);
                    const d = normalizeToEngineChar(json);
                    if (!d || !d.name) { alert('認識できないファイル形式です。'); return; }
                    if (slotKey === 'player') {
                        editTarget = 'player';
                        setEditTargetData(d);
                    } else {
                        editTarget = parseInt(slotKey);
                        setEditTargetData(d);
                    }
                    renderPartySheet();
                    renderPartySetGrid();
                    updateEditTabNames();
                    alert(d.name + ' をセットしました！');
                } catch(err) { alert('JSONの読み込みに失敗しました。'); }
            };
            reader.readAsText(file);
            e.target.value = '';
        });
    });

    // Wire Edit buttons → switch to Character Edit view + select tab
    grid.querySelectorAll('.psc-edit-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const slotKey = this.getAttribute('data-slot');
            editTarget = (slotKey === 'player') ? 'player' : parseInt(slotKey);
            // Switch nav to char-edit-view
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.querySelectorAll('.view-section').forEach(v => v.classList.add('hidden'));
            const editNav = document.querySelector('[data-view="char-edit-view"]');
            if (editNav) editNav.classList.add('active');
            document.getElementById('char-edit-view').classList.remove('hidden');
            // Select the correct tab
            document.querySelectorAll('#edit-tabs .slot-tab').forEach(t => t.classList.remove('active'));
            const targetTab = document.querySelector('#edit-tabs .slot-tab[data-edit-target="' + slotKey + '"]');
            if (targetTab) targetTab.classList.add('active');
            loadEditTargetIntoEditor();
        });
    });

    // Wire Clear buttons
    grid.querySelectorAll('.psc-clear-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.getAttribute('data-slot'));
            if (!confirm('Slot ' + (idx+1) + ' のデータをクリアしますか？')) return;
            characterDataArray[idx] = {
                name: 'Slot ' + (idx+1) + ' Empty', tags: ["Draft"], personality: "Unknown",
                description: "", scenario: "", first_mes: "", mes_example: "", sdPrompt: "", avatar: "", lorebook: []
            };
            safeSetItem('savedParty', JSON.stringify(characterDataArray));
            // クリアしたスロットが現在のeditTargetと一致する場合、フォームも同期する
            if (editTarget === idx) {
                loadEditTargetIntoEditor();
            }
            renderPartySheet();
            renderPartySetGrid();
            updateEditTabNames();
        });
    });

    // Wire Generate NPC buttons (完全自由空間モード)
    grid.querySelectorAll('.psc-generate-btn').forEach(btn => {
        btn.addEventListener('click', async function() {
            if (_isGeneratingNpc) {
                alert('別の NPC を生成中です。少しお待ちください。');
                return;
            }
            const idx = parseInt(this.getAttribute('data-slot'));
            // 世界観テーマの取得（クエスト > Settings > デフォルト）
            let theme = '';
            if (activeQuest && activeQuest.template && activeQuest.template.additional_settings) {
                theme = activeQuest.template.additional_settings.trim();
            }
            if (!theme) theme = (worldTheme || '').trim();
            if (!theme) theme = '現代日本の日常';
            const themeShown = theme.length > 100 ? theme.substring(0, 100) + '...' : theme;
            if (!confirm('世界観:\n「' + themeShown + '」\n\nこのテーマで Slot ' + (idx+1) + ' に NPC を生成しますか？\n（LLM 呼出に最大 ' + apiConfig.timeoutSec + ' 秒かかる場合があります）')) return;

            _isGeneratingNpc = true;
            const originalText = this.textContent;
            this.textContent = '⏳ 生成中...';
            this.disabled = true;

            try {
                const npc = await generateNpcByLLM();
                if (!npc || !npc.name) throw new Error('LLM 生成結果が不正です。');
                characterDataArray[idx] = npc;
                safeSetItem('savedParty', JSON.stringify(characterDataArray));
                renderPartySheet();
                renderPartySetGrid();
                updateEditTabNames();
                alert('「' + npc.name + '」を Slot ' + (idx+1) + ' に生成しました。');
            } catch (e) {
                console.error('[Generate NPC]', e);
                alert('NPC 生成失敗:\n' + e.message + '\n\nもう一度試すか、Settings の世界観テンプレを調整してください。');
                this.textContent = originalText;
                this.disabled = false;
            } finally {
                _isGeneratingNpc = false;
            }
        });
    });
}

/**
 * あらゆるフォーマットのキャラクターカードを RP Engine 内部フォーマットに正規化する。
 * 対応フォーマット:
 *   rp_engine_card_v1  — 新統一フォーマット
 *   rp_engine_v1       — 旧エンジンキャラフォーマット
 *   rp_engine_user_v1  — 旧ユーザーペルソナフォーマット
 *   chara_card_v2      — SillyTavern 互換
 *   フォールバック     — engine_data / data / root
 * @returns {object} エンジン内部フォーマットのキャラクターオブジェクト
 */
function normalizeToEngineChar(json) {
    if (!json || typeof json !== 'object') return null;

    // 新統一フォーマット
    if (json.spec === 'rp_engine_card_v1') {
        return json.data || {};
    }

    // 旧エンジンキャラフォーマット
    if (json.spec === 'rp_engine_v1') {
        return json.engine_data || {};
    }

    // 旧ユーザーペルソナフォーマット → キャラフォーマットに変換
    if (json.spec === 'rp_engine_user_v1') {
        const u = json.user_data || {};
        return {
            name:        u.name        || '',
            personality: u.personality || '',
            description: u.description || '',
            scenario:    '',
            first_mes:   '',
            mes_example: u.mes_example || '',
            avatar:      u.avatar      || '',
            tags:        [],
            creator:     '',
            lorebook:    []
        };
    }

    // SillyTavern chara_card_v2 フォーマット
    if (json.spec === 'chara_card_v2' || json.data) {
        const raw = json.data || {};
        const d = {
            name:        raw.name        || '',
            personality: raw.personality || '',
            description: raw.description || '',
            scenario:    raw.scenario    || '',
            first_mes:   raw.first_mes   || '',
            mes_example: raw.mes_example || '',
            avatar:      raw.avatar      || '',
            tags:        raw.tags        || [],
            creator:     raw.creator     || '',
            lorebook:    []
        };
        // character_book.entries → lorebook 変換
        if (raw.character_book && Array.isArray(raw.character_book.entries)) {
            d.lorebook = raw.character_book.entries
                .filter(e => e.enabled !== false && (e.content || '').trim())
                .map(e => ({
                    key:     (e.keys || []).join(', '),
                    content: e.content || ''
                }))
                .filter(e => e.content);
        }
        return d;
    }

    // フォールバック: engine_data / data / root をそのまま使用
    return json.engine_data || json.data || json;
}

// ======== AVATAR CROP MODAL ========

const cropState = {
    img:        null,    // HTMLImageElement
    scale:      1.0,
    offsetX:    0,       // px: image center offset from canvas center
    offsetY:    0,
    isDragging: false,
    dragLastX:  0,
    dragLastY:  0,
    canvasSize: 360,     // display canvas size (px)
    outputSize: 256,     // output image size (px) — 20+スロット対応で localStorage 圧迫回避のため縮小
    callback:   null     // called with base64 on confirm
};

function openAvatarCropModal(dataUrl, callback) {
    cropState.callback = callback;
    const modal = document.getElementById('avatar-crop-modal');
    const canvas = document.getElementById('crop-canvas');
    const zoomSlider = document.getElementById('crop-zoom');

    const img = new Image();
    img.onload = function() {
        cropState.img = img;
        // Initial scale: fit the shorter side to canvas
        const fitScale = cropState.canvasSize / Math.min(img.naturalWidth, img.naturalHeight);
        cropState.scale  = fitScale;
        cropState.offsetX = 0;
        cropState.offsetY = 0;
        zoomSlider.min   = (fitScale * 0.25).toFixed(3);
        zoomSlider.max   = (fitScale * 10).toFixed(3);
        zoomSlider.step  = (fitScale * 0.01).toFixed(4);
        zoomSlider.value = fitScale;
        drawCropPreview();
        modal.classList.remove('hidden');
    };
    img.src = dataUrl;
}

function drawCropPreview() {
    const canvas = document.getElementById('crop-canvas');
    if (!canvas || !cropState.img) return;
    const ctx = canvas.getContext('2d');
    const cs = cropState.canvasSize;
    const margin = 4;
    ctx.clearRect(0, 0, cs, cs);

    // Draw image centered at (cs/2 + offsetX, cs/2 + offsetY) with current scale
    const iw = cropState.img.naturalWidth  * cropState.scale;
    const ih = cropState.img.naturalHeight * cropState.scale;
    const x = cs / 2 - iw / 2 + cropState.offsetX;
    const y = cs / 2 - ih / 2 + cropState.offsetY;
    ctx.drawImage(cropState.img, x, y, iw, ih);

    // Dim overlay outside square crop guide
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fillRect(0, 0, cs, cs);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillRect(margin, margin, cs - margin * 2, cs - margin * 2);
    ctx.globalCompositeOperation = 'source-over';

    // Re-draw image clipped to square
    ctx.save();
    ctx.beginPath();
    ctx.rect(margin, margin, cs - margin * 2, cs - margin * 2);
    ctx.clip();
    ctx.drawImage(cropState.img, x, y, iw, ih);
    ctx.restore();

    // Square border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(margin, margin, cs - margin * 2, cs - margin * 2);
}

function getCroppedAvatarBase64() {
    if (!cropState.img) return null;
    const os = cropState.outputSize;
    const cs = cropState.canvasSize;
    const ratio = os / cs;
    const margin = 4;
    const out = document.createElement('canvas');
    out.width = os;
    out.height = os;
    const ctx = out.getContext('2d');

    // Square clip
    const marginScaled = margin * ratio;
    ctx.beginPath();
    ctx.rect(marginScaled, marginScaled, os - marginScaled * 2, os - marginScaled * 2);
    ctx.clip();

    // Draw image at output resolution
    const iw = cropState.img.naturalWidth  * cropState.scale * ratio;
    const ih = cropState.img.naturalHeight * cropState.scale * ratio;
    const x  = os / 2 - iw / 2 + cropState.offsetX * ratio;
    const y  = os / 2 - ih / 2 + cropState.offsetY * ratio;
    ctx.drawImage(cropState.img, x, y, iw, ih);

    // WebP 0.8 で圧縮（PNG比で約 1/5〜1/8 のサイズ）
    // 非対応ブラウザ用フォールバック: JPEG 0.85（Chrome 32+ / Firefox 65+ / Safari 14+ で WebP 対応済み）
    return canvasToCompressedDataURL(out, 'image/webp', 0.8);
}

// Canvas を WebP/JPEG/PNG の優先順で圧縮し base64 DataURL を返す
function canvasToCompressedDataURL(canvas, preferredType, quality) {
    try {
        const webp = canvas.toDataURL(preferredType, quality);
        // WebP 非対応ブラウザは PNG にフォールバックされる（接頭辞で判別）
        if (preferredType === 'image/webp' && webp && webp.startsWith('data:image/webp')) {
            return webp;
        }
        // WebP がダメなら JPEG
        const jpeg = canvas.toDataURL('image/jpeg', 0.85);
        if (jpeg && jpeg.startsWith('data:image/jpeg')) return jpeg;
    } catch (e) {
        // toDataURL 失敗時のフォールバック
    }
    return canvas.toDataURL('image/png');
}

function setupAvatarCropModal() {
    const canvas    = document.getElementById('crop-canvas');
    const wrap      = canvas ? canvas.parentElement : null;
    const zoomSlider = document.getElementById('crop-zoom');
    const confirmBtn = document.getElementById('crop-confirm-btn');
    const resetBtn   = document.getElementById('crop-reset-btn');
    const cancelBtn  = document.getElementById('crop-cancel-btn');
    if (!canvas || !wrap) return;

    // ── Drag (mouse) ──
    wrap.addEventListener('mousedown', e => {
        cropState.isDragging = true;
        cropState.dragLastX  = e.clientX;
        cropState.dragLastY  = e.clientY;
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
        if (!cropState.isDragging) return;
        cropState.offsetX += e.clientX - cropState.dragLastX;
        cropState.offsetY += e.clientY - cropState.dragLastY;
        cropState.dragLastX = e.clientX;
        cropState.dragLastY = e.clientY;
        drawCropPreview();
    });
    window.addEventListener('mouseup', () => { cropState.isDragging = false; });

    // ── Drag (touch) ──
    wrap.addEventListener('touchstart', e => {
        const t = e.touches[0];
        cropState.isDragging = true;
        cropState.dragLastX  = t.clientX;
        cropState.dragLastY  = t.clientY;
        e.preventDefault();
    }, { passive: false });
    window.addEventListener('touchmove', e => {
        if (!cropState.isDragging) return;
        const t = e.touches[0];
        cropState.offsetX += t.clientX - cropState.dragLastX;
        cropState.offsetY += t.clientY - cropState.dragLastY;
        cropState.dragLastX = t.clientX;
        cropState.dragLastY = t.clientY;
        drawCropPreview();
    });
    window.addEventListener('touchend', () => { cropState.isDragging = false; });

    // ── Scroll wheel zoom ──
    wrap.addEventListener('wheel', e => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.08 : 0.93;
        cropState.scale = Math.min(
            Math.max(cropState.scale * delta, parseFloat(zoomSlider.min)),
            parseFloat(zoomSlider.max)
        );
        zoomSlider.value = cropState.scale;
        drawCropPreview();
    }, { passive: false });

    // ── Zoom slider ──
    zoomSlider.addEventListener('input', () => {
        cropState.scale = parseFloat(zoomSlider.value);
        drawCropPreview();
    });

    // ── Buttons ──
    confirmBtn.addEventListener('click', () => {
        const base64 = getCroppedAvatarBase64();
        document.getElementById('avatar-crop-modal').classList.add('hidden');
        if (base64 && cropState.callback) cropState.callback(base64);
        cropState.callback = null;
    });

    resetBtn.addEventListener('click', () => {
        if (!cropState.img) return;
        const fitScale = cropState.canvasSize / Math.min(cropState.img.naturalWidth, cropState.img.naturalHeight);
        cropState.scale   = fitScale;
        cropState.offsetX = 0;
        cropState.offsetY = 0;
        zoomSlider.value  = fitScale;
        drawCropPreview();
    });

    cancelBtn.addEventListener('click', () => {
        document.getElementById('avatar-crop-modal').classList.add('hidden');
        cropState.callback = null;
    });
}

// ======== CHARACTER EDIT VIEW (統一エディタ) ========

// Character Edit のスロットタブを MAX_PARTY_SLOTS 個動的生成する
// Player タブは index.html に既存（最初の子要素）なので追加しない
function renderEditTabs() {
    const container = document.getElementById('edit-tabs');
    if (!container) return;
    // 既存の Slot タブ（data-edit-target が数値）を一旦すべて削除
    container.querySelectorAll('.slot-tab').forEach(tab => {
        const target = tab.getAttribute('data-edit-target');
        if (target !== 'player') tab.remove();
    });
    // MAX_PARTY_SLOTS 個のスロットタブを追加
    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
        const tab = document.createElement('div');
        tab.className = 'slot-tab';
        tab.setAttribute('data-edit-target', String(i));
        tab.textContent = 'Slot ' + (i + 1);
        container.appendChild(tab);
    }
    // 既存キャラ名でラベル更新
    updateEditTabNames();
}

function setupCharacterEdit() {
    // タブを動的生成（Player + Slot 1〜MAX_PARTY_SLOTS）
    renderEditTabs();

    // Tab switching: イベント委譲で動的タブにも対応
    const tabsContainer = document.getElementById('edit-tabs');
    if (tabsContainer) {
        tabsContainer.addEventListener('click', function(e) {
            const tab = e.target.closest('.slot-tab');
            if (!tab || !tabsContainer.contains(tab)) return;
            tabsContainer.querySelectorAll('.slot-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.getAttribute('data-edit-target');
            editTarget = (target === 'player') ? 'player' : parseInt(target);
            loadEditTargetIntoEditor();
        });
    }

    // Avatar upload
    document.getElementById('edit-char-avatar').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(event) {
            // クロップモーダルを開き、確定後にアバターを設定
            openAvatarCropModal(event.target.result, function(croppedBase64) {
                const data = getEditTargetData();
                if (data) {
                    data.avatar = croppedBase64;
                    const previewDiv = document.getElementById('slot-avatar-preview');
                    if (previewDiv) previewDiv.innerHTML = '<img src="' + croppedBase64 + '" class="slot-preview-img">';
                }
            });
        };
        reader.readAsDataURL(file);
        // ファイル入力をリセット（同じファイルの再選択を可能に）
        this.value = '';
    });

    // Save
    document.getElementById('save-char-btn').addEventListener('click', function() {
        const formData = {
            name:        document.getElementById('edit-char-name').value.trim() || (editTarget === 'player' ? 'User' : ''),
            personality: document.getElementById('edit-char-personality').value,
            description: document.getElementById('edit-char-desc').value,
            scenario:    document.getElementById('edit-char-scenario').value,
            first_mes:   document.getElementById('edit-char-firstmes').value,
            mes_example: document.getElementById('edit-char-examples').value,
            sdPrompt:    document.getElementById('edit-char-sd-prompt').value,
            lorebook:    getLorebookFromEditor(),
            avatar:      (getEditTargetData() || {}).avatar || '',
            voice: {
                engine:    document.getElementById('edit-char-voice-engine').value,
                voiceURI:  document.getElementById('edit-char-voice-engine').value === 'webspeech' ? document.getElementById('edit-char-voice-speaker').value : '',
                speakerId: document.getElementById('edit-char-voice-engine').value === 'voicevox' ? parseInt(document.getElementById('edit-char-voice-speaker').value || '0') : 0,
                pitch:     parseFloat(document.getElementById('edit-char-voice-pitch').value || '1.0'),
                speed:     parseFloat(document.getElementById('edit-char-voice-speed').value || '1.0')
            }
        };

        // ===== プレイヤー切替警告 (A) =====
        // editTarget === 'player' AND 名前が変わる AND chatHistory に内容がある場合、
        // 「リセットする/しない」の選択を提示する。
        // OKでもキャンセルでも変更自体は適用するが、OKならチャットをリセットする。
        // 旧プレイヤー名は常に履歴記録される（(B) 注釈注入の基礎データになる）。
        if (editTarget === 'player') {
            const oldName = (userConfig.name || '').trim();
            const newName = (formData.name || '').trim();
            const hasChat = Array.isArray(chatHistory) && chatHistory.length > 0;
            if (oldName && newName && oldName !== newName && hasChat) {
                const shouldReset = confirm(
                    '⚠️ プレイヤー名を変更しようとしています:\n' +
                    '  「' + oldName + '」 →  「' + newName + '」\n\n' +
                    '既存のチャット履歴には旧プレイヤー「' + oldName + '」の発言・行動が含まれています。\n' +
                    'AIが「' + oldName + ' = ' + newName + '」と混同して「合体ラベル」を出力する可能性があります。\n\n' +
                    '【OK】  チャットをリセットして変更（推奨）\n' +
                    '【キャンセル】  履歴を残したまま変更（旧名は履歴記録され、AIに「別人扱い」を促す注釈が自動注入されます）'
                );
                if (shouldReset) {
                    chatHistory = [];
                    resetContextSummary();
                    clearChoiceButtons();
                    clearInfoPanel();
                    const histEl = document.getElementById('chat-history');
                    if (histEl) histEl.innerHTML = '';
                    saveChatHistory();
                }
                // リセット有無に関わらず旧名を履歴に記録
                recordPlayerNameInHistory(oldName);
            }
        }

        setEditTargetData(formData);
        renderPartySheet();
        renderPartySetGrid();
        updateEditTabNames();
        const label = (editTarget === 'player') ? 'Player' : 'Slot ' + (editTarget + 1);
        alert(label + ' を保存しました！');
    });

    // Export JSON — rp_engine_card_v1
    document.getElementById('export-char-btn').addEventListener('click', function() {
        const data = getEditTargetData();
        if (!data) return;
        var exportObj = {
            spec: 'rp_engine_card_v1',
            spec_version: '1.0',
            data: {
                name:        data.name        || '',
                personality: data.personality || '',
                description: data.description || '',
                scenario:    data.scenario    || '',
                first_mes:   data.first_mes   || '',
                mes_example: data.mes_example || '',
                avatar:      data.avatar      || '',
                sdPrompt:    data.sdPrompt    || '',
                tags:        data.tags        || [],
                creator:     data.creator     || '',
                lorebook:    data.lorebook    || []
            }
        };
        var blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (data.name || 'character') + '_card.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    // Import JSON
    document.getElementById('import-char-file').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(event) {
            try {
                var json = JSON.parse(event.target.result);
                var d = normalizeToEngineChar(json);
                if (!d) { alert('認識できないファイル形式です。'); return; }
                setEditTargetData(d);
                loadEditTargetIntoEditor();
                renderPartySheet();
                renderPartySetGrid();
                updateEditTabNames();
                const label = (editTarget === 'player') ? 'Player' : 'Slot ' + (editTarget + 1);
                alert((d.name || '?') + ' を ' + label + ' にインポートしました！');
            } catch(err) { alert('JSONの読み込みに失敗しました。'); }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // Add Lorebook entry
    document.getElementById('add-lore-btn').addEventListener('click', function() {
        const data = getEditTargetData();
        if (!data) return;
        if (!data.lorebook) data.lorebook = [];
        data.lorebook.push({ key: '', content: '' });
        renderLorebookEditor();
    });

    // Clear this slot (NPC only)
    document.getElementById('clear-slot-btn').addEventListener('click', function() {
        if (editTarget === 'player') {
            alert('Player はクリアできません。');
            return;
        }
        const idx = editTarget;
        if (!confirm('Slot ' + (idx + 1) + ' のデータをクリアしますか？')) return;
        characterDataArray[idx] = {
            name: 'Slot ' + (idx + 1) + ' Empty', tags: ["Draft"], personality: "Unknown",
            description: "", scenario: "", first_mes: "", mes_example: "", sdPrompt: "", avatar: "", lorebook: []
        };
        safeSetItem('savedParty', JSON.stringify(characterDataArray));
        loadEditTargetIntoEditor();
        renderPartySheet();
        renderPartySetGrid();
        updateEditTabNames();
    });

    // Common Lorebook (World Lore view)
    const addCommonLoreBtn = document.getElementById('add-common-lore-btn');
    if (addCommonLoreBtn) {
        addCommonLoreBtn.addEventListener('click', function() {
            commonLorebook.push({ key: '', content: '' });
            renderCommonLorebookEditor();
        });
    }
    const saveCommonLoreBtn = document.getElementById('save-common-lore-btn');
    if (saveCommonLoreBtn) {
        saveCommonLoreBtn.addEventListener('click', function() {
            commonLorebook = getCommonLorebookFromEditor();
            localStorage.setItem('savedCommonLore', JSON.stringify(commonLorebook));
            showToast('📖 Global Lorebook を保存しました');
        });
    }

    // TTS Engine change event
    const engineSelect = document.getElementById('edit-char-voice-engine');
    if (engineSelect) {
        engineSelect.addEventListener('change', function(e) {
            const engine = e.target.value;
            const data = getEditTargetData();
            const currentSpeakerVal = data && data.voice ? (engine === 'voicevox' ? data.voice.speakerId : data.voice.voiceURI) : '';
            updateSpeakerSelect(engine, currentSpeakerVal);
        });
    }

    // Initial load
    loadEditTargetIntoEditor();
}

function loadEditTargetIntoEditor() {
    const data = getEditTargetData();
    const empty = { name: '', personality: '', description: '', scenario: '', first_mes: '', mes_example: '', sdPrompt: '', lorebook: [], avatar: '' };
    const char = data || empty;

    document.getElementById('edit-char-name').value        = char.name        || '';
    document.getElementById('edit-char-personality').value = char.personality || '';
    document.getElementById('edit-char-desc').value        = char.description || '';
    document.getElementById('edit-char-scenario').value    = char.scenario    || '';
    document.getElementById('edit-char-firstmes').value    = char.first_mes   || '';
    document.getElementById('edit-char-examples').value    = char.mes_example || '';
    document.getElementById('edit-char-sd-prompt').value   = char.sdPrompt    || '';

    // Voice settings load
    const voice = char.voice || { engine: 'none', voiceURI: '', speakerId: 0, pitch: 1.0, speed: 1.0 };
    if (document.getElementById('edit-char-voice-engine')) {
        document.getElementById('edit-char-voice-engine').value = voice.engine || 'none';
        const currentSpeakerVal = voice.engine === 'voicevox' ? voice.speakerId : voice.voiceURI;
        updateSpeakerSelect(voice.engine, currentSpeakerVal);
        document.getElementById('edit-char-voice-pitch').value = voice.pitch !== undefined ? voice.pitch : 1.0;
        document.getElementById('edit-char-voice-speed').value = voice.speed !== undefined ? voice.speed : 1.0;
    }

    // Avatar preview
    const previewDiv = document.getElementById('slot-avatar-preview');
    if (previewDiv) {
        if (char.avatar) {
            previewDiv.innerHTML = '<img src="' + char.avatar + '" alt="' + escapeHTML(char.name || '') + '" class="slot-preview-img">';
        } else {
            previewDiv.innerHTML = '<div class="slot-preview-empty">アイコン未設定</div>';
        }
    }

    // Clear button visibility (hide for Player)
    const clearBtn = document.getElementById('clear-slot-btn');
    if (clearBtn) clearBtn.style.display = (editTarget === 'player') ? 'none' : '';

    renderLorebookEditor();
    renderCommonLorebookEditor();
}

function updateEditTabNames() {
    document.querySelectorAll('#edit-tabs .slot-tab').forEach(tab => {
        const target = tab.getAttribute('data-edit-target');
        if (target === 'player') {
            const name = userConfig.name || 'Player';
            tab.textContent = name.substring(0, 12);
        } else {
            const idx = parseInt(target);
            const char = characterDataArray[idx];
            if (char && char.name && !char.name.includes('Empty')) {
                tab.textContent = char.name.substring(0, 12);
            } else {
                tab.textContent = 'Slot ' + (idx + 1);
            }
        }
    });
}

function renderLorebookEditor() {
    const container = document.getElementById('lorebook-entries');
    if (!container) return;
    container.innerHTML = '';

    const data = getEditTargetData();
    if (!data) return;

    const lore = data.lorebook || [];
    lore.forEach((entry, index) => {
        const div = document.createElement('div');
        div.className = 'lore-entry';
        div.innerHTML = `
            <div class="lore-entry-header">
                <input type="text" placeholder="Keyword (e.g. 剣, 魔法, 場所名)" class="lore-key" value="${escapeHTML(entry.key || '')}">
                <button class="remove-lore-btn" onclick="removeLoreEntry(${index})">Remove</button>
            </div>
            <textarea placeholder="AIに教えたい情報" class="lore-content">${escapeHTML(entry.content || '')}</textarea>
        `;
        container.appendChild(div);
    });
}

window.removeLoreEntry = function(index) {
    const data = getEditTargetData();
    if (data && data.lorebook) {
        data.lorebook.splice(index, 1);
        renderLorebookEditor();
    }
};

function renderCommonLorebookEditor() {
    const container = document.getElementById('common-lorebook-entries');
    if (!container) return;
    container.innerHTML = '';
    
    commonLorebook.forEach((entry, index) => {
        const div = document.createElement('div');
        div.className = 'lore-entry';
        div.innerHTML = `
            <div class="lore-entry-header">
                <input type="text" placeholder="Keyword (全キャラ共通取得)" class="lore-key" value="${escapeHTML(entry.key || '')}">
                <button class="remove-lore-btn" onclick="removeCommonLoreEntry(${index})">Remove</button>
            </div>
            <textarea placeholder="世界観や共有ルールなど" class="lore-content">${escapeHTML(entry.content || '')}</textarea>
        `;
        container.appendChild(div);
    });
}

// Global scope helper for the onclick above
window.removeCommonLoreEntry = function(index) {
    commonLorebook.splice(index, 1);
    renderCommonLorebookEditor();
};

function getLorebookFromEditor() {
    const list = [];
    const entries = document.querySelectorAll('#lorebook-entries .lore-entry');
    entries.forEach(el => {
        const key = el.querySelector('.lore-key').value.trim();
        const content = el.querySelector('.lore-content').value.trim();
        if (key && content) {
            list.push({ key, content });
        }
    });
    return list;
}    

function getCommonLorebookFromEditor() {
    const list = [];
    const entries = document.querySelectorAll('#common-lorebook-entries .lore-entry');
    entries.forEach(el => {
        const key = el.querySelector('.lore-key').value.trim();
        const content = el.querySelector('.lore-content').value.trim();
        if (key && content) {
            list.push({ key, content });
        }
    });
    return list;
}    

// ---- Character View Rendering (Party) ----
function renderPartySheet() {
    var container = document.getElementById('party-sheet-grid');
    if (!container) return;
    
    const members = getActivePartyMembers();
    if (members.length === 0) {
        container.innerHTML = '<div class="loading">キャラクターが登録されていません。Party Setup からキャラクターをインポートしてください。</div>';
        return;
    }
    
    var html = '';
    members.forEach(function(char, memberIdx) {
        // characterDataArray内の実スロット番号を特定
        var slotIdx = -1;
        for (var i = 0; i < characterDataArray.length; i++) {
            if (characterDataArray[i] && characterDataArray[i].name === char.name) {
                slotIdx = i;
                break;
            }
        }
        if (slotIdx < 0) slotIdx = memberIdx;
        html += renderSingleCharacterCard(char, memberIdx, slotIdx);
    });

    // User可視性トグル行（SD有効時のみ表示）
    if (sdConfig.enabled) {
        var userVis = isSdCharVisible('user');
        html += '<div class="sd-user-visibility-row">'
             +  '<span class="sd-user-label">' + escapeHTML(userConfig.name || 'User') + '（あなた）</span>'
             +  '<button class="sd-visible-toggle" data-slot-key="user" title="画像生成に含める/除外する">'
             +  (userVis ? '📷' : '🚫') + '</button>'
             +  '</div>';
    }

    container.innerHTML = html;
}

function renderSingleCharacterCard(char, charIdx, slotIdx) {
    if (!char) return '';

    var tagsHtml = '';
    if (char.tags && Array.isArray(char.tags)) {
        tagsHtml = char.tags.map(function(tag) {
            return '<span class="badge">' + escapeHTML(tag) + '</span>';
        }).join('');
    }
    
    var personalityHtml = '';
    if (char.personality) {
        personalityHtml = char.personality.split(',').map(function(p) {
            return '<span class="p-tag">' + escapeHTML(p.trim()) + '</span>';
        }).join('');
    }
    
    var mesExampleHtml = '';
    if (char.mes_example) {
        mesExampleHtml = char.mes_example.split('<START>').filter(function(m) {
            return m.trim();
        }).map(function(m) {
            return '<div class="message-item">' + applyMacros(escapeHTML(m.trim()), char.name).replace(/\n/g, '<br>') + '</div>';
        }).join('');
    }
    
    var portraitSrc = char.avatar || UNKNOWN_CHAR_SVG;
    if (typeof slotIdx !== 'number' || slotIdx < 0) slotIdx = charIdx;
    var slotKey = 'slot' + slotIdx;
    var isVisible = isSdCharVisible(slotKey);

    var html = '';
    html += '<div class="character-sheet">';
    html += '  <div class="character-header">';
    html += '    <img src="' + portraitSrc + '" alt="' + escapeHTML(char.name || '') + '" class="character-portrait">';
    html += '    <div class="character-info">';
    html += '      <h1>' + applyMacros(escapeHTML(char.name || 'No Name'), char.name) + '</h1>';
    html += '      <button class="focus-imggen-btn" data-char-idx="' + charIdx + '" '
         +  'title="' + escapeHTML(char.name || '') + 'のフォーカス画像を生成" '
         +  (sdConfig.enabled ? '' : 'style="display:none;"') + '>🎨</button>';
    html += '      <button class="sd-visible-toggle" data-slot-key="' + slotKey + '" '
         +  'title="画像生成に含める/除外する" '
         +  (sdConfig.enabled ? '' : 'style="display:none;"') + '>'
         +  (isVisible ? '📷' : '🚫') + '</button>';
    html += '      <div class="character-badges">' + tagsHtml + '</div>';
    html += '    </div>';
    html += '  </div>';
    if (personalityHtml) {
        html += '  <div class="section">';
        html += '    <div class="section-title">Personality</div>';
        html += '    <div class="personality-tags">' + personalityHtml + '</div>';
        html += '  </div>';
    }
    if (char.description) {
        html += '  <div class="section">';
        html += '    <div class="section-title">Description</div>';
        html += '    <div class="section-content">' + applyMacros(escapeHTML(char.description), char.name) + '</div>';
        html += '  </div>';
    }
    if (char.scenario) {
        html += '  <div class="section">';
        html += '    <div class="section-title">Scenario</div>';
        html += '    <div class="section-content">' + applyMacros(escapeHTML(char.scenario), char.name) + '</div>';
        html += '  </div>';
    }
    if (char.first_mes) {
        html += '  <div class="section">';
        html += '    <div class="section-title">First Message</div>';
        html += '    <div class="message-item">' + applyMacros(escapeHTML(char.first_mes), char.name) + '</div>';
        html += '  </div>';
    }
    if (mesExampleHtml) {
        html += '  <div class="section">';
        html += '    <div class="section-title">Message Examples</div>';
        html += '    <div class="message-list">' + mesExampleHtml + '</div>';
        html += '  </div>';
    }
    // Show Lore count
    if (char.lorebook && char.lorebook.length > 0) {
        html += '  <div class="section">';
        html += '    <div class="section-title">📖 Lorebook</div>';
        html += '    <div class="section-content">' + char.lorebook.length + ' 件の世界観設定が登録されています。</div>';
        html += '  </div>';
    }
    html += '</div>';
    return html;
}

// ---- Chat Terminal Logic ----
function getPartyId() {
    // 純チャットモードは専用バケット: RPセッションの履歴・要約と完全分離する
    if (pureChatMode) return 'pure_chat__';
    return Array.from(characterDataArray).map(c => c ? (c.name || 'empty') : 'empty').join('-');
}

/**
 * 旧方式（画像を独立した履歴エントリとして持つ）の残骸を掃除する。
 *
 * 現在は {img:タグ} を本文に残し、そこから画像を解決する方式に統一している。
 * 方式変更前に作られた独立エントリが残っていると、本文タグ由来の画像と
 * 二重に表示されるため、本文に同じタグがあるものだけを削除する。
 * （本文にタグが無い独立エントリ＝クエストイベント画像などは、
 *   重複していないのでそのまま残す）
 * @returns {number} 削除した件数
 */
function migrateLegacyImageEntries() {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return 0;
    let removed = 0;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        const e = chatHistory[i];
        if (!e || !e.isImage || !e.imageTag) continue;

        // 直前の非画像メッセージを探す
        let p = i - 1;
        while (p >= 0 && chatHistory[p] && chatHistory[p].isImage) p--;
        if (p < 0) continue;

        const prevContent = (chatHistory[p] && chatHistory[p].content) || '';
        // 本文に同じタグがある＝新方式で既に表示されるので、この独立エントリは重複
        if (prevContent.includes('{img:' + e.imageTag + '}')) {
            chatHistory.splice(i, 1);
            removed++;
        }
    }
    if (removed > 0) {
        saveChatHistory();
        console.log('[ImageLib] 旧形式の重複画像エントリを ' + removed + ' 件削除しました');
    }
    return removed;
}

/**
 * 現在の partyId バケットから chatHistory をロードして画面を再構築する。
 * init() 起動時と、純チャットモード切替（バケット切替）時に使用。
 */
function restoreChatFromStorage() {
    const savedChat = localStorage.getItem('chatHistory_' + getPartyId());
    if (savedChat) {
        chatHistory = JSON.parse(savedChat);

        // 旧方式の独立画像エントリ（本文タグと重複するもの）を掃除してから描画する
        migrateLegacyImageEntries();

        // status_values を履歴中の最新 statusSnapshot に同期（リロード後も値を維持）
        if (activeQuest && _hasAnyStatusParams(activeQuest)) {
            if (!activeQuest.state) activeQuest.state = {};
            for (let i = chatHistory.length - 1; i >= 0; i--) {
                if (chatHistory[i].statusSnapshot) {
                    activeQuest.state.status_values = JSON.parse(JSON.stringify(chatHistory[i].statusSnapshot));
                    break;
                }
            }
        }

        // Info Panel: 履歴中の最新 infoSnapshot を復元（リロード後も状況サマリを維持）
        for (let i = chatHistory.length - 1; i >= 0; i--) {
            if (chatHistory[i].infoSnapshot) {
                lastInfoSnapshot = chatHistory[i].infoSnapshot;
                break;
            }
        }
        if (lastInfoSnapshot && infoPanelEnabled) {
            renderInfoPanel(lastInfoSnapshot);
        }

        // Restore visual messages — splitAndAppendCharMessages を使い SPEAKER タグを正しく解析
        bumpChatRenderToken();
        document.getElementById('chat-history').innerHTML = '';
        chatHistory.forEach((msg, idx) => {
            if (msg.isImage && msg.imageTag) {
                // 事前登録画像: タグから再解決するのでリロード後も復元できる（非同期）
                appendLibraryImage(msg.imageTag, idx, { quiet: true });
            } else if (msg.isImage && msg.imageData) {
                // Restore generated image (full data available)
                const imgMsgDiv = appendImageMessage(msg.imageData, msg.content.replace('[Generated Image]\nPrompt: ', ''));
                imgMsgDiv.setAttribute('data-index', idx);
            } else if (msg.isImage && !msg.imageData) {
                // Image data stripped from localStorage — show regeneration placeholder
                const promptText = msg.content.replace('[Generated Image]\nPrompt: ', '');
                renderImagePlaceholder(idx, promptText);
            } else if (msg.role === 'narrator') {
                appendNarrationMessage(msg.content, idx);
            } else if (msg.role === 'user') {
                appendMessage('user', msg.content, userConfig.name, false, idx);
            } else {
                // assistant メッセージは SPEAKER タグ解析付きで復元
                // NOTE: allowUserSpeaker=true は banter_player モード専用。履歴復元時に
                // 内容文字列だけで自動判定するとフィルタを貫通してしまい、Editによる再描画等で
                // AI生成のプレイヤー発言が復活する不具合が発生するため、常に false で復元する。
                splitAndAppendCharMessages(msg.content, false, idx, false);
            }
        });
        updateRegenButtonVisibility();
        // ステータスHUDを同期
        if (typeof updateStatusHUD === 'function') updateStatusHUD();
    } else if (pureChatMode) {
        // 純チャットの新規バケット: RP用イントロ（first_mes 等）は流さない
        chatHistory = [];
        bumpChatRenderToken();
        const hist = document.getElementById('chat-history');
        if (hist) hist.innerHTML = '';
        updateRegenButtonVisibility();
    } else {
        initializeChat(characterDataArray);
    }
}

function getActivePartyMembers() {
    return characterDataArray.filter(c => c && c.name && !c.name.includes("Empty"));
}

// プレイヤー曖昧マッチ: AIが [SPEAKER: ユート] / [SPEAKER: ユート先生] 等の変則で出した場合も拾う。
// NPC マッチ後に呼ぶこと（NPC優先のため）。"user"/"player" 等のデフォルト名はマッチさせない。
function isFuzzyPlayerSpeaker(speakerTag) {
    if (!speakerTag) return false;
    const tag = speakerTag.trim().toLowerCase();
    const playerName = (userConfig.name || '').trim().toLowerCase();
    if (!playerName) return false;
    // デフォルト感のある汎用名はマッチさせない（誤判定回避）
    if (playerName === 'user' || playerName === 'player' || playerName === 'you') return false;
    if (tag === 'ナレーション' || tag === 'narration' || tag === 'narrator') return false;
    // 完全一致 or 双方向部分一致（"ユート" ↔ "ユート先生" を許容）
    if (tag === playerName) return true;
    return tag.includes(playerName) || playerName.includes(tag);
}

// 厳密マッチのみ: NPC キャラ名と直接の部分一致のみ。description / lorebook は見ない。
// プレイヤー名と他キャラ description の衝突誤判定（例: プレイヤー名「ユート」が NPC の
// description 内の「ユート先生」にマッチしてしまう問題）を防ぐため、まずこれで判定する。
function findMemberBySpeakerStrict(speakerTag, members) {
    if (!speakerTag || !members || members.length === 0) return null;
    const tag = speakerTag.trim().toLowerCase();
    return members.find(m =>
        tag.includes(m.name.toLowerCase()) ||
        m.name.toLowerCase().includes(tag)
    ) || null;
}

// Multi-strategy speaker matching: handles katakana name, English alias, partial match
function findMemberBySpeaker(speakerTag, members) {
    if (!speakerTag || !members || members.length === 0) return null;
    const tag = speakerTag.trim().toLowerCase();

    // Strategy 1: Direct name match (substring in either direction)
    let found = findMemberBySpeakerStrict(speakerTag, members);
    if (found) return found;

    // Strategy 2: Check if the speaker tag matches an alias/English name in the description
    // e.g., description contains "(Flandre Scarlet)" and AI outputs [SPEAKER: Flandre]
    found = members.find(m => {
        if (!m.description) return false;
        const desc = m.description.toLowerCase();
        // Check if the AI's speaker name appears in the character's description
        return desc.includes(tag);
    });
    if (found) return found;

    // Strategy 3: Check if any word in the speaker tag matches any word in the character name
    // e.g., "フランドール" matches "フランドール・スカーレット"
    const tagWords = tag.split(/[\s・\-_]+/).filter(w => w.length >= 2);
    found = members.find(m => {
        const nameWords = m.name.toLowerCase().split(/[\s・\-_]+/).filter(w => w.length >= 2);
        return tagWords.some(tw => nameWords.some(nw => nw.includes(tw) || tw.includes(nw)));
    });
    if (found) return found;

    return null;
}

function initializeChat(charArray) {
    if (!charArray) return;
    chatHistory = [];
    resetContextSummary();
    clearChoiceButtons();
    clearInfoPanel();
    bumpChatRenderToken();
    document.getElementById('chat-history').innerHTML = '';
    
    const members = getActivePartyMembers();
    const firstMember = members.length > 0 ? members[0] : null;

    if (firstMember && firstMember.first_mes) {
        appendMessage('char', applyMacros(firstMember.first_mes, firstMember.name), firstMember.name, true);
        saveChatHistory();
    }
}

function saveChatHistory() {
    // Strip base64 imageData before saving — too large for localStorage (5MB limit)
    // The prompt text is preserved so images can be regenerated on demand
    const historyToSave = chatHistory.map(entry => {
        if (entry.isImage && entry.imageData) {
            return {
                role: entry.role,
                content: entry.content,
                isImage: true
                // imageData intentionally omitted
            };
        }
        // alternatives / activeIndex を保存に含める（スワイプ機能用）
        const saved = { role: entry.role, content: entry.content };
        if (entry.isImage) saved.isImage = true;
        // 事前登録画像はタグ参照なので軽量。保存してリロード後の復元に使う
        if (entry.imageTag) saved.imageTag = entry.imageTag;
        if (entry.alternatives && entry.alternatives.length > 1) {
            saved.alternatives = entry.alternatives;
            saved.activeIndex = entry.activeIndex;
        }
        if (entry.statusSnapshot) saved.statusSnapshot = entry.statusSnapshot;
        return saved;
    });
    safeSetItem('chatHistory_' + getPartyId(), JSON.stringify(historyToSave));
}

function appendMessage(role, text, name, shouldSave = true, forcedIndex = -1, statusForSpeaker = null) {
    if (!name && role === 'user') {
        name = userConfig.name;
    } else if (!name) {
        name = 'System';
    }
    
    let msgIndex = forcedIndex;
    if (shouldSave) {
        // ユーザー新規発言時は既存の選択肢ボタンを除去（古い選択肢が残らないように）
        if (role === 'user') {
            clearChoiceButtons();
        }
        const apiRole = role === 'char' ? 'assistant' : 'user';
        chatHistory.push({ role: apiRole, content: text });
        saveChatHistory();
        msgIndex = chatHistory.length - 1;
    } else if (forcedIndex === -1) {
        // If not saving and no forced index, we might just be showing a temporary message or 
        // we're in a middle of a process. For history rendering, forcedIndex should be provided.
        msgIndex = chatHistory.length - 1; 
    }
    var chatContainer = document.getElementById('chat-history');
    var msgDiv = document.createElement('div');
    // ナレーションの場合は専用CSSクラスを追加
    const isNarrator = (role === 'char' && (name === 'ナレーション' || name === 'Narrator'));
    msgDiv.className = 'chat-msg ' + role + (isNarrator ? ' narrator' : '');
    msgDiv.setAttribute('data-index', msgIndex);
    
    var userSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23aaa' d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>";
    // ナレーション用アイコン（本のアイコン）
    var narratorSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23c0a0ff' d='M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z'/></svg>";
    // 汎用プレースホルダー（不明キャラ用、シルエット）
    var unknownCharSvg = UNKNOWN_CHAR_SVG;

    let portraitSrc = role === 'char' ? unknownCharSvg : (userConfig.avatar ? userConfig.avatar : userSvg);
    if (role === 'char') {
         // 「ナレーション」は専用アイコン
         if (name === 'ナレーション' || name === 'Narrator' || name === 'System') {
             portraitSrc = narratorSvg;
         } else {
             const members = getActivePartyMembers();
             const speaker = findMemberBySpeaker(name, members);
             if (speaker && speaker.avatar) {
                 portraitSrc = speaker.avatar;
             }
             // unknownCharSvg のまま（フランドールのplaceholder.pngを使わない）
         }
    }
    
    var avatarImg = document.createElement('img');
    avatarImg.src = portraitSrc;
    avatarImg.alt = name;
    avatarImg.className = 'msg-avatar';
    
    var contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    
    // Message Controls (Regen/Edit/Delete)
    if (role !== 'system') {
        const controls = document.createElement('div');
        controls.className = 'msg-controls';

        // リジェネボタン（charのみ、初期非表示 — updateRegenButtonVisibility で最後のassistantのみ表示）
        if (role === 'char') {
            const regenBtn = document.createElement('button');
            regenBtn.className = 'msg-control-btn regen-btn';
            regenBtn.title = 'Regenerate（そのまま再生成）';
            regenBtn.textContent = '🔄';
            regenBtn.style.display = 'none';
            regenBtn.addEventListener('click', () => regenerateLastResponse());
            controls.appendChild(regenBtn);

            // 指示付き再生成ボタン（💡 — モーダルでAIへの指示を入力）
            const guidedRegenBtn = document.createElement('button');
            guidedRegenBtn.className = 'msg-control-btn guided-regen-btn';
            guidedRegenBtn.title = '指示付き再生成（AIへ書き直し方を指示）';
            guidedRegenBtn.textContent = '💡';
            guidedRegenBtn.style.display = 'none';
            guidedRegenBtn.addEventListener('click', () => openGuidedRegenModal());
            controls.appendChild(guidedRegenBtn);
        }

        const speakBtn = document.createElement('button');
        speakBtn.className = 'msg-control-btn speak-btn';
        speakBtn.title = 'Speak';
        speakBtn.textContent = '🔊';
        speakBtn.addEventListener('click', () => {
            let voiceConfig = null;
            let isNarration = false;
            if (role === 'char') {
                // 統合ヘルパで解決（NPC voice → narratorVoice フォールバック）
                const members = getActivePartyMembers();
                const speaker = findMemberBySpeaker(name, members);
                const resolved = resolveTtsVoice(name, speaker);
                if (resolved) {
                    voiceConfig = resolved.voice;
                    isNarration = resolved.isNarration;
                }
            } else if (role === 'user') {
                voiceConfig = (userConfig.voice && userConfig.voice.engine && userConfig.voice.engine !== 'none')
                    ? userConfig.voice
                    : ((narratorVoice && narratorVoice.engine !== 'none') ? narratorVoice : null);
            }
            if (voiceConfig) {
                speakText(text, voiceConfig, isNarration);
            } else {
                alert('音声設定がされていません。Settings → 🎙️ ナレーター音声 で設定してください。');
            }
        });
        controls.appendChild(speakBtn);

        const editBtn = document.createElement('button');
        editBtn.className = 'msg-control-btn edit-btn';
        editBtn.title = 'Edit';
        editBtn.textContent = '🖊';
        controls.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'msg-control-btn delete-btn';
        deleteBtn.title = 'Delete';
        deleteBtn.textContent = '🗑';
        controls.appendChild(deleteBtn);

        msgDiv.appendChild(controls);

        editBtn.addEventListener('click', () => editMessage(msgDiv, msgIndex));
        const speakerName = (role === 'char') ? name : null;
        deleteBtn.addEventListener('click', () => deleteMessage(msgIndex, speakerName));
    }

    // Add speaker name header for char messages
    if (role === 'char' && name && name !== 'System') {
        var nameTag = document.createElement('div');
        nameTag.className = 'msg-speaker-name';
        // ステータスパラメーターがあればキャラ名の隣にインライン表示
        if (statusForSpeaker && typeof statusForSpeaker === 'object') {
            const nameSpan = document.createElement('span');
            nameSpan.className = 'msg-speaker-name-text';
            nameSpan.textContent = name;
            nameTag.appendChild(nameSpan);
            // 固定/変動の判定用: クエスト定義から param の type を参照
            const _charEntry = (activeQuest && activeQuest.template)
                ? (activeQuest.template.char_status_params || []).find(e => e.character === name)
                : null;
            const _paramTypeOf = (pname) => {
                if (!_charEntry || !_charEntry.params) return 'variable';
                const def = _charEntry.params.find(p => p.name === pname);
                return (def && def.type === 'fixed') ? 'fixed' : 'variable';
            };
            Object.entries(statusForSpeaker).forEach(([k, v]) => {
                const paramSpan = document.createElement('span');
                paramSpan.className = 'msg-speaker-status';
                const isFixed = _paramTypeOf(k) === 'fixed';
                paramSpan.textContent = isFixed ? `(${k}：${v})` : `(${k}：${v}%)`;
                nameTag.appendChild(paramSpan);
            });
        } else {
            nameTag.textContent = name;
        }
        contentDiv.appendChild(nameTag);
    }
    
    var textNode = document.createElement('div');
    textNode.className = 'msg-text';
    if (imageLibraryEnabled && /\{img:/i.test(text)) {
        // {img:タグ} の位置で本文を分割し、その場所に画像を挟み込む
        buildTextWithInlineImages(textNode, text);
    } else {
        textNode.innerHTML = escapeHTML(text);
    }
    contentDiv.appendChild(textNode);

    // スワイプUI（alternatives が 2件以上ある assistant メッセージに表示）
    if (role === 'char' && msgIndex >= 0 && msgIndex < chatHistory.length) {
        const entry = chatHistory[msgIndex];
        if (entry && entry.alternatives && entry.alternatives.length > 1) {
            const swipeNav = document.createElement('div');
            swipeNav.className = 'swipe-nav';
            const prevBtn = document.createElement('button');
            prevBtn.className = 'swipe-btn';
            prevBtn.textContent = '←';
            prevBtn.addEventListener('click', () => swipeResponse(msgIndex, -1));
            const counter = document.createElement('span');
            counter.className = 'swipe-counter';
            counter.textContent = ((entry.activeIndex || 0) + 1) + '/' + entry.alternatives.length;
            const nextBtn = document.createElement('button');
            nextBtn.className = 'swipe-btn';
            nextBtn.textContent = '→';
            nextBtn.addEventListener('click', () => swipeResponse(msgIndex, 1));
            swipeNav.appendChild(prevBtn);
            swipeNav.appendChild(counter);
            swipeNav.appendChild(nextBtn);
            contentDiv.appendChild(swipeNav);
        }
    }

    msgDiv.appendChild(avatarImg);
    msgDiv.appendChild(contentDiv);

    chatContainer.appendChild(msgDiv);
    scrollToBottom();
}

function editMessage(msgDiv, index) {
    if (index < 0) return;
    const textNode = msgDiv.querySelector('.msg-text');
    const originalText = chatHistory[index].content;
    
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-msg-textarea';
    textarea.value = originalText;
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary-btn small-btn';
    saveBtn.textContent = 'Save';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary-btn small-btn';
    cancelBtn.textContent = 'Cancel';
    
    const originalContent = textNode.innerHTML;
    textNode.innerHTML = '';
    textNode.appendChild(textarea);
    textNode.appendChild(saveBtn);
    textNode.appendChild(cancelBtn);
    
    saveBtn.onclick = () => {
        const newText = textarea.value;
        // {img:タグ} は本文にそのまま保存する。
        // 画像は再描画時に splitAndAppendCharMessages がタグから解決するため、
        // ここで除去や画像エントリの挿入は行わない（編集画面でタグ位置が見えるようにするため）。
        const imgTags = parseImageTags(newText).tags;
        if (imgTags.length > 0 && !imageLibraryEnabled) {
            showToast('🖼️ 画像タグを検出しましたが機能が OFF です — Settings → 画像ライブラリ を有効にしてください', 'error');
        }

        chatHistory[index].content = newText;
        // 本文にタグを書いた結果、旧方式の独立エントリと重複する場合はそちらを消す
        migrateLegacyImageEntries();
        saveChatHistory();
        // Full re-render is safest for visual consistency
        renderChatFromHistory();

        // 権限が無いと画像解決は静かに失敗するため、復帰ボタンを出す
        if (imgTags.length > 0 && imageLibraryEnabled && _imgDirHandle && !_imgDirGranted) {
            showImagePermissionBanner();
        }
    };
    
    cancelBtn.onclick = () => {
        textNode.innerHTML = originalContent;
    };
}

function deleteMessage(index, charName = null) {
    if (index < 0) return;
    const entry = chatHistory[index];
    if (!entry) return;

    // charNameが指定されており、assistantメッセージにSPEAKERタグが含まれる場合は
    // そのキャラのセグメントだけ削除し、残りのセグメントは保持する
    if (charName && entry.role === 'assistant') {
        const tagRegex = /\[SPEAKER:\s*([^\]]+)\]/gi;
        if (tagRegex.test(entry.content)) {
            // セグメント単位で分解し、該当キャラのセグメントを除外する
            tagRegex.lastIndex = 0;
            const segments = [];
            let match;
            let lastIdx = 0;
            while ((match = tagRegex.exec(entry.content)) !== null) {
                if (segments.length > 0) {
                    segments[segments.length - 1].content = entry.content.substring(lastIdx, match.index).trim();
                }
                segments.push({ speaker: match[1].trim(), content: '' });
                lastIdx = tagRegex.lastIndex;
            }
            if (segments.length > 0) {
                segments[segments.length - 1].content = entry.content.substring(lastIdx).trim();
            }

            // 削除対象キャラのセグメントを除いた残りを再結合
            const remaining = segments.filter(seg => {
                const m = findMemberBySpeaker(seg.speaker, getActivePartyMembers());
                const resolvedName = m ? m.name : seg.speaker;
                return resolvedName !== charName;
            });

            if (remaining.length === 0) {
                // 全セグメントが消えるなら確認してエントリごと削除
                if (!confirm(`${charName} の発言を削除すると、このターンの発言がすべて消えます。削除しますか？`)) return;
                chatHistory.splice(index, 1);
            } else {
                if (!confirm(`${charName} の発言を削除しますか？`)) return;
                // 残りのセグメントで内容を更新
                entry.content = remaining.map(seg => `[SPEAKER: ${seg.speaker}]\n${seg.content}`).join('\n');
            }
            saveChatHistory();
            renderChatFromHistory();
            return;
        }
    }

    // その他（userメッセージ / SPEAKERタグなしのassistantメッセージ）はターンごと削除
    const confirmMsg = (entry.role === 'assistant' && charName)
        ? `${charName} のターンをまとめて削除しますか？`
        : 'このメッセージを削除しますか？';
    if (confirm(confirmMsg)) {
        chatHistory.splice(index, 1);
        saveChatHistory();
        renderChatFromHistory();
    }
}

function renderChatFromHistory() {
    const container = document.getElementById('chat-history');
    bumpChatRenderToken(); // 進行中の非同期画像挿入を無効化（重複防止）
    container.innerHTML = '';

    // 再描画時: status_values を履歴中の最新 statusSnapshot に同期
    // （リロード後に値が初期値に戻らないようにする）
    if (activeQuest && _hasAnyStatusParams(activeQuest)) {
        for (let i = chatHistory.length - 1; i >= 0; i--) {
            if (chatHistory[i].statusSnapshot) {
                activeQuest.state.status_values = JSON.parse(JSON.stringify(chatHistory[i].statusSnapshot));
                break;
            }
        }
    }

    chatHistory.forEach((msg, idx) => {
        if (msg.isImage && msg.imageTag) {
            // 事前登録画像: タグから再解決（非同期）
            appendLibraryImage(msg.imageTag, idx, { quiet: true });
        } else if (msg.isImage && msg.imageData) {
            const imgDiv = appendImageMessage(msg.imageData, msg.content.replace('[Generated Image]\nPrompt: ', ''));
            imgDiv.setAttribute('data-index', idx);
        } else if (msg.isImage) {
            renderImagePlaceholder(idx, msg.content.replace('[Generated Image]\nPrompt: ', ''));
        } else if (msg.role === 'narrator') {
            // idx を渡さないと msgIndex=-1 になり、編集/削除ボタンが
            // editMessage/deleteMessage 冒頭の index<0 ガードで無効化される
            appendNarrationMessage(msg.content, idx);
        } else if (msg.role === 'assistant') {
            // NOTE: 履歴復元時は常に allowUserSpeaker=false。
            // 内容文字列からの自動判定はフィルタを貫通させる不具合に繋がるため行わない。
            splitAndAppendCharMessages(msg.content, false, idx, false);
        } else {
            appendMessage('user', msg.content, userConfig.name, false, idx);
        }
    });

    updateRegenButtonVisibility();
    // 履歴再構築後に HUD を同期
    if (typeof updateStatusHUD === 'function') updateStatusHUD();
}

function renderImagePlaceholder(idx, promptText) {
    const chatContainer = document.getElementById('chat-history');
    const placeholderDiv = document.createElement('div');
    placeholderDiv.className = 'chat-msg image-msg';
    placeholderDiv.setAttribute('data-index', idx);
    placeholderDiv.innerHTML = `
        <div class="image-msg-container">
            <div class="image-placeholder">
                <span>🖼️ 画像（リロードにより消去）</span>
                <button class="regen-image-btn" title="再生成">🔄</button>
            </div>
            <div class="image-prompt-text">${(promptText).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        </div>`;
    placeholderDiv.querySelector('.regen-image-btn').addEventListener('click', async function() {
        this.disabled = true;
        try {
            const base64 = await generateImage(promptText);
            const newDiv = appendImageMessage(base64, promptText);
            newDiv.setAttribute('data-index', idx);
            if (chatHistory[idx]) chatHistory[idx].imageData = base64;
            placeholderDiv.remove();
        } catch(e) {
            alert('再生成エラー: ' + e.message);
            this.disabled = false;
        }
    });
    chatContainer.appendChild(placeholderDiv);
}

function updateRegenButtonVisibility() {
    // 全リジェネ系ボタンを非表示
    document.querySelectorAll('.regen-btn, .guided-regen-btn').forEach(btn => btn.style.display = 'none');
    // 最後のassistant（非image）indexを取得
    let lastIdx = -1;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'assistant' && !chatHistory[i].isImage) {
            lastIdx = i;
            break;
        }
    }
    if (lastIdx === -1) return;
    // 該当するDOM要素のリジェネ系ボタンを表示
    document.querySelectorAll(`.chat-msg[data-index="${lastIdx}"] .regen-btn, .chat-msg[data-index="${lastIdx}"] .guided-regen-btn`).forEach(btn => {
        btn.style.display = '';
    });
}

// 指示付き再生成のためのガイダンス文字列。fetchChatCompletion 呼び出し中のみセットされる。
let _pendingRegenGuidance = '';

async function regenerateLastResponse(guidance = '') {
    if (isRegenerating) return;

    // 最後のassistant（非image）エントリを探す
    let targetIndex = -1;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'assistant' && !chatHistory[i].isImage) {
            targetIndex = i;
            break;
        }
    }
    if (targetIndex === -1) return;

    isRegenerating = true;
    const entry = chatHistory[targetIndex];

    // alternatives初期化（初回リジェネ時）
    if (!entry.alternatives) {
        entry.alternatives = [entry.content];
        entry.activeIndex = 0;
    }

    // UI無効化
    const inputArea = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const banterBtn = document.getElementById('banter-btn');
    inputArea.disabled = true;
    sendBtn.disabled = true;
    banterBtn.disabled = true;

    const loadingId = 'regen-loading-' + Date.now();
    appendLoadingMsg(loadingId, guidance ? '指示付きで再生成中...' : '再生成中...');

    try {
        // 一時的に最後のassistantエントリを除去してAPI呼び出し
        const removed = chatHistory.splice(targetIndex, 1)[0];
        // ガイダンスを fetchChatCompletion へ伝達（モジュールスコープ変数で受け渡し）
        _pendingRegenGuidance = guidance || '';
        let reply;
        try {
            reply = await fetchChatCompletion();
        } finally {
            _pendingRegenGuidance = '';
        }
        // 元に戻す
        chatHistory.splice(targetIndex, 0, removed);

        if (reply) {
            let cleanReply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            cleanReply = cleanReply.replace(/<think>[\s\S]*/gi, '').trim();
            cleanReply = cleanReply.replace(/<\/think>/gi, '').trim();

            // 最大10件に制限（localStorage容量保護）
            if (entry.alternatives.length >= 10) {
                entry.alternatives.shift();
                entry.activeIndex = Math.max(0, entry.activeIndex - 1);
            }

            entry.alternatives.push(cleanReply);
            entry.activeIndex = entry.alternatives.length - 1;
            entry.content = cleanReply;

            saveChatHistory();
            removeLoadingMsg(loadingId);
            renderChatFromHistory();
        } else {
            removeLoadingMsg(loadingId);
        }
    } catch (e) {
        removeLoadingMsg(loadingId);
        alert('再生成エラー: ' + e.message);
    } finally {
        isRegenerating = false;
        inputArea.disabled = false;
        sendBtn.disabled = false;
        banterBtn.disabled = false;
        inputArea.focus();
    }
}

function swipeResponse(historyIndex, direction) {
    const entry = chatHistory[historyIndex];
    if (!entry || !entry.alternatives || entry.alternatives.length <= 1) return;

    let newIdx = (entry.activeIndex || 0) + direction;
    if (newIdx < 0) newIdx = entry.alternatives.length - 1;
    if (newIdx >= entry.alternatives.length) newIdx = 0;

    entry.activeIndex = newIdx;
    entry.content = entry.alternatives[newIdx];

    saveChatHistory();
    renderChatFromHistory();
}

// [STATUS: 好感度=+5, 独占欲=-3] タグを解析し、値を現在値に加算（0-100クランプ）
// 戻り値: { deltas: {paramName: delta}, cleanedContent: string }
function parseStatusTag(content) {
    const regex = /\[STATUS:\s*([^\]]+)\]/gi;
    const deltas = {};
    let cleanedContent = content;
    let match;
    while ((match = regex.exec(content)) !== null) {
        const body = match[1];
        body.split(',').forEach(pair => {
            const m = pair.trim().match(/^(.+?)\s*=\s*([+-]?\d+)$/);
            if (m) {
                const name = m[1].trim();
                const delta = parseInt(m[2]);
                if (!isNaN(delta)) {
                    deltas[name] = (deltas[name] || 0) + delta;
                }
            }
        });
    }
    cleanedContent = content.replace(regex, '').trim();
    return { deltas, cleanedContent };
}

// parseChoicesTag は src/parsers.js へ移動（モジュール分割第一歩）

/**
 * AI 応答末尾の選択肢ボタンを最後のチャット末尾に描画。
 * 既存のボタンがあれば置き換える。
 */
function renderChoiceButtons(choices) {
    const history = document.getElementById('chat-history');
    if (!history) return;
    // 既存ボタンを除去
    const existing = history.querySelector('#choice-buttons');
    if (existing) existing.remove();

    if (!choices || choices.length === 0) return;

    const wrap = document.createElement('div');
    wrap.id = 'choice-buttons';
    wrap.className = 'choice-buttons';
    wrap.innerHTML = '<div class="choice-buttons-label">💭 選択肢（クリックで送信 / Shift+クリックで入力欄に挿入）</div>';

    choices.forEach((c, i) => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.innerHTML = `<span class="choice-num">${i + 1}</span><span class="choice-text">${escapeHTML(c)}</span>`;
        btn.addEventListener('click', (ev) => {
            const input = document.getElementById('chat-input');
            if (!input) return;
            input.value = c;
            input.dispatchEvent(new Event('input')); // 高さ調整トリガー
            if (ev.shiftKey) {
                // Shift+クリック: 挿入のみ（送信前に編集したい場合）
                input.focus();
                return;
            }
            // 通常クリック: 即送信
            clearChoiceButtons();
            const sendBtn = document.getElementById('send-btn');
            if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
            } else {
                input.focus();
            }
        });
        wrap.appendChild(btn);
    });

    history.appendChild(wrap);
    history.scrollTop = history.scrollHeight;
}

/** 選択肢ボタンを除去（次のメッセージ送信時など） */
function clearChoiceButtons() {
    const existing = document.getElementById('choice-buttons');
    if (existing) existing.remove();
}

// ======== Info Panel パース/レンダ/制御 ========
// parseInfoTag は src/parsers.js へ移動（モジュール分割第一歩）

/**
 * Info Panel に infoText を描画。空文字なら placeholder 表示。
 * 【セクション】見出しを軽く強調する以外は pre-wrap でそのまま表示。
 */
function renderInfoPanel(infoText) {
    const panel = document.getElementById('info-panel');
    const body = document.getElementById('info-panel-body');
    if (!panel || !body) return;

    if (!infoText || !infoText.trim()) {
        body.innerHTML = '<span class="info-panel-empty">情報はまだありません。次のAI応答で更新されます。</span>';
        return;
    }

    // ── コンパクト描画 ──
    // AI 出力の改行をそのまま表示すると縦に伸びるため、
    // 【見出し】行だけをブロックにし、それ以外の行は「 ｜ 」で連結してインライン流し込みにする。
    // フォントサイズは据え置き、行数だけを圧縮する。
    const lines = infoText.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
    let html = '';
    let inlineBuf = [];
    const flushInline = () => {
        if (inlineBuf.length) {
            html += '<span class="info-inline">' + inlineBuf.join(' ｜ ') + '</span>';
            inlineBuf = [];
        }
    };
    lines.forEach(line => {
        const headMatch = line.match(/^(【[^】]+】)\s*(.*)$/);
        if (headMatch) {
            flushInline();
            html += '<span class="info-section-header">' + escapeHTML(headMatch[1]) + '</span>';
            if (headMatch[2]) inlineBuf.push(escapeHTML(headMatch[2]));
        } else {
            inlineBuf.push(escapeHTML(line));
        }
    });
    flushInline();
    body.innerHTML = html;
    body.scrollTop = 0;
}

/** Info Panel の表示を空に戻す（チャットクリア時など） */
function clearInfoPanel() {
    lastInfoSnapshot = '';
    renderInfoPanel('');
}

/** infoPanelEnabled に応じてパネル本体の表示/非表示を切り替え */
function updateInfoPanelVisibility() {
    const panel = document.getElementById('info-panel');
    if (!panel) return;
    if (infoPanelEnabled) {
        panel.classList.remove('hidden');
        // 既存スナップショットがあれば再描画
        if (lastInfoSnapshot) renderInfoPanel(lastInfoSnapshot);
    } else {
        panel.classList.add('hidden');
    }
}

// ======== 📜 コンテキスト要約ビューア（右スライドパネル） ========

/** 要約パネルの中身を最新状態に更新する（開いている時のみ描画コスト発生） */
function renderSummaryPanel() {
    const body = document.getElementById('summary-panel-body');
    const meta = document.getElementById('summary-panel-meta');
    if (!body || !meta) return;

    // メタ情報: 要約済み件数 / プリセット名
    const presetLabel = summaryPromptPreset === 'telelynx' ? 'Telelynx式'
                      : summaryPromptPreset === 'custom'   ? 'カスタム'
                      : '標準';
    meta.textContent = '要約済み: ' + lastSummarizedIndex + ' / ' + chatHistory.length + ' 件'
        + '　|　プリセット: ' + presetLabel
        + (contextSummary ? '　|　' + contextSummary.length + ' 字' : '');

    if (!contextSummary || !contextSummary.trim()) {
        body.innerHTML = '<span class="summary-panel-empty">まだ要約はありません。<br>チャットが '
            + CONTEXT_WINDOW_ENTRIES + ' 件（' + (CONTEXT_WINDOW_ENTRIES / 2) + 'ターン）を超えると自動生成されます。</span>';
        return;
    }

    // Markdown 風の見出し（## 〜）と太字（**〜**）を軽く整形して表示
    let html = escapeHTML(contextSummary);
    html = html.replace(/^###\s*(.+)$/gm, '<span class="summary-h3">$1</span>');
    html = html.replace(/^##\s*(.+)$/gm, '<span class="summary-h2">$1</span>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^---+$/gm, '<hr class="summary-hr">');
    body.innerHTML = html;
}

/** 要約パネルの開閉トグル */
function toggleSummaryPanel(forceOpen) {
    const panel = document.getElementById('summary-panel');
    const btn = document.getElementById('summary-panel-toggle');
    if (!panel) return;
    const opening = (forceOpen !== undefined) ? forceOpen : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    panel.setAttribute('aria-hidden', opening ? 'false' : 'true');
    if (btn) btn.classList.toggle('active', opening);
    if (opening) renderSummaryPanel(); // 開くたびに最新化
}

/** 要約パネルが開いていれば再描画（要約更新直後のライブ反映用） */
function refreshSummaryPanelIfOpen() {
    const panel = document.getElementById('summary-panel');
    if (panel && !panel.classList.contains('hidden')) renderSummaryPanel();
}

function setupSummaryPanel() {
    const btn = document.getElementById('summary-panel-toggle');
    const closeBtn = document.getElementById('summary-panel-close');
    if (btn && !btn._bound) {
        btn._bound = true;
        btn.addEventListener('click', () => toggleSummaryPanel());
    }
    if (closeBtn && !closeBtn._bound) {
        closeBtn._bound = true;
        closeBtn.addEventListener('click', () => toggleSummaryPanel(false));
    }
}

// キャラクター毎の status_values を差分更新する（そのキャラの定義済みパラメーターのみ受け付ける）
function applyStatusDelta(speakerName, deltas) {
    if (!activeQuest || !_hasAnyStatusParams(activeQuest)) return;
    const charEntry = _getCharStatusEntry(activeQuest, speakerName);
    if (!charEntry || !charEntry.params || charEntry.params.length === 0) return;

    if (!activeQuest.state.status_values) activeQuest.state.status_values = {};
    if (!activeQuest.state.status_values[speakerName]) activeQuest.state.status_values[speakerName] = {};

    // 未初期化パラメーターは初期値で埋める
    charEntry.params.forEach(p => {
        if (!p.name) return;
        if (typeof activeQuest.state.status_values[speakerName][p.name] !== 'number') {
            const init = (typeof p.initial_value === 'number') ? p.initial_value : 50;
            if (p.type === 'fixed') {
                activeQuest.state.status_values[speakerName][p.name] = init; // 任意整数
            } else if (p.type === 'clock') {
                activeQuest.state.status_values[speakerName][p.name] = ((init % 1440) + 1440) % 1440; // 0-1439 分
            } else {
                activeQuest.state.status_values[speakerName][p.name] = Math.max(-100, Math.min(100, init));
            }
        }
    });

    // 差分適用（そのキャラに定義されたパラメーターのみ・fixed 型は変動不可・clock は 24h ラップ）
    Object.entries(deltas).forEach(([paramName, delta]) => {
        const paramDef = charEntry.params.find(p => p.name === paramName);
        if (!paramDef) return;
        if (paramDef.type === 'fixed') return; // 固定値は AI による変動を拒否
        const current = activeQuest.state.status_values[speakerName][paramName] || 0;
        if (paramDef.type === 'clock') {
            // 時刻: 分単位で加算、24h でラップ
            const next = ((current + delta) % 1440 + 1440) % 1440;
            activeQuest.state.status_values[speakerName][paramName] = next;
        } else {
            // variable: -100..100 にクランプ
            activeQuest.state.status_values[speakerName][paramName] = Math.max(-100, Math.min(100, current + delta));
        }
    });
}

// 現在の全キャラ全パラメーター値のスナップショットを返す
function snapshotStatusValues() {
    if (!activeQuest || !activeQuest.state || !activeQuest.state.status_values) return null;
    if (!_hasAnyStatusParams(activeQuest)) return null;
    return JSON.parse(JSON.stringify(activeQuest.state.status_values));
}

// Split AI reply into per-character messages
function splitAndAppendCharMessages(fullReply, shouldSave, forcedIndex = -1, allowUserSpeaker = false) {
    // ===== 💬 純チャットモード: SPEAKER解析なしで「AI」のシンプルバブルとして表示 =====
    if (pureChatMode) {
        let mIdx = forcedIndex;
        const clean = (fullReply || '').replace(/<\/?think>/gi, '').trim();
        if (shouldSave) {
            chatHistory.push({ role: 'assistant', content: clean });
            saveChatHistory();
            mIdx = chatHistory.length - 1;
        }
        appendMessage('char', clean, 'AI', false, mIdx, null);
        if (shouldSave && autoplayTts) {
            const resolved = resolveTtsVoice('ナレーション', null);
            if (resolved) queueTts(clean, resolved.voice, true); // 全文読み上げ
        }
        return;
    }

    const members = getActivePartyMembers();

    // [MEMO: 〜] タグを最初に抽出（AI Memo へ追加 + 表示文からは除去）
    fullReply = parseAndStoreAiMemoTags(fullReply);

    // {img:tag} を抽出（本文からは常に除去し、有効時のみ描画後に画像バブルを挿入）
    // {img:tag} は本文に残したまま描画側へ渡す。
    // appendMessage がタグの位置で本文を分割し、そこに画像を挟み込む
    // （タグの位置＝画像の表示位置になる）。
    const _replyWithImgTags = fullReply; // 履歴保存用（タグを残した原文）
    if (!imageLibraryEnabled) {
        // 機能 OFF のときはタグが本文にそのまま出てしまうので表示からは除去する
        const imgResult = parseImageTags(fullReply);
        if (imgResult.tags.length > 0) {
            fullReply = imgResult.cleanedContent;
            if (shouldSave) {
                console.warn('[ImageLib] タグを検出しましたが画像ライブラリが無効です:', imgResult.tags.join(', '));
                showToast('🖼️ 画像タグを検出しましたが機能が OFF です — Settings → 画像ライブラリ を有効にしてください', 'error');
            }
        }
    }

    // Universe Report 検出 → 「学習量: 低い」なら世界観名で自動 Web Search → AI Memo へ記録 (非同期)
    detectUniverseReportAndAutoSearch(fullReply);

    // [INFO]...[/INFO] を最優先で抽出（CHOICES 抽出の前に）
    // infoPanelEnabled が false でも誤出力されたタグは本文から除去する
    let _extractedInfoText = null;
    {
        const infoResult = parseInfoTag(fullReply);
        if (infoResult.infoText) {
            fullReply = infoResult.cleanedContent;
            if (infoPanelEnabled) {
                _extractedInfoText = infoResult.infoText;
            }
        }
    }

    // 末尾選択肢 [CHOICES]...[/CHOICES] を抽出して本文から除去
    // 抽出した選択肢は分割処理後にボタンとして描画する
    let _extractedChoices = [];
    let _choicesRawBlock = ''; // 履歴保存用の正規化 [CHOICES] ブロック（表示からは除去するがモデルの手本として履歴に残す）
    if (showChoices) {
        const choicesResult = parseChoicesTag(fullReply);
        if (choicesResult.choices.length > 0) {
            _extractedChoices = choicesResult.choices;
            fullReply = choicesResult.cleanedContent;
            // 履歴には正規化した [CHOICES] ブロックを残す。
            // これがないと API 送信履歴に選択肢が一切残らず、ローカルモデルが
            // 「直前の自分の応答に選択肢が無い」パターンを真似て2ターン目以降に選択肢を出さなくなる。
            _choicesRawBlock = '\n\n[CHOICES]\n'
                + choicesResult.choices.map((c, i) => (i + 1) + '. ' + c).join('\n')
                + '\n[/CHOICES]';
        }
    } else {
        // showChoices=false でも誤って AI が出力した CHOICES タグは除去する
        const choicesResult = parseChoicesTag(fullReply);
        if (choicesResult.choices.length > 0) {
            fullReply = choicesResult.cleanedContent;
        }
    }

    // INFO 抽出があれば描画＋スナップショット更新
    if (_extractedInfoText) {
        lastInfoSnapshot = _extractedInfoText;
        renderInfoPanel(_extractedInfoText);
    }

    // 既存の選択肢ボタンをクリア（次の応答に置き換わる）
    clearChoiceButtons();

    // パーティなしの場合: SPEAKER タグがあればタグベース解析へ落下、なければナレーションとして一括処理
    if (members.length === 0) {
        if (!/\[SPEAKER:\s*[^\]]+\]/i.test(fullReply)) {
            const { cleanedContent } = parseStatusTag(fullReply);
            let mIdx = forcedIndex;
            if (shouldSave) {
                // 履歴には {img:} タグを残した原文を保存（編集画面で位置が見えるように）
                const clean = _replyWithImgTags.replace(/<\/?think>/gi, '').trim();
                chatHistory.push({ role: 'assistant', content: clean + _choicesRawBlock });
                saveChatHistory();
                mIdx = chatHistory.length - 1;
            }
            appendMessage('char', cleanedContent || fullReply, 'ナレーション', false, mIdx, null);
            // ナレーション読み上げ
            if (shouldSave && autoplayTts) {
                const resolved = resolveTtsVoice('ナレーション', null);
                if (resolved) queueTts(cleanedContent || fullReply, resolved.voice, resolved.isNarration);
            }
            if (shouldSave && mIdx >= 0) {
                const snap = snapshotStatusValues();
                if (snap) { chatHistory[mIdx].statusSnapshot = snap; saveChatHistory(); }
                updateStatusHUD();
            }
            if (shouldSave && _extractedChoices && _extractedChoices.length > 0) {
                renderChoiceButtons(_extractedChoices);
            }
            if (shouldSave && _extractedInfoText && mIdx >= 0 && chatHistory[mIdx]) {
                chatHistory[mIdx].infoSnapshot = _extractedInfoText;
                saveChatHistory();
            }
            return;
        }
        // SPEAKER タグあり → そのままタグベース解析へ（members 空でも動作する）
    }

    // --- 共通: statusSnapshot の解決 ---
    // 新規生成時 (shouldSave=true): この応答内の [STATUS: ...] を適用しながら各キャラの値を更新
    // 再描画時 (shouldSave=false): chatHistory[forcedIndex].statusSnapshot があればそれを使用
    const renderMode = !shouldSave;
    const existingSnapshot = (renderMode && forcedIndex >= 0 && chatHistory[forcedIndex])
        ? chatHistory[forcedIndex].statusSnapshot
        : null;

    if (members.length === 1 && !/\[SPEAKER:\s*[^\]]+\]/i.test(fullReply)) {
        // [SPEAKER:] タグがない1人構成の場合のみ単一バブルとして処理
        const name = members[0].name;
        const { deltas, cleanedContent } = parseStatusTag(fullReply);
        if (!renderMode) applyStatusDelta(name, deltas);
        const statusForSpeaker = renderMode
            ? (existingSnapshot && existingSnapshot[name]) || null
            : getStatusValueForSpeaker(name);
        appendMessage('char', applyMacros(cleanedContent, name), name, shouldSave, forcedIndex, statusForSpeaker);
        // 選択肢ブロックを履歴に残す
        // （この経路は appendMessage が表示用テキストを push するため、末尾エントリへ追記して復元する。
        //   {img:} タグは表示テキストに含まれたまま push されるので、ここでの追記は不要）
        if (shouldSave && _choicesRawBlock && chatHistory.length > 0) {
            chatHistory[chatHistory.length - 1].content += _choicesRawBlock;
            saveChatHistory();
        }
        if (shouldSave && autoplayTts) {
            const resolved = resolveTtsVoice(name, members[0]);
            if (resolved) queueTts(cleanedContent, resolved.voice, resolved.isNarration);
        }
        // 新規生成後の snapshot 保存 & HUD 更新
        if (!renderMode && chatHistory.length > 0) {
            const snap = snapshotStatusValues();
            if (snap) {
                chatHistory[chatHistory.length - 1].statusSnapshot = snap;
                saveChatHistory();
            }
            updateStatusHUD();
        }
        // INFO 永続化（1人構成・SPEAKER タグなし経路）
        if (!renderMode && _extractedInfoText && chatHistory.length > 0) {
            chatHistory[chatHistory.length - 1].infoSnapshot = _extractedInfoText;
            saveChatHistory();
        }
        // 事前登録画像 → 選択肢ボタンの順で描画（1人構成・SPEAKER タグなし経路）
        if (shouldSave && _extractedChoices && _extractedChoices.length > 0) {
            renderChoiceButtons(_extractedChoices);
        }
        return;
    }

    // Build a regex to find [SPEAKER: Name] or similar variations
    const tagRegex = /\[SPEAKER:\s*([^\]]+)\]/gi;

    // Let's check if the AI used the tags. If not, fallback to name prefix logic
    if (!tagRegex.test(fullReply)) {
        // Fallback: detect speaker changes using multiple common AI output patterns
        // Patterns: "Name:", "Name：", "**Name:**", "**Name：**", "【Name】", "Name「"
        const namePatterns = members.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const nameGroup = namePatterns.join('|');
        // Match line-start speaker patterns:
        //   Name: / Name：
        //   **Name:** / **Name：**
        //   【Name】
        //   ―Name― / —Name—
        //   Name「 (Japanese dialogue opener)
        const fallbackRegex = new RegExp(
            '(?=(?:^|\\n)\\s*(?:'
            + '\\*\\*(?:' + nameGroup + ')\\**\\s*[：:]\\s*\\**'  // **Name:** or **Name：**
            + '|【(?:' + nameGroup + ')】'                         // 【Name】
            + '|[―—](?:' + nameGroup + ')[―—]'                    // ―Name― / —Name—
            + '|(?:' + nameGroup + ')\\s*[：:]'                    // Name: / Name：
            + '|(?:' + nameGroup + ')「'                           // Name「
            + '))', 'g');
        const segments = fullReply.split(fallbackRegex).filter(s => s.trim());

        let mIndex = forcedIndex;
        if (shouldSave) {
            // 履歴には {img:} タグを残した原文を保存（編集画面で位置が見えるように）
            let fullReplyForHistory = _replyWithImgTags.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            fullReplyForHistory = fullReplyForHistory.replace(/<think>[\s\S]*/gi, '').trim();
            fullReplyForHistory = fullReplyForHistory.replace(/<\/think>/gi, '').trim();
            chatHistory.push({ role: 'assistant', content: fullReplyForHistory + _choicesRawBlock });
            saveChatHistory();
            mIndex = chatHistory.length - 1;
        }

        segments.forEach(seg => {
            let trimmed = seg.trim();
            let speakerName = members[0].name;
            for (const m of members) {
                const esc = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Try all speaker prefix patterns and strip them from displayed text
                const prefixPatterns = [
                    new RegExp('^\\*\\*' + esc + '\\**\\s*[：:]\\s*\\**\\s*', ''),  // **Name:**
                    new RegExp('^【' + esc + '】\\s*', ''),                          // 【Name】
                    new RegExp('^[―—]' + esc + '[―—]\\s*', ''),                      // ―Name―
                    new RegExp('^' + esc + '\\s*[：:]\\s*', ''),                      // Name: / Name：
                    new RegExp('^' + esc + '(?=「)', ''),                             // Name「 (keep 「)
                ];
                let matched = false;
                for (const pRegex of prefixPatterns) {
                    if (pRegex.test(trimmed)) {
                        speakerName = m.name;
                        trimmed = trimmed.replace(pRegex, '');
                        matched = true;
                        break;
                    }
                }
                if (matched) break;
            }
            // STATUS タグの抽出と適用
            const { deltas, cleanedContent } = parseStatusTag(trimmed);
            trimmed = cleanedContent;
            if (!renderMode) applyStatusDelta(speakerName, deltas);
            const statusForSpeaker = renderMode
                ? (existingSnapshot && existingSnapshot[speakerName]) || null
                : getStatusValueForSpeaker(speakerName);
            if (trimmed) {
                appendMessage('char', applyMacros(trimmed, speakerName), speakerName, false, mIndex, statusForSpeaker);
                if (shouldSave && autoplayTts) {
                    const speaker = findMemberBySpeaker(speakerName, members);
                    const resolved = resolveTtsVoice(speakerName, speaker);
                    if (resolved) queueTts(trimmed, resolved.voice, resolved.isNarration);
                }
            }
        });
        // 新規生成後: snapshot を記録し HUD 更新
        if (!renderMode && mIndex >= 0) {
            const snap = snapshotStatusValues();
            if (snap) {
                chatHistory[mIndex].statusSnapshot = snap;
                saveChatHistory();
            }
            updateStatusHUD();
        }
        // 事前登録画像 → 選択肢描画（名前プレフィックス・フォールバック経路）
        if (!renderMode && _extractedChoices && _extractedChoices.length > 0) {
            renderChoiceButtons(_extractedChoices);
        }
        // INFO 永続化（SPEAKER タグなしフォールバック経路）
        if (!renderMode && _extractedInfoText && mIndex >= 0 && chatHistory[mIndex]) {
            chatHistory[mIndex].infoSnapshot = _extractedInfoText;
            saveChatHistory();
        }
        return;
    }

    // Tag-based Splitting (AI followed instructions)
    tagRegex.lastIndex = 0; // reset
    const segments = [];
    let match;
    let lastIndex = 0;

    while ((match = tagRegex.exec(fullReply)) !== null) {
        if (segments.length === 0 && match.index > 0) {
            // 最初の[SPEAKER:]タグの前にテキストがある場合の話者帰属:
            //   1人構成 → そのキャラの発言として扱う（タグなしテキスト＝主役キャラが既定）
            //   それ以外（GM/複数構成）→ ナレーションとして扱う
            const preText = fullReply.substring(0, match.index).trim();
            if (preText) {
                const defaultSpeaker = (members.length === 1) ? members[0].name : 'ナレーション';
                segments.push({ speaker: defaultSpeaker, content: preText });
            }
        } else if (segments.length > 0) {
            segments[segments.length - 1].content = fullReply.substring(lastIndex, match.index).trim();
        }
        segments.push({ speaker: match[1].trim(), content: '' });
        lastIndex = tagRegex.lastIndex;
    }
    if (segments.length > 0) {
        segments[segments.length - 1].content = fullReply.substring(lastIndex).trim();
    }

    // 二次分割: 各セグメント内で「===...」区切り線や「**【」メタ見出しが出現した場合、
    // そこから後ろをナレーションセグメントとして独立させる。
    // ユーザー名フィルタで SPEAKER=プレイヤー名 のセグメントが破棄されるケースでも、
    // ぶら下がっているエンディング本文などを救出するため。
    {
        const rescued = [];
        const rescueRegex = /(^|\n)[ \t]*(?:={4,}|\*\*【)/;
        segments.forEach(seg => {
            const m = seg.content.match(rescueRegex);
            if (m && m.index !== undefined && m.index > 0) {
                const splitAt = m.index + m[1].length; // 区切り線の行頭位置
                const before = seg.content.substring(0, splitAt).trim();
                const after = seg.content.substring(splitAt).trim();
                if (before) rescued.push({ speaker: seg.speaker, content: before });
                if (after) rescued.push({ speaker: 'ナレーション', content: after });
            } else {
                rescued.push(seg);
            }
        });
        segments.length = 0;
        rescued.forEach(s => segments.push(s));
    }

    let msgIndex = forcedIndex;
    if (shouldSave) {
        // 履歴には {img:} タグを残した原文を保存（編集画面で位置が見えるように）
        let fullReplyForHistory = _replyWithImgTags.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        fullReplyForHistory = fullReplyForHistory.replace(/<think>[\s\S]*/gi, '').trim();
        fullReplyForHistory = fullReplyForHistory.replace(/<\/think>/gi, '').trim();
        chatHistory.push({ role: 'assistant', content: fullReplyForHistory + _choicesRawBlock });
        saveChatHistory();
        msgIndex = chatHistory.length - 1;
    }

    segments.forEach(seg => {
        // Strip [SPEAKER: ...] tags from displayed content
        let rawContent = seg.content.replace(/\[SPEAKER:\s*[^\]]+\]/gi, '');
        // STATUS タグも抽出
        const { deltas, cleanedContent } = parseStatusTag(rawContent);
        let cleanContent = cleanedContent;
        if (!cleanContent) return;

        // ───────────────────────────────────────────────
        // スピーカー解決の優先順位（3段判定）:
        //   1. NPC「厳密」マッチ（NPCキャラ名のみ・description は見ない）
        //   2. プレイヤー名と曖昧一致 → ナレーション救済
        //      （banter_player モード時はプレイヤー発言として表示）
        //   3. NPC「緩い」マッチ（description / alias / 単語分割）
        //   4. どれにも該当しない → フリーフォーム名でそのまま描画
        //
        // NOTE: 1→2→3 の順序が重要。
        // プレイヤー名「ユート」が NPC の description 内「ユート先生」と部分一致して
        // 誤って NPC に割り当てられるバグを防ぐため、緩いマッチの前にプレイヤー判定を入れる。
        // ───────────────────────────────────────────────

        // 1. NPC 厳密マッチ
        let realMember = findMemberBySpeakerStrict(seg.speaker, members);

        // 2. プレイヤー曖昧マッチ → ナレーション救済（Gemma/Gemini系の癖対策）
        if (!realMember && isFuzzyPlayerSpeaker(seg.speaker)) {
            if (!allowUserSpeaker) {
                console.warn('[RP Engine] AIが{{user}}名義の発言を生成 → ナレーションとして描画:', seg.speaker);
                appendMessage('char', applyMacros(cleanContent, userConfig.name), 'ナレーション', false, msgIndex, null);
                // 救済されたブロックも narratorVoice で読み上げ
                if (shouldSave && autoplayTts) {
                    const resolved = resolveTtsVoice('ナレーション', null);
                    if (resolved) queueTts(cleanContent, resolved.voice, resolved.isNarration);
                }
                return;
            }
            // banter_player モード: プレイヤー発言をユーザーメッセージとして表示
            appendMessage('user', applyMacros(cleanContent, userConfig.name), userConfig.name, false, msgIndex);
            if (shouldSave && autoplayTts) {
                // userConfig.voice 優先、なければ narratorVoice フォールバック
                const playerVoice = (userConfig.voice && userConfig.voice.engine && userConfig.voice.engine !== 'none')
                    ? userConfig.voice
                    : ((narratorVoice && narratorVoice.engine !== 'none') ? narratorVoice : null);
                if (playerVoice) queueTts(cleanContent, playerVoice, false);
            }
            return;
        }

        // 3. NPC 緩いマッチ（description ベース等）
        if (!realMember) {
            realMember = findMemberBySpeaker(seg.speaker, members);
        }

        let name = realMember ? realMember.name : seg.speaker;

        // STATUS 適用（新規生成時のみ）
        if (!renderMode) {
            if (realMember) {
                applyStatusDelta(realMember.name, deltas);
            } else if (members.length === 1 && Object.keys(deltas).length > 0) {
                // 1人構成の場合、ナレーターブロックのSTATUSも唯一のキャラクターに適用する
                applyStatusDelta(members[0].name, deltas);
            } else if (Object.keys(deltas).length > 0) {
                // メンバーなし/マッチなし → SPEAKER 名が char_status_params に存在すれば直接適用
                applyStatusDelta(name, deltas);
            }
        }
        const statusForSpeaker = renderMode
            ? (existingSnapshot && existingSnapshot[name]) || null
            : getStatusValueForSpeaker(name);

        appendMessage('char', applyMacros(cleanContent, name), name, false, msgIndex, statusForSpeaker);
        if (shouldSave && autoplayTts) {
            // 統合解決ヘルパで NPC voice / ナレーター voice / フォールバックを一括処理
            const resolved = resolveTtsVoice(name, realMember);
            if (resolved) queueTts(cleanContent, resolved.voice, resolved.isNarration);
        }
    });

    // 新規生成後: snapshot を記録し HUD 更新
    if (!renderMode && msgIndex >= 0) {
        const snap = snapshotStatusValues();
        if (snap) {
            chatHistory[msgIndex].statusSnapshot = snap;
            saveChatHistory();
            // インラインステータスを最終値に同期
            // （ナレーターブロック末尾のSTATUSがキャラバブルより後に処理されるため
            //   描画済みバブルを遡って上書き更新する）
            syncInlineStatusForMsg(msgIndex, snap);
        }
        updateStatusHUD();
    }

    // 事前登録画像 → 選択肢ボタンの順で描画（タグベース解析経路）
    if (!renderMode && _extractedChoices && _extractedChoices.length > 0) {
        renderChoiceButtons(_extractedChoices);
    }

    // 新規生成時、INFO スナップショットを最新 assistant メッセージに添付（永続化）
    if (!renderMode && _extractedInfoText && msgIndex >= 0 && chatHistory[msgIndex]) {
        chatHistory[msgIndex].infoSnapshot = _extractedInfoText;
        saveChatHistory();
    }
}

/**
 * 指定メッセージインデックスのキャラバブルのインラインステータス表示を
 * 最終スナップショット値で上書き同期する。
 * タグ分割処理でSTATUSがナレーターブロックに書かれた場合、
 * キャラバブルの描画より後に値が更新されるため、この関数で事後補正する。
 */
function syncInlineStatusForMsg(msgIndex, snapshot) {
    if (!activeQuest || !snapshot) return;
    document.querySelectorAll(`.chat-msg[data-index="${msgIndex}"]`).forEach(msgDiv => {
        const nameTextEl = msgDiv.querySelector('.msg-speaker-name-text');
        if (!nameTextEl) return; // インライン表示なし（通常の名前テキストのみ）
        const charName = nameTextEl.textContent;
        const charEntry = _getCharStatusEntry(activeQuest, charName);
        if (!charEntry || !charEntry.params) return;
        const charVals = snapshot[charName];
        if (!charVals) return;
        const nameEl = nameTextEl.parentElement; // .msg-speaker-name
        if (!nameEl) return;
        // 既存のパラメータースパンをすべて削除して最新値で再描画
        nameEl.querySelectorAll('.msg-speaker-status').forEach(s => s.remove());
        charEntry.params.forEach(p => {
            if (!p.name || typeof charVals[p.name] !== 'number') return;
            const paramSpan = document.createElement('span');
            paramSpan.className = 'msg-speaker-status';
            paramSpan.textContent = `(${p.name}：${charVals[p.name]}%)`;
            nameEl.appendChild(paramSpan);
        });
    });
}

function escapeHTML(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

function scrollToBottom() {
    var history = document.getElementById('chat-history');
    if (history) {
        history.scrollTop = history.scrollHeight;
    }
}

// ======== Banter Member Select Modal ========
// メンバー選択モーダルを開き、ユーザーがチェックを入れて「生成」を押すと
// callback(selectedMembers, includePlayer) を呼び出す。キャンセル時は callback 非呼出。
function openBanterSelectModal(activeMembers, defaultIncludePlayer, callback) {
    const modal = document.getElementById('banter-select-modal');
    const listDiv = document.getElementById('banter-member-list');
    const includePlayerCheckbox = document.getElementById('banter-include-player');
    const confirmBtn = document.getElementById('banter-confirm-btn');
    const cancelBtn = document.getElementById('banter-cancel-btn');
    if (!modal || !listDiv || !confirmBtn || !cancelBtn) {
        // モーダルが見つからない場合は全員＋デフォルトで即実行
        callback(activeMembers, defaultIncludePlayer);
        return;
    }

    // 前回の選択を localStorage から復元（同じセッション内の連発を快適に）
    let lastSelection = [];
    try {
        const stored = localStorage.getItem('banterLastSelection');
        if (stored) lastSelection = JSON.parse(stored);
    } catch (e) { /* noop */ }

    // メンバーカード描画
    listDiv.innerHTML = '';
    activeMembers.forEach(m => {
        const card = document.createElement('label');
        card.className = 'banter-member-card';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = m.name;
        // 前回選択 or 初回はアクティブメンバー全員ON（2〜4人を期待）
        const wasSelectedLast = lastSelection.includes(m.name);
        cb.checked = lastSelection.length > 0 ? wasSelectedLast : true;
        cb.addEventListener('change', () => {
            card.classList.toggle('selected', cb.checked);
        });

        const avatar = document.createElement('img');
        avatar.src = m.avatar || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23666"><circle cx="12" cy="8" r="4"/><path d="M4 22a8 8 0 0 1 16 0"/></svg>';
        avatar.alt = m.name;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'banter-member-name';
        nameSpan.textContent = m.name;

        card.appendChild(cb);
        card.appendChild(avatar);
        card.appendChild(nameSpan);
        if (cb.checked) card.classList.add('selected');
        listDiv.appendChild(card);
    });

    includePlayerCheckbox.checked = !!defaultIncludePlayer;

    // モーダル表示
    modal.classList.remove('hidden');

    // 古いハンドラを除去（モーダルを再利用する場合の安全策）
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

    newConfirm.addEventListener('click', () => {
        const checked = Array.from(listDiv.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
        const includePlayer = includePlayerCheckbox.checked;
        const minNeeded = includePlayer ? 1 : 2;
        if (checked.length < minNeeded) {
            alert(includePlayer ? '掛け合いには最低1人のキャラクターを選択してください。' : '掛け合いには最低2人のキャラクターを選択してください。');
            return;
        }
        if (checked.length > 5) {
            if (!confirm(checked.length + '人を一度に掛け合いさせるとAIが混乱する可能性があります。続行しますか？')) return;
        }
        const selectedMembers = activeMembers.filter(m => checked.includes(m.name));
        try {
            localStorage.setItem('banterLastSelection', JSON.stringify(checked));
        } catch (e) { /* localStorage full などは無視 */ }
        modal.classList.add('hidden');
        callback(selectedMembers, includePlayer);
    });

    newCancel.addEventListener('click', () => {
        modal.classList.add('hidden');
    });
}

function setupChat() {
    var inputArea = document.getElementById('chat-input');
    var sendBtn = document.getElementById('send-btn');
    var banterBtn = document.getElementById('banter-btn');
    
    var isSending = false; // 二重送信防止フラグ
    var sendMessage = async function() {
        if (isSending) return; // 送信中は無視
        var text = inputArea.value.trim();
        if(!text) return;

        // Living World タイマー: ユーザー入力時刻を更新（アイドル発火タイマーをリセット）
        _lastUserInputTime = Date.now();

        // ── ダイスロールコマンド: /roll NdX または /r NdX ──
        // 2パターン対応:
        //   (a) メッセージ全体が /roll XdY のみ      → 従来挙動: ダイス結果をユーザーバブル化してAIへ
        //   (b) メッセージ内に /roll XdY 行が含まれる → RP本文末尾に [DICE_RESULT: ...] マーカーを付与してAIへ
        const rollStandaloneMatch = text.match(/^\/r(?:oll)?\s+(.+)$/i);
        const rollInlineRegex = /(^|\n)\s*\/r(?:oll)?\s+([^\s\n]+)\s*(?=\n|$)/i;
        const rollInlineMatch = !rollStandaloneMatch ? text.match(rollInlineRegex) : null;

        if (rollStandaloneMatch || rollInlineMatch) {
            const notationStr = rollStandaloneMatch ? rollStandaloneMatch[1] : rollInlineMatch[2];
            const parsed = parseDiceNotation(notationStr);
            if (!parsed) {
                appendDiceMessage(notationStr, [], 0);
                if (rollStandaloneMatch) { inputArea.value = ''; inputArea.style.height = 'auto'; return; }
                // inline で不正な表記なら /roll 行だけ除去して通常送信
            }

            let diceRollMsg = null;
            let diceMarker = null;
            if (parsed) {
                const { rolls, total } = rollDiceNotation(parsed.count, parsed.sides);
                const notation = `${parsed.count}d${parsed.sides}`;
                appendDiceMessage(notation, rolls, total);
                diceRollMsg = parsed.count > 1
                    ? `[ダイスロール: ${notation} → ${rolls.join('+')}=${total}]`
                    : `[ダイスロール: ${notation} → ${total}]`;
                diceMarker = parsed.count > 1
                    ? `[DICE_RESULT: ${notation} = ${rolls.join('+')} = ${total}]`
                    : `[DICE_RESULT: ${notation} = ${total}]`;
            }

            if (rollStandaloneMatch) {
                // (a) 単独 /roll: 従来どおりダイス結果だけをユーザーバブル化
                if (diceRollMsg) appendMessage('user', diceRollMsg, userConfig.name, true);
            } else {
                // (b) RP本文 + /roll 混在: /roll 行を除去し、本文末尾にマーカー付与
                const rpText = text.replace(rollInlineRegex, '').trim();
                const combined = diceMarker ? (rpText + '\n' + diceMarker) : rpText;
                if (combined) appendMessage('user', combined, userConfig.name, true);
            }

            inputArea.value = '';
            inputArea.style.height = 'auto';
            isSending = true;
            inputArea.disabled = true;
            sendBtn.disabled = true;
            banterBtn.disabled = true;
            const _loadMembers = getActivePartyMembers();
            const loadingName = _loadMembers.length === 1
                ? _loadMembers[0].name
                : (_loadMembers.length === 0 ? userConfig.name : 'Party');
            const loadingId = 'loading-' + Date.now();
            appendLoadingMsg(loadingId, loadingName);
            try {
                const reply = await fetchChatCompletion();
                removeLoadingMsg(loadingId);
                if (reply) {
                    splitAndAppendCharMessages(reply, true);
                    updateRegenButtonVisibility();
                }
            } catch (e) {
                removeLoadingMsg(loadingId);
            } finally {
                isSending = false;
                inputArea.disabled = false;
                sendBtn.disabled = false;
                banterBtn.disabled = false;
                inputArea.focus();
            }
            return;
        }

        // ── プレイヤーナレーションモード: LLMを呼ばずにナレーション表示 ──
        if (playerNarrationMode) {
            chatHistory.push({ role: 'narrator', content: text });
            saveChatHistory();
            appendNarrationMessage(text, chatHistory.length - 1);
            inputArea.value = '';
            inputArea.style.height = 'auto';
            return;
        }

        isSending = true;

        appendMessage('user', text, userConfig.name, true);

        inputArea.value = '';
        inputArea.disabled = true;
        sendBtn.disabled = true;
        banterBtn.disabled = true;

        var loadingName = 'Party';
        const members = getActivePartyMembers();
        if(members.length === 1) loadingName = members[0].name;

        // ── Web Search フック: 検索判定 → 結果を _pendingWebSearchInjection に格納 ──
        _pendingWebSearchInjection = '';
        try {
            const searchTrigger = shouldPerformWebSearch(text);
            if (searchTrigger) {
                appendWebSearchBadge(searchTrigger.query, 'searching');
                const r = await performWebSearch(searchTrigger.query, { bypassCooldown: !!searchTrigger.bypassCooldown });
                if (r.results && r.results.length) {
                    _pendingWebSearchInjection = formatWebSearchForPrompt(searchTrigger.query, r.results);
                    updateWebSearchBadge(searchTrigger.query, 'done',
                        r.results.length + ' 件' + (r.fromCache ? '（キャッシュ）' : '') + ' [' + (r.provider || '?') + ']');
                } else if (r.error === 'cooldown') {
                    updateWebSearchBadge(searchTrigger.query, 'cooldown', r.secondsLeft + '秒待機');
                } else {
                    updateWebSearchBadge(searchTrigger.query, 'error', r.error ? String(r.error).slice(0, 60) : '失敗');
                }
            }
        } catch (e) {
            console.warn('[WebSearch] error:', e);
        }

        var loadingId = 'loading-' + Date.now();
        appendLoadingMsg(loadingId, loadingName);

        try {
            console.log('[sendMessage] fetchChatCompletion start');
            var reply = await fetchChatCompletion();
            console.log('[sendMessage] fetchChatCompletion returned, len=' + (reply ? reply.length : 0));

            // fetch 直後に loading を消す（splitAndAppend 失敗時の二段保護）
            removeLoadingMsg(loadingId);

            if(reply) {
                // 描画パイプラインの例外を個別 catch して見える化
                try {
                    splitAndAppendCharMessages(reply, true);
                    console.log('[sendMessage] splitAndAppendCharMessages OK');
                } catch (innerErr) {
                    console.error('[sendMessage] splitAndAppendCharMessages threw:', innerErr);
                    appendMessage('char', '[Render Error] ' + innerErr.message + '\n\n--- 生応答 ---\n' + reply, 'System');
                }
                try { updateRegenButtonVisibility(); } catch (e) { console.warn('updateRegenButtonVisibility err', e); }
                // Auto image generation after reply
                if (sdConfig.enabled && sdConfig.autoGenerate) {
                    triggerImageGeneration();
                }
                // Auto narration after reply
                if (narratorConfig.enabled && narratorConfig.autoTrigger) {
                    triggerNarration();
                }
            }
        } catch (e) {
            console.error('[sendMessage] fetchChatCompletion threw:', e);
            removeLoadingMsg(loadingId);
            appendMessage('char', '[System Error] ' + e.message, 'System');
        } finally {
            isSending = false; // 送信完了
            inputArea.disabled = false;
            sendBtn.disabled = false;
            banterBtn.disabled = false;
            inputArea.focus();
            // 二段ガード: finally 段階でも loading が残っていれば最後に消す
            removeLoadingMsg(loadingId);
        }
    };

    // NPC Banter (掛け合い)
    // 実際にBanterリクエストを発行する内部関数。
    // selectedMembers: 掛け合いに参加するメンバー配列（null なら getActivePartyMembers() を使用）
    // withPlayer: プレイヤーも参加させる（banter_player モード）
    var executeBanter = async function(selectedMembers, withPlayer) {
        inputArea.disabled = true;
        sendBtn.disabled = true;
        banterBtn.disabled = true;

        var loadingId = 'loading-' + Date.now();
        appendLoadingMsg(loadingId, '掛け合い中...');

        // メンバーオーバーライドを設定
        _banterMembersOverride = (selectedMembers && selectedMembers.length > 0) ? selectedMembers : null;

        try {
            var reply = await fetchChatCompletion(withPlayer ? 'banter_player' : 'banter');

            removeLoadingMsg(loadingId);

            if(reply) {
                splitAndAppendCharMessages(reply, true, -1, withPlayer);
                updateRegenButtonVisibility();
            }
        } catch (e) {
            removeLoadingMsg(loadingId);
            appendMessage('char', '[System Error] ' + e.message, 'System');
        } finally {
            _banterMembersOverride = null;
            inputArea.disabled = false;
            sendBtn.disabled = false;
            banterBtn.disabled = false;
            inputArea.focus();
        }
    };

    var triggerBanter = async function() {
        const members = getActivePartyMembers();
        const withPlayerDefault = playerNarrationMode;

        if (!withPlayerDefault && members.length < 2) {
            alert('掛け合いには2人以上のキャラクターが必要です。');
            return;
        }
        if (members.length < 1) {
            alert('掛け合いには1人以上のキャラクターが必要です。');
            return;
        }

        // アクティブメンバーがちょうど2人 → モーダル省略して即実行（旧来の挙動）
        if (members.length === 2 && !withPlayerDefault) {
            executeBanter(members, false);
            return;
        }

        // 3人以上 or プレイヤーモード時はメンバー選択モーダルを表示
        openBanterSelectModal(members, withPlayerDefault, function(selectedMembers, includePlayer) {
            if (!selectedMembers || selectedMembers.length === 0) return;
            executeBanter(selectedMembers, includePlayer);
        });
    };

    sendBtn.addEventListener('click', sendMessage);
    banterBtn.addEventListener('click', triggerBanter);
    inputArea.addEventListener('keydown', function(e) {
        if(e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    const exportChatBtn = document.getElementById('export-chat-btn');
    if (exportChatBtn) {
        // 画像の base64 埋め込みで非同期になるため、失敗を握り潰さないよう明示的に捕捉する
        exportChatBtn.addEventListener('click', () => {
            exportChatLog().catch(e => {
                console.error('[Export] failed:', e);
                showToast('エクスポートに失敗しました: ' + e.message, 'error');
            });
        });
    }

    const saveSessionBtn = document.getElementById('save-session-btn');
    if (saveSessionBtn) {
        saveSessionBtn.addEventListener('click', saveChatSession);
    }
    const loadSessionFile = document.getElementById('load-session-file');
    if (loadSessionFile) {
        loadSessionFile.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            loadChatSession(file);
            e.target.value = '';
        });
    }

    // ✏️ プレイヤーナレーションモード切替
    const playerNarrateBtn = document.getElementById('player-narrate-btn');
    if (playerNarrateBtn) {
        playerNarrateBtn.addEventListener('click', () => {
            playerNarrationMode = !playerNarrationMode;
            playerNarrateBtn.classList.toggle('active', playerNarrationMode);
            inputArea.classList.toggle('narration-mode', playerNarrationMode);
            inputArea.placeholder = playerNarrationMode
                ? 'ナレーションを入力... (Enterで送信)'
                : 'メッセージを入力... (Enterで送信, Shift+Enterで改行)';
            inputArea.focus();
        });
    }

    // 📖 LLMナレーター
    const narratorBtn = document.getElementById('narrator-btn');
    if (narratorBtn) {
        narratorBtn.addEventListener('click', () => triggerNarration());
    }

    // 🎲 ダイスロールポップオーバー
    const diceBtn = document.getElementById('dice-btn');
    const dicePopover = document.getElementById('dice-popover');
    if (diceBtn && dicePopover) {
        diceBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dicePopover.classList.toggle('hidden');
        });
        // ポップオーバー外クリックで閉じる
        document.addEventListener('click', (e) => {
            if (!dicePopover.contains(e.target) && e.target !== diceBtn) {
                dicePopover.classList.add('hidden');
            }
        });
        // クイックダイスボタン
        // ※ 変更: 即時送信ではなく「入力欄に挿入」フローに変更。
        //   バブルは視覚的なロール記録としてチャットに残し、テキストは入力欄に挿入。
        //   プレイヤーが RP 描写を書き加えてから自分で送信する。
        document.querySelectorAll('.dice-face-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const parsed = parseDiceNotation(btn.dataset.notation);
                if (!parsed) return;
                const { rolls, total } = rollDiceNotation(parsed.count, parsed.sides);
                const notation = btn.dataset.notation;
                appendDiceMessage(notation, rolls, total);
                dicePopover.classList.add('hidden');
                const rollText = parsed.count > 1
                    ? `[ダイスロール: ${notation} → ${rolls.join('+')}=${total}]`
                    : `[ダイスロール: ${notation} → ${total}]`;
                insertIntoChatInput(rollText);
            });
        });
        // カスタムロール（即時送信から入力欄挿入フローへ変更）
        const customInput = document.getElementById('dice-custom-input');
        const customRollBtn = document.getElementById('dice-custom-roll-btn');
        const doCustomRoll = () => {
            const val = customInput ? customInput.value.trim() : '';
            const parsed = parseDiceNotation(val);
            if (!parsed) {
                appendDiceMessage(val || '?', [], 0); // エラーバブル表示
                dicePopover.classList.add('hidden');
                return;
            }
            const { rolls, total } = rollDiceNotation(parsed.count, parsed.sides);
            appendDiceMessage(val, rolls, total);
            dicePopover.classList.add('hidden');
            const rollText = parsed.count > 1
                ? `[ダイスロール: ${val} → ${rolls.join('+')}=${total}]`
                : `[ダイスロール: ${val} → ${total}]`;
            insertIntoChatInput(rollText);
            if (customInput) customInput.value = '';
        };
        if (customRollBtn) customRollBtn.addEventListener('click', doCustomRoll);
        if (customInput) {
            customInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doCustomRoll(); }
            });
        }
    }

    const imggenBtn = document.getElementById('imggen-btn');
    if (imggenBtn) {
        imggenBtn.addEventListener('click', function(e) {
            if (e.shiftKey) {
                // LLMでシーンプロンプト生成 → モーダルで確認・編集 → SD生成
                const btn = document.getElementById('imggen-btn');
                if (btn) btn.disabled = true;
                (async () => {
                    try {
                        const generatedPrompt = await generateScenePrompt();
                        openPromptEditModal(generatedPrompt, async function(editedPrompt) {
                            await triggerImageGeneration(editedPrompt);
                        });
                    } catch (err) {
                        alert('プロンプト生成エラー: ' + err.message);
                    } finally {
                        if (btn) btn.disabled = false;
                    }
                })();
            } else {
                triggerImageGeneration();
            }
        });
    }
}

// loading 表示が長時間（既定 5 分）残った場合の自動クリーンアップ。
// 主な発火条件: LLM 側完了したのにフロントで処理失敗・JS 例外・fetch ハング等。
// 既存 setTimeout を ID にぶら下げて、明示 removeLoadingMsg 時にクリアする。
const LOADING_AUTOCLEAR_MS = 300000; // 5 分
const _loadingTimers = new Map();

function appendLoadingMsg(id, name) {
    var chatContainer = document.getElementById('chat-history');
    var msgDiv = document.createElement('div');
    msgDiv.id = id;
    msgDiv.className = 'chat-msg char';
    
    var avatarImg = document.createElement('img');
    const members = getActivePartyMembers();
    
    var partySvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%237c4dff' d='M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z'/></svg>";
    
    var portraitSrc = partySvg;
    if (members.length === 1 && members[0].avatar) {
        portraitSrc = members[0].avatar;
    } else if (members.length > 1) {
        // Maybe use a combined icon later, for now party icon is fine
        portraitSrc = partySvg;
    } else if (members[0]) {
        portraitSrc = members[0].avatar || UNKNOWN_CHAR_SVG;
    } else {
        portraitSrc = UNKNOWN_CHAR_SVG;
    }
    
    avatarImg.src = portraitSrc;
    avatarImg.alt = name;
    avatarImg.className = 'msg-avatar';
    avatarImg.style.opacity = '0.5';
    
    var contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    contentDiv.style.opacity = '0.5';
    contentDiv.style.fontStyle = 'italic';
    contentDiv.textContent = '... typing ...';
    
    msgDiv.appendChild(avatarImg);
    msgDiv.appendChild(contentDiv);
    chatContainer.appendChild(msgDiv);
    scrollToBottom();

    // セーフティネット: 5分経っても消えなければ自動クリア＋警告
    // 多くの場合 fetch ハング・JS例外で removeLoadingMsg が呼ばれず固まる
    const timerId = setTimeout(() => {
        const lingering = document.getElementById(id);
        if (lingering) {
            console.warn('[RP Engine] Loading message ' + id + ' auto-cleared after ' + (LOADING_AUTOCLEAR_MS / 1000) + 's. Possible fetch hang or unhandled exception.');
            lingering.remove();
            // ユーザーに警告メッセージを表示
            const warnDiv = document.createElement('div');
            warnDiv.className = 'chat-msg char';
            warnDiv.innerHTML = '<div class="msg-content" style="background:rgba(255,180,50,0.15);border-color:rgba(255,180,50,0.4);color:#ffcc66"><div class="msg-speaker-name">⚠️ System</div>応答が ' + (LOADING_AUTOCLEAR_MS / 60000) + ' 分以内に届かなかったため自動クリアしました。<br>F12 の Console / Network タブで詳細を確認してください。</div>';
            chatContainer.appendChild(warnDiv);
            scrollToBottom();
            // 入力欄も復活
            const ia = document.getElementById('chat-input');
            const sb = document.getElementById('send-btn');
            const bb = document.getElementById('banter-btn');
            if (ia) ia.disabled = false;
            if (sb) sb.disabled = false;
            if (bb) bb.disabled = false;
            try { isSending = false; } catch (e) {}
        }
        _loadingTimers.delete(id);
    }, LOADING_AUTOCLEAR_MS);
    _loadingTimers.set(id, timerId);
}

function removeLoadingMsg(id) {
    var el = document.getElementById(id);
    if(el) el.remove();
    // 自動クリアタイマーがあれば解除
    const timer = _loadingTimers.get(id);
    if (timer) {
        clearTimeout(timer);
        _loadingTimers.delete(id);
    }
}

// ---- API Integration ----
// ======== 要約プロンプト プリセット ========
// Settings → 📜 チャット要約 で選択・編集可能。
const SUMMARY_PROMPT_DEFAULT =
    'あなたはRPセッションの記録係です。会話内容を今後のロールプレイ継続に必要な情報だけ残した簡潔な要約にまとめてください。\n'
    + '\n保持すべき情報:\n'
    + '・重要な出来事と場面展開\n'
    + '・キャラクターの感情変化・関係性の変化\n'
    + '・プレイヤーの重要な選択と行動結果\n'
    + '・明かされた秘密や真実\n'
    + '・現在の状況（場所・時間・状態）\n'
    + '\n出力ルール:\n'
    + '・日本語で 300〜500 字以内。箇条書き可。\n'
    + '・ロールプレイ口調ではなく客観的な記録文体で。\n'
    + '・[SPEAKER:] [STATUS:] タグは含めないこと。\n';

// Telelynx の公開要約プロンプト（構造化・詳細）
const SUMMARY_PROMPT_TELELYNX =
    '以下の会話を下記の構造に合わせて日本語で要約してください。この要約はAIが今後の対話で文脈を把握するために使用されます。\n'
    + '\n## 会話概要\n'
    + '- **シナリオ**: [会話が起こった背景や状況を簡潔に説明]\n'
    + '- **場面設定**: [会話が発生した具体的な場所や状況]\n'
    + '\n### 主要人物\n'
    + '- **ユーザー**: [会話で現れたユーザーの特性や役割], 感情的/個人的発展: [主要な感情変化や成長]\n'
    + '- **AIキャラクター**: [AIが演じるキャラクターの特性], 感情的/個人的発展: [関係変化や感情発展]\n'
    + '\n---\n'
    + '\n## 主要な出来事\n'
    + '### テーマ: [主要な話題や出来事1]\n'
    + '- **主要ポイント**: [具体的な会話内容や行動]\n'
    + '- **関係変化**: [人物間の関係の変化]\n'
    + '- **感情変化**: [感情の変化や発展]\n'
    + '- **相互作用の影響**: [該当する相互作用が与えた影響]\n'
    + '- **呼び方の変化**: [呼び方に変化があればそのきっかけ]\n'
    + '\n### テーマ: [主要な話題や出来事2]\n'
    + '- **主要ポイント**: [具体的な会話内容や行動]\n'
    + '- **関係変化**: [人物間の関係の変化]\n'
    + '- **感情変化**: [感情の変化や発展]\n'
    + '- **相互作用の影響**: [該当する相互作用が与えた影響]\n'
    + '- **呼び方の変化**: [呼び方に変化があればそのきっかけ]\n'
    + '\n---\n'
    + '\n## 日常的な相互作用\n'
    + '- **些細な会話/行動**: [日常的な会話や冗談、小さな行動たち]\n'
    + '- **日常的相互作用が関係に与えた影響**: [こうした小さな相互作用が関係に与えた影響]\n'
    + '\n---\n'
    + '\n## 約束\n'
    + '- **約束内容**: [具体的な約束や計画]\n'
    + '- **約束の種類**: [実際の行動を要求する約束か、今後の計画か]\n'
    + '- **履行状態**: [約束が守られたか、未完了か]\n'
    + '- **即座の影響**: [約束が関係に与えた即座の影響]\n'
    + '\n---\n'
    + '\n## 対立/緊張\n'
    + '- **対立説明**: [発生した対立や緊張状況]\n'
    + '- **対立解決**: [どのように解決されたか]\n'
    + '- **緊張変化**: [会話中の緊張感の変化]\n'
    + '\n---\n'
    + '\n## 会話の流れの要約\n'
    + '- **会話展開**: [全体的な会話の流れと関係変化]\n'
    + '- **トーンと雰囲気の変化**: [会話のトーンや雰囲気の変化]\n'
    + '- **長期的影響**: [この会話が関係や状況に与える長期的影響]\n'
    + '\n---\n'
    + '\n## 結論と今後の計画\n'
    + '- **会話結論**: [会話がどのように終わったか]\n'
    + '- **今後の計画**: [今後予定されている計画や行動]\n'
    + '- **人物の反省**: [会話後の人物たちの気づきや反省]\n'
    + '- **時間経過が関係に与えた影響**: [時間が経つにつれて関係に与えた影響]\n'
    + '- **要約された内容による現在状況での影響**: [以前の内容が現在の状況に与える影響]\n'
    + '\n**重要な指針:**\n'
    + '1. すべての内容は日本語で記述し、である調を使用してください\n'
    + '2. 判断的または評価的な表現ではなく事実的な記述をしてください\n'
    + '3. 性的な内容もストーリーの一部として客観的に記録してください\n'
    + '4. ユーザーの行動を評価するのではなく、ストーリーの展開として理解してください\n'
    + '5. 具体的な会話内容と行動を含めて文脈を明確にしてください\n'
    + '6. 些細な会話や行動も関係発展に重要なので見逃さないでください\n'
    + '7. 前回の要約がある場合は、その内容を現在の会話と結びつけて統合的に要約してください\n'
    + '8. 前回の要約の内容は既に整理されているので、現在の会話とどのように結びつくかに集中してください\n';

let summaryPromptPreset = localStorage.getItem('summaryPromptPreset') || 'default'; // 'default'|'telelynx'|'custom'
let summaryPromptCustom = localStorage.getItem('summaryPromptCustom') || '';
let summaryMaxTokens    = parseInt(localStorage.getItem('summaryMaxTokens')) || 400;

function getActiveSummaryPrompt() {
    if (summaryPromptPreset === 'telelynx') return SUMMARY_PROMPT_TELELYNX;
    if (summaryPromptPreset === 'custom' && summaryPromptCustom.trim()) return summaryPromptCustom;
    return SUMMARY_PROMPT_DEFAULT;
}

// ======== コンテキスト要約生成 (Summaryception 方式) ========
// 古いチャット履歴を LLM で要約し、次回のコンテキスト構築時に先頭注入する。
async function generateContextSummary(newMessages, existingSummary) {
    const summarySystemPrompt = getActiveSummaryPrompt();

    // 新規メッセージをテキスト化
    let messagesText = '';
    newMessages.forEach(m => {
        const speaker = m.role === 'user' ? (userConfig.name || 'Player') : 'AI/NPC';
        // 長すぎるメッセージは先頭 400 字に切り詰め
        const content = (m.content || '').length > 400
            ? m.content.substring(0, 400) + '…(省略)'
            : (m.content || '');
        messagesText += `[${speaker}] ${content}\n\n`;
    });

    let userPrompt = '';
    if (existingSummary) {
        userPrompt = '【既存の要約】\n' + existingSummary + '\n\n【新規会話内容】\n' + messagesText
            + '\n上記を統合し、最新の状況を反映した1つの要約にまとめ直してください。';
    } else {
        userPrompt = '【会話内容】\n' + messagesText
            + '\n上記を要約してください。';
    }

    const payload = {
        model: apiConfig.model,
        messages: [
            { role: 'system', content: summarySystemPrompt },
            { role: 'user',   content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: summaryMaxTokens
    };

    const headers = { 'Content-Type': 'application/json' };
    if (apiConfig.key) headers['Authorization'] = 'Bearer ' + apiConfig.key;

    const response = await fetch(apiConfig.endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        console.warn('[ContextSummary] 要約生成失敗 (HTTP', response.status, ')');
        return existingSummary || ''; // フォールバック: 既存要約をそのまま返す
    }

    const data = await response.json();
    const summary = (data.choices && data.choices[0] && data.choices[0].message)
        ? data.choices[0].message.content.trim()
        : '';

    if (!summary) {
        console.warn('[ContextSummary] 要約が空のため既存を維持');
        return existingSummary || '';
    }

    console.log('[ContextSummary] 要約更新完了 (' + summary.length + '字)');
    return summary;
}

// 要約をlocalStorageに永続化
function saveContextSummary() {
    const pid = getPartyId();
    localStorage.setItem('contextSummary_' + pid, contextSummary);
    localStorage.setItem('lastSummarizedIndex_' + pid, String(lastSummarizedIndex));
}

// 要約をlocalStorageから復元
function loadContextSummary() {
    const pid = getPartyId();
    contextSummary = localStorage.getItem('contextSummary_' + pid) || '';
    lastSummarizedIndex = parseInt(localStorage.getItem('lastSummarizedIndex_' + pid)) || 0;
    // chatHistory の長さより大きい場合はリセット（データ不整合の防止）
    if (lastSummarizedIndex > chatHistory.length) {
        lastSummarizedIndex = 0;
        contextSummary = '';
    }
}

// 要約をリセット（チャットクリア時に呼ぶ）
function resetContextSummary() {
    contextSummary = '';
    lastSummarizedIndex = 0;
    saveContextSummary();
}

async function fetchChatCompletion(mode) {
    if (!apiConfig.endpoint) throw new Error("API Endpoint is missing. Please check Settings.");

    // ===== 💬 純チャットモード: RP用プロンプト注入を一切せず素のチャットを送る =====
    // Player Info / SPEAKER / クエスト / Lore / ペルソナ / directive 群をすべてバイパス。
    if (pureChatMode) {
        const msgs = [];
        if (pureChatSystemPrompt && pureChatSystemPrompt.trim()) {
            msgs.push({ role: 'system', content: pureChatSystemPrompt.trim() });
        }
        // スライディングウィンドウのみ適用（Summaryception はRP用のため使わない）
        const hist = chatHistory.length > CONTEXT_WINDOW_ENTRIES
            ? chatHistory.slice(-CONTEXT_WINDOW_ENTRIES)
            : chatHistory;
        hist.forEach(m => {
            if (m.isImage) return; // 画像エントリは送信対象外
            msgs.push({ role: (m.role === 'narrator') ? 'assistant' : m.role, content: m.content });
        });
        return _executeChatRequest(msgs);
    }

    // Banter モード時にメンバー選択オーバーライドが設定されていればそれを優先
    const isBanter = (mode === 'banter' || mode === 'banter_player');
    const members = (isBanter && Array.isArray(_banterMembersOverride) && _banterMembersOverride.length > 0)
        ? _banterMembersOverride
        : getActivePartyMembers();

    // Construct System Prompt
    let systemPrompt = '';

    if (members.length === 0) {
        // パーティなし（プレイヤー単独）モード: AIがGM/ナレーター/NPC全員を演じる
        systemPrompt = 'あなたはゲームマスターです。プレイヤー以外のすべての登場人物（NPC・ナレーション・敵・脇役）を演じてください。\n'
            + '### 必須出力フォーマット ###\n'
            + '各キャラクターの発言・行動の前に、必ず以下の形式でスピーカータグを付けてください:\n'
            + '[SPEAKER: キャラクター名]\n'
            + '地の文（ナレーション）やNPCの発言には:\n'
            + '[SPEAKER: ナレーション]\n'
            + '登場NPCの発言には [SPEAKER: NPC名] を使用してください。\n\n'
            + '### 絶対禁止事項 ###\n'
            + '- ' + userConfig.name + '（プレイヤー）のセリフ・行動・思考を絶対に生成しないでください。\n'
            + '- プレイヤーの代わりに返答を書くことは厳禁です。\n'
            + '- ※どうしてもプレイヤーの動きや反応に言及する必要がある場合は、[SPEAKER: ' + userConfig.name + '] タグは絶対に使わず、必ず [SPEAKER: ナレーション] タグで客観描写として書いてください（例:「彼は驚いて後ずさった」「その表情は…」）。\n\n'
            + '[Player Info]\n'
            + 'Name: ' + userConfig.name + '\n'
            + (userConfig.personality ? 'Personality: ' + userConfig.personality + '\n' : '')
            + (userConfig.description ? 'Description:\n' + userConfig.description + '\n' : '')
            + (userConfig.mes_example ? 'Dialogue Style:\n' + userConfig.mes_example + '\n' : '');
    } else if (members.length === 1) {
        systemPrompt = 'Write the next response for the roleplay. You are playing the role of ' + members[0].name + '. Do not break character.\n'
            + '### ABSOLUTE RULE ###\n'
            + 'NEVER write dialogue, actions, or thoughts for ' + userConfig.name + ' (the player). Only the player decides what they say or do.\n'
            + 'If you absolutely must reference the player\'s reaction or movement, use [SPEAKER: ナレーション] for objective third-person description (e.g., "He stepped back in surprise"). NEVER use [SPEAKER: ' + userConfig.name + '].\n\n'
            + '[User (Player) Info]\n'
            + 'Name: ' + userConfig.name + '\n'
            + (userConfig.personality ? 'Personality: ' + userConfig.personality + '\n' : '')
            + (userConfig.description ? 'Description:\n' + userConfig.description + '\n' : '')
            + (userConfig.mes_example ? 'Dialogue Style:\n' + userConfig.mes_example + '\n' : '')
            + '\n'
            + '[Character Info]\n'
            + 'Description:\n' + applyMacros(members[0].description, members[0].name) + '\n\n'
            + 'Personality: ' + applyMacros(members[0].personality, members[0].name) + '\n\n'
            + 'Scenario:\n' + applyMacros(members[0].scenario, members[0].name);

        if (members[0].system_prompt) {
            systemPrompt = applyMacros(members[0].system_prompt, members[0].name) + '\n\n' + systemPrompt;
        }
    } else {
        const names = members.map(m => m.name).join(', ');
        // Build dynamic example using actual character names
        const speakerExample = members.map(m =>
            `[SPEAKER: ${m.name}]\n（${m.name}のセリフや行動をここに書く）`
        ).join('\n');

        systemPrompt = 'あなたはゲームマスターとして、以下の複数キャラクターを演じてください: ' + names + '。\n'
            + '### 必須出力フォーマット ###\n'
            + '各キャラクターの発言・行動の前に、必ず以下の形式でスピーカータグを付けてください:\n'
            + '[SPEAKER: キャラクター名]\n'
            + '※キャラクター名は登録名をそのまま使ってください（英語に変換しないこと）。\n\n'
            + '地の文（ナレーション）やNPCの発言には必ず以下のタグを使ってください:\n'
            + '[SPEAKER: ナレーション]\n'
            + '（場面描写、状況説明、シナリオNPCの発言など）\n\n'
            + '例:\n'
            + '[SPEAKER: ナレーション]\n'
            + '（場面の描写や、シナリオNPCのセリフをここに書く）\n'
            + speakerExample + '\n\n'
            + (mode !== 'banter_player'
                ? '### 絶対禁止事項 ###\n'
                  + '- ' + userConfig.name + '（プレイヤー）のセリフ・行動・思考を絶対に生成しないでください。\n'
                  + '- ' + userConfig.name + ' が何を言うか、何をするかはプレイヤー自身が決めます。\n'
                  + '- プレイヤーの代わりに返答を書くことは厳禁です。\n'
                  + '- ※どうしてもプレイヤーの動きや反応に言及する必要がある場合は、[SPEAKER: ' + userConfig.name + '] タグは絶対に使わず、必ず [SPEAKER: ナレーション] タグで客観描写として書いてください（例:「ユートは弾丸を素手で受け止めた」のように三人称客観で）。\n\n'
                : '')
            + '[User (Player) Info]\n'
            + 'Name: ' + userConfig.name + '\n'
            + (userConfig.personality ? 'Personality: ' + userConfig.personality + '\n' : '')
            + (userConfig.description ? 'Description:\n' + userConfig.description + '\n' : '')
            + (userConfig.mes_example ? 'Dialogue Style:\n' + userConfig.mes_example + '\n' : '')
            + '\n';

        members.forEach(m => {
             systemPrompt += `========== [Character: ${m.name}] ==========\n`;
             if (m.system_prompt) systemPrompt += `Instruction: ${applyMacros(m.system_prompt, m.name)}\n`;
             systemPrompt += `Description: ${applyMacros(m.description, m.name)}\n`
                + `Personality: ${applyMacros(m.personality, m.name)}\n`
                + `Scenario: ${applyMacros(m.scenario, m.name)}\n`
                + `※${m.name}のセリフ・行動を書くときは、上記の設定に忠実に従ってください。\n\n`;
        });
    }
    
    // Banter mode: add special instruction
    if (mode === 'banter' && members.length >= 2) {
        const names = members.map(m => m.name).join('と');
        systemPrompt += `\n\n### 特別指示: キャラクター同士の掛け合い ###\n`
            + `${names}が自然に会話してください。ユーザーの介入はありません。\n`
            + `必ず [SPEAKER: キャラクター名] フォーマットを使い、登録名をそのまま使用してください。\n`;
    }

    // Banter with player mode: add special instruction
    if (mode === 'banter_player') {
        const allNames = [...members.map(m => m.name), userConfig.name].join('と');
        systemPrompt += `\n\n### 特別指示: 全員参加の掛け合い ###\n`
            + `${allNames}が自然に会話してください。${userConfig.name}も積極的に発言します。\n`
            + `必ず [SPEAKER: キャラクター名] フォーマットを使い、全員の発言を書いてください。\n`
            + `${userConfig.name}の発言も [SPEAKER: ${userConfig.name}] タグを付けて書いてください。\n`;
    }

    // ===== 現話者の最優先明示（往復・多人数ペルソナ切替への耐性） =====
    // banter 系（複数人が同時に喋る）以外で、直近のユーザー入力の話者 = 現プレイヤー を高優先で固定する。
    if (mode !== 'banter' && mode !== 'banter_player') {
        const _prevForSpeaker = detectPreviousPlayersInChat();
        systemPrompt += '\n\n========== 🎯 現在の話者（最優先・毎ターン固定） ==========\n';
        systemPrompt += '直近のユーザー入力は「' + userConfig.name + '」によるものである。今このターンの {{user}} ＝ プレイヤーは「' + userConfig.name + '」で固定。\n';
        if (_prevForSpeaker.length > 0) {
            systemPrompt += '⚠️ 過去ログには他のプレイヤー名（' + _prevForSpeaker.join('、') + '）が主人公として登場しているが、それらは「今この瞬間の話者ではない」。\n';
            systemPrompt += '過去ログの分量に引きずられず、現在の話者「' + userConfig.name + '」を最優先で認識すること。直前まで別名がプレイヤーだったとしても、今は「' + userConfig.name + '」である。\n';
        }
        systemPrompt += '========================================================\n';
    }

    // ======== QUEST CONTEXT INJECTION ========
    if (activeQuest && activeQuest.template) {
        const qt = activeQuest.template;
        const qs = activeQuest.state;

        // 1. AI Instructions (mandatory rules)
        if (qt.ai_instructions && qt.ai_instructions.length > 0) {
            systemPrompt += '\n\n========== クエスト指示 (必須遵守) ==========\n';
            qt.ai_instructions.forEach(instr => {
                if (instr.header) systemPrompt += `[${instr.header}]\n`;
                if (instr.content) systemPrompt += instr.content + '\n\n';
            });
            systemPrompt += '================================================\n';
        }

        // 1.5. Content Guidelines (Telelynx式ソフトルール: AI自己照合方式)
        if (qt.content_guidelines && (typeof qt.content_guidelines === 'string'
                ? qt.content_guidelines.trim()
                : (Array.isArray(qt.content_guidelines) && qt.content_guidelines.length > 0))) {
            const guidelinesText = Array.isArray(qt.content_guidelines)
                ? qt.content_guidelines.join('\n')
                : qt.content_guidelines;
            systemPrompt += '\n\n========== 描写ガイドライン（ソフトルール） ==========\n';
            systemPrompt += guidelinesText.trim() + '\n';
            systemPrompt += '\n【自己照合プロトコル】\n';
            systemPrompt += '応答本文を書く前に、<think>...</think> ブロック内でガイドラインとの整合性を簡潔に自己照合してください。\n';
            systemPrompt += '例: <think>禁止描写の有無確認 → OK。寸止めで進行。</think>\n';
            systemPrompt += '<think> ブロックは表示時に除去されるため、自由に内省可能です（プレイヤーには見えません）。\n';
            systemPrompt += '・ハードフィルタではなくAI自身による演技的自制で表現してください。\n';
            systemPrompt += '・違反しそうな展開はキャラクターの自制・回避・代替行動として描写してください。\n';
            systemPrompt += '======================================================\n';
        }

        // 2. Background + Additional Settings (always injected)
        if (qt.background) {
            systemPrompt += '\n\n========== クエスト背景 ==========\n'
                + qt.background + '\n'
                + '==================================\n';
        }
        if (qt.additional_settings && qt.additional_settings.length > 0) {
            systemPrompt += '\n========== 追加設定 ==========\n';
            qt.additional_settings.forEach(s => {
                systemPrompt += `[${s.title}] ${s.content}\n`;
            });
            systemPrompt += '==============================\n';
        }

        // 3. Current Event Progress
        if (qt.events && qt.events.length > 0) {
            const completedNames = qs.completed_events.map(eid => {
                const ev = qt.events.find(e => e.id === eid);
                return ev ? `${ev.id}. ${ev.title}` : '';
            }).filter(s => s).join(', ');

            const currentEvent = qt.events[qs.current_event_index];
            systemPrompt += '\n\n========== ストーリー進行状況 ==========\n';
            if (completedNames) {
                systemPrompt += '完了済みイベント: ' + completedNames + '\n';
            }
            if (currentEvent) {
                systemPrompt += `現在のイベント: ◇ ${currentEvent.id} ${currentEvent.title}\n`;
                systemPrompt += `内容: ${currentEvent.content}\n`;
                systemPrompt += '※このイベントの内容に沿って物語を進めてください。\n';
            }
            const nextEvent = qt.events[qs.current_event_index + 1];
            if (nextEvent) {
                systemPrompt += `次のイベント（予告のみ、先走らないこと）: ◇ ${nextEvent.id} ${nextEvent.title}\n`;
            }
            systemPrompt += '========================================\n';
        }

        // 4. Revealed Hidden Truths (only revealed ones)
        if (qt.hidden_truths && qt.hidden_truths.length > 0) {
            const revealed = qt.hidden_truths.filter(t => qs.revealed_truths.includes(t.id));
            if (revealed.length > 0) {
                systemPrompt += '\n\n========== 公開された真実 (物語に織り込むこと) ==========\n';
                revealed.forEach(t => {
                    systemPrompt += `[${t.title}] ${t.content}\n`;
                });
                systemPrompt += '========================================================\n';
            }
        }

        // 4b. Status Parameters (per-character, individually defined)
        // ===== 型ごとに明確に分離して提示（Gemma3 等が fixed を誤って STATUS タグに含めるのを防ぐ）=====
        const csp = qt.char_status_params || [];
        if (csp.length > 0 && csp.some(e => e.params && e.params.length > 0)) {
            const sv = qs.status_values || {};
            systemPrompt += '\n\n========== ステータスパラメーター（キャラクター個別設定） ==========\n';
            systemPrompt += 'このシナリオでは各キャラクターが独自のパラメーターを持ちます。\n';
            systemPrompt += 'パラメーターは下記の通り「STATUS タグで操作可能なもの」と「参照専用（操作禁止）」に明確に分かれます。\n';
            systemPrompt += 'パラメーターの値はキャラクターの感情・行動・判定に影響します。現在値を演技に反映してください。\n\n';

            csp.forEach(charEntry => {
                const cn = charEntry.character;
                if (!cn || !charEntry.params || charEntry.params.length === 0) return;

                const variableParams = charEntry.params.filter(p => p.type !== 'fixed' && p.type !== 'clock');
                const clockParams    = charEntry.params.filter(p => p.type === 'clock');
                const fixedParams    = charEntry.params.filter(p => p.type === 'fixed');

                systemPrompt += `═══ 【${cn}】 ═══\n`;

                // ▼ 操作可能（STATUS タグで増減）
                if (variableParams.length > 0 || clockParams.length > 0) {
                    systemPrompt += `[A] ★ STATUS タグで操作可能 ★\n`;
                    variableParams.forEach(p => {
                        const cur = (sv[cn] && typeof sv[cn][p.name] === 'number') ? sv[cn][p.name] : p.initial_value;
                        systemPrompt += `  ・${p.name}（変動・-100〜100、現在: ${cur}）: ${p.description || '(説明なし)'}\n`;
                    });
                    clockParams.forEach(p => {
                        const cur = (sv[cn] && typeof sv[cn][p.name] === 'number') ? sv[cn][p.name] : p.initial_value;
                        const m = ((cur % 1440) + 1440) % 1440;
                        const hh = String(Math.floor(m / 60)).padStart(2, '0');
                        const mm = String(m % 60).padStart(2, '0');
                        systemPrompt += `  ・${p.name}（時刻・24h制、現在: ${hh}:${mm}）: ${p.description || '(説明なし)'}\n`;
                    });
                    // 出力例
                    const examples = [];
                    if (variableParams.length > 0) examples.push(...variableParams.slice(0, 2).map(p => `${p.name}=+5`));
                    if (clockParams.length > 0) examples.push(`${clockParams[0].name}=+30`);
                    if (examples.length > 0) {
                        systemPrompt += `  → 出力例（発言末尾）: [STATUS: ${examples.join(', ')}]\n`;
                    }
                }

                // ▼ 参照専用（操作禁止）— 物理的に隔離して明示
                if (fixedParams.length > 0) {
                    systemPrompt += `[B] ⛔ 参照専用・絶対に STATUS タグに含めないこと ⛔\n`;
                    fixedParams.forEach(p => {
                        const cur = (sv[cn] && typeof sv[cn][p.name] === 'number') ? sv[cn][p.name] : p.initial_value;
                        systemPrompt += `  ・${p.name}（固定値: ${cur}）: ${p.description || '(説明なし)'}\n`;
                    });
                    systemPrompt += `  → これらは読み取りのみ。STATUS タグに「${fixedParams[0].name}=+N」等を書くと完全に無視されます（仕様上の安全装置）。\n`;
                }
                systemPrompt += '\n';
            });
            systemPrompt += '【出力形式の重要ルール】\n';
            systemPrompt += '・各キャラクターの発言ブロックの末尾に [STATUS: パラメーター名=増減値, ...] を1行追加してください（変動・時刻パラメーターのみ）。\n';
            systemPrompt += '・増減値は "+N" または "-N" の形式（現在値は書かない）。変化なしのパラメーターは省略可。\n';
            systemPrompt += '・変動値域は -100〜100、時刻は分単位（24h でラップ）。UI 側で自動処理されます。\n';
            systemPrompt += '・【固定・判定基準】のパラメーターは絶対に STATUS タグに含めないでください（書かれても無視されます）。\n';
            systemPrompt += '・そのキャラクターに定義されていないパラメーターは書かないでください。\n';
            systemPrompt += '・会話の流れや行動に応じて自然な変動値を（普段 ±1〜±10、強い感情時 ±10〜±25 目安）。\n';
            systemPrompt += '・時刻は場面の所要時間に応じて自然に進めてください（短い会話 +5〜10分、ゆっくり休憩 +30〜60分、移動 +15〜30分など）。\n';
            systemPrompt += '・[SPEAKER: 名前] タグがある場合、それぞれのブロック末尾に付けてください。\n';
            systemPrompt += '====================================================================\n';
        }

        // 4c. Dice Roll Instructions (when dice_enabled)
        if (qt.dice_enabled) {
            systemPrompt += '\n\n========== ダイスロール判定ルール ==========\n';
            systemPrompt += 'このシナリオはTRPG風のダイス判定を用います。\n';
            systemPrompt += '・判定方式は 1D10 ロールアンダー（補正後の出目 ≤ ステータス値で成功、超過で失敗）。\n';
            systemPrompt += '・判定が必要な場面では `[判定要求: ステータス=<名前>, 基準値=N, 補正=±0]` のように明示してください。\n';
            systemPrompt += '・補正は「出目への±」で表現します（ステータス値を変えるのではなく出目を増減する）。\n';
            systemPrompt += '  有利状況（奇襲・援護・準備万端）→ 補正=-N（出目を下げる=成功しやすい）。\n';
            systemPrompt += '  不利状況（疲労・負傷・動揺）   → 補正=+N（出目を上げる=失敗しやすい）。\n';
            systemPrompt += '  例：器用=8で奇襲有利の場合 → 補正=-1（出目-1 適用。7出たら6として判定→成功）。\n';
            systemPrompt += '  例：器用=8で疲労不利の場合 → 補正=+1（出目+1 適用。7出たら8として判定→成功ギリギリ）。\n';
            systemPrompt += '  補正の符号と理由は必ず明示し、絶対に逆の符号を使わないこと。\n';
            systemPrompt += '・プレイヤーは `/roll 1d10` でロールしますが、RP本文と併記することも可能です。\n';
            systemPrompt += '・プレイヤーメッセージに `[DICE_RESULT: NdX = <値>]` マーカーが含まれる場合は\n';
            systemPrompt += '  それを判定結果として採用し、RP本文と辻褄を合わせて描写してください。\n';
            systemPrompt += '・クリティカル（1）・ファンブル（最大値）は演出的に強調してください。\n';
            systemPrompt += '============================================\n';
        }

        // 5. Prologue handling
        if (mode === 'quest_prologue' && qt.prologue_overview) {
            systemPrompt += '\n\n========== プロローグ生成指示 ==========\n'
                + '以下の概要に基づいて、クエストの冒頭シーンを生成してください。\n'
                + 'パーティ構成に合わせた描写をしてください。\n\n'
                + qt.prologue_overview + '\n'
                + '========================================\n';
        }
    }

    // ── プレイヤーノート注入（Lorebook 直前 = 重要度高）──
    // Global: userConfig.player_note  / Quest: activeQuest.state.player_note
    {
        const globalNote = (userConfig.player_note || '').trim();
        const questNote = (activeQuest && activeQuest.state && activeQuest.state.player_note)
            ? activeQuest.state.player_note.trim() : '';
        if (globalNote || questNote) {
            systemPrompt += '\n\n========== PLAYER NOTES (user-authored memory / must respect) ==========\n';
            systemPrompt += 'これはユーザーが手書きで維持している補足メモです。物語・キャラクター記憶・設定の優先順位は最高です。\n';
            systemPrompt += 'ここに書かれた事実は必ず尊重し、矛盾する描写は避けてください。\n';
            if (globalNote) {
                systemPrompt += '\n--- Global Note (全チャット共通) ---\n' + globalNote + '\n';
            }
            if (questNote) {
                systemPrompt += '\n--- Quest Note (このクエスト固有) ---\n' + questNote + '\n';
            }
            systemPrompt += '========================================================================\n';
        }
    }

    // ===== 応答品質メタルール（案C: 矛盾解決 ／ 案D: 前パターン避け ／ 案B: 応答長） =====
    {
        const lengthDirectives = {
            short:  '【応答長: 短め】2〜4文または1〜2段落で簡潔に応答すること。展開速度を優先し、冗長な描写・繰り返しは省く。',
            medium: '【応答長: 標準】1〜3段落程度。描写と展開のバランスを取ること。',
            long:   '【応答長: 詳細】4段落以上を目安に。情景・感情・世界観の細部を丁寧に掘り下げること。'
        };
        systemPrompt += '\n\n========== 応答品質ルール (必須遵守) ==========\n';
        systemPrompt += '【前パターン避け】直前の応答と同じ文章の出だし・語尾・展開構成・比喩を繰り返さないこと。毎ターン新鮮な語り口・視点で描写する。\n';
        systemPrompt += '【矛盾解決優先順位】Player Notes > キャラクター個別設定 > クエスト設定 > 一般描写。矛盾が生じた場合は上位情報を優先し、下位情報は自然に再解釈する。絶対に設定の矛盾を放置しないこと。\n';
        systemPrompt += (lengthDirectives[responseLength] || lengthDirectives['medium']) + '\n';
        systemPrompt += '================================================\n';
    }

    // ===== Info Panel モード（Telelynx式・状況サマリ） =====
    if (infoPanelEnabled) {
        const questTemplate = (activeQuest && activeQuest.template && activeQuest.template.info_panel_template)
            ? activeQuest.template.info_panel_template.trim()
            : '';

        systemPrompt += '\n\n========== Info Panel モード ==========\n';
        systemPrompt += '応答の最末尾に必ず [INFO] ブロックを付与してください。これは「現在の状況サマリ」として専用UIに表示されます。\n';
        systemPrompt += '本文・STATUSタグ・CHOICES の後、出力の最後に配置すること。\n\n';
        systemPrompt += '[INFO]\n';
        if (questTemplate) {
            systemPrompt += questTemplate + '\n';
        } else {
            // テンプレ未定義時の基本セクション（AI 任せ）
            systemPrompt += '【現在の状況】\n';
            systemPrompt += '日時: [年月日 時刻] | 場所: [現在地] | 周囲: [周辺の状況・空気]\n\n';
            systemPrompt += '【ユーザーの情報】\n';
            systemPrompt += '所属: [所属組織] | 地位: [立場] | 状態: [心身の状態]\n\n';
            systemPrompt += '【登場キャラ】\n';
            systemPrompt += '[キャラ名] - [簡単な現在の状況・行動] | ...\n\n';
            systemPrompt += '（その他、シナリオに応じて【組織関係】【捕縛キャラ】【離脱キャラ】等のセクションを適宜追加してよい）\n';
        }
        systemPrompt += '[/INFO]\n\n';
        systemPrompt += '【Info Panel ルール】\n';
        systemPrompt += '・各セクションは【】で囲み、コンパクトな1〜2行で書くこと。冗長な散文は避ける。\n';
        systemPrompt += '・同じ項目内の複数情報は「 | 」（縦棒空白）で区切ること（例: "場所: A | 周囲: B"）。\n';
        systemPrompt += '・登場キャラには絵文字（🌹🔥💀⚔️等）を付けると視認性が上がる（任意）。\n';
        systemPrompt += '・前回の Info Panel から状況が変わっていなくても、必ず最新版を出力すること（パネルは毎回上書きされる）。\n';
        systemPrompt += '・本文中には [INFO]...[/INFO] タグを使わないこと（最後に1つだけ）。\n';
        systemPrompt += '==========================================\n';
    }

    // ===== 末尾選択肢生成モード（Telelynx式インスパイア） =====
    if (showChoices) {
        systemPrompt += '\n\n========== 末尾選択肢生成モード ==========\n';
        systemPrompt += '応答本文の最後に必ず以下のフォーマットで 2〜3 個の選択肢を提示してください。\n';
        systemPrompt += '選択肢はプレイヤー（' + userConfig.name + '）の次の行動候補を示し、それぞれ性質が異なるものを提案します。\n\n';
        systemPrompt += '[CHOICES]\n';
        systemPrompt += '1. 選択肢A（穏当・自然な選択）\n';
        systemPrompt += '2. 選択肢B（積極的・大胆な選択）\n';
        systemPrompt += '3. 選択肢C（意外性・リスクのある選択）\n';
        systemPrompt += '[/CHOICES]\n\n';
        systemPrompt += '【選択肢ルール】\n';
        systemPrompt += '・選択肢は本文・STATUSタグの全てが終わった最後に配置してください。\n';
        systemPrompt += '・プレイヤー視点の行動文として書く（例:「彼女に詳しく聞く」「黙ってその場を離れる」）。1行20〜30字目安。\n';
        systemPrompt += '・選択肢同士で内容を被らせない。3択なら3つの異なる方向性を示す。\n';
        systemPrompt += '・プレイヤーは選択肢から選んでも、自由入力で別の行動を取っても構いません。選択肢はあくまで提案です。\n';
        systemPrompt += '・描写ガイドラインがある場合、選択肢にも自制系の選択肢を1つ含めてバランスを取ること。\n';
        systemPrompt += '・🚨 必ず [CHOICES] で始め [/CHOICES] で閉じること。閉じタグを省略しないこと。\n';
        systemPrompt += '・Info Panel モードと併用する場合、[INFO]...[/INFO] ブロックの後に [CHOICES] を置くこと。\n';
        systemPrompt += '====================================================\n';
    }

    // ===== 音声読み上げ用の記法ルール（自動読み上げ ON 時のみ） =====
    // セリフと強調で同じ「」を使うと TTS が両方読んでしまうため、書き分けを促す。
    if (autoplayTts) {
        systemPrompt += '\n\n========== 音声読み上げ用の記法ルール ==========\n';
        systemPrompt += '音声合成(TTS)が有効です。読み上げ対象を明確にするため、次の書き分けを必ず守ってください。\n';
        systemPrompt += '・キャラクターが実際に声に出す【セリフ】だけを「」で囲む（読み上げられるのはこの中身のみ）。\n';
        systemPrompt += '・心の声・モノローグ・強調したい語句は「」を使わず、（）で囲むか ※ を付ける（読み上げ対象外）。\n';
        systemPrompt += '・ナレーション・地の文・動作描写は「」で囲まない（そのまま地の文として書く）。\n';
        systemPrompt += '例: 彼女は（本当は怖い……）と思いながらも「大丈夫、行こう」と笑ってみせた。\n';
        systemPrompt += '  → 読み上げは「大丈夫、行こう」のみになる。\n';
        systemPrompt += '================================================\n';
    }

    // ===== 🖼️ 事前登録画像タグ（Layer 2: LLM がタグで画像を呼ぶ） =====
    // 全件を毎回渡すとコンテキストを食うため、登場中キャラのタグに絞り、件数上限も設ける。
    if (imageLibraryEnabled && imageCatalog.length > 0) {
        const activeNames = members.map(m => m.name);
        const usable = imageCatalog.filter(e =>
            e.tag && e.layer !== 'state' && (!e.character || activeNames.includes(e.character))
        );
        if (usable.length > 0) {
            const listed = usable.slice(0, Math.max(1, imageTagInjectMax));
            systemPrompt += '\n\n========== 画像タグ（使用可能な画像） ==========\n';
            systemPrompt += '場面や表情に合う画像がある場合、応答本文中に {img:タグ名} と書くとその画像が表示されます。\n';
            systemPrompt += '・1応答につき最大 ' + Math.max(1, imageMaxPerTurn) + ' 個まで。ふさわしい画像が無ければ使わなくてよい。\n';
            systemPrompt += '・タグは下記リストから厳密に選ぶこと（リストにないタグは無視されます）。\n';
            systemPrompt += '・タグは本文の流れの中に自然に置くこと（読者にはタグ自体は見えません）。\n\n';
            listed.forEach(e => {
                systemPrompt += '{img:' + e.tag + '}'
                    + (e.description ? ' — ' + e.description : '')
                    + (e.character ? '（' + e.character + '）' : '')
                    + '\n';
            });
            systemPrompt += '================================================\n';
        }
    }

    // ===== NPC 発言保証（複数キャラ・非banter時のみ） =====
    // 全 NPC を毎ターン喋らせると重い。シーン中心の最大 N 人だけ最低一言を促す。
    if (npcMinDialogueEnabled && members.length >= 2 && mode !== 'banter' && mode !== 'banter_player') {
        const n = Math.max(1, Math.min(npcDialogueMax || 3, members.length));
        systemPrompt += '\n\n========== NPC 発言保証（シーン中心人物のみ） ==========\n';
        systemPrompt += '登録 NPC は ' + members.length + ' 人いるが、1ターンで全員を登場させる必要はない（むしろ避けること）。\n';
        systemPrompt += 'このターンのシーンに直接関わる NPC を最大 ' + n + ' 人だけ選び、その選んだ NPC には最低一言の発言または明確な反応を必ず描写すること（名前だけの棒立ち・存在の無視を避ける）。\n';
        systemPrompt += 'シーンに無関係・その場にいない NPC は無理に登場させず、言及もしないこと（コンテキスト節約のため）。\n';
        systemPrompt += '誰を中心にするかは直近の文脈（話しかけられた相手・その場にいる人物・話題の対象）から自然に判断する。\n';
        systemPrompt += '====================================================\n';
    }

    // ===== 完全自由空間モード directive 群 =====
    // 親トグル freeWorldEnabled が ON のときのみ、有効化されたサブ機能ごとに directive を注入
    if (freeWorldEnabled) {
        // チートモード検出: 世界観に「チートモード」が含まれていれば Mary Sue 防止を強制 OFF
        const cheatActive = isCheatModeActive();

        if (marySuePrevention && !cheatActive) {
            systemPrompt += '\n\n========== メアリー・スー防止モード ==========\n';
            systemPrompt += 'プレイヤー（' + userConfig.name + '）は原作世界の住人と同等以下の能力を持つ「ごく自然な存在」として扱ってください。\n\n';
            systemPrompt += '必須:\n';
            systemPrompt += '・プレイヤーが世界バランスを壊す行動（無双・無敵・神能力的な振る舞い）を取ろうとしたら、AIは失敗描写・別解釈・周囲の反発などで自然に抑制してください。\n';
            systemPrompt += '・原作世界の NPC は経験・知識・能力でプレイヤーより常に優位、または同等であるよう描写してください。\n';
            systemPrompt += '・ただし、努力・工夫・関係性の積み重ねによる成長は許容してください（「最初から最強」を抑制するのが目的）。\n';
            systemPrompt += '・プレイヤーの設定で明示的に超能力等が記載されている場合は、そちらを優先しつつ、世界観への影響を抑える描写を心がけてください。\n';
            systemPrompt += '========================================\n';
        } else if (marySuePrevention && cheatActive) {
            // チートモード明示時: Mary Sue 防止をスキップし、AI に「自由演出」を促す
            systemPrompt += '\n\n========== チートモード（Mary Sue 防止無効） ==========\n';
            systemPrompt += '世界観に「チートモード」が指定されています。プレイヤー（' + userConfig.name + '）が世界バランスを超える能力・行動を取ることを許容してください。\n';
            systemPrompt += '無双・最強・神視点等の演出を抑制せず、プレイヤーの希望どおりの強さで描写してください。\n';
            systemPrompt += '================================================\n';
        }
        if (realismMode) {
            systemPrompt += '\n\n========== リアル判定モード ==========\n';
            systemPrompt += 'プレイヤーの行動は思い通りに成功するとは限りません。以下を考慮して結果を描写してください:\n';
            systemPrompt += '・緊張・恐怖 → 動作が震える、声が出ない、判断が鈍る\n';
            systemPrompt += '・疲労・空腹 → 集中力低下、息切れ、ミス増加\n';
            systemPrompt += '・経験不足 → 未知の領域では失敗確率が高い\n';
            systemPrompt += '・環境 → 暗闇・雨・人混みは行動を阻害する\n';
            systemPrompt += '「思い通りにならないもどかしさ」が物語の没入感となるよう、適度な困難や失敗描写を自然に演出してください。\n';
            systemPrompt += '困難を乗り越えた時の喜びが格別なものになるよう、緩急のあるロールプレイを心がけること。\n';
            systemPrompt += '================================\n';
        }
        if (livingWorldEnabled) {
            systemPrompt += '\n\n========== 生きている世界モード ==========\n';
            systemPrompt += 'この世界はプレイヤーを待つ書割ではありません。プレイヤーが何もしなくても、NPC同士は会話し、街では事件が起き、時間は流れます。\n';
            systemPrompt += '描写時に「今この瞬間、別の場所で起きていそうな出来事」をさりげなく挿入してよいです（例:「遠くで子供の声が聞こえる」「街の中央で何やら騒ぎが起きているようだ」）。\n';
            systemPrompt += 'NPC は自分の生活・予定・秘密を持っており、プレイヤーの相手をするためだけに存在するわけではありません。\n';
            systemPrompt += 'プレイヤーが何度も顔を合わせる過程で関係が変化するよう、最初は素っ気ない NPC も徐々に打ち解けるなど時間の流れを意識した関係性を描いてください。\n';
            systemPrompt += '================================\n';
        }
        // ===== Universe Report (初回テンプレ入力時の確認) =====
        if (universeReportEnabled) {
            // 直近のユーザーメッセージにテンプレ構造が含まれているかチェック
            const lastUserMsg = (() => {
                for (let i = chatHistory.length - 1; i >= 0; i--) {
                    if (chatHistory[i].role === 'user') return chatHistory[i].content || '';
                }
                return '';
            })();
            const hasTemplate = /#世界観[:：]|#user設定|#初期状況[:：]/.test(lastUserMsg);
            // 過去にすでに Universe Report を返したかチェック（chatHistory に "Universe Report" を含む assistant 応答があれば既出と判定）
            const alreadyReported = chatHistory.some(m =>
                m.role === 'assistant' && /Universe Report/.test(m.content || '')
            );
            if (hasTemplate && !alreadyReported) {
                systemPrompt += '\n\n========== Universe Report モード (初回確認) ==========\n';
                systemPrompt += 'ユーザーが初回のテンプレート入力（#世界観 / #user設定 / #初期状況）を送信しました。\n';
                systemPrompt += '**物語の本編を始める前に**、まず以下の形式で「Universe Report」を返してください。\n';
                systemPrompt += '本編シーン描写・NPC のセリフ等は Universe Report の後ろに**書かないこと**。本編開始はユーザーが追加情報や OK を返した次のターン以降です。\n\n';
                systemPrompt += '【出力フォーマット】（バッククォート三連で囲むこと）\n';
                systemPrompt += '```Universe Report\n';
                systemPrompt += '🌎️世界観: [認識した作品名・世界観]\n';
                systemPrompt += '📓学習量: [高い / 中程度 / 低い / ほぼ知識なし] ※ あなたがこの作品をどれくらい知っているかを正直に申告\n';
                systemPrompt += '🎥核心ストーリー: [この作品の核心を2〜3文で要約]\n';
                systemPrompt += '💡確認および調整リクエスト:\n';
                systemPrompt += '- [ユーザー設定の解釈と確認 - 特に原作にない要素]\n';
                systemPrompt += '- [曖昧な点・追加情報が欲しい点（オリジナル能力の効果、所属の予定、出会いの順序など）]\n';
                systemPrompt += '- [世界観と user 設定の整合性確認]\n';
                systemPrompt += '```\n\n';
                systemPrompt += 'この設定でシミュレーションを開始しますか？\n';
                systemPrompt += '[具体的に追加質問があればここに自然な日本語で記載]\n\n';
                systemPrompt += '【ルール】\n';
                systemPrompt += '・学習量は正直に申告すること。知識が曖昧なら「低い」「ほぼ知識なし」と書くこと（誤情報を装うより遥かに価値がある）。\n';
                systemPrompt += '・学習量「低い」「ほぼ知識なし」と申告した場合、自動で Web Search が走り結果が AI Memo に記録されます（ユーザー操作不要）。\n';
                systemPrompt += '・原作と矛盾する独自設定（オリジナル能力など）があれば、それを尊重しつつ詳細を質問する。\n';
                systemPrompt += '・Universe Report の後はユーザーの追加情報・OK を待つこと。先走って本編を開始しないこと。\n';
                systemPrompt += '・[SPEAKER: ...] タグは Universe Report ターンでは使わなくてよい（本編ではないため）。\n';
                systemPrompt += '====================================================\n';
            }
        }
    }

    // ===== プレイヤー切替後コンテキスト注釈 (B) =====
    // chatHistory に旧プレイヤー名の [SPEAKER:] が残っていれば、それを「別人」と明示する。
    // 旧プレイヤーが現在 NPC として登録されていれば、NPC の設定どおりに独立した存在として演じさせる。
    const _prevPlayers = detectPreviousPlayersInChat();
    if (_prevPlayers.length > 0) {
        systemPrompt += '\n\n========== プレイヤー切替後コンテキスト（最重要・必ず遵守） ==========\n';
        systemPrompt += 'このチャットでは過去にプレイヤーが演じていたキャラクターが変更されています。\n';
        systemPrompt += '【旧プレイヤー（過去ログに登場）】: ' + _prevPlayers.join('、') + '\n';
        systemPrompt += '【現プレイヤー（{{user}} = 現在の操作キャラ）】: ' + userConfig.name + '\n\n';
        systemPrompt += '遵守事項:\n';
        systemPrompt += '・上記の旧プレイヤー名と現プレイヤー名は完全に「別人」として扱うこと。\n';
        systemPrompt += '・過去ログ内の [SPEAKER: ' + _prevPlayers[0] + '] 等のブロックは当時の主人公の独白・行動であり、現プレイヤー「' + userConfig.name + '」の記憶ではない。\n';
        systemPrompt += '・「' + _prevPlayers[0] + '（' + userConfig.name + '）」「' + userConfig.name + '＝' + _prevPlayers[0] + '」のような同一視・合体ラベルは絶対に作成しないこと。\n';
        systemPrompt += '・旧プレイヤー名が現在 NPC キャラクターとして登録されている場合は、そのキャラクター設定（Description/Personality/Scenario）どおりに独立した存在として演じること。プレイヤーとは別人格として描写する。\n';
        systemPrompt += '・現プレイヤー「' + userConfig.name + '」の発言・行動・思考はプレイヤー自身が決めるため、AIが生成してはならない（既存の絶対禁止事項と同じ）。\n';
        systemPrompt += '====================================================================\n';
    }

    // ===== ペルソナ・モード（{{user}}の多面性） =====
    if (personaModeEnabled) {
        systemPrompt += '\n\n========== ペルソナ・モード（' + userConfig.name + 'の多面性） ==========\n';
        systemPrompt += 'プレイヤー（' + userConfig.name + ' = {{user}}）は単一人物だが、状況により複数のペルソナ（見せる顔）を使い分ける。\n';
        systemPrompt += 'これらは「別人」ではなく同一人物の異なる側面である。合体ラベルや別人扱いをしないこと。\n\n';
        if (personaDefinitions && personaDefinitions.trim()) {
            systemPrompt += '【ペルソナ定義（ユーザー設定）】\n';
            systemPrompt += personaDefinitions.trim() + '\n\n';
        } else {
            systemPrompt += '【ペルソナ定義】明示的な定義はないため、一人称・呼称の変化から自然にペルソナを推測すること。\n\n';
        }
        systemPrompt += '【判別ルール（必ず遵守）】\n';
        systemPrompt += '① 一人称・呼称で自動判別: ユーザーの一人称（私／僕など）やキャラへの呼称が変わったら、対応するペルソナに切り替わったと解釈し、そのトーンに合わせて NPC を応答させる。\n';
        systemPrompt += '② 1メッセージ内はペルソナ固定: ペルソナ切替の検知はユーザーメッセージの冒頭でのみ行う。1つのメッセージ内で途中から呼び方が変わっても、そのターンは冒頭のペルソナのまま扱い、混乱しないこと。\n';
        systemPrompt += '③ 地の文トーン統一: ペルソナによる差は NPC のセリフ・態度・関係性の温度に反映するに留め、ナレーション（地の文）の語り口・文体は常に統一すること。切替時の違和感をなくす。\n';
        systemPrompt += '④ 明示タグ優先: ユーザーが [ペルソナ名] のように冒頭で明示した場合は、それを最優先で採用する（例: 「[春姉さん] おはよう」なら春姉さんペルソナ）。\n';
        systemPrompt += '====================================================\n';
    }

    // ===== Web Search Results 注入 (sendMessage で事前検索された場合のみ) =====
    if (_pendingWebSearchInjection) {
        systemPrompt += _pendingWebSearchInjection;
        _pendingWebSearchInjection = ''; // 一度きり: 後続呼び出しへ漏らさない
        // Web Search が走った時、AI Memo 有効なら強めに「必ず [MEMO:] で記録せよ」と命令
        if (aiMemoEnabled) {
            systemPrompt += '\n\n🚨 上の検索結果は重要な世界観情報です。**必ず**応答内のどこかに [MEMO: 内容] タグで核心事実を1つ以上記録してください（タグはユーザー表示時に除去）。\n';
            systemPrompt += '例: [MEMO: ロザリオとバンパイア主要キャラ: 赤夜萌香(吸血鬼), 黒乃胡夢(サキュバス), 仙童紫(魔女), 白雪みぞれ(雪女), 朱染心愛(人間)]\n';
        }
    }

    // ===== AI Memo 注入 =====
    const aiMemoInjection = formatAiMemoForPrompt();
    if (aiMemoInjection) systemPrompt += aiMemoInjection;

    // Lorebook (Dynamic Knowledge Injection) - MOVED TO THE END FOR HIGHER WEIGHT
    const activeLore = [
        ...members.flatMap(m => m.lorebook || []),
        ...commonLorebook
    ];

    if (activeLore.length > 0) {
        // Scan last 10 messages + current user input for keyword matches
        const lastMsgs = chatHistory.slice(-10);
        const scanText = lastMsgs.map(m => m.content).join(' ').toLowerCase();

        if (scanText.trim()) {
            let loreInjected = '';
            const usedKeys = new Set();

            activeLore.forEach(entry => {
                if (!entry.key) return;
                // Support comma-separated keywords (e.g. "魔法の森,Magic Forest")
                const keywords = entry.key.split(',').map(k => k.trim()).filter(k => k);
                const matched = keywords.some(kw => scanText.includes(kw.toLowerCase()));
                if (matched && !usedKeys.has(entry.key)) {
                    loreInjected += `[LORE: ${entry.key}]\n${entry.content}\n\n`;
                    usedKeys.add(entry.key);
                }
            });
            if (loreInjected) {
                systemPrompt += '\n\n========== WORLD LORE (ABSOLUTE TRUTH - YOU MUST FOLLOW) ==========\n'
                    + 'These are established facts of this world. You MUST incorporate them into your response.\n'
                    + 'Contradicting these facts is strictly forbidden.\n\n'
                    + loreInjected
                    + '====================================================================\n';
            }
        }
    }

    // For banter mode, add a user message to trigger the AI

    // ── スライディングウィンドウ ＋ コンテキスト要約（Summaryception方式）──
    // chatHistory本体は変更せず、API送信用にのみ末尾Nエントリに絞る。
    // トリミングされた古いメッセージはLLMで要約し、先頭に注入して長期記憶を維持する。
    const totalEntries = chatHistory.length;
    const isTrimmed = totalEntries > CONTEXT_WINDOW_ENTRIES;
    const trimPoint = isTrimmed ? (totalEntries - CONTEXT_WINDOW_ENTRIES) : 0;
    const trimmedHistory = isTrimmed
        ? chatHistory.slice(-CONTEXT_WINDOW_ENTRIES)
        : chatHistory;

    // 要約の更新判定: 新たにトリミングされるメッセージが閾値以上あれば要約を再生成
    if (isTrimmed && trimPoint > lastSummarizedIndex + SUMMARY_MIN_NEW_MESSAGES && !_isSummarizing) {
        _isSummarizing = true;
        try {
            const newMsgsToSummarize = chatHistory.slice(lastSummarizedIndex, trimPoint);
            console.log(`[ContextSummary] 要約更新開始: ${newMsgsToSummarize.length}件の新規メッセージ (idx ${lastSummarizedIndex}→${trimPoint})`);
            contextSummary = await generateContextSummary(newMsgsToSummarize, contextSummary);
            lastSummarizedIndex = trimPoint;
            saveContextSummary();
            refreshSummaryPanelIfOpen(); // 📜 ビューアが開いていればライブ更新
        } catch (e) {
            console.warn('[ContextSummary] 要約生成エラー:', e.message);
            // フォールバック: 既存の要約をそのまま使う（または空）
        } finally {
            _isSummarizing = false;
        }
    }

    if (isTrimmed) {
        console.log(`[Context Trim] ${totalEntries}件中、直近${CONTEXT_WINDOW_ENTRIES}件のみ送信` +
            (contextSummary ? ` + 要約(${contextSummary.length}字)` : ' (要約なし)'));
    }

    // 古い履歴の要約を先頭に注入
    let rawHistory;
    if (isTrimmed && contextSummary) {
        rawHistory = [
            { role: 'user',      content: '[以下はこれまでの会話の要約です。この要約を踏まえ、直近の会話から自然に続けてください。]\n\n' + contextSummary },
            { role: 'assistant', content: '[了解。要約を把握しました。直近の会話に合わせて応答します。]' },
            ...trimmedHistory
        ];
    } else if (isTrimmed) {
        rawHistory = [
            { role: 'user',      content: '[これ以前にも会話の経緯があります。現在の場面から続けてください。]' },
            { role: 'assistant', content: '[了解しました。]' },
            ...trimmedHistory
        ];
    } else {
        rawHistory = trimmedHistory;
    }

    // ナレーションエントリ（role: 'narrator'）をassistantメッセージに変換し、
    // 送信に不要なフィールド（alternatives / statusSnapshot / isImage 等）を削ぐ。
    // 余計なフィールドはモデル側が無視する筈だがペイロード肥大化を防ぐため明示的に剥がす。
    const historyWithContext = rawHistory.map(m => {
        if (m.role === 'narrator') {
            return { role: 'assistant', content: `(${narratorConfig.name}・場面描写): ${m.content || ''}` };
        }
        // 画像エントリは LLM へは「シーン画像（プロンプト: ...）」として簡易テキスト化
        if (m.isImage) {
            return { role: 'assistant', content: '[シーン画像が表示されました]' };
        }
        return { role: m.role, content: m.content || '' };
    });

    var messages = [
        { role: 'system', content: systemPrompt },
        ...historyWithContext
    ];

    // 指示付き再生成: 履歴末尾に「再生成指示」を user role で追加
    // （直前の assistant 応答は regenerateLastResponse 側で一時的に取り除かれているため、
    //   末尾は user 発言になっている前提。指示はその発言を補強する形で追加する。）
    if (_pendingRegenGuidance && _pendingRegenGuidance.trim()) {
        messages.push({
            role: 'user',
            content: '[再生成指示] 直前のあなたの応答を以下の指示に従って書き直してください。文体や形式（[SPEAKER:] [STATUS:] タグ等）は維持しつつ、内容のみ修正してください。\n\n指示:\n' + _pendingRegenGuidance.trim()
        });
        console.log('[Guided Regen] 指示付き再生成を実行:', _pendingRegenGuidance.slice(0, 100));
    }

    if (mode === 'banter') {
        messages.push({ role: 'user', content: `[システム: ${members.map(m => m.name).join('と')}が自由に会話してください。プレイヤーは見守っています。]` });
    }
    if (mode === 'banter_player') {
        const allNames = [...members.map(m => m.name), userConfig.name].join('と');
        messages.push({ role: 'user', content: `[システム: ${allNames}が自由に会話してください。${userConfig.name}も会話参加者です。全員の発言を [SPEAKER: 名前] タグ付きで生成してください。]` });
    }
    
    return _executeChatRequest(messages);
}

/**
 * messages 配列を LLM に送信して応答テキストを返す共有ヘルパー。
 * RPモード（fetchChatCompletion）と純チャットモードの両方から使用。
 * タイムアウト・ストリーミング/JSONフォールバック・<think>除去・暴走圧縮を内包。
 */
async function _executeChatRequest(messages) {
    var payload = {
        model: apiConfig.model,
        messages: messages,
        temperature: 0.8,
        max_tokens: apiConfig.tokens,
        stream: !!streamingEnabled
    };
    // 繰り返しペナルティ（暴走リピート抑制）。0 のときは送らない。
    if (repetitionPenalty && repetitionPenalty > 0) {
        payload.frequency_penalty = repetitionPenalty;
        payload.presence_penalty  = repetitionPenalty;
    }

    var headers = {
        'Content-Type': 'application/json'
    };

    if (apiConfig.key) {
        headers['Authorization'] = 'Bearer ' + apiConfig.key;
    }

    // ===== AbortController + タイムアウト =====
    // KoboldCpp 等が長時間生成中にコネクション切断を起こしてレスポンスが永久に届かない
    // ケースを物理的に防ぐ。timeoutSec=0 ならタイムアウト無効。
    const _abortCtrl = new AbortController();
    let _timeoutId = null;
    if (apiConfig.timeoutSec && apiConfig.timeoutSec > 0) {
        _timeoutId = setTimeout(() => {
            console.warn('[fetchChatCompletion] Timeout (' + apiConfig.timeoutSec + 's) → fetch abort');
            _abortCtrl.abort();
        }, apiConfig.timeoutSec * 1000);
    }

    var response;
    try {
        response = await fetch(apiConfig.endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload),
            signal: _abortCtrl.signal
        });
    } catch (fetchErr) {
        if (_timeoutId) clearTimeout(_timeoutId);
        if (fetchErr.name === 'AbortError') {
            throw new Error('API タイムアウト (' + apiConfig.timeoutSec + '秒)。LLM バックエンドがハングしている可能性があります。\n対処: ① バックエンド（KoboldCpp等）を再起動 ② Settings の Max Tokens を下げる ③ Settings の API Timeout を延ばす');
        }
        // 'Failed to fetch' = 大抵 backend 不到達 or CORS
        if (fetchErr.message && fetchErr.message.includes('Failed to fetch')) {
            throw new Error('API 接続失敗: バックエンドが応答していません。\n対処: ① LLM バックエンド（' + apiConfig.endpoint + '）が起動しているか確認 ② バックエンドが前回リクエストでハングしていないか確認（再起動推奨） ③ ファイアウォール / CORS 設定確認');
        }
        throw fetchErr;
    }
    if (_timeoutId) clearTimeout(_timeoutId);

    if (!response.ok) {
        var errText = await response.text();
        throw new Error('API Error ' + response.status + ': ' + errText);
    }

    // ===== 応答取得: SSE ストリーミング or 通常 JSON =====
    // stream: true を要求しても非対応バックエンドは普通の JSON を返すため、
    // Content-Type で実際の形式を判定して自動フォールバックする。
    var content;
    const _respType = (response.headers.get('content-type') || '').toLowerCase();
    if (streamingEnabled && response.body && _respType.includes('text/event-stream')) {
        content = await _readSseStreamToText(response, _abortCtrl);
    } else {
        var result = await response.json();
        if (result.choices && result.choices.length > 0) {
            content = result.choices[0].message.content;
        } else {
            throw new Error("Invalid API response structure");
        }
    }

    // --- 強力な <think> 除去処理 ---
    // 1. 基本的な <think>...</think> の除去（大文字小文字無視、複数対応）
    content = (content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');

    // 2. 閉じタグがない場合（トークン切れや生成途中）の対応
    // Qwen3などは思考が始まると <think> で始まるので、これ以降を一度切り捨てる
    if(content.includes('<think>')) {
         let parts = content.split('<think>');
         // <think>より前の部分だけを結合する（もし複数あれば）
         content = parts[0];
    }

    // 3. 暴走リピート（degenerate loop）の圧縮
    //    「ろ、ろ、ろ、…」のような同一短単位の連続を 3 回 + 省略記号に畳む。
    //    ストリーミング早期中断・非ストリーミング全文返却の双方に効く最終ガード。
    content = collapseRunawayRepetition(content);

    // タグの残骸などをトリム
    content = content.trim();

    // もし生成結果に対しても {{user}} だけは即座に適用したい場合はここで置き換える
    // ただし {{char}} は splitAndAppendCharMessages 内で話者ごとに適用する
    content = content.replace(/{{user}}/gi, userConfig.name);

    // もし除去した結果、空っぽになってしまった場合（思考プロセスしか出力されなかった場合）のガード
    if(!content) {
        return "(思考プロセスのみが返されました。Max Tokensを増やすか、もう一度試してみてください。)";
    }

    return content;
}

// ======== QUEST UI SYSTEM ========
let editingQuestId = null; // ID of quest being edited, null for new quest

function setupQuestUI() {
    // Import quest file
    const importInput = document.getElementById('import-quest-file');
    if (importInput) {
        importInput.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            importQuestFromFile(file, function() {
                renderQuestLibrary();
                alert('クエストをインポートしました！');
            });
            e.target.value = '';
        });
    }

    // New quest button
    const newBtn = document.getElementById('new-quest-btn');
    if (newBtn) {
        newBtn.addEventListener('click', function() {
            editingQuestId = null;
            loadQuestIntoEditor(createEmptyQuest());
            showQuestEditor();
        });
    }

    // Back to library button
    const backBtn = document.getElementById('quest-back-btn');
    if (backBtn) {
        backBtn.addEventListener('click', function() {
            showQuestLibrary();
        });
    }

    // Save quest button
    const saveBtn = document.getElementById('save-quest-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', function() {
            const quest = getQuestFromEditor();
            if (editingQuestId) {
                quest.id = editingQuestId;
                updateQuest(quest);
            } else {
                addQuest(quest);
                editingQuestId = quest.id;
            }
            alert('クエストを保存しました！');
        });
    }

    // Export quest button
    const exportBtn = document.getElementById('export-quest-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', function() {
            const quest = getQuestFromEditor();
            exportQuest(quest);
        });
    }

    // Dynamic list add buttons
    setupDynamicListButton('add-ai-instruction-btn', 'quest-ai-instructions', 'ai_instruction');
    setupDynamicListButton('add-event-btn', 'quest-events', 'event');
    setupDynamicListButton('add-additional-setting-btn', 'quest-additional-settings', 'additional_setting');
    setupDynamicListButton('add-hidden-truth-btn', 'quest-hidden-truths', 'hidden_truth');
    setupDynamicListButton('add-item-clue-btn', 'quest-items-clues', 'item_clue');
    setupCharStatusParamsEditor();

    renderQuestLibrary();
}

function setupDynamicListButton(btnId, containerId, entryType) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', function() {
        const container = document.getElementById(containerId);
        if (!container) return;
        const index = container.children.length;
        container.appendChild(createQuestEntryElement(entryType, index, {}));
    });
}

function showQuestEditor() {
    document.getElementById('quest-library-view').classList.add('hidden');
    document.getElementById('quest-editor-view').classList.remove('hidden');
}

function showQuestLibrary() {
    document.getElementById('quest-editor-view').classList.add('hidden');
    document.getElementById('quest-library-view').classList.remove('hidden');
    renderQuestLibrary();
}

function renderQuestLibrary() {
    const grid = document.getElementById('quest-library-grid');
    if (!grid) return;

    if (savedQuests.length === 0) {
        grid.innerHTML = '<div class="loading">クエストがまだありません。「新規クエスト作成」または「インポート」で追加してください。</div>';
        return;
    }

    let html = '';
    savedQuests.forEach(function(quest) {
        const tags = (quest.metadata.tags || []).map(t => '<span class="quest-tag">' + escapeHTML(t) + '</span>').join('');
        const preview = quest.selection_text ? escapeHTML(quest.selection_text) : '<em>説明文なし</em>';
        const eventCount = (quest.events || []).length;
        const meta = '推奨: ' + (quest.metadata.recommended_party_size || '?') + '人 / イベント: ' + eventCount + '件';

        html += '<div class="quest-card" data-quest-id="' + quest.id + '">'
            + '<h3>' + escapeHTML(quest.metadata.name || '名称未設定') + '</h3>'
            + '<div class="quest-tags">' + tags + '</div>'
            + '<div class="quest-preview">' + preview + '</div>'
            + '<div class="quest-meta">' + meta + '</div>'
            + '<div class="quest-card-actions">'
            + '  <button class="quest-start-btn" data-id="' + quest.id + '">開始</button>'
            + '  <button class="quest-edit-btn" data-id="' + quest.id + '">編集</button>'
            + '  <button class="quest-export-btn" data-id="' + quest.id + '">出力</button>'
            + '  <button class="quest-delete-btn" data-id="' + quest.id + '">削除</button>'
            + '</div>'
            + '</div>';
    });
    grid.innerHTML = html;

    // Wire up card buttons
    grid.querySelectorAll('.quest-edit-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const quest = savedQuests.find(q => q.id === this.dataset.id);
            if (quest) {
                editingQuestId = quest.id;
                loadQuestIntoEditor(quest);
                showQuestEditor();
            }
        });
    });

    grid.querySelectorAll('.quest-export-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const quest = savedQuests.find(q => q.id === this.dataset.id);
            if (quest) exportQuest(quest);
        });
    });

    grid.querySelectorAll('.quest-delete-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const quest = savedQuests.find(q => q.id === this.dataset.id);
            if (quest && confirm('「' + quest.metadata.name + '」を削除しますか？')) {
                deleteQuest(quest.id);
                renderQuestLibrary();
            }
        });
    });

    grid.querySelectorAll('.quest-start-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const quest = savedQuests.find(q => q.id === this.dataset.id);
            if (quest) {
                startQuest(quest);
            }
        });
    });
}

// --- Quest Editor: Load/Get ---

function loadQuestIntoEditor(quest) {
    document.getElementById('quest-editor-title').textContent = editingQuestId ? 'クエスト編集' : '新規クエスト作成';
    document.getElementById('quest-name').value = quest.metadata.name || '';
    document.getElementById('quest-tags').value = (quest.metadata.tags || []).join(', ');
    document.getElementById('quest-author').value = quest.metadata.author || '';
    document.getElementById('quest-party-size').value = quest.metadata.recommended_party_size || 2;
    document.getElementById('quest-selection-text').value = quest.selection_text || '';
    document.getElementById('quest-prologue').value = quest.prologue_overview || '';
    document.getElementById('quest-background').value = quest.background || '';
    document.getElementById('quest-intro-dialogue').value = quest.introduction_dialogue || '';
    document.getElementById('quest-dice-enabled').checked = !!quest.dice_enabled;

    // Render dynamic lists
    renderQuestDynamicList('quest-ai-instructions', 'ai_instruction', quest.ai_instructions || []);
    renderQuestDynamicList('quest-events', 'event', quest.events || []);
    renderQuestDynamicList('quest-additional-settings', 'additional_setting', quest.additional_settings || []);
    renderQuestDynamicList('quest-hidden-truths', 'hidden_truth', quest.hidden_truths || []);
    renderQuestDynamicList('quest-items-clues', 'item_clue', quest.items_clues || []);
    renderCharStatusParamsEditor(quest.char_status_params || []);
}

function getQuestFromEditor() {
    const quest = createEmptyQuest();
    if (editingQuestId) quest.id = editingQuestId;

    quest.metadata.name = document.getElementById('quest-name').value.trim();
    quest.metadata.tags = document.getElementById('quest-tags').value.split(',').map(t => t.trim()).filter(t => t);
    quest.metadata.author = document.getElementById('quest-author').value.trim();
    quest.metadata.recommended_party_size = parseInt(document.getElementById('quest-party-size').value) || 2;
    quest.selection_text = document.getElementById('quest-selection-text').value.trim();
    quest.prologue_overview = document.getElementById('quest-prologue').value.trim();
    quest.background = document.getElementById('quest-background').value.trim();
    quest.introduction_dialogue = document.getElementById('quest-intro-dialogue').value.trim();

    quest.ai_instructions = getQuestDynamicList('quest-ai-instructions', 'ai_instruction');
    quest.events = getQuestDynamicList('quest-events', 'event');
    quest.additional_settings = getQuestDynamicList('quest-additional-settings', 'additional_setting');
    quest.hidden_truths = getQuestDynamicList('quest-hidden-truths', 'hidden_truth');
    quest.items_clues = getQuestDynamicList('quest-items-clues', 'item_clue');
    quest.char_status_params = getCharStatusParamsFromEditor();
    quest.dice_enabled = document.getElementById('quest-dice-enabled').checked;

    return quest;
}

// --- Quest Editor: Dynamic List Rendering ---

function renderQuestDynamicList(containerId, entryType, items) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    items.forEach(function(item, index) {
        container.appendChild(createQuestEntryElement(entryType, index, item));
    });
}

function createQuestEntryElement(entryType, index, data) {
    const div = document.createElement('div');
    div.className = 'quest-entry';
    div.dataset.type = entryType;

    let fieldsHtml = '';

    switch (entryType) {
        case 'ai_instruction':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>ヘッダー (例: 主目的)</label><input type="text" class="qe-header" value="${escapeHTML(data.header || '')}"></div>
                <div class="form-group"><label>内容</label><textarea class="qe-content" rows="3">${escapeHTML(data.content || '')}</textarea></div>
            `;
            break;
        case 'event':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>イベント名</label><input type="text" class="qe-title" value="${escapeHTML(data.title || '')}"></div>
                <div class="form-group"><label>内容</label><textarea class="qe-content" rows="3">${escapeHTML(data.content || '')}</textarea></div>
            `;
            break;
        case 'additional_setting':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>設定名</label><input type="text" class="qe-title" value="${escapeHTML(data.title || '')}"></div>
                <div class="form-group"><label>内容</label><textarea class="qe-content" rows="3">${escapeHTML(data.content || '')}</textarea></div>
            `;
            break;
        case 'hidden_truth':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>真実の名前</label><input type="text" class="qe-title" value="${escapeHTML(data.title || '')}"></div>
                <div class="form-group"><label>内容</label><textarea class="qe-content" rows="3">${escapeHTML(data.content || '')}</textarea></div>
                <div class="form-group"><label>公開タイミング (イベント番号。0=手動)</label><input type="number" class="qe-reveal-after" min="0" value="${data.reveal_after_event || 0}"></div>
            `;
            break;
        case 'item_clue':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>名前</label><input type="text" class="qe-name" value="${escapeHTML(data.name || '')}"></div>
                <div class="form-group"><label>説明</label><textarea class="qe-content" rows="2">${escapeHTML(data.description || '')}</textarea></div>
            `;
            break;
    }

    div.innerHTML = fieldsHtml + '<button class="remove-entry-btn" title="削除">✕</button>';

    div.querySelector('.remove-entry-btn').addEventListener('click', function() {
        div.remove();
        // Re-number siblings
        const container = div.parentElement;
        if (container) {
            container.querySelectorAll('.quest-entry').forEach((el, i) => {
                const num = el.querySelector('.entry-number');
                if (num) num.textContent = i + 1;
            });
        }
    });

    return div;
}

function getQuestDynamicList(containerId, entryType) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    const items = [];

    container.querySelectorAll('.quest-entry').forEach(function(el, index) {
        switch (entryType) {
            case 'ai_instruction':
                items.push({
                    header: (el.querySelector('.qe-header') || {}).value || '',
                    content: (el.querySelector('.qe-content') || {}).value || ''
                });
                break;
            case 'event':
                items.push({
                    id: index + 1,
                    title: (el.querySelector('.qe-title') || {}).value || '',
                    content: (el.querySelector('.qe-content') || {}).value || ''
                });
                break;
            case 'additional_setting':
                items.push({
                    title: (el.querySelector('.qe-title') || {}).value || '',
                    content: (el.querySelector('.qe-content') || {}).value || ''
                });
                break;
            case 'hidden_truth':
                items.push({
                    id: index + 1,
                    title: (el.querySelector('.qe-title') || {}).value || '',
                    content: (el.querySelector('.qe-content') || {}).value || '',
                    reveal_after_event: parseInt((el.querySelector('.qe-reveal-after') || {}).value) || 0
                });
                break;
            case 'item_clue':
                items.push({
                    name: (el.querySelector('.qe-name') || {}).value || '',
                    description: (el.querySelector('.qe-content') || {}).value || ''
                });
                break;
        }
    });
    return items;
}

// ======== char_status_params 専用エディタ ========

function createParamEntryElement(p) {
    const div = document.createElement('div');
    div.className = 'csp-param-entry';
    const type = p.type || 'variable'; // 'variable' | 'fixed' | 'clock'
    div.innerHTML = `
        <div class="csp-param-row">
            <input type="text" class="csp-param-name" placeholder="パラメーター名（例：好感度・時間）" value="${escapeHTML(p.name || '')}">
            <div class="csp-initial-wrap">
                <label class="csp-initial-label">初期値</label>
                <input type="number" class="csp-param-initial" value="${typeof p.initial_value === 'number' ? p.initial_value : 0}">
            </div>
            <div class="csp-type-wrap" title="パラメーターの種類">
                <label class="csp-initial-label">種類</label>
                <select class="csp-param-type">
                    <option value="variable" ${type === 'variable' ? 'selected' : ''}>変動 (%バー)</option>
                    <option value="fixed"    ${type === 'fixed'    ? 'selected' : ''}>固定 (判定基準)</option>
                    <option value="clock"    ${type === 'clock'    ? 'selected' : ''}>時刻 (HH:MM)</option>
                </select>
            </div>
            <button class="csp-remove-param-btn" title="パラメーター削除">✕</button>
        </div>
        <textarea class="csp-param-desc" rows="2" placeholder="AIへの説明（時刻型の場合は分単位で経過時間を加算）">${escapeHTML(p.description || '')}</textarea>
    `;
    div.querySelector('.csp-remove-param-btn').addEventListener('click', () => div.remove());
    return div;
}

function createCharStatusBlock(charEntry) {
    const block = document.createElement('div');
    block.className = 'char-status-block';
    block.innerHTML = `
        <div class="char-status-block-header">
            <input type="text" class="csp-char-name" placeholder="キャラクター名" value="${escapeHTML(charEntry.character || '')}">
            <button class="csp-remove-char-btn small-btn" title="このキャラクターのステータス設定を削除">キャラ削除</button>
        </div>
        <div class="csp-param-list"></div>
        <button class="csp-add-param-btn secondary-btn">+ パラメーター追加</button>
    `;

    const paramList = block.querySelector('.csp-param-list');
    (charEntry.params || []).forEach(p => paramList.appendChild(createParamEntryElement(p)));

    block.querySelector('.csp-remove-char-btn').addEventListener('click', () => block.remove());
    block.querySelector('.csp-add-param-btn').addEventListener('click', () => {
        paramList.appendChild(createParamEntryElement({}));
    });

    return block;
}

function renderCharStatusParamsEditor(charStatusParams) {
    const container = document.getElementById('quest-char-status-params');
    if (!container) return;
    container.innerHTML = '';
    (charStatusParams || []).forEach(entry => {
        container.appendChild(createCharStatusBlock(entry));
    });
}

function getCharStatusParamsFromEditor() {
    const container = document.getElementById('quest-char-status-params');
    if (!container) return [];
    const result = [];
    container.querySelectorAll('.char-status-block').forEach(block => {
        const charName = (block.querySelector('.csp-char-name') || {}).value || '';
        if (!charName.trim()) return;
        const params = [];
        block.querySelectorAll('.csp-param-entry').forEach(entry => {
            const name = (entry.querySelector('.csp-param-name') || {}).value || '';
            const desc = (entry.querySelector('.csp-param-desc') || {}).value || '';
            const initVal = parseInt((entry.querySelector('.csp-param-initial') || {}).value);
            const typeSel = entry.querySelector('.csp-param-type');
            const paramType = (typeSel && typeSel.value) || 'variable';
            if (name.trim()) {
                const initSafe = isNaN(initVal) ? 0 : initVal;
                let safeInit;
                if (paramType === 'fixed') {
                    safeInit = initSafe; // 任意の整数
                } else if (paramType === 'clock') {
                    // 時刻は 0-1439 (分単位)
                    safeInit = ((initSafe % 1440) + 1440) % 1440;
                } else {
                    safeInit = Math.max(-100, Math.min(100, initSafe)); // variable
                }
                params.push({
                    name: name.trim(),
                    description: desc.trim(),
                    initial_value: safeInit,
                    type: paramType
                });
            }
        });
        result.push({ character: charName.trim(), params });
    });
    return result;
}

function setupCharStatusParamsEditor() {
    const addCharBtn = document.getElementById('add-char-status-btn');
    if (addCharBtn) {
        addCharBtn.addEventListener('click', () => {
            const container = document.getElementById('quest-char-status-params');
            if (!container) return;
            container.appendChild(createCharStatusBlock({ character: '', params: [] }));
        });
    }
}

// ======== END char_status_params エディタ ========

// --- Quest Start ---
async function startQuest(quest) {
    if (activeQuest) {
        if (!confirm('既にアクティブなクエストがあります。新しいクエストを開始しますか？')) return;
    }

    const members = getActivePartyMembers();
    // メンバー0 でもプレイヤー(userConfig)が存在するため続行可能。
    // ただし推奨人数が2人以上のシナリオは確認を取る。
    if (members.length === 0) {
        const recSize = (quest.metadata && quest.metadata.recommended_party_size) || 1;
        if (recSize > 1) {
            if (!confirm('パーティにキャラクターがいません。プレイヤーのみでクエストを開始しますか？\n（NPCはAIが生成します）')) return;
        }
        // 推奨1人 or 確認OK → プレイヤー単独で続行
    }

    activeQuest = {
        template: JSON.parse(JSON.stringify(quest)),
        state: {
            current_event_index: 0,
            completed_events: [],
            revealed_truths: [],
            prologue_delivered: false,
            items_shown: false,
            status_values: {},
            player_note: ''   // クエストスコープのプレイヤーノート
        }
    };
    initializeStatusValues(activeQuest, members);
    saveActiveQuest();

    // Reset chat for new quest
    chatHistory = [];
    resetContextSummary();
    clearInfoPanel();
    bumpChatRenderToken();
    document.getElementById('chat-history').innerHTML = '';
    saveChatHistory();

    // Switch to chat view
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(v => v.classList.add('hidden'));
    const chatNav = document.querySelector('[data-view="chat-view"]');
    if (chatNav) chatNav.classList.add('active');
    document.getElementById('chat-view').classList.remove('hidden');

    updateQuestHUD();
    updateStatusHUD();

    // Deliver prologue
    if (quest.introduction_dialogue && quest.introduction_dialogue.trim()) {
        // Fixed dialogue prologue
        appendMessage('char', quest.introduction_dialogue, 'ナレーション', true);
        activeQuest.state.prologue_delivered = true;
        activeQuest.state.items_shown = true;
        saveActiveQuest();
    } else if (quest.prologue_overview && quest.prologue_overview.trim()) {
        // AI-generated prologue
        appendMessage('system', 'クエスト「' + quest.metadata.name + '」を開始します...プロローグを生成中...', 'System', false);
        try {
            const reply = await fetchChatCompletion('quest_prologue');
            // Remove loading message
            const chatContainer = document.getElementById('chat-history');
            const lastMsg = chatContainer.lastElementChild;
            if (lastMsg && lastMsg.classList.contains('system')) lastMsg.remove();

            splitAndAppendCharMessages(reply, true);
            updateRegenButtonVisibility();
            activeQuest.state.prologue_delivered = true;
            activeQuest.state.items_shown = true;
            saveActiveQuest();
        } catch (err) {
            appendMessage('system', 'プロローグ生成エラー: ' + err.message, 'System', false);
        }
    } else {
        appendMessage('system', 'クエスト「' + quest.metadata.name + '」を開始しました。メッセージを送信してプレイを始めてください。', 'System', false);
        activeQuest.state.prologue_delivered = true;
        saveActiveQuest();
    }
}

function endQuest() {
    if (!activeQuest) return;
    if (!confirm('クエスト「' + activeQuest.template.metadata.name + '」を終了しますか？')) return;
    activeQuest = null;
    saveActiveQuest();
    updateQuestHUD();
    updateStatusHUD();
}

// --- Status Parameters ---

// char_status_params のエントリをキャラ名で引く
function _getCharStatusEntry(quest, charName) {
    const csp = (quest && quest.template && quest.template.char_status_params) || [];
    return csp.find(e => e.character === charName) || null;
}

// シナリオ全体で char_status_params が1件でも定義されているか
function _hasAnyStatusParams(quest) {
    const csp = (quest && quest.template && quest.template.char_status_params) || [];
    return csp.some(e => e.params && e.params.length > 0);
}

function initializeStatusValues(quest, members) {
    if (!quest || !quest.template) return;
    const csp = quest.template.char_status_params || [];
    if (csp.length === 0) return;
    if (!quest.state.status_values) quest.state.status_values = {};

    csp.forEach(charEntry => {
        const charName = charEntry.character;
        if (!charName) return;
        if (!quest.state.status_values[charName]) quest.state.status_values[charName] = {};
        (charEntry.params || []).forEach(p => {
            if (!p.name) return;
            if (typeof quest.state.status_values[charName][p.name] !== 'number') {
                const init = (typeof p.initial_value === 'number') ? p.initial_value : 50;
                quest.state.status_values[charName][p.name] = Math.max(-100, Math.min(100, init));
            }
        });
    });
}

function getStatusValueForSpeaker(speakerName) {
    if (!activeQuest || !_hasAnyStatusParams(activeQuest)) return null;
    const entry = _getCharStatusEntry(activeQuest, speakerName);
    if (!entry || !entry.params || entry.params.length === 0) return null;
    if (!activeQuest.state || !activeQuest.state.status_values) return null;
    return activeQuest.state.status_values[speakerName] || null;
}

// 数値/文字列が混在しうるIDを Number 正規化（数値化できなければ元のまま）
function _normalizeId(v) {
    if (typeof v === 'number') return v;
    if (v == null || v === '') return v;
    const n = Number(v);
    return isNaN(n) ? v : n;
}

// 配列 arr が id を含むか（型不一致対応版）
function _idArrayIncludes(arr, id) {
    if (!Array.isArray(arr)) return false;
    const target = _normalizeId(id);
    return arr.some(x => _normalizeId(x) === target || x === id);
}

function advanceQuestEvent() {
    if (!activeQuest) return;
    const events = activeQuest.template.events || [];
    const currentIdx = activeQuest.state.current_event_index;
    if (currentIdx >= events.length) return;

    // Mark current event as completed（型不一致対応）
    const currentEvent = events[currentIdx];
    if (currentEvent && !_idArrayIncludes(activeQuest.state.completed_events, currentEvent.id)) {
        activeQuest.state.completed_events.push(_normalizeId(currentEvent.id));
    }

    // Auto-reveal truths tied to this event
    // ※ JSON 直接インポート時に reveal_after_event / id が文字列で保存されることがあるため
    //   _normalizeId() で正規化して比較（厳密等価による発火漏れの防止）
    const truths = activeQuest.template.hidden_truths || [];
    const currentEventIdNorm = _normalizeId(currentEvent && currentEvent.id);
    truths.forEach(t => {
        const revealAfterNorm = _normalizeId(t.reveal_after_event);
        if (revealAfterNorm === currentEventIdNorm && !_idArrayIncludes(activeQuest.state.revealed_truths, t.id)) {
            activeQuest.state.revealed_truths.push(_normalizeId(t.id));
            const body = t.content ? '\n' + t.content : '';
            appendMessage('system', '🔓 真実が明かされた: 「' + t.title + '」' + body, 'System', false);
        }
    });

    // Advance to next event
    if (currentIdx < events.length - 1) {
        activeQuest.state.current_event_index = currentIdx + 1;
    }

    saveActiveQuest();
    updateQuestHUD();

    // Notify in chat
    const nextEvent = events[activeQuest.state.current_event_index];
    if (nextEvent && currentIdx < events.length - 1) {
        appendMessage('system', '📍 次のイベント: ' + nextEvent.title, 'System', false);
    } else {
        appendMessage('system', '🏁 全イベントが完了しました！', 'System', false);
    }

    // ===== 🖼️ Layer 1: イベントに紐付いた場面画像を表示 =====
    // カタログ側が eventId を持つ片方向参照なので、クエスト JSON のスキーマ変更は不要。
    if (imageLibraryEnabled && nextEvent) {
        const evIdNorm = String(_normalizeId(nextEvent.id));
        const hit = imageCatalog.find(e =>
            e.layer === 'state' && e.eventId !== '' && String(_normalizeId(e.eventId)) === evIdNorm
        );
        if (hit) appendLibraryImage(hit.tag);
    }
}

function revealQuestTruth(truthId) {
    if (!activeQuest) return;
    if (!activeQuest.state.revealed_truths.includes(truthId)) {
        activeQuest.state.revealed_truths.push(truthId);
        saveActiveQuest();
        updateQuestHUD();
        const truth = (activeQuest.template.hidden_truths || []).find(t => t.id === truthId);
        if (truth) {
            const body = truth.content ? '\n' + truth.content : '';
            appendMessage('system', '🔓 真実が明かされた: 「' + truth.title + '」' + body, 'System', false);
        }
    }
}

function updateQuestHUD() {
    // プレイヤーノートUIもクエスト状態に同期（Quest note textareaの有効/無効）
    if (typeof updatePlayerNotesUI === 'function') updatePlayerNotesUI();

    const hud = document.getElementById('quest-hud');
    if (!hud) return;

    // ダイスボタンの表示制御（クエストにdice_enabledが明示的にtrueのときだけ表示）
    const diceBtn = document.getElementById('dice-btn');
    const dicePopover = document.getElementById('dice-popover');
    const diceEnabled = !!(activeQuest && activeQuest.template && activeQuest.template.dice_enabled);
    if (diceBtn) diceBtn.style.display = diceEnabled ? '' : 'none';
    if (dicePopover && !diceEnabled) dicePopover.classList.add('hidden');

    if (!activeQuest) {
        hud.classList.add('hidden');
        return;
    }

    hud.classList.remove('hidden');
    const qt = activeQuest.template;
    const qs = activeQuest.state;
    const events = qt.events || [];
    const truths = qt.hidden_truths || [];
    const items = qt.items_clues || [];

    // Name & progress
    document.getElementById('quest-hud-name').textContent = qt.metadata.name || 'クエスト';
    document.getElementById('quest-hud-progress').textContent =
        events.length > 0 ? `Event ${qs.current_event_index + 1} / ${events.length}` : '';

    // 機能別ボタンの表示/非表示
    const advanceBtn = document.getElementById('quest-advance-btn');
    if (advanceBtn) advanceBtn.style.display = events.length > 0 ? '' : 'none';
    const revealSelectEl = document.getElementById('quest-reveal-select');
    if (revealSelectEl) revealSelectEl.style.display = truths.length > 0 ? '' : 'none';
    const itemsToggleBtn = document.getElementById('quest-items-toggle');
    if (itemsToggleBtn) itemsToggleBtn.style.display = items.length > 0 ? '' : 'none';
    const truthsToggleBtn = document.getElementById('quest-truths-toggle');
    // 公開済み真実ボタンは、シナリオにhidden_truthsが定義されていれば表示
    // （公開済みが0件でも押せば「まだ公開された真実はありません」と表示）
    if (truthsToggleBtn) truthsToggleBtn.style.display = truths.length > 0 ? '' : 'none';

    // Dots
    const dotsContainer = document.getElementById('quest-hud-dots');
    dotsContainer.innerHTML = '';
    events.forEach((ev, i) => {
        const dot = document.createElement('span');
        dot.className = 'dot';
        if (_idArrayIncludes(qs.completed_events, ev.id)) dot.classList.add('completed');
        if (i === qs.current_event_index && !_idArrayIncludes(qs.completed_events, ev.id)) dot.classList.add('current');
        dot.title = ev.title || `Event ${i + 1}`;
        dotsContainer.appendChild(dot);
    });

    // Reveal truths dropdown
    const revealSelect = document.getElementById('quest-reveal-select');
    revealSelect.innerHTML = '<option value="">真実を公開...</option>';
    (qt.hidden_truths || []).forEach(t => {
        if (!qs.revealed_truths.includes(t.id)) {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.title;
            revealSelect.appendChild(opt);
        }
    });

    // Items panel
    const itemsList = document.getElementById('quest-items-list');
    if (itemsList) {
        const items = qt.items_clues || [];
        if (items.length > 0 && qs.items_shown) {
            itemsList.innerHTML = items.map(item =>
                '<div class="quest-item-entry">'
                + '<div class="item-name">' + escapeHTML(item.name) + '</div>'
                + '<div class="item-desc">' + escapeHTML(item.description) + '</div>'
                + '</div>'
            ).join('');
        } else {
            itemsList.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.85rem;">アイテムはまだ表示されていません。</div>';
        }
    }

    // Revealed truths panel
    const truthsList = document.getElementById('quest-truths-list');
    if (truthsList) {
        const revealed = truths.filter(t => qs.revealed_truths.includes(t.id));
        if (revealed.length > 0) {
            truthsList.innerHTML = revealed.map(t =>
                '<div class="quest-item-entry">'
                + '<div class="item-name">🔓 ' + escapeHTML(t.title) + '</div>'
                + '<div class="item-desc">' + escapeHTML(t.content || '') + '</div>'
                + '</div>'
            ).join('');
        } else {
            truthsList.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.85rem;">まだ公開された真実はありません。</div>';
        }
    }
}

function setupQuestHUD() {
    const advanceBtn = document.getElementById('quest-advance-btn');
    if (advanceBtn) {
        advanceBtn.addEventListener('click', advanceQuestEvent);
    }

    const endBtn = document.getElementById('quest-end-btn');
    if (endBtn) {
        endBtn.addEventListener('click', endQuest);
    }

    const revealSelect = document.getElementById('quest-reveal-select');
    if (revealSelect) {
        revealSelect.addEventListener('change', function() {
            const truthId = parseInt(this.value);
            if (truthId) {
                revealQuestTruth(truthId);
                this.value = '';
            }
        });
    }

    const itemsToggle = document.getElementById('quest-items-toggle');
    if (itemsToggle) {
        itemsToggle.addEventListener('click', function() {
            const panel = document.getElementById('quest-items-panel');
            if (panel) panel.classList.toggle('hidden');
            // 他パネルは閉じる
            const truthsPanel = document.getElementById('quest-truths-panel');
            if (truthsPanel) truthsPanel.classList.add('hidden');
        });
    }

    const truthsToggle = document.getElementById('quest-truths-toggle');
    if (truthsToggle) {
        truthsToggle.addEventListener('click', function() {
            const panel = document.getElementById('quest-truths-panel');
            if (panel) panel.classList.toggle('hidden');
            // 他パネルは閉じる
            const itemsPanel = document.getElementById('quest-items-panel');
            if (itemsPanel) itemsPanel.classList.add('hidden');
        });
    }

    // Status Parameter HUD collapse toggle
    const statusToggle = document.getElementById('status-param-hud-toggle');
    if (statusToggle) {
        statusToggle.addEventListener('click', function() {
            const grid = document.getElementById('status-param-hud-grid');
            if (!grid) return;
            const collapsed = grid.classList.toggle('collapsed');
            statusToggle.textContent = collapsed ? '▶' : '▼';
        });
    }
}

// ======== 指示付き再生成モーダル ========

function openGuidedRegenModal() {
    if (isRegenerating) return;

    // 最後のassistantエントリを取得（プレビュー用）
    let lastAssistant = null;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'assistant' && !chatHistory[i].isImage) {
            lastAssistant = chatHistory[i];
            break;
        }
    }
    if (!lastAssistant) return;

    const modal = document.getElementById('guided-regen-modal');
    const preview = document.getElementById('guided-regen-preview');
    const input = document.getElementById('guided-regen-input');
    if (!modal || !input) return;

    if (preview) {
        // タグを除去した簡易プレビュー
        const cleaned = (lastAssistant.content || '')
            .replace(/\[SPEAKER:\s*[^\]]+\]/gi, '')
            .replace(/\[STATUS:\s*[^\]]+\]/gi, '')
            .trim();
        preview.textContent = cleaned.slice(0, 600) + (cleaned.length > 600 ? '...' : '');
    }
    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
}

function closeGuidedRegenModal() {
    const modal = document.getElementById('guided-regen-modal');
    if (modal) modal.classList.add('hidden');
}

function setupGuidedRegenModal() {
    const closeBtn = document.getElementById('guided-regen-close');
    const cancelBtn = document.getElementById('guided-regen-cancel');
    const submitBtn = document.getElementById('guided-regen-submit');
    const input = document.getElementById('guided-regen-input');

    if (closeBtn) closeBtn.addEventListener('click', closeGuidedRegenModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeGuidedRegenModal);

    if (submitBtn) submitBtn.addEventListener('click', async () => {
        const guidance = (input && input.value || '').trim();
        if (!guidance) {
            alert('指示を入力してください。');
            return;
        }
        closeGuidedRegenModal();
        await regenerateLastResponse(guidance);
    });

    // Ctrl+Enter で送信
    if (input) {
        input.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (submitBtn) submitBtn.click();
            }
            if (e.key === 'Escape') {
                closeGuidedRegenModal();
            }
        });
    }
}

// ======== END 指示付き再生成モーダル ========

// ======== プレイヤーノート (Global / Quest 2層) ========

function updatePlayerNotesUI() {
    const globalText = document.getElementById('player-notes-global-text');
    const questText = document.getElementById('player-notes-quest-text');
    const globalCount = document.getElementById('player-notes-global-count');
    const questCount = document.getElementById('player-notes-quest-count');
    const questStatus = document.getElementById('player-notes-quest-status');

    if (globalText) {
        globalText.value = userConfig.player_note || '';
        if (globalCount) {
            const len = globalText.value.length;
            globalCount.textContent = `${len} / ${PLAYER_NOTE_MAX} 字`;
            globalCount.parentElement.classList.toggle('over-limit', len > PLAYER_NOTE_MAX);
        }
    }
    if (questText) {
        const hasQuest = !!activeQuest;
        questText.disabled = !hasQuest;
        questText.value = hasQuest ? (activeQuest.state.player_note || '') : '';
        if (questCount) {
            const len = questText.value.length;
            questCount.textContent = `${len} / ${PLAYER_NOTE_MAX} 字`;
            questCount.parentElement.classList.toggle('over-limit', len > PLAYER_NOTE_MAX);
        }
        if (questStatus) {
            questStatus.textContent = hasQuest
                ? ('🎯 ' + (activeQuest.template.metadata.name || 'クエスト'))
                : '（クエスト未開始）';
        }
    }
}

// ======== Response Length Preset (S / M / L) ========
function setupResponseLength() {
    document.querySelectorAll('.resp-len-btn').forEach(btn => {
        // 初期アクティブ状態を反映
        btn.classList.toggle('active', btn.dataset.length === responseLength);
        btn.addEventListener('click', () => {
            responseLength = btn.dataset.length;
            localStorage.setItem('responseLength', responseLength);
            document.querySelectorAll('.resp-len-btn').forEach(b => {
                b.classList.toggle('active', b === btn);
            });
            console.log('[ResponseLength] プリセット変更:', responseLength);
        });
    });
}

function setupShowChoicesToggle() {
    const btn = document.getElementById('show-choices-toggle');
    if (!btn) return;
    btn.classList.toggle('active', showChoices);
    btn.addEventListener('click', () => {
        showChoices = !showChoices;
        localStorage.setItem('showChoices', showChoices ? '1' : '0');
        btn.classList.toggle('active', showChoices);
        if (!showChoices) {
            // OFF にしたら現在表示中の選択肢ボタンを消す
            clearChoiceButtons();
        }
        console.log('[ShowChoices] 末尾選択肢モード:', showChoices ? 'ON' : 'OFF');
    });
}

// ======== Info Panel (Telelynx式・状況サマリ) ========
function setupInfoPanel() {
    const toggleBtn = document.getElementById('info-panel-toggle');
    const panel = document.getElementById('info-panel');
    const refreshBtn = document.getElementById('info-panel-refresh');
    const collapseBtn = document.getElementById('info-panel-collapse');
    if (!toggleBtn || !panel) return;

    // 初期トグル状態反映
    toggleBtn.classList.toggle('active', infoPanelEnabled);
    updateInfoPanelVisibility();

    // ツールバートグル: ON/OFF
    toggleBtn.addEventListener('click', () => {
        infoPanelEnabled = !infoPanelEnabled;
        localStorage.setItem('infoPanelEnabled', infoPanelEnabled ? '1' : '0');
        toggleBtn.classList.toggle('active', infoPanelEnabled);
        updateInfoPanelVisibility();
        console.log('[InfoPanel] 状況サマリモード:', infoPanelEnabled ? 'ON' : 'OFF');
    });

    // 折りたたみ
    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            const collapsed = panel.classList.toggle('collapsed');
            collapseBtn.textContent = collapsed ? '▶' : '▼';
            collapseBtn.title = collapsed ? '展開' : '折りたたみ';
        });
    }

    // 手動再生成: 独立APIコールで [INFO] ブロックのみ取得
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            if (_isInfoRefreshing) return;
            if (!infoPanelEnabled) {
                alert('Info Panel が OFF です。先にツールバーの 📊 ボタンで有効化してください。');
                return;
            }
            if (chatHistory.length === 0) {
                alert('チャット履歴が空です。会話を進めてから再生成してください。');
                return;
            }
            _isInfoRefreshing = true;
            refreshBtn.classList.add('spinning');
            refreshBtn.disabled = true;
            panel.classList.add('refreshing');
            try {
                const fresh = await fetchInfoPanelOnly();
                if (fresh) {
                    lastInfoSnapshot = fresh;
                    renderInfoPanel(fresh);
                    // 最新 assistant メッセージに上書き保存
                    for (let i = chatHistory.length - 1; i >= 0; i--) {
                        if (chatHistory[i].role === 'assistant') {
                            chatHistory[i].infoSnapshot = fresh;
                            saveChatHistory();
                            break;
                        }
                    }
                } else {
                    alert('Info Panel の再生成に失敗しました。AI応答に [INFO]...[/INFO] ブロックが含まれていません。');
                }
            } catch (e) {
                alert('Info Panel 再生成エラー: ' + e.message);
            } finally {
                _isInfoRefreshing = false;
                refreshBtn.classList.remove('spinning');
                refreshBtn.disabled = false;
                panel.classList.remove('refreshing');
            }
        });
    }
}

/**
 * Info Panel の手動再生成専用API呼び出し。
 * 通常チャットとは独立した最小システムプロンプトで [INFO]...[/INFO] ブロックのみを要求する。
 * 戻り値: infoText (string) または null
 */
async function fetchInfoPanelOnly() {
    if (!apiConfig.endpoint) throw new Error('API Endpoint が未設定です。');

    // 直近のチャット履歴を圧縮した状況プロンプトを構築
    const recent = chatHistory.slice(-8).filter(m => !m.isImage && m.content)
        .map(m => `[${m.role}] ${m.content}`).join('\n\n');

    const questTemplate = (activeQuest && activeQuest.template && activeQuest.template.info_panel_template)
        ? activeQuest.template.info_panel_template.trim()
        : '';

    let sysPrompt = '以下のロールプレイ履歴を読み、現在の状況サマリを [INFO]...[/INFO] ブロック1つだけで出力してください。\n';
    sysPrompt += '本文の解説・前置き・後置きは一切不要です。[INFO] ブロックのみを返してください。\n\n';
    sysPrompt += '[INFO]\n';
    if (questTemplate) {
        sysPrompt += questTemplate + '\n';
    } else {
        sysPrompt += '【現在の状況】\n日時 / 場所 / 周囲\n\n【ユーザーの情報】\n所属 / 地位 / 状態\n\n【登場キャラ】\n[キャラ名] - [現状] | ...\n';
    }
    sysPrompt += '[/INFO]\n\n';
    sysPrompt += '各セクションは【】で囲み、コンパクトに。同じ項目内は「 | 」で区切る。';

    const userPrompt = '【直近の会話履歴】\n' + recent + '\n\n上記の状況を踏まえ、[INFO]...[/INFO] ブロックを1つだけ出力してください。';

    const body = {
        model: apiConfig.model,
        messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.5,
        max_tokens: 500,
        stream: false
    };

    const headers = { 'Content-Type': 'application/json' };
    if (apiConfig.key && apiConfig.key !== 'none') headers['Authorization'] = 'Bearer ' + apiConfig.key;

    const res = await fetch(apiConfig.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('API ' + res.status);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const parsed = parseInfoTag(text);
    return parsed.infoText;
}

// ======== 完全自由空間モード: NPC 自動生成 ========
// 世界観に合わせた NPC を 1 人 LLM 生成する。fetchInfoPanelOnly() と同じ独立API呼出パターン。
// 戻り値: { name, personality, description, scenario, first_mes, mes_example } またはエラー throw
async function generateNpcByLLM(themeOverride) {
    if (!apiConfig.endpoint) throw new Error('API Endpoint が未設定です。');

    // 世界観の3段階フォールバック
    let theme = themeOverride;
    if (!theme) {
        if (activeQuest && activeQuest.template && activeQuest.template.additional_settings) {
            theme = activeQuest.template.additional_settings.trim();
        }
    }
    if (!theme) theme = (worldTheme || '').trim();
    if (!theme) theme = '現代日本の日常';

    // 既存キャラ名（プレイヤー + アクティブNPC）— 重複回避用
    const existingNames = [userConfig.name];
    characterDataArray.forEach(c => {
        if (c && c.name && !c.name.includes('Empty')) existingNames.push(c.name);
    });

    const sysPrompt =
        '以下の世界観に適した NPC キャラクターを 1 人生成してください。\n' +
        '世界観: ' + theme + '\n' +
        '既存キャラクター（被らないこと）: ' + existingNames.join('、') + '\n\n' +
        '厳密に以下の JSON 形式のみを出力してください。装飾・コメント・コードフェンス（```）・解説文は一切禁止。生 JSON のみ。\n\n' +
        '{\n' +
        '  "name": "キャラ名（フルネーム、日本語）",\n' +
        '  "personality": "短い性格タグの列、カンマ区切り（例: 真面目, 内向的, 几帳面）",\n' +
        '  "description": "詳細な背景・外見・口調・年齢・職業など 200〜400字",\n' +
        '  "scenario": "プレイヤーと出会うシチュエーション 50〜150字",\n' +
        '  "first_mes": "プレイヤーに初めて会った時のセリフ・行動 100〜250字",\n' +
        '  "mes_example": "対話例（<START> タグ区切り、2〜3往復程度）"\n' +
        '}';

    const userPrompt = '上記の世界観で、世界に自然に溶け込むキャラクターを 1 人作ってください。テンプレ的でない、独自の個性を持つキャラを希望します。';

    const body = {
        model: apiConfig.model,
        messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user',   content: userPrompt }
        ],
        temperature: 0.9,
        max_tokens: 1000,
        stream: false
    };

    const headers = { 'Content-Type': 'application/json' };
    if (apiConfig.key && apiConfig.key !== 'none') headers['Authorization'] = 'Bearer ' + apiConfig.key;

    // AbortController + timeoutSec
    const ctrl = new AbortController();
    const tid = (apiConfig.timeoutSec > 0)
        ? setTimeout(() => ctrl.abort(), apiConfig.timeoutSec * 1000)
        : null;

    let res;
    try {
        res = await fetch(apiConfig.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
    } catch (e) {
        if (tid) clearTimeout(tid);
        if (e.name === 'AbortError') throw new Error('NPC 生成タイムアウト（' + apiConfig.timeoutSec + '秒）');
        throw e;
    }
    if (tid) clearTimeout(tid);

    if (!res.ok) throw new Error('NPC 生成 API エラー: ' + res.status);
    const data = await res.json();
    let raw = data?.choices?.[0]?.message?.content || '';

    // think タグ除去
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    raw = raw.replace(/<\/?think>/gi, '').trim();

    // コードフェンスを誤って出力した場合の除去
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    // 最初の { から最後の } までを抽出
    const firstBrace = raw.indexOf('{');
    const lastBrace  = raw.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
        throw new Error('LLM 出力に JSON が見つかりません。出力先頭: ' + raw.substring(0, 100));
    }
    const jsonStr = raw.substring(firstBrace, lastBrace + 1);

    let npcJson;
    try {
        npcJson = JSON.parse(jsonStr);
    } catch (e) {
        throw new Error('LLM 出力の JSON パース失敗: ' + e.message);
    }

    if (!npcJson.name || typeof npcJson.name !== 'string') {
        throw new Error('生成された NPC に name フィールドがありません。');
    }
    // 既存名重複チェック（部分一致でも警告）
    const norm = npcJson.name.trim().toLowerCase();
    if (existingNames.some(n => n.toLowerCase() === norm)) {
        throw new Error('生成された NPC 名「' + npcJson.name + '」が既存キャラと重複しています。再試行してください。');
    }

    // 既存の正規化関数経由でエンジン形式に整える
    if (typeof normalizeToEngineChar === 'function') {
        return normalizeToEngineChar(npcJson);
    }
    return npcJson;
}

// ======== 完全自由空間モード: 生きている世界 (アイドルイベント) ========
// チャット画面で一定時間ユーザー入力がない場合、LLM が世界の自律的な小事件を生成する。
// setInterval で 30 秒毎に発火条件チェック → 条件成立で fetchLivingWorldEvent() 実行。

function startLivingWorldTimer() {
    if (_livingWorldTimerHandle) {
        clearInterval(_livingWorldTimerHandle);
        _livingWorldTimerHandle = null;
    }
    if (!freeWorldEnabled || !livingWorldEnabled) return;
    // 入力時刻を初期化（開始直後の即発火を防ぐ）
    _lastUserInputTime = Date.now();
    // 30秒毎に発火条件チェック
    _livingWorldTimerHandle = setInterval(checkAndFireLivingWorldEvent, 30000);
    console.log('[LivingWorld] タイマー開始 — 最低間隔', livingWorldIntervalSec, '秒');
}

function stopLivingWorldTimer() {
    if (_livingWorldTimerHandle) {
        clearInterval(_livingWorldTimerHandle);
        _livingWorldTimerHandle = null;
        console.log('[LivingWorld] タイマー停止');
    }
}

async function checkAndFireLivingWorldEvent() {
    // 発火条件の段階的チェック
    if (!freeWorldEnabled || !livingWorldEnabled) {
        stopLivingWorldTimer();
        return;
    }
    if (pureChatMode) return;                  // 純チャット中はRPイベントを流さない
    if (_isLivingWorldFiring) return;          // 二重発火防止
    if (typeof isSending !== 'undefined' && isSending) return;  // AI 応答生成中はスキップ
    if (_isGeneratingNpc) return;              // NPC 生成中もスキップ
    if (chatHistory.length === 0) return;      // 履歴空ならスキップ
    // chat-view がアクティブか確認
    const chatView = document.getElementById('chat-view');
    if (!chatView || chatView.classList.contains('hidden')) return;
    // 経過時間チェック
    const elapsed = (Date.now() - _lastUserInputTime) / 1000;
    if (elapsed < livingWorldIntervalSec) return;

    _isLivingWorldFiring = true;
    const loadingId = 'loading-livingworld-' + Date.now();
    try {
        if (typeof appendLoadingMsg === 'function') {
            appendLoadingMsg(loadingId, '🌍 世界が動く...');
        }
        const eventText = await fetchLivingWorldEvent();
        if (typeof removeLoadingMsg === 'function') removeLoadingMsg(loadingId);

        if (eventText && eventText.trim()) {
            // splitAndAppendCharMessages で既存のタグ解析・SPEAKER 振り分け・履歴保存を享受
            splitAndAppendCharMessages(eventText, true, -1, false);
            // 履歴の最終 assistant メッセージに livingWorldEvent フラグを付与
            for (let i = chatHistory.length - 1; i >= 0; i--) {
                if (chatHistory[i].role === 'assistant') {
                    chatHistory[i].livingWorldEvent = true;
                    saveChatHistory();
                    break;
                }
            }
            if (typeof updateRegenButtonVisibility === 'function') updateRegenButtonVisibility();
        }
        // 発火後はクールダウン: _lastUserInputTime を現在時刻にリセットして再発火タイマーを延長
        _lastUserInputTime = Date.now();
    } catch (e) {
        if (typeof removeLoadingMsg === 'function') removeLoadingMsg(loadingId);
        console.warn('[LivingWorld] イベント生成失敗:', e.message);
        // 失敗時もクールダウンを設定（連続失敗の連発防止）
        _lastUserInputTime = Date.now();
    } finally {
        _isLivingWorldFiring = false;
    }
}

// LLM 呼出: 世界の自律的小事件を生成
async function fetchLivingWorldEvent() {
    if (!apiConfig.endpoint) throw new Error('API Endpoint が未設定です。');

    // 世界観取得（同じ3段階フォールバック）
    let theme = '';
    if (activeQuest && activeQuest.template && activeQuest.template.additional_settings) {
        theme = activeQuest.template.additional_settings.trim();
    }
    if (!theme) theme = (worldTheme || '').trim();
    if (!theme) theme = '現代日本の日常';

    // アクティブメンバーの名前リスト（NPCの自律行動描写に使う）
    const members = (typeof getActivePartyMembers === 'function') ? getActivePartyMembers() : [];
    const memberNames = members.map(m => m.name).filter(n => n);

    // 直近のチャット履歴（最大8件）
    const recent = chatHistory.slice(-8).filter(m => !m.isImage && m.content)
        .map(m => `[${m.role}] ${m.content}`).join('\n\n');

    const sysPrompt =
        'あなたは「生きている世界」のナレーターです。プレイヤーが何もしていない間に、世界で起きた小さな出来事を描写してください。\n\n' +
        '世界観: ' + theme + '\n' +
        (memberNames.length > 0 ? '登場可能 NPC: ' + memberNames.join('、') + '\n' : '') +
        '\n' +
        '【厳守事項】\n' +
        '・プレイヤー（' + userConfig.name + '）の発言・行動・思考は絶対に生成しないこと。\n' +
        '・[SPEAKER: ' + userConfig.name + '] タグは絶対に使わないこと。\n' +
        '・[SPEAKER: ナレーション] タグ、または NPC の [SPEAKER: 名前] タグのみ使用すること。\n' +
        '\n' +
        '【描写の方針】\n' +
        '・2〜3 段落、合計 200〜400 字程度。長すぎないこと。\n' +
        '・以下のいずれかを描写してください:\n' +
        '  - NPC 同士の何気ない会話を一場面切り取って描写（井戸端会議的）\n' +
        '  - 別の場所で起きた小さな事件・噂・自然現象\n' +
        '  - 時間経過の演出（夕暮れ、雨が降り始めた、店が閉店した等）\n' +
        '  - 既に登場した NPC が別の場所で何かしている描写\n' +
        '・プレイヤー不在の世界が自然に動いていることを示すのが目的。劇的すぎる事件は避け、生活感のあるサイズに留めること。\n' +
        '・直近の会話で出た要素と矛盾しないよう注意してください。';

    const userPrompt = '【直近の会話履歴】\n' + (recent || '(空)') + '\n\n' +
        '上記の流れを踏まえ、プレイヤーが何もしていない間に世界で起きた小事件を 1 つ、上記ルールで描写してください。';

    const body = {
        model: apiConfig.model,
        messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user',   content: userPrompt }
        ],
        temperature: 0.85,
        max_tokens: 500,
        stream: false
    };

    const headers = { 'Content-Type': 'application/json' };
    if (apiConfig.key && apiConfig.key !== 'none') headers['Authorization'] = 'Bearer ' + apiConfig.key;

    const ctrl = new AbortController();
    const tid = (apiConfig.timeoutSec > 0)
        ? setTimeout(() => ctrl.abort(), apiConfig.timeoutSec * 1000)
        : null;

    let res;
    try {
        res = await fetch(apiConfig.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
    } catch (e) {
        if (tid) clearTimeout(tid);
        if (e.name === 'AbortError') throw new Error('Living World タイムアウト');
        throw e;
    }
    if (tid) clearTimeout(tid);

    if (!res.ok) throw new Error('Living World API エラー: ' + res.status);
    const data = await res.json();
    let text = data?.choices?.[0]?.message?.content || '';
    // think タグ除去
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    text = text.replace(/<\/?think>/gi, '').trim();
    return text;
}

function setupPlayerNotes() {
    const toggleBtn = document.getElementById('player-notes-toggle');
    const panel = document.getElementById('player-notes-panel');
    const closeBtn = document.getElementById('player-notes-close');
    const tabs = document.querySelectorAll('.player-notes-tab');
    const sectionGlobal = document.getElementById('player-notes-global-section');
    const sectionQuest = document.getElementById('player-notes-quest-section');
    const globalText = document.getElementById('player-notes-global-text');
    const questText = document.getElementById('player-notes-quest-text');

    if (!panel || !toggleBtn) return;

    // 初期値描画
    updatePlayerNotesUI();

    toggleBtn.addEventListener('click', () => {
        panel.classList.toggle('hidden');
        const hidden = panel.classList.contains('hidden');
        panel.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        toggleBtn.classList.toggle('active', !hidden);
        if (!hidden) updatePlayerNotesUI();
    });
    if (closeBtn) closeBtn.addEventListener('click', () => {
        panel.classList.add('hidden');
        panel.setAttribute('aria-hidden', 'true');
        toggleBtn.classList.remove('active');
    });

    // タブ切替
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const scope = tab.dataset.scope;
            if (sectionGlobal) sectionGlobal.classList.toggle('hidden', scope !== 'global');
            if (sectionQuest) sectionQuest.classList.toggle('hidden', scope !== 'quest');
        });
    });

    // Global note: input でユーザーコンフィグへ即時保存
    if (globalText) {
        globalText.addEventListener('input', () => {
            userConfig.player_note = globalText.value.slice(0, PLAYER_NOTE_MAX * 2); // クランプ: 異常に長い貼り付けだけ抑制
            saveUserConfig();
            updatePlayerNotesUI();
        });
    }

    // Quest note: activeQuest が存在する時のみ書き込み可能
    if (questText) {
        questText.addEventListener('input', () => {
            if (!activeQuest) return;
            activeQuest.state.player_note = questText.value.slice(0, PLAYER_NOTE_MAX * 2);
            saveActiveQuest();
            updatePlayerNotesUI();
        });
    }
}

// ======== END プレイヤーノート ========

// 直前値を記憶して差分ハイライトに使うキャッシュ
let _statusHUDPrev = {};

// ステータスパラメーターHUDを描画
// キャラクター x パラメーター のグリッドとしてプログレスバーを表示
function updateStatusHUD() {
    const hud = document.getElementById('status-param-hud');
    const grid = document.getElementById('status-param-hud-grid');
    if (!hud || !grid) return;

    // クエスト無効時 / char_status_params 未定義時は隠す
    if (!activeQuest || !_hasAnyStatusParams(activeQuest)) {
        hud.classList.add('hidden');
        grid.innerHTML = '';
        _statusHUDPrev = {};
        return;
    }

    const csp = activeQuest.template.char_status_params || [];
    const sv = (activeQuest.state && activeQuest.state.status_values) || {};

    hud.classList.remove('hidden');

    // キャラクターごとにブロックを描画（char_status_params の定義順）
    let html = '';
    csp.forEach(charEntry => {
        const charName = charEntry.character;
        if (!charName || !charEntry.params || charEntry.params.length === 0) return;
        const charVals = sv[charName] || {};

        html += '<div class="status-char-row">';
        html += `<div class="status-char-name">${escapeHTML(charName)}</div>`;
        html += '<div class="status-param-list">';
        charEntry.params.forEach(p => {
            if (!p.name) return;
            const rawVal = (typeof charVals[p.name] === 'number')
                ? charVals[p.name]
                : (typeof p.initial_value === 'number' ? p.initial_value : 0);
            const isFixed = p.type === 'fixed';
            const isClock = p.type === 'clock';
            const prevKey = `${charName}__${p.name}`;
            if (isClock) {
                // 時刻ステータス: 分単位値を HH:MM 表示。バーなし。
                const m = ((rawVal % 1440) + 1440) % 1440;
                const hh = String(Math.floor(m / 60)).padStart(2, '0');
                const mm = String(m % 60).padStart(2, '0');
                const prevVal = _statusHUDPrev[prevKey];
                const changed = (typeof prevVal === 'number' && prevVal !== m);
                const diffCls = changed
                    ? 'status-cell status-cell-clock changed up'
                    : 'status-cell status-cell-clock';
                html += `<div class="${diffCls}" data-char="${escapeHTML(charName)}" data-param="${escapeHTML(p.name)}">`;
                html += `<div class="status-cell-label"><span class="status-param-name">⏰ ${escapeHTML(p.name)}</span><span class="status-param-value">${hh}:${mm}</span></div>`;
                html += '</div>';
                _statusHUDPrev[prevKey] = m;
            } else if (isFixed) {
                // 固定ステータス: 生値表示、%・バーなし
                html += `<div class="status-cell status-cell-fixed" data-char="${escapeHTML(charName)}" data-param="${escapeHTML(p.name)}">`;
                html += `<div class="status-cell-label"><span class="status-param-name">${escapeHTML(p.name)}</span><span class="status-param-value">${rawVal}</span></div>`;
                html += '</div>';
                _statusHUDPrev[prevKey] = rawVal;
            } else {
                const clamped = Math.max(-100, Math.min(100, rawVal));
                // バー幅: -100→0%, 0→50%, 100→100% に線形変換
                const barPct = (clamped + 100) / 2;
                const prevVal = _statusHUDPrev[prevKey];
                const changed = (typeof prevVal === 'number' && prevVal !== clamped);
                const diffCls = changed
                    ? (clamped > prevVal ? 'status-cell changed up' : 'status-cell changed down')
                    : 'status-cell';
                html += `<div class="${diffCls}" data-char="${escapeHTML(charName)}" data-param="${escapeHTML(p.name)}">`;
                html += `<div class="status-cell-label"><span class="status-param-name">${escapeHTML(p.name)}</span><span class="status-param-value">${clamped}%</span></div>`;
                html += `<div class="status-bar"><div class="status-bar-center"></div><div class="status-bar-fill" style="width: ${barPct}%"></div></div>`;
                html += '</div>';
                _statusHUDPrev[prevKey] = clamped;
            }
        });
        html += '</div></div>';
    });
    grid.innerHTML = html;
}

// ======== END QUEST UI SYSTEM ========

// ======== CHAT LOG HTML EXPORT ========

/**
 * chatHistory の各エントリを表示用セグメントに変換する純粋関数。
 * DOM 操作なし。
 * @returns {Array<{role, speakerName, content, avatarSrc, isNarrator}>}
 */
function parseChatHistoryToSegments() {
    const members = getActivePartyMembers();

    // SVG フォールバックアイコン（appendMessage と同じ定義）
    const userSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23aaa' d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>";
    const narratorSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23c0a0ff' d='M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z'/></svg>";
    const unknownCharSvg = UNKNOWN_CHAR_SVG;

    function getCharAvatar(name) {
        if (name === 'ナレーション' || name === 'Narrator' || name === 'System') return narratorSvg;
        const member = findMemberBySpeaker(name, members);
        return (member && member.avatar) ? member.avatar : unknownCharSvg;
    }

    const segments = [];

    chatHistory.forEach(entry => {
        // Image generation entries
        if (entry.isImage && entry.imageData) {
            const promptText = entry.content.replace('[Generated Image]\nPrompt: ', '');
            segments.push({
                role: 'image',
                speakerName: 'Generated Image',
                content: promptText,
                avatarSrc: '',
                isNarrator: false,
                imageData: entry.imageData
            });
            return;
        }
        if (entry.role === 'user') {
            segments.push({
                role: 'user',
                speakerName: userConfig.name,
                content: entry.content,
                avatarSrc: userConfig.avatar || userSvg,
                isNarrator: false
            });
            return;
        }

        // assistant メッセージ
        const fullReply = entry.content;

        if (members.length === 1 && !/\[SPEAKER:\s*[^\]]+\]/i.test(fullReply)) {
            // SPEAKERタグがない場合のみ1人扱いの単一ブロックとして処理
            const name = members[0].name;
            segments.push({
                role: 'char',
                speakerName: name,
                content: applyMacros(fullReply, name),
                avatarSrc: getCharAvatar(name),
                isNarrator: false
            });
            return;
        }

        // マルチキャラ: [SPEAKER:] タグがあるか確認
        const tagRegex = /\[SPEAKER:\s*([^\]]+)\]/gi;
        if (!tagRegex.test(fullReply)) {
            // フォールバック: 名前プレフィックスで分割（splitAndAppendCharMessages と同ロジック）
            const namePatterns = members.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            const nameGroup = namePatterns.join('|');
            const fallbackRegex = new RegExp(
                '(?=(?:^|\\n)\\s*(?:'
                + '\\*\\*(?:' + nameGroup + ')\\**\\s*[：:]\\s*\\**'
                + '|【(?:' + nameGroup + ')】'
                + '|[―—](?:' + nameGroup + ')[―—]'
                + '|(?:' + nameGroup + ')\\s*[：:]'
                + '|(?:' + nameGroup + ')「'
                + '))', 'g');
            const parts = fullReply.split(fallbackRegex).filter(s => s.trim());
            parts.forEach(seg => {
                let trimmed = seg.trim();
                let speakerName = members[0].name;
                for (const m of members) {
                    const esc = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const prefixPatterns = [
                        new RegExp('^\\*\\*' + esc + '\\**\\s*[：:]\\s*\\**\\s*', ''),
                        new RegExp('^【' + esc + '】\\s*', ''),
                        new RegExp('^[―—]' + esc + '[―—]\\s*', ''),
                        new RegExp('^' + esc + '\\s*[：:]\\s*', ''),
                        new RegExp('^' + esc + '(?=「)', ''),
                    ];
                    for (const pRegex of prefixPatterns) {
                        if (pRegex.test(trimmed)) {
                            speakerName = m.name;
                            trimmed = trimmed.replace(pRegex, '');
                            break;
                        }
                    }
                }
                if (trimmed) {
                    segments.push({
                        role: 'char',
                        speakerName,
                        content: applyMacros(trimmed, speakerName),
                        avatarSrc: getCharAvatar(speakerName),
                        isNarrator: speakerName === 'ナレーション' || speakerName === 'Narrator'
                    });
                }
            });
            return;
        }

        // タグベース分割
        tagRegex.lastIndex = 0;
        const tagSegments = [];
        let match;
        let lastIndex = 0;
        while ((match = tagRegex.exec(fullReply)) !== null) {
            if (tagSegments.length === 0 && match.index > 0) {
                const preText = fullReply.substring(0, match.index).trim();
                if (preText) tagSegments.push({ speaker: 'ナレーション', content: preText });
            } else if (tagSegments.length > 0) {
                tagSegments[tagSegments.length - 1].content = fullReply.substring(lastIndex, match.index).trim();
            }
            tagSegments.push({ speaker: match[1].trim(), content: '' });
            lastIndex = tagRegex.lastIndex;
        }
        if (tagSegments.length > 0) {
            tagSegments[tagSegments.length - 1].content = fullReply.substring(lastIndex).trim();
        }

        tagSegments.forEach(seg => {
            const cleanContent = seg.content.replace(/\[SPEAKER:\s*[^\]]+\]/gi, '').trim();
            if (!cleanContent) return;
            const speakerLower = seg.speaker.trim().toLowerCase();
            if (speakerLower === userConfig.name.toLowerCase()) return; // {{user}}発言は除外
            const realMember = findMemberBySpeaker(seg.speaker, members);
            const speakerName = realMember ? realMember.name : seg.speaker;
            segments.push({
                role: 'char',
                speakerName,
                content: applyMacros(cleanContent, speakerName),
                avatarSrc: getCharAvatar(speakerName),
                isNarrator: speakerName === 'ナレーション' || speakerName === 'Narrator'
            });
        });
    });

    return segments;
}

/**
 * セッション全体をJSONファイルとして保存する（チャット履歴 + パーティ + ユーザー設定 + ロア + クエスト）。
 */
function saveChatSession() {
    if (chatHistory.length === 0) {
        alert('保存するチャット履歴がありません。');
        return;
    }
    const members = getActivePartyMembers();
    const defaultName = (members.length > 0 ? members.map(m => m.name).join('・') : 'Chat')
        + '_' + new Date().toISOString().slice(0, 10);
    const saveName = prompt('セーブ名を入力してください:', defaultName);
    if (!saveName) return;

    const saveData = {
        spec: "rp_engine_save_v1",
        spec_version: "1.0",
        metadata: {
            saveName: saveName,
            timestamp: Date.now(),
            partyId: getPartyId(),
            partyNames: members.map(m => m.name),
            playerName: userConfig.name,
            questName: (activeQuest && activeQuest.template && activeQuest.template.metadata)
                ? activeQuest.template.metadata.name : null,
            messageCount: chatHistory.filter(m => !m.isImage).length
        },
        data: {
            chatHistory: chatHistory.map(entry => {
                const saved = { role: entry.role, content: entry.content };
                if (entry.isImage) saved.isImage = true;
                if (entry.alternatives && entry.alternatives.length > 1) {
                    saved.alternatives = entry.alternatives;
                    saved.activeIndex = entry.activeIndex;
                }
                return saved;
            }),
            party: characterDataArray,
            userConfig: { ...userConfig },
            commonLorebook: commonLorebook,
            activeQuest: activeQuest,
            contextSummary: contextSummary || '',
            lastSummarizedIndex: lastSummarizedIndex || 0
        }
    };

    const blob = new Blob([JSON.stringify(saveData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rp_save_' + saveName.replace(/[\\/:*?"<>|]/g, '_') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * JSONセーブファイルからセッションを復元する。
 */
function loadChatSession(file) {
    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const json = JSON.parse(event.target.result);
            if (json.spec !== "rp_engine_save_v1") {
                alert('認識できないセーブファイル形式です。');
                return;
            }
            const meta = json.metadata || {};
            const partyStr = (meta.partyNames || []).join(', ') || '不明';
            const dateStr = meta.timestamp ? new Date(meta.timestamp).toLocaleString('ja-JP') : '不明';
            const confirmMsg = 'セーブデータをロードしますか？\n\n'
                + 'セーブ名: ' + (meta.saveName || '不明') + '\n'
                + 'パーティ: ' + partyStr + '\n'
                + 'メッセージ数: ' + (meta.messageCount || '?') + '\n'
                + 'クエスト: ' + (meta.questName || 'なし') + '\n'
                + '保存日時: ' + dateStr + '\n\n'
                + '※ 現在の会話履歴とパーティ設定は上書きされます。';
            if (!confirm(confirmMsg)) return;

            const data = json.data;

            // パーティ復元
            characterDataArray = data.party || [null, null, null];
            safeSetItem('savedParty', JSON.stringify(characterDataArray));

            // ユーザー設定復元
            if (data.userConfig) {
                Object.assign(userConfig, {
                    name:        data.userConfig.name        || 'User',
                    personality: data.userConfig.personality || '',
                    description: data.userConfig.description || '',
                    scenario:    data.userConfig.scenario    || '',
                    first_mes:   data.userConfig.first_mes   || '',
                    mes_example: data.userConfig.mes_example || '',
                    avatar:      data.userConfig.avatar      || '',
                    sdPrompt:    data.userConfig.sdPrompt    || '',
                    lorebook:    data.userConfig.lorebook    || []
                });
                saveUserConfig();
            }

            // ワールドロア復元
            commonLorebook = data.commonLorebook || [];
            localStorage.setItem('savedCommonLore', JSON.stringify(commonLorebook));

            // チャット履歴復元
            chatHistory = data.chatHistory || [];
            saveChatHistory();

            // コンテキスト要約復元
            contextSummary = data.contextSummary || '';
            lastSummarizedIndex = data.lastSummarizedIndex || 0;
            saveContextSummary();

            // クエスト復元
            activeQuest = data.activeQuest || null;
            saveActiveQuest();

            // UI全体を再描画
            renderPartySheet();
            renderPartySetGrid();
            updateEditTabNames();
            renderChatFromHistory();
            updateQuestHUD();
            updateImggenButtonVisibility();

            alert('セーブデータをロードしました: ' + (meta.saveName || ''));
        } catch (err) {
            alert('セーブファイルの読み込みに失敗しました: ' + err.message);
        }
    };
    reader.readAsText(file);
}

/**
 * チャットログをスタンドアロン HTML ファイルとしてダウンロードする。
 */
async function exportChatLog() {
    if (chatHistory.length === 0) {
        alert('エクスポートするチャット履歴がありません。');
        return;
    }

    const segments = parseChatHistoryToSegments();
    const members = getActivePartyMembers();

    // ===== 事前登録画像を base64 で埋め込む =====
    // HTML ログは配布先でフォルダを参照できないため、本文中の {img:タグ} を
    // 実ファイルの data URL に置き換えて自己完結させる。
    const imgTagRe = /\{img:\s*([a-zA-Z0-9_\-ぁ-んァ-ヶ一-龠]+)\s*\}/g;
    const imgDataUrls = new Map(); // tag → dataURL
    if (imageLibraryEnabled && _imgDirHandle) {
        const wanted = new Set();
        segments.forEach(seg => {
            if (seg.role === 'image' || !seg.content) return;
            let m;
            imgTagRe.lastIndex = 0;
            while ((m = imgTagRe.exec(seg.content)) !== null) wanted.add(m[1]);
        });
        if (wanted.size > 0) {
            if (!_imgDirGranted) _imgDirGranted = await ensureImageDirPermission();
            if (_imgDirGranted) {
                showToast('🖼️ 画像 ' + wanted.size + ' 件を HTML に埋め込んでいます…');
                for (const tag of wanted) {
                    const entry = findByTag(imageCatalog, tag);
                    if (!entry) continue;
                    const dataUrl = await getImageDataUrl(_imgDirHandle, entry.file, entry.subDir);
                    if (dataUrl) imgDataUrls.set(tag, dataUrl);
                }
            } else {
                showToast('🖼️ フォルダの許可が無いため画像は埋め込まれません', 'error');
            }
        }
    }
    /** エスケープ済み本文の {img:タグ} を <img> に置換（未解決のタグは削除） */
    const embedImageTags = (escaped) => escaped.replace(imgTagRe, (full, tag) => {
        const url = imgDataUrls.get(tag);
        return url ? `<img src="${url}" alt="${tag}" class="export-library-image">` : '';
    });

    // ファイル名用のタイトル
    const questName = (activeQuest && activeQuest.template && activeQuest.template.metadata && activeQuest.template.metadata.name)
        ? activeQuest.template.metadata.name
        : (members.length > 0 ? members.map(m => m.name).join('・') : 'Chat');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = 'chatlog_' + questName.replace(/[\\/:*?"<>|]/g, '_') + '_' + timestamp + '.html';

    // セグメントを HTML バブルに変換
    function segToHtml(seg) {
        // Image entries
        if (seg.role === 'image') {
            const escapedPrompt = seg.content
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `
        <div class="msg image-export">
          <div class="image-export-container">
            <img src="data:image/png;base64,${seg.imageData}" alt="Generated scene" class="export-generated-image">
            <div class="export-prompt-text">${escapedPrompt}</div>
          </div>
        </div>`;
        }
        const isUser = seg.role === 'user';
        const isNarrator = seg.isNarrator;
        const escapedContent = embedImageTags(
            seg.content
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '<br>')
        );
        const escapedName = seg.speakerName
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        if (isNarrator) {
            return `
        <div class="msg narrator">
          <img class="avatar" src="${seg.avatarSrc}" alt="ナレーション">
          <div class="bubble narrator-bubble">${escapedContent}</div>
        </div>`;
        }
        if (isUser) {
            return `
        <div class="msg user">
          <div class="bubble user-bubble">
            <div class="speaker">${escapedName}</div>
            ${escapedContent}
          </div>
          <img class="avatar" src="${seg.avatarSrc}" alt="${escapedName}">
        </div>`;
        }
        return `
        <div class="msg char">
          <img class="avatar" src="${seg.avatarSrc}" alt="${escapedName}">
          <div class="bubble char-bubble">
            <div class="speaker">${escapedName}</div>
            ${escapedContent}
          </div>
        </div>`;
    }

    const bubblesHtml = segments.map(segToHtml).join('\n');

    // クエスト情報バナー
    let questBannerHtml = '';
    if (activeQuest && activeQuest.template) {
        const qt = activeQuest.template;
        const tagsHtml = (qt.metadata.tags || []).map(t => `<span class="tag">${t.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>`).join(' ');
        questBannerHtml = `
      <div class="quest-banner">
        <div class="quest-banner-title">📜 ${qt.metadata.name.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
        <div class="quest-banner-tags">${tagsHtml}</div>
      </div>`;
    }

    // パーティ情報
    const partyNames = members.map(m => m.name).join(' / ');
    const exportDateStr = new Date().toLocaleString('ja-JP');

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chat Log — ${questName.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      background: #0f1117;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 2rem 1rem;
    }
    .page-header {
      max-width: 760px;
      margin: 0 auto 1.5rem;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 1.2rem 1.5rem;
    }
    .page-header h1 {
      font-size: 1.2rem;
      color: #a0a6b5;
      font-weight: 400;
    }
    .page-header .meta {
      margin-top: 0.4rem;
      font-size: 0.82rem;
      color: #666;
    }
    .quest-banner {
      max-width: 760px;
      margin: 0 auto 1.2rem;
      background: rgba(124, 77, 255, 0.12);
      border: 1px solid rgba(124, 77, 255, 0.3);
      border-radius: 12px;
      padding: 0.9rem 1.2rem;
    }
    .quest-banner-title {
      font-size: 1rem;
      font-weight: 600;
      color: #c9b8ff;
    }
    .quest-banner-tags {
      margin-top: 0.4rem;
    }
    .tag {
      display: inline-block;
      background: rgba(124,77,255,0.2);
      color: #b8a0ff;
      border-radius: 20px;
      padding: 0.15rem 0.6rem;
      font-size: 0.75rem;
      margin-right: 0.3rem;
    }
    .chat-log {
      max-width: 760px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .msg {
      display: flex;
      align-items: flex-start;
      gap: 0.7rem;
    }
    .msg.user {
      flex-direction: row-reverse;
    }
    .msg.narrator {
      justify-content: center;
    }
    .avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      background: #1a1d26;
    }
    .bubble {
      max-width: 68%;
      padding: 0.65rem 0.9rem;
      border-radius: 16px;
      line-height: 1.55;
      font-size: 0.92rem;
    }
    .char-bubble {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-top-left-radius: 4px;
    }
    .user-bubble {
      background: rgba(124, 77, 255, 0.25);
      border: 1px solid rgba(124, 77, 255, 0.35);
      border-top-right-radius: 4px;
      text-align: right;
    }
    .narrator-bubble {
      max-width: 90%;
      background: rgba(80, 70, 120, 0.25);
      border-left: 3px solid rgba(180, 160, 255, 0.5);
      border-radius: 8px;
      font-style: italic;
      color: #c0b8e0;
      padding: 0.6rem 1rem;
    }
    .speaker {
      font-size: 0.75rem;
      font-weight: 600;
      margin-bottom: 0.3rem;
      opacity: 0.7;
      letter-spacing: 0.03em;
    }
    .page-footer {
      max-width: 760px;
      margin: 2rem auto 0;
      text-align: center;
      font-size: 0.75rem;
      color: #444;
    }
    .image-export { justify-content: center; padding: 8px 0; }
    .image-export-container { text-align: center; max-width: 90%; }
    .export-generated-image {
      max-width: 100%; border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    }
    .export-prompt-text {
      font-size: 0.72em; color: rgba(255,255,255,0.3);
      margin-top: 5px; word-break: break-word;
    }
    .export-library-image {
      display: block; max-width: 100%; max-height: 420px;
      width: auto; height: auto; margin: 10px 0;
      border-radius: 10px; border: 1px solid rgba(255,255,255,0.1);
      object-fit: contain;
    }
  </style>
</head>
<body>
  <div class="page-header">
    <h1>📖 RP Game Engine — Chat Log</h1>
    <div class="meta">
      Party: ${partyNames.replace(/&/g,'&amp;').replace(/</g,'&lt;')} &nbsp;|&nbsp;
      Player: ${userConfig.name.replace(/&/g,'&amp;').replace(/</g,'&lt;')} &nbsp;|&nbsp;
      Export: ${exportDateStr}
    </div>
  </div>
  ${questBannerHtml}
  <div class="chat-log">
${bubblesHtml}
  </div>
  <div class="page-footer">Generated by RP Game Engine</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ======== END CHAT LOG EXPORT ========

init();
