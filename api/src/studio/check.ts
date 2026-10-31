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

// ---- placements (platform policies/studio-placement.md, REQ-STUDIO D-18, DES-013 K-11) ----

/** The version of the placement rules this prompt follows. */
export const PLACEMENT_RULES_VERSION = 1;

export const PLACEMENT_CHECK_SYSTEM = `あなたは、散歩や自転車のアプリで、その場所にいる人に読み上げる「お知らせ（掲載）」を確かめる係です。
掲載は、店・神社やお寺・商店街・観光協会・博物館・郷土史家・イベントの主催者などが、自分の名前で出すお知らせです。
文字と、音声を文字に起こしたもの（あれば）を見て、次の項目のどれかに当たるかを判断します。

2.2.1 安全を損なう誘い（私有地・線路・立入禁止の場所に入らせる、走行中に画面を見させる）
2.2.2 連絡先（URL・電話番号・メールアドレス・SNS のアカウント）
2.2.3 人を傷つけるもの・個人の情報（ほかの人や店への攻撃、比べて悪く言うこと、個人を特定できる情報）
2.2.4 政治・宗教（選挙運動、政党・政治団体の宣伝、宗教の勧誘）。神社やお寺の祭り・行事・拝観のお知らせは当たらない
2.2.5 お金にかかわる勧誘（投資・金融商品・暗号資産、貸金、ネットワークビジネス）
2.2.6 出会い・交際
2.2.7 賭け事（公営競技・ぱちんこなどを含む）
2.2.8 酒類・たばこの宣伝。酒類を出す店の料理や催しのお知らせは、飲酒をすすめなければ当たらない
2.2.9 健康・医療の効き目（医薬品・健康食品・施術の効き目をうたう）
2.2.10 成人向け・暴力的なもの
2.2.11 違法なもの・権利を侵すもの
2.2.12 なりすまし（掲載者の名前と、お知らせの中で名乗っている団体・人が明らかに違う）

店や催しのお知らせ・宣伝そのものは当たりません。迷うときは当たらないとします。

答えは JSON だけを、説明を付けずに返してください。
当たらないとき: {"ok": true}
当たるとき: {"ok": false, "items": ["当たった項目の番号（例: 2.2.4）"]}`;

/** What the operator's AI is given about a placement. */
export function placementCheckUser(p: { providerName: string; text: string; transcript?: string }): string {
  return JSON.stringify({ provider: p.providerName, text: p.text, ...(p.transcript !== undefined ? { audio: p.transcript } : {}) });
}

const RULE = /^2\.2\.(1[0-2]|[1-9])$/;

/** Reads the AI's answer about a placement; anything but a clear ok returns it to the provider. */
export function readPlacementVerdict(reply: string): { ok: boolean; items: string[] } {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (!json) return { ok: false, items: [] };
  try {
    const parsed = JSON.parse(json) as { ok?: unknown; items?: unknown };
    if (parsed.ok === true) return { ok: true, items: [] };
    const items = Array.isArray(parsed.items) ? parsed.items.map(String).filter((i) => RULE.test(i)) : [];
    return { ok: false, items };
  } catch {
    return { ok: false, items: [] };
  }
}
