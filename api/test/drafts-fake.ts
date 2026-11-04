import type { DraftDeps } from '../src/console/deps.js';

/** The drafts' bucket in memory (DES-014), with what was asked of it. */
export function memoryDrafts(): DraftDeps & { objects: Map<string, Uint8Array>; checks: { kind: string; id: string }[]; existing: Set<string> } {
  const objects = new Map<string, Uint8Array>();
  const checks: { kind: string; id: string }[] = [];
  const existing = new Set<string>();
  return {
    objects,
    checks,
    existing,
    put: async (key, bytes) => void objects.set(key, bytes),
    get: async (key) => objects.get(key) ?? Promise.reject(new Error(`no ${key}`)),
    remove: async (key) => void objects.delete(key),
    uploadExists: async (key) => existing.has(key),
    presignPublic: async (key) => `https://public.example/${key}?signed`,
    invokeCheck: async (event) => void checks.push(event),
  };
}
