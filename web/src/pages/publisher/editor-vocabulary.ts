import { KNOWN_APPS } from '@yorisoi-console/protocol/ecosystem';
import { VOCABULARY as BASE } from '@yorisoi-console/protocol/vocabulary';

/** The package's values (DES-014 R-10) with the apps' names, for the editor's choices. */
export const VOCABULARY = { ...BASE, apps: Object.fromEntries(Object.entries(KNOWN_APPS).map(([id, app]) => [id, app.name])) as Record<string, string> };

/** Which features each app has, as a line under the editor's choice of features. */
export const KNOWN_APPS_FOR_SCREEN = Object.values(KNOWN_APPS).map((app) => `${app.name}（${app.features.join(' ')}）`).join('、');
