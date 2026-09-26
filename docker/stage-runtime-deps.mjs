#!/usr/bin/env node
// Copies packages and their runtime dependency closure out of node_modules
// into a staging directory, for the Docker runner stage. The Next.js
// standalone trace follows static imports and requires, but not a require
// whose name is computed at runtime (libsql loads `@libsql/${target}`, its
// platform-native package) or a binary a package locates at runtime
// (Meridian finds @anthropic-ai/claude-code/bin/claude.exe). Staging the
// whole closure of such a package ships those too.
//
// Packages are resolved the way Node resolves them (nested node_modules
// first, then parent directories), so the staged tree has exactly the
// versions npm installed. Merging it over the standalone node_modules only
// adds files: any package both contain comes from the same install.
//
// Optional dependencies that npm skipped (wrong platform) are skipped here
// too, and so are peer dependencies that aren't installed (the build uses
// --legacy-peer-deps, so npm doesn't install peers on their own). A missing
// required dependency fails the build.
//
// Usage:
//   node docker/stage-runtime-deps.mjs <outDir> <package>... [--exclude <pattern>]...
//
// A pattern matches a package name exactly, or by prefix when it ends in "*".
// Excluded packages are neither copied nor traversed.

import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isExcluded(name, excludes) {
  return excludes.some((pattern) =>
    pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  );
}

// Node's lookup: <dir>/node_modules/<name> for dir and each parent, skipping
// directories that are themselves named node_modules, stopping at root.
export function resolvePackageDir(name, fromDir, root) {
  let dir = fromDir;
  for (;;) {
    if (basename(dir) !== 'node_modules') {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Returns a Map of package directory -> package name for the closure. */
export function collectClosure(root, packages, excludes = []) {
  const staged = new Map();
  const queue = packages.map((name) => ({ name, fromDir: root, optional: false, requiredBy: '(root)' }));

  while (queue.length > 0) {
    const { name, fromDir, optional, requiredBy } = queue.shift();
    if (isExcluded(name, excludes)) continue;

    const pkgDir = resolvePackageDir(name, fromDir, root);
    if (!pkgDir) {
      if (optional) continue;
      throw new Error(`${name} (required by ${requiredBy}) is not installed`);
    }
    if (staged.has(pkgDir)) continue;
    staged.set(pkgDir, name);

    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const optionalDeps = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dep, fromDir: pkgDir, optional: optionalDeps.has(dep), requiredBy: name });
    }
    for (const dep of [...optionalDeps, ...Object.keys(manifest.peerDependencies ?? {})]) {
      queue.push({ name: dep, fromDir: pkgDir, optional: true, requiredBy: name });
    }
  }
  return staged;
}

function sizeOf(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + sizeOf(join(path, entry)), 0);
}

/** Copies each staged package to the same relative path under outDir; returns the bytes copied. */
export function copyClosure(root, outDir, staged) {
  let totalBytes = 0;
  for (const pkgDir of staged.keys()) {
    const target = join(outDir, relative(root, pkgDir));
    const nestedModules = join(pkgDir, 'node_modules') + sep;
    // A package's nested node_modules holds other packages: the ones in the
    // closure are staged on their own, the rest are left out.
    cpSync(pkgDir, target, {
      recursive: true,
      dereference: true,
      filter: (src) => !(src + sep).startsWith(nestedModules),
    });
    totalBytes += sizeOf(target);
  }
  return totalBytes;
}

function parseArgs(argv) {
  const packages = [];
  const excludes = [];
  let outDir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--exclude') {
      const pattern = argv[++i];
      if (!pattern) throw new Error('--exclude needs a pattern');
      excludes.push(pattern);
    } else if (outDir === null) {
      outDir = arg;
    } else {
      packages.push(arg);
    }
  }
  if (outDir === null || packages.length === 0) {
    throw new Error('usage: stage-runtime-deps.mjs <outDir> <package>... [--exclude <pattern>]...');
  }
  return { outDir: resolve(outDir), packages, excludes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { outDir, packages, excludes } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const staged = collectClosure(root, packages, excludes);
  const totalBytes = copyClosure(root, outDir, staged);
  const names = [...staged.values()].sort();
  console.log(`Staged ${names.length} packages (${(totalBytes / 1024 / 1024).toFixed(1)} MiB) into ${outDir}:`);
  for (const name of names) console.log(`  ${name}`);
}
