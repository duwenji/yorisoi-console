/**
 * The ecosystem's vocabulary (platform API-CHANNEL-PACKAGE, ECOSYSTEM E-9), as `core-format` holds it.
 * Values are added there first; keep these in step when the console takes a new core-format.
 */
export const ACTIVITIES = ['walk', 'cycle'] as const;
export const GENRES = ['general', 'history', 'nature', 'food', 'shopping'] as const;
export const FEATURES = [
  'slot:guide', 'slot:companion',
  'trigger:spot', 'trigger:point', 'trigger:event',
  'present:speak', 'present:card', 'present:notify', 'present:sheet', 'present:play', 'present:ambient', 'present:fullscreen',
] as const;

/** An app of the ecosystem: what it is for and what it implements (platform ECOSYSTEM E-6 ①). */
export interface KnownApp {
  name: string;
  activity: string;
  features: readonly string[];
}

/**
 * The apps of the ecosystem, by the id `minAppVersions` and `grants.apps` use (API-CHANNEL-LIST P-20,
 * API-MATERIALS I-11), as `core-format`'s `AppIds` and each app's profile have them (DES-011 N-4).
 */
export const KNOWN_APPS: Record<string, KnownApp> = {
  // SanpoGuide's SanpoProfile: walking, every feature but recorded sound (its app stage 2).
  sanpoguide: { name: '散策ガイド', activity: 'walk', features: FEATURES.filter((f) => f !== 'present:play' && f !== 'present:ambient') },
  // CycleGuide's CycleProfile: cycling, the channel's slots and its spot and point cues, read out
  // only (CycleGuide requirements F-32).
  cycleguide: { name: 'サイクルガイド', activity: 'cycle', features: ['slot:guide', 'slot:companion', 'trigger:spot', 'trigger:point', 'present:speak'] },
};

/** The apps a channel is offered in: for one of its activities, implementing all it requires (API-CHANNEL-PACKAGE G-4). */
export function appsFor(activities: readonly string[], requires: readonly string[], apps: Record<string, KnownApp> = KNOWN_APPS): string[] {
  return Object.entries(apps)
    .filter(([, app]) => activities.includes(app.activity) && requires.every((f) => app.features.includes(f)))
    .map(([id]) => id);
}

/** Version numbers no app has: what a channel or collection gets for an app that can't use it (API-CHANNEL-LIST P-21). */
export const NO_APP_VERSION = 9999;

/** What a studio is about; its producer picks one (platform API-MATERIALS「スタジオの分類」, core-format StudioCategory). */
export const STUDIO_CATEGORIES = {
  'shrine-temple': '寺社・その行事',
  event: '催し',
  food: '飲食',
  shopping: '買い物',
  sightseeing: '観光の案内',
  nature: '自然・季節',
  culture: '展示・文化',
  traffic: '交通・通行',
  community: '地域のお知らせ',
} as const;
export type StudioCategory = keyof typeof STUDIO_CATEGORIES;
export const isStudioCategory = (v: unknown): v is StudioCategory => typeof v === 'string' && Object.hasOwn(STUDIO_CATEGORIES, v);
