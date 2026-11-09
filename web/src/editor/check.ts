import { BUILTIN_PRODUCERS, RESOURCE_MIME, VOCABULARY as V } from '@yorisoi-console/protocol/vocabulary';
import { packageZip, getIn, resourcesOf, cuesOf, collectionsOf, type Draft, type Json, type Resource } from './draft';

/**
 * What the screen checks before a draft may be submitted (DES-014 R-9): the rules of
 * platform API-CHANNEL-PACKAGE and API-MATERIALS a form can see. The machine review (R-16)
 * checks the rest; this only keeps a submission from using the day's count to find these.
 */

export interface Problem {
  /** Where, as the screen names it (e.g. 「基本: 名前」, 「素材 old-photo」). */
  where: string;
  message: string;
}

export interface Context {
  /** The registered channel or collection id. */
  id: string;
  /** The account id the package must name (`publisher` / `producer`). */
  accountId?: string | undefined;
  latestApprovedVersion?: number | undefined;
}

const ID = /^[a-z0-9-]{1,40}$/;
const OSM = /^(node|way|relation)\/\d+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ACCOUNT = /^sg1[a-z2-7]{32}$/;
const TAG = /^[a-z][a-z0-9-]{0,29}$/;
const URL_IN_TEXT = /https?:\/\/|www\./i;
const MAX_PACKAGE = 2 * 1024 * 1024 - 4 * 1024; // what signature.json adds, with room
const IMAGE_IN_PACKAGE = 300 * 1024;
const IMAGE_OUTSIDE = 1024 * 1024;
const LIMITS: Record<string, { bytes: number; seconds?: number }> = {
  image: { bytes: IMAGE_OUTSIDE }, audio: { bytes: 10 * 1024 * 1024, seconds: 600 }, video: { bytes: 50 * 1024 * 1024, seconds: 300 },
};

export const chars = (s: string) => [...s].length;
const isString = (v: unknown): v is string => typeof v === 'string';
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : []);

/** API-CHANNEL-PACKAGE F-2: what a slot (and a grounding text) may not hold. */
export function forbiddenText(value: string): string | undefined {
  if (value.charCodeAt(0) === 0xfeff) return 'BOM を含められません';
  if (value.includes('\r')) return '改行に CR を含められません（LF だけにしてください）';
  if (value.includes('{{')) return '「{{」を書けません';
  if (URL_IN_TEXT.test(value)) return 'URL（http://・https://・www.）を書けません';
  if (/^#/m.test(value)) return '見出し（# で始まる行）を書けません';
  return undefined;
}

function textLength(out: Problem[], where: string, value: unknown, min: number, max: number) {
  if (!isString(value) || chars(value) < min || chars(value) > max) out.push({ where, message: `${min}〜${max} 文字にしてください` });
}

function oneOf(out: Problem[], where: string, value: unknown, allowed: readonly string[]) {
  if (!isString(value) || !allowed.includes(value)) out.push({ where, message: `次から選んでください: ${allowed.join('・')}` });
}

function list(out: Problem[], where: string, value: unknown, allowed: readonly string[], min: number, max: number) {
  const items = strings(value);
  if (!Array.isArray(value) || items.length !== value.length) return void out.push({ where, message: '一覧になっていません' });
  if (items.length < min || items.length > max) out.push({ where, message: `${min}〜${max} 個にしてください` });
  const unknown = items.filter((x) => !allowed.includes(x));
  if (unknown.length) out.push({ where, message: `知らない値: ${unknown.join('・')}` });
  if (new Set(items).size !== items.length) out.push({ where, message: '同じ値が重なっています' });
}

function header(out: Problem[], m: Json, ctx: Context, owner: 'publisher' | 'producer') {
  if (m.format !== 1) out.push({ where: '基本: 形式', message: 'format は 1 です' });
  if (m.id !== ctx.id) out.push({ where: '基本: ID', message: `id は ${ctx.id} です` });
  if (!Number.isInteger(m.version) || (m.version as number) < 1) out.push({ where: '基本: 版', message: '1 以上の整数にしてください' });
  else if (ctx.latestApprovedVersion !== undefined && (m.version as number) <= ctx.latestApprovedVersion) {
    out.push({ where: '基本: 版', message: `最後に承認された版 ${ctx.latestApprovedVersion} より大きくしてください` });
  }
  if (ctx.accountId && m[owner] !== ctx.accountId) out.push({ where: `基本: ${owner}`, message: `あなたのアカウントID ${ctx.accountId} にしてください` });
  textLength(out, '基本: 名前', m.name, 1, 20);
  textLength(out, '基本: 要約', m.summary, 1, 60);
  if (m.lang !== 'ja') out.push({ where: '基本: 言語', message: '今は ja だけです' });
}

/** The magic bytes of a JPEG, PNG or WebP. */
export function imageFormat(bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'webp';
  return undefined;
}

function resources(out: Problem[], d: Draft, inCollection: boolean) {
  const items = resourcesOf(d);
  const grounding = inCollection && getIn(d.manifest, ['grants', 'grounding']) === true;
  if (inCollection && items.length === 0) out.push({ where: '素材', message: '素材集には素材が 1 つ以上要ります' });
  if (items.length > 500) out.push({ where: '素材', message: '500 個までです' });
  const byId = new Map<string, Resource>();
  for (const r of items) {
    if (byId.has(r.id)) out.push({ where: `素材 ${r.id}`, message: 'ID が重なっています' });
    byId.set(r.id, r);
  }
  const files = new Set<string>();
  let external = 0;
  let prefetch = 0;
  for (const r of items) {
    const where = `素材 ${r.id || '（ID なし）'}`;
    if (!ID.test(r.id ?? '')) out.push({ where, message: 'ID は英小文字・数字・ハイフンの 1〜40 文字です' });
    oneOf(out, `${where}: 種類`, r.type, V.materialTypes);
    const file = r.file;
    if (isString(file) === isString(r.url)) out.push({ where, message: 'パッケージの中のファイルか外部の URL の、どちらか一方にしてください' });
    if (isString(file)) {
      files.add(file);
      const bytes = d.files[file];
      if (r.type !== 'text' && r.type !== 'image') out.push({ where, message: 'パッケージに入れられるのはテキストと画像だけです（音声・映像は外部の URL に）' });
      if (r.type === 'text' && !/^resources\/text\/[^/]+\.md$/.test(file)) out.push({ where, message: 'テキストは resources/text/<名前>.md に置きます' });
      if (r.type === 'image' && !/^resources\/img\/[^/]+\.(jpg|png|webp)$/.test(file)) out.push({ where, message: '画像は resources/img/<名前>.jpg・.png・.webp に置きます' });
      if (!bytes) out.push({ where, message: `ファイル ${file} がありません` });
      else if (r.type === 'text') {
        const value = new TextDecoder().decode(bytes);
        if (chars(value.trim()) === 0 || chars(value.trim()) > V.textChars) out.push({ where, message: `本文は 1〜${V.textChars} 文字です` });
        if (value.includes('\r')) out.push({ where, message: '改行に CR を含められません' });
        if (URL_IN_TEXT.test(value)) out.push({ where, message: '本文に URL を書けません（出典は credit.source に）' });
        if (grounding && value.includes('{{')) out.push({ where, message: 'AI の根拠にする素材集の本文に「{{」を書けません' });
      } else if (r.type === 'image') {
        if (bytes.length > IMAGE_IN_PACKAGE) out.push({ where, message: 'パッケージの中の画像は 300KB までです' });
        if (!imageFormat(bytes)) out.push({ where, message: 'JPEG・PNG・WebP の画像にしてください' });
      }
    }
    if (isString(r.url)) {
      if (!r.url.startsWith('https://')) out.push({ where, message: 'URL は https:// で始めてください' });
      if (r.type === 'text') out.push({ where, message: 'テキストは外部の URL に置けません' });
      if (!HEX64.test(String(r.sha256 ?? ''))) out.push({ where, message: 'SHA-256 を 16 進数 64 文字（小文字）で入れてください' });
      const size = Number(r.size);
      const limit = LIMITS[r.type];
      if (!Number.isInteger(size) || size < 1) out.push({ where, message: '大きさ（バイト数）を入れてください' });
      else if (limit && size > limit.bytes) out.push({ where, message: `${Math.round(limit.bytes / 1024 / 1024)}MB までです` });
      else {
        external += size;
        if (r.type !== 'video') prefetch += size;
      }
      if (!(RESOURCE_MIME[r.type] ?? []).includes(String(r.mime))) out.push({ where, message: `形式（mime）は ${(RESOURCE_MIME[r.type] ?? []).join('・')} から選んでください` });
    }
    if (r.type === 'audio' || r.type === 'video') {
      const seconds = Number(r.durationSec);
      if (!Number.isFinite(seconds) || seconds <= 0) out.push({ where, message: '長さ（秒）を入れてください' });
      else if (seconds > (LIMITS[r.type]!.seconds ?? Infinity)) out.push({ where, message: `${LIMITS[r.type]!.seconds! / 60} 分までです` });
      if (byId.get(String(r.transcript))?.type !== 'text') out.push({ where, message: '書き起こし（テキストの素材）を選んでください' });
      if (r.type === 'video' && r.poster !== undefined && byId.get(String(r.poster))?.type !== 'image') out.push({ where, message: '最初に見せる絵は画像の素材にしてください' });
    }
    if (r.type === 'image') {
      textLength(out, `${where}: 代替テキスト`, r.alt, 1, 120);
      if (grounding && isString(r.alt) && (r.alt.includes('{{') || URL_IN_TEXT.test(r.alt))) out.push({ where, message: 'AI の根拠にする素材集の代替テキストに「{{」・URL を書けません' });
    }
    if (r.type !== 'text') {
      textLength(out, `${where}: 作者`, getIn(r, ['credit', 'author']), 1, 80);
      textLength(out, `${where}: ライセンス`, getIn(r, ['credit', 'license']), 1, 40);
      const source = getIn(r, ['credit', 'source']);
      if (source !== undefined && !(isString(source) && source.startsWith('https://'))) out.push({ where: `${where}: 出典`, message: 'https:// で始まる URL にしてください' });
    }
    if (inCollection) {
      const tags = strings(r.tags);
      if (tags.length > 3) out.push({ where: `${where}: タグ`, message: '3 個までです' });
      if (tags.some((t) => !TAG.test(t))) out.push({ where: `${where}: タグ`, message: '英小文字で始まる英小文字・数字・ハイフンの 1〜30 文字です' });
      if (r.about !== undefined) about(out, `${where}: 題材`, r.about as Json);
    }
  }
  if (external > 200 * 1024 * 1024) out.push({ where: '素材', message: '外部の素材は合計 200MB までです' });
  if (prefetch > 50 * 1024 * 1024) out.push({ where: '素材', message: '映像を除いた外部の素材は合計 50MB までです' });
  for (const path of Object.keys(d.files)) {
    if (path.startsWith('resources/') && !files.has(path)) out.push({ where: 'ファイル', message: `${path} を指している素材がありません` });
  }
}

function about(out: Problem[], where: string, a: Json) {
  const lat = Number(a.lat);
  const lon = Number(a.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) out.push({ where, message: '位置（緯度・経度）を入れてください' });
  if (a.type === 'spot') {
    if (!OSM.test(String(a.osm ?? ''))) out.push({ where, message: 'OSM の ID（node/…・way/…・relation/…）を入れてください' });
    if (a.name !== undefined) textLength(out, `${where}: 名前`, a.name, 1, 60);
  } else if (a.type === 'point') {
    const r = Number(a.radiusM);
    if (!Number.isInteger(r) || r < 20 || r > 300) out.push({ where, message: '半径は 20〜300m です' });
  } else {
    out.push({ where, message: 'スポットか地点にしてください' });
  }
}

/** The aliases a `source` may name: `self`, the declared collections and selectors. */
function aliases(d: Draft): Set<string> {
  const named = collectionsOf(d).map((c) => String(c.as));
  const selectors = Array.isArray(d.manifest.selectors) ? (d.manifest.selectors as Json[]).map((s) => String(s.as)) : [];
  return new Set([...named, ...selectors]);
}

/** Whether a source candidate can be resolved by the screen; returns why not. */
function candidate(value: string, d: Draft, declared: Set<string>, byId: Map<string, Resource>): string | undefined {
  if (value.startsWith('builtin:')) return value in BUILTIN_PRODUCERS ? undefined : `知らない組み込みの素材提供者 ${value}`;
  const [alias, id] = value.split('#') as [string, string | undefined];
  if (alias === 'self') return id && byId.has(id) ? undefined : `同梱の素材 ${id ?? ''} がありません`;
  return declared.has(alias) ? undefined : `宣言していない素材集・基準 ${alias}`;
}

function cues(out: Problem[], d: Draft) {
  const items = cuesOf(d);
  const byId = new Map(resourcesOf(d).map((r) => [r.id, r]));
  const declared = aliases(d);
  const used = new Set<string>();
  if (items.length > 500) out.push({ where: 'きっかけ', message: '500 個までです' });
  if (items.filter((c) => getIn(c, ['trigger', 'any']) === true).length > 5) out.push({ where: 'きっかけ', message: '題材を問わないきっかけは 5 個までです' });
  const ids = new Set<string>();
  for (const cue of items) {
    const where = `きっかけ ${String(cue.id ?? '（ID なし）')}`;
    if (!ID.test(String(cue.id ?? ''))) out.push({ where, message: 'ID は英小文字・数字・ハイフンの 1〜40 文字です' });
    if (ids.has(String(cue.id))) out.push({ where, message: 'ID が重なっています' });
    ids.add(String(cue.id));
    const trigger = (cue.trigger ?? {}) as Json;
    if (trigger.type === 'spot') {
      if (trigger.any === true) list(out, `${where}: スポットの種類`, trigger.categories, Object.keys(V.spotKinds), 1, 8);
      else if (!OSM.test(String(trigger.osm ?? ''))) out.push({ where, message: 'OSM の ID（node/…・way/…・relation/…）を入れてください' });
      if (trigger.name !== undefined) textLength(out, `${where}: 名前`, trigger.name, 1, 60);
    } else if (trigger.type === 'point') {
      about(out, where, { ...trigger, type: 'point' });
    } else if (trigger.type === 'event') {
      oneOf(out, `${where}: 出来事`, trigger.event, V.cueEvents);
    } else {
      out.push({ where, message: '題材（スポット・地点・出来事）を選んでください' });
    }
    if (cue.narration !== undefined) {
      if (trigger.type !== 'spot') out.push({ where, message: '語り（置き換え・後に足す）はスポットのきっかけだけです' });
      oneOf(out, `${where}: 語り`, cue.narration, V.narration);
    }
    if (cue.repeat !== undefined) {
      if (trigger.event === 'idle') out.push({ where, message: '語りの合間のきっかけには繰り返しを書けません' });
      oneOf(out, `${where}: 繰り返し`, cue.repeat, V.repeat);
    }
    const present = Array.isArray(cue.present) ? (cue.present as Json[]) : [];
    if (present.length < 1 || present.length > 4) out.push({ where, message: '見せ方は 1〜4 個です' });
    present.forEach((p, i) => {
      const at = `${where}: 見せ方 ${i + 1}`;
      const as = String(p.as);
      const types = (V.presentAs as Record<string, string[]>)[as];
      if (!types) return void out.push({ where: at, message: `見せ方を選んでください: ${Object.keys(V.presentAs).join('・')}` });
      const own = [...(isString(p.resource) ? [p.resource] : []), ...strings(p.resources)];
      const sources = [...(isString(p.source) ? [[p.source]] : Array.isArray(p.source) ? [strings(p.source)] : []), ...(Array.isArray(p.sources) ? (p.sources as unknown[]).map((s) => (isString(s) ? [s] : strings(s))) : [])];
      if (own.length === 0 && sources.length === 0) out.push({ where: at, message: '素材か素材提供者を選んでください' });
      if (own.length > 0 && sources.length > 0) out.push({ where: at, message: '同梱の素材と素材提供者の参照のどちらか一方にしてください' });
      if (as !== 'sheet' && (own.length > 1 || sources.length > 1)) out.push({ where: at, message: '複数並べられるのは解説の画面（sheet）だけです' });
      if (as === 'sheet' && own.length + sources.length > 10) out.push({ where: at, message: '解説の画面に並べられるのは 10 個までです' });
      for (const id of own) {
        const r = byId.get(id);
        if (!r) out.push({ where: at, message: `素材 ${id} がありません` });
        else if (!types.includes(r.type)) out.push({ where: at, message: `${as} で ${r.type} の素材は出せません（${types.join('・')}）` });
        else if (r.type === 'text' && (as === 'card' || as === 'notify') && r.file && d.files[r.file as string]) {
          const max = as === 'card' ? 200 : 100;
          if (chars(new TextDecoder().decode(d.files[r.file as string]!).trim()) > max) out.push({ where: at, message: `${as} のテキストは ${max} 文字までです` });
        }
      }
      for (const group of sources) {
        if (group.length < 1 || group.length > 3) out.push({ where: at, message: '素材提供者の候補は 1〜3 個です' });
        for (const value of group) {
          const why = candidate(value, d, declared, byId);
          if (why) out.push({ where: at, message: why });
          used.add(value.split('#')[0]!);
          if (trigger.event === 'idle' && value !== 'builtin:studio' && value !== 'builtin:note') out.push({ where: at, message: '語りの合間に出せるのはスタジオと一言だけです' });
          if (value === 'builtin:ai-guide' && cue.narration !== undefined) out.push({ where, message: 'AI の解説を候補に入れたきっかけには語りを書けません' });
        }
      }
      if (p.params !== undefined && (typeof p.params !== 'object' || p.params === null || Array.isArray(p.params))) out.push({ where: at, message: '指示（params）は JSON のオブジェクトです' });
    });
  }
  for (const alias of declared) if (!used.has(alias)) out.push({ where: `素材集 ${alias}`, message: 'どのきっかけでも使っていません（使わない宣言は拒まれます）' });
}

function declarations(out: Problem[], d: Draft) {
  const items = collectionsOf(d);
  if (items.length > 5) out.push({ where: '素材集', message: '5 個までです' });
  const seen = new Set<string>();
  for (const c of items) {
    const where = `素材集 ${String(c.as ?? '')}`;
    const as = String(c.as ?? '');
    if (!/^[a-z0-9-]{1,20}$/.test(as) || as === 'self' || as === 'builtin') out.push({ where, message: '別名は英小文字・数字・ハイフンの 1〜20 文字です（self・builtin は使えません）' });
    if (seen.has(as)) out.push({ where, message: '別名が重なっています' });
    seen.add(as);
    if (!/^[a-z0-9-]{3,40}$/.test(String(c.id ?? ''))) out.push({ where, message: '素材集の ID を入れてください' });
    if (!Number.isInteger(c.minVersion) || (c.minVersion as number) < 1) out.push({ where, message: '最低の版は 1 以上の整数です' });
  }
}

function channel(out: Problem[], d: Draft) {
  const m = d.manifest;
  list(out, '基本: 過ごし方', m.activities, V.activities, 1, 4);
  list(out, '基本: ジャンル', m.genres ?? [], V.genres, 0, 3);
  list(out, '基本: 必要な機能', getIn(m, ['requires', 'features']) ?? [], V.features, 0, 20);
  textLength(out, '基本: あいさつ', m.greeting, 1, 60);
  oneOf(out, '話し方: 話す頻度', getIn(m, ['talk', 'level']), V.talkLevels);
  for (const e of V.talkEvents) {
    const on = getIn(m, ['talk', 'events', e]);
    // preview・chat・song may be left out: they are on then (platform REQ-NEARBY-TALK F-29).
    if (on === undefined && V.talkEventsOptional.includes(e)) continue;
    if (typeof on !== 'boolean') out.push({ where: `話し方: 出来事 ${e}`, message: '話すかどうかを選んでください' });
  }
  const kinds = Object.keys(V.spotKinds);
  list(out, '話し方: 優先するスポット', getIn(m, ['spots', 'prefer']), kinds, 0, 8);
  list(out, '話し方: 話題にしないスポット', getIn(m, ['spots', 'skip']), kinds, 0, kinds.length);
  const both = strings(getIn(m, ['spots', 'prefer'])).filter((k) => strings(getIn(m, ['spots', 'skip'])).includes(k));
  if (both.length) out.push({ where: '話し方: スポット', message: `優先と話題にしないを重ねられません: ${both.join('・')}` });
  oneOf(out, '話し方: 解説の長さ', getIn(m, ['guide', 'length']), V.guideLengths);
  if (typeof getIn(m, ['mood', 'tone']) !== 'boolean') out.push({ where: '話し方: 雰囲気', message: '合わせるかどうかを選んでください' });
  oneOf(out, '話し方: 背景音', getIn(m, ['mood', 'sound']), V.sounds);

  let total = 0;
  for (const [path, max] of Object.entries(V.slots)) {
    const bytes = d.files[path];
    if (!bytes) continue;
    const value = new TextDecoder().decode(bytes);
    total += chars(value);
    if (chars(value) > max) out.push({ where: `プロンプト ${path}`, message: `${max} 文字までです（今 ${chars(value)} 文字）` });
    const why = forbiddenText(value);
    if (why) out.push({ where: `プロンプト ${path}`, message: why });
  }
  if (total > V.slotsTotal) out.push({ where: 'プロンプト', message: `合計 ${V.slotsTotal} 文字までです（今 ${total} 文字）` });
  for (const path of Object.keys(d.files)) {
    if (!path.startsWith('resources/') && !(path in V.slots)) out.push({ where: 'ファイル', message: `${path} はパッケージに入れられません` });
  }
  resources(out, d, false);
  declarations(out, d);
  cues(out, d);
}

function collection(out: Problem[], d: Draft) {
  const m = d.manifest;
  const publishers = getIn(m, ['grants', 'publishers']);
  if (publishers !== '*') {
    const ids = strings(publishers);
    if (ids.length < 1 || ids.length > 50 || ids.length !== (publishers as unknown[] | undefined)?.length) out.push({ where: '利用許諾: チャンネル提供者', message: '「誰でも」か、アカウントIDを 1〜50 個にしてください' });
    if (ids.some((x) => !ACCOUNT.test(x))) out.push({ where: '利用許諾: チャンネル提供者', message: 'アカウントID（sg1…）の形になっていません' });
  }
  const apps = getIn(m, ['grants', 'apps']);
  if (apps !== undefined && (strings(apps).length < 1 || strings(apps).length > 20)) out.push({ where: '利用許諾: アプリ', message: '1〜20 個にしてください（すべてのアプリなら選ばない）' });
  for (const path of Object.keys(d.files)) if (!path.startsWith('resources/')) out.push({ where: 'ファイル', message: `${path} は素材集に入れられません` });
  resources(out, d, true);
}

export function check(d: Draft, ctx: Context): Problem[] {
  const out: Problem[] = [];
  header(out, d.manifest, ctx, d.kind === 'channel' ? 'publisher' : 'producer');
  if (d.kind === 'channel') channel(out, d);
  else collection(out, d);
  const size = packageZip(d).length;
  if (size > MAX_PACKAGE) out.push({ where: 'パッケージ', message: `署名すると 2MB を超えます（今 ${Math.ceil(size / 1024)}KB。大きな画像は外部の URL に）` });
  if (d.kind === 'channel' && d.icon && (d.icon.length > 100 * 1024 || imageFormat(d.icon) !== 'png')) out.push({ where: '申請: アイコン', message: 'PNG で 100KB 以下にしてください' });
  return out;
}

