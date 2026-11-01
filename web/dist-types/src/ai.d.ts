/**
 * The review samples' AI (ARCH-001 D-4, DES-005): called from the browser with the operator's own
 * key, which lives only in the page's memory and is never sent to the console's server. Both
 * services speak the OpenAI chat-completions form; the review policy asks for two (審査基準 2.7).
 */
export interface AiService {
    id: 'openai' | 'deepseek';
    label: string;
    base: string;
    /** Which of the account's models are chat models worth offering. */
    isChatModel: (id: string) => boolean;
    /** The service's name for the reply length limit. */
    lengthParam: 'max_completion_tokens' | 'max_tokens';
}
export declare const AI_SERVICES: AiService[];
/** Chat models the key can use, newest first where the service says when they were made. */
export declare function listModels(service: AiService, key: string): Promise<string[]>;
/** One reply to a sample scene, given the system and user prompts the app would send. */
export declare function reply(service: AiService, key: string, model: string, system: string, user: string): Promise<string>;
/** One point the AI raises against the review policy (platform AI-ROLES H-12): material, not a verdict. */
export interface Concern {
    item: string;
    quote: string;
    reason: string;
}
/** A file the AI reads as material, by its path in the package. */
export interface ReviewFile {
    name: string;
    text: string;
}
/**
 * Has the AI read a package against the review policy and list what a reviewer should look at
 * (platform AI-ROLES H-12). It never approves: the package's text may try to steer it, so a person decides.
 */
export declare function preReview(service: AiService, key: string, model: string, kind: 'channel' | 'collection', files: ReviewFile[]): Promise<Concern[]>;
