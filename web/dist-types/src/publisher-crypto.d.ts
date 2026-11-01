export declare const MIN_PASSPHRASE = 12;
declare const b64url: {
    encode: (bytes: Uint8Array) => string;
    decode: (text: string) => Uint8Array;
};
export { b64url };
export declare function sha256(data: Uint8Array): Promise<Uint8Array>;
/** `sg1` + base32(SHA-256(public key)), first 32 characters: the same as the server and core-format. */
export declare function accountIdOf(publicKey: Uint8Array): Promise<string>;
/** Whether this browser can make and use Ed25519 keys (recent Chrome, Edge, Firefox and Safari can). */
export declare function ed25519Supported(): Promise<boolean>;
export interface PublisherKey {
    accountId: string;
    publicKey: Uint8Array;
    privateKey: CryptoKey;
}
/** What the publisher saves: the private key, encrypted with their passphrase. */
export interface KeyFile {
    type: 'sanpo-publisher-key';
    version: 1;
    accountId: string;
    publicKey: string;
    kdf: {
        name: 'PBKDF2';
        hash: 'SHA-256';
        iterations: number;
        salt: string;
    };
    cipher: {
        name: 'AES-GCM';
        iv: string;
    };
    encryptedPrivateKey: string;
}
/** Makes a new key and its key file. */
export declare function createKey(passphrase: string): Promise<{
    key: PublisherKey;
    file: KeyFile;
}>;
/** Opens a key file with its passphrase; a wrong passphrase or a damaged file is an error. */
export declare function openKeyFile(text: string, passphrase: string): Promise<PublisherKey>;
export declare function sign(key: PublisherKey, message: Uint8Array): Promise<Uint8Array>;
export interface SignedPackage {
    zip: Uint8Array;
    channel: string;
    version: number;
    files: string[];
}
/** A channel package (API-CHANNEL-PACKAGE F-6). */
export declare function signPackage(zip: Uint8Array, key: PublisherKey, expect: {
    channel: string;
}): Promise<SignedPackage>;
/** A collection package (API-MATERIALS, DES-010 N-3): the same, as its producer. */
export declare function signCollectionPackage(zip: Uint8Array, key: PublisherKey, expect: {
    collection: string;
}): Promise<{
    zip: Uint8Array;
    version: number;
    files: string[];
}>;
