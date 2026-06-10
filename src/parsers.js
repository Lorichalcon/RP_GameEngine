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
