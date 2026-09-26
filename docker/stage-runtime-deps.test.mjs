import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectClosure, copyClosure, isExcluded, resolvePackageDir } from './stage-runtime-deps.mjs';

let root;

// Writes <root>/<dir>/package.json (and an index.js) for a fixture package.
function pkg(dir, manifest) {
  const full = join(root, dir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(full, 'index.js'), `module.exports = ${JSON.stringify(manifest.name)};`);
  return full;
}

// Package names in the closure, sorted.
function names(staged) {
  return [...staged.values()].sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stage-deps-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectClosure', () => {
  test('follows required dependencies', () => {
    pkg('node_modules/app', { name: 'app', dependencies: { lib: '1' } });
    pkg('node_modules/lib', { name: 'lib', dependencies: { util: '1' } });
    pkg('node_modules/util', { name: 'util' });

    expect(names(collectClosure(root, ['app']))).toEqual(['app', 'lib', 'util']);
  });

  test('fails on a missing required dependency, naming who needs it', () => {
    pkg('node_modules/app', { name: 'app', dependencies: { lib: '1' } });

    expect(() => collectClosure(root, ['app'])).toThrow('lib (required by app) is not installed');
  });

  test('skips an optional dependency npm did not install', () => {
    pkg('node_modules/libsql', {
      name: 'libsql',
      optionalDependencies: { '@libsql/linux-x64-musl': '1', '@libsql/darwin-arm64': '1' },
    });
    pkg('node_modules/@libsql/linux-x64-musl', { name: '@libsql/linux-x64-musl' });

    expect(names(collectClosure(root, ['libsql']))).toEqual(['@libsql/linux-x64-musl', 'libsql']);
  });

  test('stages an installed peer and skips a missing one', () => {
    pkg('node_modules/app', { name: 'app', peerDependencies: { react: '1', zod: '1' } });
    pkg('node_modules/zod', { name: 'zod' });

    expect(names(collectClosure(root, ['app']))).toEqual(['app', 'zod']);
  });

  test('prefers a nested version over the hoisted one', () => {
    pkg('node_modules/app', { name: 'app', dependencies: { lib: '2', other: '1' } });
    const nested = pkg('node_modules/app/node_modules/lib', { name: 'lib', version: '2.0.0' });
    const hoisted = pkg('node_modules/lib', { name: 'lib', version: '1.0.0' });
    pkg('node_modules/other', { name: 'other', dependencies: { lib: '1' } });

    const staged = collectClosure(root, ['app']);

    expect(staged.has(nested)).toBe(true);
    expect(staged.has(hoisted)).toBe(true); // other's lib@1
  });

  test('resolves a dependency only a parent directory has', () => {
    pkg('node_modules/app', { name: 'app', dependencies: { lib: '1' } });
    pkg('node_modules/app/node_modules/lib', { name: 'lib', dependencies: { util: '1' } });
    const util = pkg('node_modules/util', { name: 'util' });

    expect(collectClosure(root, ['app']).has(util)).toBe(true);
  });

  test('handles scoped packages', () => {
    pkg('node_modules/@rynfar/meridian', { name: '@rynfar/meridian', dependencies: { '@anthropic-ai/sdk': '1' } });
    pkg('node_modules/@anthropic-ai/sdk', { name: '@anthropic-ai/sdk' });

    expect(names(collectClosure(root, ['@rynfar/meridian']))).toEqual(['@anthropic-ai/sdk', '@rynfar/meridian']);
  });

  test('neither stages nor traverses excluded packages', () => {
    pkg('node_modules/app', { name: 'app', optionalDependencies: { 'bin-linux-x64': '1' }, dependencies: { bin: '1' } });
    pkg('node_modules/bin-linux-x64', { name: 'bin-linux-x64', dependencies: { huge: '1' } });
    pkg('node_modules/bin', { name: 'bin' });
    pkg('node_modules/huge', { name: 'huge' });

    expect(names(collectClosure(root, ['app'], ['bin-linux-*']))).toEqual(['app', 'bin']);
  });

  test('terminates on a dependency cycle', () => {
    pkg('node_modules/a', { name: 'a', dependencies: { b: '1' } });
    pkg('node_modules/b', { name: 'b', dependencies: { a: '1' } });

    expect(names(collectClosure(root, ['a']))).toEqual(['a', 'b']);
  });
});

describe('isExcluded', () => {
  test('matches exact names and prefixes ending in *', () => {
    expect(isExcluded('foo', ['foo'])).toBe(true);
    expect(isExcluded('foo-bar', ['foo'])).toBe(false);
    expect(isExcluded('foo-bar', ['foo-*'])).toBe(true);
    expect(isExcluded('foo', ['foo-*'])).toBe(false);
  });
});

describe('resolvePackageDir', () => {
  test('stops at root', () => {
    pkg('node_modules/app', { name: 'app' });

    expect(resolvePackageDir('app', join(root, 'node_modules/app'), root)).toBe(join(root, 'node_modules/app'));
    expect(resolvePackageDir('missing', join(root, 'node_modules/app'), root)).toBeNull();
  });
});

describe('copyClosure', () => {
  test('copies staged packages but not the rest of their nested node_modules', () => {
    pkg('node_modules/app', { name: 'app', dependencies: { lib: '1' } });
    pkg('node_modules/app/node_modules/lib', { name: 'lib' });
    pkg('node_modules/app/node_modules/unused', { name: 'unused' });
    const out = join(root, 'out');

    copyClosure(root, out, collectClosure(root, ['app']));

    expect(existsSync(join(out, 'node_modules/app/index.js'))).toBe(true);
    expect(existsSync(join(out, 'node_modules/app/node_modules/lib/index.js'))).toBe(true);
    expect(existsSync(join(out, 'node_modules/app/node_modules/unused'))).toBe(false);
  });
});
