/**
 * The ecosystem's vocabulary (platform API-003, ADR-003 E-9), as `core-format` holds it.
 * Values are added there first; keep these in step when the console takes a new core-format.
 */
export const ACTIVITIES = ['walk', 'cycle'] as const;
export const GENRES = ['general', 'history', 'nature', 'food', 'shopping'] as const;
export const FEATURES = [
  'slot:guide', 'slot:companion',
  'trigger:spot', 'trigger:point', 'trigger:event',
  'present:speak', 'present:card', 'present:notify', 'present:sheet', 'present:play', 'present:ambient', 'present:fullscreen',
] as const;

/** An app of the ecosystem: what it is for and what it implements (platform ADR-003 E-6 ①). */
export interface KnownApp {
  name: string;
  activity: string;
  features: readonly string[];
}

/**
 * The apps of the ecosystem, by the id `minAppVersions` and `grants.apps` use (API-002 P-20,
 * API-004 I-11), as `core-format`'s `AppIds` and each app's profile have them (DES-011 N-4).
 */
export const KNOWN_APPS: Record<string, KnownApp> = {
  // SanpoGuide's SanpoProfile: walking, every feature but recorded sound (its app stage 2).
  sanpoguide: { name: '散策ガイド', activity: 'walk', features: FEATURES.filter((f) => f !== 'present:play' && f !== 'present:ambient') },
  // CycleGuide's profile: cycling, the channel's slots read out. Cues and what they show come with
  // its app stage 2 (CycleGuide requirements F-26).
  cycleguide: { name: 'サイクルガイド', activity: 'cycle', features: ['slot:guide', 'slot:companion', 'present:speak'] },
};

/** The apps a channel is offered in: for one of its activities, implementing all it requires (API-003 G-4). */
export function appsFor(activities: readonly string[], requires: readonly string[], apps: Record<string, KnownApp> = KNOWN_APPS): string[] {
  return Object.entries(apps)
    .filter(([, app]) => activities.includes(app.activity) && requires.every((f) => app.features.includes(f)))
    .map(([id]) => id);
}

/** Version numbers no app has: what a channel or collection gets for an app that can't use it (API-002 P-21). */
export const NO_APP_VERSION = 9999;
