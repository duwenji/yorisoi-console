#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { checkProvider, title } from './check.js';

const USAGE = `sanpo-conformance <provider base URL> [--provider sc1…] [--min-seq N] [--allow-local-http] [--json]

Checks a SanpoGuide channel provider against API-CHANNEL-LIST. Exits with 1 if any check fails.
Pass --provider with the provider id you got by another route; it is never taken from the URL.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: 'string' },
      'min-seq': { type: 'string' },
      'allow-local-http': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const base = positionals[0];
  if (!base) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const results = await checkProvider(base, {
    ...(values.provider ? { expectedProvider: values.provider } : {}),
    ...(values['min-seq'] ? { minSeq: Number(values['min-seq']) } : {}),
    allowLocalHttp: values['allow-local-http'],
  });
  if (values.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) console.log(`${r.status.toUpperCase().padEnd(4)} ${r.id} ${title(r.id)}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  if (results.some((r) => r.status === 'fail')) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
