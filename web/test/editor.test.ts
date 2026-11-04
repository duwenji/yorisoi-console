import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { check, forbiddenText } from '../src/editor/check';
import {
  blankChannel, blankCollection, fileText, fromPackage, getIn, packageZip, packDraft, resourcesOf, setIn, unpackDraft, withFileText, withList, withManifest, withResources,
  type Draft,
} from '../src/editor/draft';

// DES-014: the draft's form (R-3), keeping what the screens don't edit (R-11), and the screen's checks (R-9).

const ACCOUNT = 'sg1abcdefghijklmnopqrstuvwxyz234567';
const ctx = { id: 'kamakura-history', accountId: ACCOUNT, latestApprovedVersion: 2 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A channel the screen should take: the blank one filled in. */
function good(): Draft {
  let d = blankChannel('kamakura-history', ACCOUNT, 3);
  d = withManifest(d, ['name'], '鎌倉歴史散歩');
  d = withManifest(d, ['summary'], '鎌倉の寺社と武士の歴史を、語り部の口調で');
  d = withManifest(d, ['greeting'], 'ここからは、鎌倉の歴史をたどりながら歩きましょう。');
  return withFileText(d, 'prompts/guide/focus.md', '- 由来と、関わった人物を中心に話す\n');
}
const where = (d: Draft, c: Parameters<typeof check>[1] = ctx) => check(d, c).map((p) => p.where);

describe('the draft', () => {
  it('round-trips through the stored ZIP, with fields the screens do not edit', () => {
    let d = withManifest(good(), ['selectors'], [{ as: 'nearby', tags: ['history'] }]);
    d = withManifest(d, ['x-future'], { keep: true });
    d = { ...d, listing: { description: '説明', tags: ['history'] }, icon: PNG };
    const back = unpackDraft(packDraft(d), 'channel');
    expect(back).toEqual(d);
    expect(Object.keys(unzipSync(packDraft(d))).sort()).toEqual(['draft.json', 'icon.png', 'package/channel.json', 'package/prompts/guide/focus.md']);
  });

  it('starts from a package, dropping its signature, and gives the package back unsigned', () => {
    const manifest = { ...good().manifest, unknown: 1 };
    const zip = zipSync({ 'channel.json': strToU8(JSON.stringify(manifest)), 'signature.json': strToU8('{}'), 'prompts/guide/focus.md': strToU8('- 話す\n'), 'prompts/': new Uint8Array() });
    const d = fromPackage(zip, 'channel');
    expect(d.manifest).toEqual(manifest);
    expect(Object.keys(d.files)).toEqual(['prompts/guide/focus.md']);
    const pkg = unzipSync(packageZip(d));
    expect(Object.keys(pkg).sort()).toEqual(['channel.json', 'prompts/guide/focus.md']);
    expect(JSON.parse(strFromU8(pkg['channel.json']!))).toEqual(manifest);
    expect(() => fromPackage(zipSync({ 'prompts/a.md': strToU8('x') }), 'channel')).toThrow('channel.json がありません');
  });

  it('removes an emptied text and the files no resource points at', () => {
    let d = withFileText(good(), 'prompts/guide/focus.md', '');
    expect(d.files['prompts/guide/focus.md']).toBeUndefined();
    d = withResources(d, [{ id: 'intro', type: 'text', file: 'resources/text/intro.md' }]);
    d = withFileText(d, 'resources/text/intro.md', '鶴岡八幡宮の由来');
    expect(fileText(d, 'resources/text/intro.md')).toBe('鶴岡八幡宮の由来');
    d = withResources(d, []);
    expect(d.files).toEqual({});
    expect(withList(d, 'cues', []).manifest.cues).toBeUndefined();
  });

  it('sets and reads nested fields without touching the others', () => {
    const m = { talk: { level: 'normal', events: { spot: true } }, keep: 1 };
    const next = setIn(m, ['talk', 'events', 'rest'], false);
    expect(next).toEqual({ talk: { level: 'normal', events: { spot: true, rest: false } }, keep: 1 });
    expect(m.talk.events).toEqual({ spot: true });
    expect(getIn(setIn(m, ['talk', 'level'], undefined), ['talk'])).toEqual({ events: { spot: true } });
    expect(setIn({ list: [1, 2] }, ['list', 1], 3)).toEqual({ list: [1, 3] });
  });
});

describe('the screen’s checks (R-9)', () => {
  it('take a filled-in channel', () => {
    expect(check(good(), ctx)).toEqual([]);
  });

  it('find what the machine review would turn away', () => {
    const blank = blankChannel('kamakura-history', ACCOUNT, 2);
    expect(where(blank)).toEqual(expect.arrayContaining(['基本: 版', '基本: 名前', '基本: 要約', '基本: あいさつ']));
    expect(where(withManifest(good(), ['publisher'], 'sg1other'))).toEqual(['基本: publisher']);
    expect(where(withManifest(good(), ['name'], 'あ'.repeat(21)))).toEqual(['基本: 名前']);
    expect(where(withManifest(good(), ['spots'], { prefer: ['temple'], skip: ['temple'] }))).toEqual(['話し方: スポット']);
    expect(where(withManifest(good(), ['activities'], ['run']))).toEqual(['基本: 過ごし方']);
    expect(where(withFileText(good(), 'prompts/guide/persona.md', 'あ'.repeat(601)))).toEqual(['プロンプト prompts/guide/persona.md']);
    expect(where(withFileText(good(), 'notes.txt', 'x'))).toEqual(['ファイル']);
  });

  it('know the slots’ forbidden text (API-CHANNEL-PACKAGE F-2)', () => {
    expect(forbiddenText('- 由来を話す\n')).toBeUndefined();
    expect(forbiddenText('詳しくは https://example.com')).toMatch('URL');
    expect(forbiddenText('# 見出し')).toMatch('見出し');
    expect(forbiddenText('{{name}}')).toMatch('{{');
    expect(forbiddenText('a\r\nb')).toMatch('CR');
  });

  it('check resources, cues and declared collections together', () => {
    let d = withResources(good(), [
      { id: 'intro', type: 'text', file: 'resources/text/intro.md' },
      { id: 'photo', type: 'image', file: 'resources/img/photo.png', alt: '本宮', credit: { author: '不明', license: 'PD' } },
    ]);
    d = withFileText(d, 'resources/text/intro.md', '鶴岡八幡宮の由来');
    d = { ...d, files: { ...d.files, 'resources/img/photo.png': PNG } };
    d = withList(d, 'cues', [
      { id: 'hachimangu', trigger: { type: 'spot', osm: 'way/123456', name: '鶴岡八幡宮' }, present: [{ as: 'speak', resource: 'intro' }, { as: 'card', resource: 'photo' }] },
      { id: 'daibutsu', trigger: { type: 'spot', osm: 'way/234567' }, present: [{ as: 'card', source: ['kamakura#daibutsu', 'builtin:commons-photo'] }] },
    ]);
    d = withList(d, 'collections', [{ as: 'kamakura', id: 'kamakura-audio-guide', minVersion: 1 }]);
    expect(check(d, ctx)).toEqual([]);

    // A photo read out, a missing resource, an undeclared alias, a declaration no cue uses.
    const bad = withList(withList(d, 'collections', [{ as: 'kamakura', id: 'kamakura-audio-guide', minVersion: 1 }, { as: 'unused', id: 'other-guide', minVersion: 1 }]), 'cues', [
      { id: 'a', trigger: { type: 'spot', osm: 'way/1' }, present: [{ as: 'speak', resource: 'photo' }] },
      { id: 'b', trigger: { type: 'point', lat: 35.32, lon: 139.55, radiusM: 10 }, present: [{ as: 'play', resource: 'none' }] },
      { id: 'c', trigger: { type: 'event', event: 'idle' }, repeat: 'once', present: [{ as: 'speak', source: 'nobody#x' }] },
      { id: 'd', trigger: { type: 'spot', osm: 'way/2' }, present: [{ as: 'speak', source: 'kamakura' }] },
    ]);
    const messages = check(bad, ctx).map((p) => `${p.where}: ${p.message}`);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('speak で image の素材は出せません'),
      expect.stringContaining('素材 none がありません'),
      expect.stringContaining('半径は 20〜300m'),
      expect.stringContaining('繰り返しを書けません'),
      expect.stringContaining('宣言していない素材集・基準 nobody'),
      expect.stringContaining('素材集 unused: どのきっかけでも使っていません'),
    ]));
    // A resource whose file went, and a file no resource points at.
    const files = { ...d.files, 'resources/img/old.png': PNG };
    delete files['resources/img/photo.png'];
    expect(where({ ...d, files })).toEqual(expect.arrayContaining(['素材 photo', 'ファイル']));
  });

  it('take a collection with a subject and tags, and find its problems', () => {
    let d = blankCollection('kamakura-audio-guide', ACCOUNT, 1);
    d = withManifest(d, ['name'], '鎌倉音声ガイド');
    d = withManifest(d, ['summary'], '寺社の音声ガイド');
    d = withResources(d, [
      { id: 'intro', type: 'text', file: 'resources/text/intro.md', tags: ['history'], about: { type: 'spot', osm: 'way/123456', name: '鶴岡八幡宮', lat: 35.326, lon: 139.5565 } },
      {
        id: 'audio', type: 'audio', url: 'https://cdn.example.com/a.ogg', sha256: 'a'.repeat(64), size: 1000, durationSec: 60, mime: 'audio/ogg', transcript: 'intro',
        credit: { author: '観光協会', license: 'permission' },
      },
    ]);
    d = withFileText(d, 'resources/text/intro.md', '鶴岡八幡宮の由来');
    const c = { id: 'kamakura-audio-guide', accountId: ACCOUNT };
    expect(check(d, c)).toEqual([]);
    expect(where(withManifest(d, ['grants', 'publishers'], ['nobody']), c)).toEqual(['利用許諾: チャンネル提供者']);
    const noPlace = withResources(d, [...resourcesOf(d), { id: 'x', type: 'text', file: 'resources/text/intro.md', about: { type: 'spot', osm: 'way/1' }, tags: ['History'] }]);
    expect(where(noPlace, c)).toEqual(expect.arrayContaining(['素材 x: 題材', '素材 x: タグ']));
    expect(where(blankCollection('kamakura-audio-guide', ACCOUNT, 1), c)).toEqual(expect.arrayContaining(['素材']));
  });
});
