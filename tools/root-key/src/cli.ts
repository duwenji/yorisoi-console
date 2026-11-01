#!/usr/bin/env -S npx tsx
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateRootKey, signKeyset, verifyKeyset, type KeysetInput } from './root-key.js';

const USAGE = `sanpo-root-key — the provider's root key, on an offline machine (ARCH-001 A-9)

  generate --out <dir>
      Creates root-key.pem (encrypted with $ROOT_KEY_PASSPHRASE) and root-key.pub.
      Prints the provider id. Keep copies of the .pem offline, in more than one place.

  sign-keyset --root-key <root-key.pem> --in <keyset-input.json> --out <keyset.json>
      Signs a keyset. The input is { "seq", "keys": [{ keyId, publicKey, notBefore, notAfter }], "revokedKeys" }.
      Register the output in the operator screen.

  verify-keyset --in <keyset.json> --root-public-key <base64url> [--provider <sc1…>]
`;

function passphrase(): string {
  const value = process.env.ROOT_KEY_PASSPHRASE;
  if (!value) throw new Error('set ROOT_KEY_PASSPHRASE');
  return value;
}

/** A private key file inside a git working tree is one `git add .` away from being published. */
function insideGitRepo(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string' },
      in: { type: 'string' },
      'root-key': { type: 'string' },
      'root-public-key': { type: 'string' },
      provider: { type: 'string' },
      'allow-in-repo': { type: 'boolean', default: false },
    },
  });

  switch (command) {
    case 'generate': {
      const out = values.out ?? fail('--out is required');
      if (insideGitRepo(out) && !values['allow-in-repo']) {
        fail(`${out} is inside a git repository; choose another folder (or --allow-in-repo for a gitignored dev key)`);
      }
      if (existsSync(join(out, 'root-key.pem'))) fail(`${join(out, 'root-key.pem')} already exists; refusing to overwrite a root key`);
      const key = generateRootKey(passphrase());
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'root-key.pem'), key.privatePem, { mode: 0o600 });
      await writeFile(join(out, 'root-key.pub'), `${key.publicKey}\n`);
      console.log(`provider: ${key.provider}\nrootKey:  ${key.publicKey}`);
      return;
    }
    case 'sign-keyset': {
      const pem = await readFile(values['root-key'] ?? fail('--root-key is required'), 'utf8');
      const input = JSON.parse(await readFile(values.in ?? fail('--in is required'), 'utf8')) as KeysetInput;
      const signed = await signKeyset(input, pem, passphrase());
      await writeFile(values.out ?? fail('--out is required'), `${JSON.stringify(signed, null, 2)}\n`);
      console.log(`signed keyset seq ${input.seq} with ${signed.keyId}`);
      return;
    }
    case 'verify-keyset': {
      const signed = JSON.parse(await readFile(values.in ?? fail('--in is required'), 'utf8'));
      const keyset = verifyKeyset(signed, values['root-public-key'] ?? fail('--root-public-key is required'), values.provider);
      console.log(`ok: ${keyset.provider} seq ${keyset.seq}, keys ${keyset.keys.map((k) => k.keyId).join(', ')}`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

function fail(message: string): never {
  throw new Error(message);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
