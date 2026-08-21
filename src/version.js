/**
 * Single source of truth for the version.
 *
 * Read from package.json rather than hardcoded, so a release bump cannot leave the
 * server advertising a stale version over the wire. Falls back gracefully if the file
 * is unreadable, since a version string is never worth crashing a server over.
 */
import { readFileSync } from 'node:fs';

let cached;

export function version() {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

export const SERVER_NAME = 'reddit-radar-mcp';
