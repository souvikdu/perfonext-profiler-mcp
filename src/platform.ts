import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_ABS = /^[A-Za-z]:[\\/]/;

/**
 * Convert `\\` to `/` for artifact / URL identity. Never use the result with `readFile`.
 */
export function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/');
}

/**
 * Convert a `file://` URL or absolute filesystem path to a native path.
 * Returns null for other schemes (`http:`, `node:`), relative paths, empty input,
 * and malformed percent-encoding.
 */
export function toFilePath(urlOrPath: string): string | null {
  if (!urlOrPath) {
    return null;
  }

  if (urlOrPath.startsWith('file:')) {
    try {
      return fileURLToPath(urlOrPath);
    } catch {
      return null;
    }
  }

  // Other URL schemes. Windows drive letters (`C:\...`) look like a scheme — keep those.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(urlOrPath) && !WINDOWS_ABS.test(urlOrPath)) {
    return null;
  }

  if (urlOrPath.startsWith('/') || WINDOWS_ABS.test(urlOrPath) || urlOrPath.startsWith('\\\\')) {
    return urlOrPath;
  }

  return null;
}

/**
 * Encode a POSIX path for a file:// URL without using pathToFileURL.
 * encodeURI keeps `@` (scoped packages) and encodes spaces.
 */
function encodeFileUrlPath(posixPath: string): string {
  return encodeURI(posixPath).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/**
 * POSIX `file://` URL for a filesystem path or `file://` input.
 * Built without `pathToFileURL` so a Unix profile stays Unix on Windows CI
 * and a Windows profile stays Windows on macOS.
 */
function toFileUrl(urlOrPath: string): string | null {
  const filePath = toFilePath(urlOrPath);
  if (filePath === null) {
    return null;
  }

  const posix = encodeFileUrlPath(toPosixPath(filePath));
  if (WINDOWS_ABS.test(filePath)) {
    return `file:///${posix}`;
  }
  if (filePath.startsWith('\\\\')) {
    return `file:${posix}`;
  }
  return posix.startsWith('/') ? `file://${posix}` : `file:///${posix}`;
}

/**
 * Canonicalize a V8 callFrame URL at ingest. Filesystem paths and `file://` URLs
 * become one POSIX `file://` form. Other schemes (`node:`, `http:`) and empty
 * strings are left untouched.
 */
export function canonicalizeProfileUrl(url: string): string {
  return toFileUrl(url) ?? url;
}

/**
 * True when `target` is inside `root` (default: process cwd).
 * Uses `path.relative` so other-drive Windows paths are rejected.
 * When both paths exist, compares realpaths so a symlink cannot escape the root.
 */
export function isInsideRoot(target: string, root: string = process.cwd()): boolean {
  let resolvedRoot = resolve(root);
  let resolvedTarget = resolve(target);

  if (existsSync(resolvedRoot) && existsSync(resolvedTarget)) {
    try {
      resolvedRoot = realpathSync(resolvedRoot);
      resolvedTarget = realpathSync(resolvedTarget);
    } catch {
      // Fall back to the lexical check if realpath fails (race, permissions).
    }
  }

  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === '') {
    return true;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * Split source text on LF, CRLF, or CR. Repo files stay LF; profiled sources may not.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}
