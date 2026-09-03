/**
 * parsers.js — AI応答からの構造化タグ抽出（純粋関数群）
 *
 * main.js モジュール分割の第一歩。グローバル状態に依存しない純粋関数のみを置く。
 * 今後の分割候補: dice.js (parseDiceNotation/rollDiceNotation), macros.js (applyMacros) など。
 */

/**
 * [CHOICES]...[/CHOICES] ブロックから選択肢配列を抽出し、本文から除去する。
 * 想定フォーマット:
 *   [CHOICES]
 *   1. 選択肢A
 *   2. 選択肢B
 *   3. 選択肢C
 *   [/CHOICES]
 * 閉じタグ欠落（LLM が出し忘れ / EOS で途切れ）にもフォールバックで対応。
 * 戻り値: { choices: string[], cleanedContent: string }
 */
export function parseChoicesTag(content) {
    if (!content) return { choices: [], cleanedContent: content || '' };

    let block = null;
    let cleanedContent = content;

    // 1. 正規ペア [CHOICES]...[/CHOICES]
    const pairRegex = /\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/i;
    const pairMatch = content.match(pairRegex);
    if (pairMatch) {
        block = pairMatch[1];
        cleanedContent = content.replace(pairRegex, '').trim();
    } else {
        // 2. フォールバック: 閉じタグ欠落
        //    [CHOICES] 以降を末尾まで取得。ただし次の主要タグ（[INFO] / [SPEAKER:）が来たらそこで止める。
        //    ※ INFO は本関数より前に抽出・除去済みのため、通常は末尾まで安全に取れる。
        const openMatch = content.match(/\[CHOICES\]([\s\S]*)$/i);
        if (openMatch) {
            let rest = openMatch[1];
            const stopMatch = rest.match(/\[\/?INFO\]|\[SPEAKER:/i);
            if (stopMatch) rest = rest.slice(0, stopMatch.index);
            block = rest;
            cleanedContent = content.slice(0, openMatch.index).trim();
        }
    }

    if (block === null) return { choices: [], cleanedContent: content };

    const choices = [];
    block.split(/\n/).forEach(line => {
        // 行頭の番号と区切り（. ) : 、）を許容
        const m = line.trim().match(/^[0-9]+\s*[.):、]\s*(.+)$/);
        if (m && m[1].trim()) choices.push(m[1].trim());
    });

    // フォールバックで番号行が1つも取れなかった場合は誤検出を避けて元の本文を保持
    if (choices.length === 0 && !pairMatch) {
        return { choices: [], cleanedContent: content };
    }

    return { choices, cleanedContent };
}

/**
 * AI応答から {img:tag_name} を抽出し、本文からは除去する。
 * 事前登録画像ライブラリ（Layer 2）のトリガー。
 * 戻り値: { tags: string[], cleanedContent: string }
 */
export function parseImageTags(content) {
    if (!content) return { tags: [], cleanedContent: content || '' };
    const re = /\{img:\s*([a-zA-Z0-9_\-ぁ-んァ-ヶ一-龠]+)\s*\}/g;
    const tags = [];
    let m;
    while ((m = re.exec(content)) !== null) {
        const t = m[1].trim();
        if (t) tags.push(t);
    }
    if (tags.length === 0) return { tags: [], cleanedContent: content };
    // タグ除去後に残る余分な空白・空行を軽く整える
    const cleaned = content.replace(re, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { tags, cleanedContent: cleaned };
}

/**
 * 暴走リピート（degenerate repetition loop）を圧縮する。
 * LLM が「ろ、ろ、ろ、…」のように同じ短い単位を延々繰り返す現象の後処理。
 * 同一の短い単位（1〜12文字）が threshold 回以上連続したら、3回 + 省略記号に畳む。
 * 正規表現の \1 は後方参照（固定文字列）なので線形時間で安全。
 */
export function collapseRunawayRepetition(text, threshold = 6) {
    if (!text) return text;
    const minRepeat = Math.max(2, threshold) - 1; // 「最初の1回 + \1{minRepeat,}」で threshold 回
    const re = new RegExp('([\\s\\S]{1,12}?)\\1{' + minRepeat + ',}', 'g');
    return text.replace(re, (m, unit) => {
        if (!unit || !unit.trim()) return m; // 空白のみの単位は触らない
        return unit + unit + unit + '…';
    });
}

/**
 * テキスト末尾が暴走リピートに陥っているかを判定（ストリーミング早期中断用）。
 * 早期中断は誤検出を避けるため閾値を高め（連続 8 回以上）にする。
 */
export function looksRunawayRepetition(tail) {
    if (!tail) return false;
    return /([\s\S]{1,12}?)\1{8,}/.test(tail);
}

/**
 * AI応答から [INFO]...[/INFO] ブロックを抽出。
 * 戻り値: { infoText: string|null, cleanedContent: string }
 * infoText が null なら未生成。
 */
export function parseInfoTag(content) {
    if (!content) return { infoText: null, cleanedContent: content || '' };
    const regex = /\[INFO\]([\s\S]*?)\[\/INFO\]/i;
    const match = content.match(regex);
    if (!match) return { infoText: null, cleanedContent: content };
    const infoText = (match[1] || '').trim();
    const cleanedContent = content.replace(regex, '').trim();
    return { infoText: infoText || null, cleanedContent };
}

/** 正規表現に埋め込むためのエスケープ */
function escapeForRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 話者マーカーのパターン群を作る。
 * 先頭ほど強いパターンなので順序を変えないこと（**名前**: を 名前: より先に当てる必要がある）。
 * いずれも「行頭」限定。マッチした部分はそのまま削れば表示用テキストになる
 * （「名前「」形式だけは先読みで 「 を残す）。
 */
function buildSpeakerMarkerPatterns(name) {
    const e = escapeForRegex(name);
    return [
        new RegExp('^[ \\t]*\\*\\*' + e + '\\*{0,2}[ \\t]*[：:][ \\t]*\\*{0,2}[ \\t]*'), // **名前**: / **名前:**
        new RegExp('^[ \\t]*【' + e + '】[ \\t]*'),                                       // 【名前】
        new RegExp('^[ \\t]*[―—]' + e + '[―—][ \\t]*'),                                  // ―名前―
        new RegExp('^[ \\t]*' + e + '[ \\t]*[：:][ \\t]*'),                               // 名前: / 名前：
        new RegExp('^[ \\t]*' + e + '[ \\t]*(?=[「『])')                                  // 名前「 / 名前『（括弧は残す）
    ];
}

/**
 * [SPEAKER: ナレーション] に切り替わったあと、キャラクターのセリフが続いても
 * 話者タグが再開されない——というローカルモデル特有のドリフトを補正する。
 * ナレーション扱いのまま残ると、そのブロック全体がナレーターの声・アイコンになってしまう。
 *
 * 行頭に「名前「」「名前:」「**名前**:」「【名前】」「―名前―」といった明示的な話者マーカーがあり、
 * かつ現在の話者と違う場合にだけ [SPEAKER: 名前] を挿入し、マーカー自体は表示用に削る。
 * 地の文へ埋め込まれた括弧だけのセリフ（例: 扉が開いた。「遅かったな」）は
 * 誰の発言か確定できないため、あえて手を付けない。
 *
 * @param {string} text        AI応答（[SPEAKER:] タグを含むもの）
 * @param {string[]} memberNames 登録済みキャラクター名
 * @returns {{ text: string, inserted: number }}
 */
export function recoverMissingSpeakerTags(text, memberNames) {
    if (!text || !Array.isArray(memberNames) || memberNames.length === 0) {
        return { text: text || '', inserted: 0 };
    }
    // タグが1つも無い応答は既存の「名前プレフィックス」経路が担当するので触らない
    if (!/\[SPEAKER:\s*[^\]]+\]/i.test(text)) return { text, inserted: 0 };

    const markers = memberNames
        .filter(n => n && String(n).trim())
        .map(name => ({ name, patterns: buildSpeakerMarkerPatterns(name) }));
    if (markers.length === 0) return { text, inserted: 0 };

    const tagLineRegex = /^[ \t]*\[SPEAKER:\s*([^\]]+)\]/i;
    const lines = text.split('\n');
    const out = [];
    let current = null;   // 最初のタグが出るまでは null（＝タグ前テキストには介入しない）
    let inserted = 0;

    for (const line of lines) {
        const tagMatch = tagLineRegex.exec(line);
        if (tagMatch) {
            current = tagMatch[1].trim();
            out.push(line);
            continue;
        }
        if (current !== null && line.trim()) {
            let hit = null;
            let stripped = line;
            for (const mk of markers) {
                if (mk.name === current) continue; // 既にその話者のブロック内なら何もしない
                const p = mk.patterns.find(re => re.test(line));
                if (p) { hit = mk; stripped = line.replace(p, ''); break; }
            }
            if (hit && stripped.trim()) {
                out.push('[SPEAKER: ' + hit.name + ']');
                out.push(stripped);
                current = hit.name;
                inserted++;
                continue;
            }
        }
        out.push(line);
    }

    return { text: inserted > 0 ? out.join('\n') : text, inserted };
}

