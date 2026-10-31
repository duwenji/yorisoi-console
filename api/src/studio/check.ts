/**
 * The check before a note is placed (platform REQ-STUDIO D-6, DES-013 K-10): contact details by
 * pattern first, which costs nothing, then the operator's AI against the note terms (platform
 * policies/studio-note-terms.md 2). The prompt goes with the terms' version (K-13).
 */

/** The version of the note terms this prompt follows. */
export const NOTE_CHECK_TERMS_VERSION = 1;

const URL = /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|jp|io|co|info|me|app|dev)\b)/i;
const EMAIL = /[^\s@＠]+[@＠][^\s@＠]+\.[^\s@＠]+/;
// Ten or more digits, allowing the separators people speak or type between them; full-width too.
const PHONE = /(?:[0-9０-９][\s\-－ー‐()（）.]*){10,}/;
const HANDLE = /(^|[\s　])[@＠][A-Za-z0-9_]{2,}/;

/** True when the text carries a URL, e-mail address, phone number or account handle (terms 2-4). */
export function hasContact(text: string): boolean {
  return URL.test(text) || EMAIL.test(text) || PHONE.test(text) || HANDLE.test(text);
}

export const NOTE_CHECK_SYSTEM = `あなたは、散歩や自転車のアプリで、知らない人に読み上げる短い一言を確かめる係です。
一言は、置いた場所の近くに来たほかの人に、そのまま読み上げられます。
次のどれかに当たれば「当たる」と判断します。

1. 安全を損なう誘い: 私有地・線路・立入禁止の場所・危ない場所に入らせる、危ない行動をすすめる
2. 人を傷つけるもの: 人や店を攻撃する、差別する、脅す、嫌がらせをする
3. 人を特定する情報: 名前・住所・電話番号・顔や車の特徴など人を特定できること、「今ここに〇〇がいる」のように人の居場所を知らせること
4. 連絡先: URL・電話番号・メールアドレス・SNS のアカウント
5. 宣伝・勧誘: 店や商品・サービスの宣伝や勧誘、客を装った宣伝
6. 違法なもの・権利を侵すもの
7. 聞かせるのに合わないもの: 性的・暴力的な内容、わいせつな言葉
8. なりすまし: ほかの人・店・団体のふりをすること

景色・季節・食べたもの・感じたこと・その場所の様子や注意（「この先の坂は急です」など）は当たりません。
店の名前が出てきても、感想だけなら宣伝ではありません。迷うときは当たらないとします。

答えは JSON だけを、説明を付けずに返してください。
当たらないとき: {"ok": true}
当たるとき: {"ok": false, "items": [当たった番号]}`;

/** What the operator's AI is given: the note, and the spot's name when there is one. */
export function noteCheckUser(text: string, spotName?: string): string {
  return JSON.stringify({ note: text, ...(spotName ? { spot: spotName } : {}) });
}

/**
 * Reads the AI's answer. Anything but a clear `{"ok": true}` stops the note: what can't be checked
 * isn't placed.
 */
export function readVerdict(reply: string): { ok: boolean; items: number[] } {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (!json) return { ok: false, items: [] };
  try {
    const parsed = JSON.parse(json) as { ok?: unknown; items?: unknown };
    if (parsed.ok === true) return { ok: true, items: [] };
    const items = Array.isArray(parsed.items) ? parsed.items.filter((n): n is number => Number.isInteger(n)) : [];
    return { ok: false, items };
  } catch {
    return { ok: false, items: [] };
  }
}
