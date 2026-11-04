import vocabulary from './vocabulary.json' with { type: 'json' };

/**
 * The values of a package and a collection (platform API-CHANNEL-PACKAGE, API-MATERIALS) that the
 * screens offer and check (DES-014 R-10). Kept in vocabulary.json, which the validator's tests compare
 * with core-format's own.
 */
export const VOCABULARY = vocabulary;

export type MaterialType = (typeof vocabulary.materialTypes)[number];

/** The built-in producers a cue's `source` may name (platform API-MATERIALS「組み込みの素材提供者」). */
export const BUILTIN_PRODUCERS = {
  'builtin:ai-guide': 'AI のスポットの解説',
  'builtin:ai-companion': 'AI の散歩の友の一言',
  'builtin:fallback-text': 'AI を使えないときの定型文',
  'builtin:commons-photo': 'スポットの写真（Commons）',
  'builtin:ambient': '合成の背景音',
  'builtin:mood-scene': '雰囲気の絵',
  'builtin:studio': 'スタジオ',
  'builtin:note': '一言',
} as const;

/** The MIME types an outside resource may have, by type (API-CHANNEL-PACKAGE「素材」). */
export const RESOURCE_MIME: Record<string, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  audio: ['audio/ogg', 'audio/mp4', 'audio/aac'],
  video: ['video/mp4'],
};
