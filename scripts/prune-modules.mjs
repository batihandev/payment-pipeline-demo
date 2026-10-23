// Slims a production node_modules tree for the runtime image: drops type
// declarations, sources, maps and docs, packages the Prisma CLI never loads
// for `migrate`, the interface and query-compiler files it never uses, other
// databases' runtime files, and every package no longer reachable from the
// top-level dependencies.
import process from 'node:process';
import { readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const modules = process.argv[2] ?? 'node_modules';
const store = join(modules, '.pnpm');

const unused = [/^@electric-sql\+pglite@/, /^typescript@/];
for (const entry of readdirSync(store)) {
  if (unused.some((pattern) => pattern.test(entry))) {
    rmSync(join(store, entry), { recursive: true, force: true });
  }
}

// The Prisma CLI loads these two packages at start-up but only uses their
// data modules for `migrate`; the studio interface and the local dev
// server's database assets are not needed.
for (const entry of readdirSync(store)) {
  if (entry.startsWith('@prisma+studio-core@')) {
    const dist = join(
      store,
      entry,
      'node_modules',
      '@prisma',
      'studio-core',
      'dist',
    );
    for (const name of readdirSync(dist)) {
      if (name !== 'data')
        rmSync(join(dist, name), { recursive: true, force: true });
    }
    for (const name of readdirSync(join(store, entry, 'node_modules'))) {
      if (name !== '@prisma')
        rmSync(join(store, entry, 'node_modules', name), {
          recursive: true,
          force: true,
        });
    }
  }
  if (entry.startsWith('@prisma+dev@')) {
    rmSync(
      join(
        store,
        entry,
        'node_modules',
        '@prisma',
        'dev',
        'dist',
        'runtime-assets',
      ),
      { recursive: true, force: true },
    );
  }
}

const reached = new Set();
function follow(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      follow(path);
    } else if (entry.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(path);
      } catch {
        continue;
      }
      const name = relative(realpathSync(store), target).split(sep)[0];
      if (name.startsWith('..') || reached.has(name)) continue;
      reached.add(name);
      follow(join(store, name, 'node_modules'));
    }
  }
}
follow(modules);
for (const entry of readdirSync(store)) {
  if (
    entry !== 'node_modules' &&
    !entry.startsWith('.') &&
    !reached.has(entry)
  ) {
    rmSync(join(store, entry), { recursive: true, force: true });
  }
}

const otherDatabases = /(mysql|sqlite|sqlserver|cockroach|mongodb)/;
function sweep(directory, inPrismaRuntime, inPrismaCli) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sweep(
        path,
        inPrismaRuntime || path.endsWith(`@prisma${sep}client${sep}runtime`),
        inPrismaCli || path.endsWith(`prisma${sep}build`),
      );
    } else if (entry.isFile()) {
      const dropped =
        /\.(?:[cm]?ts|map|md)$/.test(entry.name) ||
        (inPrismaCli && entry.name.startsWith('query_compiler_')) ||
        (inPrismaRuntime && otherDatabases.test(entry.name));
      if (dropped) rmSync(path);
    }
  }
}
sweep(store, false, false);
