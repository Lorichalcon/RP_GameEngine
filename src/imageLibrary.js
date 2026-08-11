/**
 * imageLibrary.js — 事前登録画像ライブラリ
 *
 * 画像実体はユーザーのローカルフォルダに置いたまま、File System Access API で参照する。
 * localStorage には「カタログ（タグ・説明・キャラ紐付け等のメタデータのみ）」を保存するため、
 * 数百枚を登録してもブラウザストレージ（5MB上限）をほとんど消費しない。
 *
 * ディレクトリハンドルは構造化クローンでしか永続化できないため IndexedDB に保存する
 * （localStorage は文字列のみのため不可）。
 *
 * ⚠️ File System Access API は Chrome / Edge のみ、かつ https または localhost が必要。
 */

const IDB_NAME  = 'rpengine_imglib';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'imageDir';
const CATALOG_KEY = 'imageLibraryCatalog';

/** この環境で画像ライブラリ（フォルダ参照）が使えるか */
export function isImageLibrarySupported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// ---- IndexedDB（ディレクトリハンドルの永続化） ----

function openIdb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

export async function saveDirHandle(handle) {
    try {
        const db = await openIdb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(handle, HANDLE_KEY);
            tx.oncomplete = resolve;
            tx.onerror    = () => reject(tx.error);
        });
        db.close();
        return true;
    } catch (e) {
        console.warn('[ImageLib] saveDirHandle failed:', e);
        return false;
    }
}

export async function loadDirHandle() {
    try {
        const db = await openIdb();
        const handle = await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror   = () => reject(req.error);
        });
        db.close();
        return handle;
    } catch (e) {
        console.warn('[ImageLib] loadDirHandle failed:', e);
        return null;
    }
}

export async function clearDirHandle() {
    try {
        const db = await openIdb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(HANDLE_KEY);
            tx.oncomplete = resolve;
            tx.onerror    = () => reject(tx.error);
        });
        db.close();
    } catch (e) { /* noop */ }
}

/**
 * ハンドルの読み取り権限を確認し、必要なら要求する。
 * リロード後は権限が 'prompt' に戻るため、ユーザー操作起点で呼ぶ必要がある。
 * @param {boolean} interactive false なら要求せず現在の状態だけ返す
 */
export async function verifyPermission(handle, interactive = true) {
    if (!handle || !handle.queryPermission) return false;
    const opts = { mode: 'read' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!interactive) return false;
    try {
        return (await handle.requestPermission(opts)) === 'granted';
    } catch (e) {
        return false;
    }
}

// ---- フォルダ選択・スキャン ----

export async function pickImageFolder() {
    if (!isImageLibrarySupported()) {
        throw new Error('このブラウザはフォルダ選択に対応していません（Chrome / Edge が必要）');
    }
    const handle = await window.showDirectoryPicker({ id: 'rpengine-images', mode: 'read' });
    await saveDirHandle(handle);
    return handle;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

/**
 * 直下 + 1階層下のサブフォルダを走査して画像ファイルを列挙する。
 * サブフォルダ名はキャラ名の初期値として使える（例: mahiro/smile.png → character='mahiro'）。
 * @returns {Promise<Array<{fileName:string, subDir:string}>>}
 */
export async function scanImageFiles(handle) {
    const out = [];
    if (!handle) return out;
    for await (const [name, entry] of handle.entries()) {
        if (entry.kind === 'file') {
            if (IMAGE_EXT.test(name)) out.push({ fileName: name, subDir: '' });
        } else if (entry.kind === 'directory') {
            try {
                for await (const [subName, subEntry] of entry.entries()) {
                    if (subEntry.kind === 'file' && IMAGE_EXT.test(subName)) {
                        out.push({ fileName: subName, subDir: name });
                    }
                }
            } catch (e) { /* サブフォルダ読取失敗はスキップ */ }
        }
    }
    return out;
}

// ---- 画像読み出し（Blob URL キャッシュ） ----

const _urlCache = new Map(); // 'subDir/fileName' → objectURL

function cacheKey(fileName, subDir) {
    return (subDir ? subDir + '/' : '') + fileName;
}

/** ファイルを読み出して Blob URL を返す（同一ファイルはキャッシュを再利用） */
export async function getImageUrl(handle, fileName, subDir) {
    if (!handle || !fileName) return null;
    const key = cacheKey(fileName, subDir);
    if (_urlCache.has(key)) return _urlCache.get(key);
    try {
        let dir = handle;
        if (subDir) dir = await handle.getDirectoryHandle(subDir);
        const fileHandle = await dir.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const url = URL.createObjectURL(file);
        _urlCache.set(key, url);
        return url;
    } catch (e) {
        console.warn('[ImageLib] getImageUrl failed:', key, e.message);
        return null;
    }
}

/** キャッシュ済み Blob URL を全て解放（フォルダ切替時など） */
export function revokeAllImageUrls() {
    _urlCache.forEach(url => { try { URL.revokeObjectURL(url); } catch (e) {} });
    _urlCache.clear();
}

// ---- カタログ（localStorage: メタデータのみ） ----

/**
 * カタログ1件の形:
 * { tag, file, subDir, character, description, layer: 'reactive'|'state', eventId }
 */
export function loadCatalog() {
    try {
        const raw = localStorage.getItem(CATALOG_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

/** カタログを保存用の JSON 文字列にする（実保存は main.js の safeSetItem 経由） */
export function serializeCatalog(list) {
    return JSON.stringify(list || []);
}

export function getCatalogKey() { return CATALOG_KEY; }

export function findByTag(catalog, tag) {
    if (!catalog || !tag) return null;
    const t = String(tag).trim().toLowerCase();
    return catalog.find(e => String(e.tag).trim().toLowerCase() === t) || null;
}

/** ファイル名からタグ候補を生成（拡張子除去・記号正規化） */
export function fileNameToTag(fileName) {
    return String(fileName || '')
        .replace(IMAGE_EXT, '')
        .replace(/[^a-zA-Z0-9_\-ぁ-んァ-ヶ一-龠]/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_|_$/g, '');
}

/**
 * スキャン結果を既存カタログにマージする（既存エントリは保持し、新規ファイルのみ追加）。
 * @returns {{catalog:Array, added:number}}
 */
export function mergeScanIntoCatalog(catalog, scanned) {
    const list = Array.isArray(catalog) ? catalog.slice() : [];
    const known = new Set(list.map(e => cacheKey(e.file, e.subDir)));
    const usedTags = new Set(list.map(e => String(e.tag).toLowerCase()));
    let added = 0;

    scanned.forEach(({ fileName, subDir }) => {
        if (known.has(cacheKey(fileName, subDir))) return;
        // タグ重複時は _2, _3 … を付与
        let base = fileNameToTag(fileName) || 'image';
        let tag = base, n = 2;
        while (usedTags.has(tag.toLowerCase())) tag = base + '_' + (n++);
        usedTags.add(tag.toLowerCase());

        list.push({
            tag,
            file: fileName,
            subDir: subDir || '',
            character: subDir || '',   // サブフォルダ名をキャラ名の初期値に
            description: '',
            layer: 'reactive',
            eventId: ''
        });
        added++;
    });

    return { catalog: list, added };
}

/** タグ重複の検出（大文字小文字を無視） */
export function findDuplicateTags(catalog) {
    const seen = new Map();
    const dups = new Set();
    (catalog || []).forEach(e => {
        const t = String(e.tag).toLowerCase();
        if (seen.has(t)) dups.add(e.tag);
        else seen.set(t, true);
    });
    return Array.from(dups);
}
