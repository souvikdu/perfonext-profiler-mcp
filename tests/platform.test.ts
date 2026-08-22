import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeProfileUrl,
  isInsideRoot,
  splitLines,
  toFilePath,
  toPosixPath,
} from '../src/platform.js';

describe('toPosixPath', () => {
  it('converts backslashes to slashes', () => {
    expect(toPosixPath('C:\\proj\\src\\app.js')).toBe('C:/proj/src/app.js');
    expect(toPosixPath('static/chunks/main.js')).toBe('static/chunks/main.js');
  });
});

describe('toFilePath', () => {
  it('converts unix file:// URLs with Node fileURLToPath', () => {
    expect(toFilePath('file:///app/src/foo.js')).toBe(fileURLToPath('file:///app/src/foo.js'));
  });

  it('converts Windows drive file:// URLs with Node fileURLToPath', () => {
    expect(toFilePath('file:///C:/Users/dev/app.js')).toBe(
      fileURLToPath('file:///C:/Users/dev/app.js'),
    );
  });

  it('decodes percent-encoded spaces', () => {
    expect(toFilePath('file:///app/My%20Project/foo.js')).toBe(
      fileURLToPath('file:///app/My%20Project/foo.js'),
    );
  });

  it('returns absolute unix paths as-is', () => {
    expect(toFilePath('/home/user/project/src/foo.js')).toBe('/home/user/project/src/foo.js');
  });

  it('returns Windows drive paths as-is', () => {
    expect(toFilePath('C:\\Users\\dev\\app.js')).toBe('C:\\Users\\dev\\app.js');
  });

  it('returns UNC paths as-is', () => {
    expect(toFilePath('\\\\host\\share\\file.js')).toBe('\\\\host\\share\\file.js');
  });

  it('returns null for http URLs', () => {
    expect(toFilePath('http://example.com/foo.js')).toBeNull();
  });

  it('returns null for node: builtins', () => {
    expect(toFilePath('node:fs')).toBeNull();
  });

  it('returns null for empty input and relative paths', () => {
    expect(toFilePath('')).toBeNull();
    expect(toFilePath('src/foo.js')).toBeNull();
  });

  it('returns null for malformed percent-encoding', () => {
    expect(toFilePath('file:///app/%ZZ/foo.js')).toBeNull();
  });
});

describe('canonicalizeProfileUrl', () => {
  it('leaves unix file:// URLs unchanged', () => {
    expect(canonicalizeProfileUrl('file:///app/src/foo.js')).toBe('file:///app/src/foo.js');
  });

  it('round-trips percent-encoded spaces and keeps scoped package names', () => {
    expect(canonicalizeProfileUrl('file:///app/My%20Project/foo.js')).toBe(
      'file:///app/My%20Project/foo.js',
    );
    expect(canonicalizeProfileUrl('file:///app/node_modules/@babel/core/index.js')).toBe(
      'file:///app/node_modules/@babel/core/index.js',
    );
  });

  it('normalizes Windows drive file:// URLs to POSIX file://', () => {
    expect(canonicalizeProfileUrl('file:///C:/Users/dev/app.js')).toBe(
      'file:///C:/Users/dev/app.js',
    );
  });

  it('normalizes Windows drive filesystem paths to POSIX file://', () => {
    expect(canonicalizeProfileUrl('C:\\Users\\dev\\app.js')).toBe('file:///C:/Users/dev/app.js');
  });

  it('normalizes UNC paths to POSIX file://', () => {
    expect(canonicalizeProfileUrl('\\\\host\\share\\file.js')).toBe('file://host/share/file.js');
  });

  it('leaves node:, http:, and empty URLs untouched', () => {
    expect(canonicalizeProfileUrl('node:fs')).toBe('node:fs');
    expect(canonicalizeProfileUrl('http://example.com/foo.js')).toBe('http://example.com/foo.js');
    expect(canonicalizeProfileUrl('')).toBe('');
  });
});

describe('isInsideRoot', () => {
  it('accepts a path inside the root', () => {
    const inside = resolve(process.cwd(), 'src/index.ts');
    expect(isInsideRoot(inside)).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(isInsideRoot(process.cwd())).toBe(true);
  });

  it('rejects a path outside the root', () => {
    expect(isInsideRoot('/etc/passwd')).toBe(false);
  });

  it('rejects a path that traverses above the root via ..', () => {
    const escaped = resolve(process.cwd(), '../../etc/passwd');
    expect(isInsideRoot(escaped)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('rejects a different Windows drive', () => {
    expect(isInsideRoot('D:\\other\\file.js', 'C:\\proj')).toBe(false);
  });
});

describe('splitLines', () => {
  it('splits LF, CRLF, and CR without leaving \\r on lines', () => {
    expect(splitLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps a trailing empty line', () => {
    expect(splitLines('a\n')).toEqual(['a', '']);
  });
});
