#!/usr/bin/env node
// Copies packages and their runtime dependency closure out of node_modules
// into a staging directory, so the Docker runner stage can add packages that
// the Next.js standalone trace misses: packages loaded with a dynamic
// import() (like @rynfar/meridian) and the platform-specific native packages
// they pick at runtime (like @libsql/linux-x64-musl).
//
// Packages are resolved the way Node resolves them (nested node_modules
// first, then parent directories), so the staged tree has exactly the
// versions npm installed. Merging it over the standalone node_modules only
// adds files: any package both contain comes from the same install.
//
// Optional dependencies that npm skipped (wrong platform) are skipped here
// too. A missing required dependency fails the build.
//
// Usage:
//   node docker/stage-runtime-deps.mjs <outDir> <package>... [--exclude <pattern>]...
//
// A pattern matches a package name exactly, or by prefix when it ends in "*".
// Excluded packages are neither copied nor traversed.

import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

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

function isExcluded(name, excludes) {
  return excludes.some((pattern) =>
    pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  );
}

// Node's lookup: <dir>/node_modules/<name> for dir and each parent, skipping
// directories that are themselves named node_modules, stopping at root.
function resolvePackageDir(name, fromDir, root) {
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

function collectClosure(root, packages, excludes) {
  const staged = new Map(); // package dir -> package name
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
    const peerMeta = manifest.peerDependenciesMeta ?? {};
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dep, fromDir: pkgDir, optional: optionalDeps.has(dep), requiredBy: name });
    }
    for (const dep of optionalDeps) {
      queue.push({ name: dep, fromDir: pkgDir, optional: true, requiredBy: name });
    }
    // Peers come from the installing project: stage the installed ones and
    // fail only on a missing peer that isn't marked optional.
    for (const dep of Object.keys(manifest.peerDependencies ?? {})) {
      queue.push({ name: dep, fromDir: pkgDir, optional: peerMeta[dep]?.optional === true, requiredBy: name });
    }
  }
  return staged;
}

function sizeOf(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + sizeOf(join(path, entry)), 0);
}

const { outDir, packages, excludes } = parseArgs(process.argv.slice(2));
const root = process.cwd();
const staged = collectClosure(root, packages, excludes);

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

const names = [...staged.values()].sort();
console.log(`Staged ${names.length} packages (${(totalBytes / 1024 / 1024).toFixed(1)} MiB) into ${outDir}:`);
for (const name of names) console.log(`  ${name}`);
