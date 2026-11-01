import { useSession } from '../../main';
import { type KeyFile, type PublisherKey } from '../../publisher-crypto';
/** The publisher's start page: register, then bind a key, then see where things stand. */
export declare function PublisherHome(): import("react").JSX.Element;
/** Binds a key: proves possession by signing the server's one-time challenge (ARCH-001 A-5). */
export declare function bindKey(api: ReturnType<typeof useSession>['api'], key: PublisherKey): Promise<void>;
export declare function download(file: KeyFile): void;
