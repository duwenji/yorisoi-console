/**
 * Signing keys (in KMS) and keysets (signed by the root key offline, ARCH-001 A-8, A-9). The steps:
 * register a KMS key here, copy the keyset input to the offline machine, sign it with
 * `sanpo-root-key sign-keyset`, and paste the signed keyset back.
 */
export declare function KeysPage(): import("react").JSX.Element;
