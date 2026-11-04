/**
 * A draft as the console keeps it (DES-014 R-3): one ZIP with the package's files under
 * `package/`, the submission's other inputs in `draft.json`, and the channel's `icon.png`.
 * The manifest stays a plain JSON object, so fields the screens don't edit are kept (R-11).
 */
export type Kind = 'channel' | 'collection';
export type Json = Record<string, unknown>;
/** What a submission takes besides the package (API-001 `SubmissionInput`). */
export interface Listing {
    description?: string;
    tags?: string[];
    regions?: string[];
    note?: string;
}
export interface Draft {
    kind: Kind;
    manifest: Json;
    /** The package's other files, by their path in the package (prompts/…, resources/…). */
    files: Record<string, Uint8Array>;
    listing: Listing;
    icon?: Uint8Array;
}
export declare const MANIFEST: Record<Kind, string>;
/** The draft as the console stores it. */
export declare function packDraft(d: Draft): Uint8Array;
export declare function unpackDraft(zip: Uint8Array, kind: Kind): Draft;
/** A draft from a package (a past submission or a local ZIP): its signature is dropped (R-2). */
export declare function fromPackage(zip: Uint8Array, kind: Kind, extra?: {
    listing?: Listing;
    icon?: Uint8Array;
}): Draft;
/** The package to sign, export or show the AI: the manifest and the files, unsigned. */
export declare function packageZip(d: Draft): Uint8Array;
/** A new channel with every required field (platform API-CHANNEL-PACKAGE `channel.json`). */
export declare function blankChannel(id: string, publisher: string, version: number): Draft;
/** A new collection (platform API-MATERIALS「素材集の形式」). */
export declare function blankCollection(id: string, producer: string, version: number): Draft;
export declare const fileText: (d: Draft, path: string) => string;
/** Sets a text file; an empty one is removed (an empty slot takes the standard text). */
export declare function withFileText(d: Draft, path: string, value: string): Draft;
export declare function withFile(d: Draft, path: string, bytes: Uint8Array | undefined): Draft;
/** The value at [path] in [obj], or undefined. */
export declare function getIn(obj: unknown, path: (string | number)[]): unknown;
/** A copy of [obj] with [value] at [path]; `undefined` removes the field. Missing objects are made. */
export declare function setIn<T>(obj: T, path: (string | number)[], value: unknown): T;
export declare const withManifest: (d: Draft, path: (string | number)[], value: unknown) => Draft;
export type Resource = Json & {
    id: string;
    type: string;
};
export declare const resourcesOf: (d: Draft) => Resource[];
export declare const cuesOf: (d: Draft) => Json[];
export declare const collectionsOf: (d: Draft) => Json[];
/** Replaces the resources; files no resource points at any more go with them. */
export declare function withResources(d: Draft, resources: Resource[]): Draft;
/** A copy of [d] with [field] as a list, removed when empty and the format allows leaving it out. */
export declare function withList(d: Draft, field: string, list: unknown[]): Draft;
