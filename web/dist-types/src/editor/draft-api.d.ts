import type { Schemas } from '@yorisoi-console/api-types';
import type { Auth } from '../auth';
import type { Kind } from './draft';
/**
 * The draft's ZIP to and from the console API (API-001 C-28). It goes as bytes, so it uses
 * `fetch` rather than the JSON client; errors are the same Problem Details.
 */
export interface StoredDraft {
    zip: Uint8Array;
    rev: number;
}
/** The saved draft, or undefined when there is none. */
export declare function loadDraft(auth: Auth, kind: Kind, id: string): Promise<StoredDraft | undefined>;
/** Saves over [rev] (undefined for the first save, API-001 C-28) and returns the summary. */
export declare function saveDraft(auth: Auth, kind: Kind, id: string, zip: Uint8Array, rev: number | undefined): Promise<Schemas['Draft']>;
export declare function deleteDraft(auth: Auth, kind: Kind, id: string, rev: number): Promise<void>;
/** Bytes from a presigned URL (an owner's own submission, API-001 C-30). */
export declare function download(url: string): Promise<Uint8Array>;
