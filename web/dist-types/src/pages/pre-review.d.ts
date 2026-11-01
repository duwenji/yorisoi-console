import { type ReviewFile } from '../ai';
/**
 * The texts of a package the AI reads in the first review (platform AI-ROLES H-12): a channel's
 * `channel.json` and prompt slots; a collection's texts with each resource's alt (its settings say
 * what each is about).
 */
export declare function reviewFiles(zip: Uint8Array): ReviewFile[];
/**
 * The AI's first review (platform AI-ROLES H-12, 審査基準 2): what a person should look at, from the
 * reviewer's or the publisher's own key, called from the browser. The key stays in this page's
 * memory and never reaches the console. It never decides: the package may try to steer it.
 */
export declare function PreReview({ kind, load, who }: {
    kind: 'channel' | 'collection';
    load: () => Promise<ReviewFile[]>;
    who: 'operator' | 'provider';
}): import("react").JSX.Element;
