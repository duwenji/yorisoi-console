import { type Draft } from './draft';
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
export declare const chars: (s: string) => number;
/** API-CHANNEL-PACKAGE F-2: what a slot (and a grounding text) may not hold. */
export declare function forbiddenText(value: string): string | undefined;
/** The magic bytes of a JPEG, PNG or WebP. */
export declare function imageFormat(bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | undefined;
export declare function check(d: Draft, ctx: Context): Problem[];
