import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Harness home: `$DSH_HOME` when set, `~/.dsh` otherwise.
 */
export function dshHomeDirectory(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * Host packages whose module instance must be the host installation's own.
 *
 * A private copy is not a version problem but an identity problem: the gateway
 * reads Remote markers with its own `remoteMethods()` and the LLM runtime
 * dispatches through its own `LlmAdapter` base class, so a plugin built against
 * a second copy registers classes the host cannot recognize. The symptoms are
 * endpoints answering 404 and `prepareCall is not a function`, neither of which
 * points at the dependency tree, so the mismatch is reported at load time.
 *
 * `@deepseek-ai/schemastery` is deliberately absent: it is also duplicated by an
 * auto-installing package manager but has no identity-sensitive use here.
 */
export const SHARED_HOST_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-typert-protocol',
]

/** One package directory as a Node resolution found it. */
export interface ResolvedPackage {
  /** Real path of the package directory, symlinks collapsed. */
  path: string
  /** `version` from its manifest, when it declares one. */
  version: string | undefined
  /** Whether this is a dsh module proxy re-exporting another installation. */
  proxy: boolean
}

export interface ShadowedHostPackage {
  specifier: string
  /** The copy the plugin imports. */
  loaded: ResolvedPackage
  /** The copy the host installation resolves for the same specifier. */
  host: ResolvedPackage
}

export interface HostPackageQuery {
  specifiers?: readonly string[]
  /** File the plugin's own imports resolve from; defaults to this module. */
  loadedAnchor?: string
  /** File the host installation resolves from; defaults under `$DSH_HOME`. */
  hostAnchor?: string
}

export interface HostAuditLogger {
  warn(message: unknown): void
}

const MANIFEST = 'package.json'

function readManifest(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * A dsh-managed module proxy stands in for a package that lives inside a
 * packaged executable; it re-exports the installation's real module.
 */
function isModuleProxy(manifest: Record<string, unknown>): boolean {
  const dsh = manifest.dsh
  return dsh !== null && typeof dsh === 'object' && 'moduleFallback' in dsh
}

/**
 * Dereference the anchor the way Node dereferences a module before resolving
 * its imports. pnpm links a package into `node_modules` but keeps its
 * dependencies beside the store copy, so resolving from the link instead of the
 * store path finds nothing and would hide the very mismatch being looked for.
 * An anchor that does not exist yet (the host fallback file) stays as given.
 */
function normalizeAnchor(anchor: string): string {
  if (!anchor.startsWith('file:')) {
    try {
      return realpathSync(anchor)
    } catch {
      return anchor
    }
  }
  try {
    return realpathSync(fileURLToPath(anchor))
  } catch {
    return anchor
  }
}

/**
 * Resolve `specifier` from `anchor` to its package directory. Not every package
 * exports `./package.json`, so the resolved entry is walked upward until a
 * manifest names the package.
 */
function resolvePackage(anchor: string, specifier: string): ResolvedPackage | undefined {
  try {
    const require = createRequire(normalizeAnchor(anchor))
    let start: string
    try {
      start = dirname(require.resolve(`${specifier}/${MANIFEST}`))
    } catch {
      start = dirname(require.resolve(specifier))
    }
    for (let directory = start; ;) {
      const manifest = readManifest(join(directory, MANIFEST))
      if (manifest?.name === specifier) {
        return {
          path: directory,
          version: typeof manifest.version === 'string' ? manifest.version : undefined,
          proxy: isModuleProxy(manifest),
        }
      }
      const parent = dirname(directory)
      if (parent === directory) return undefined
      directory = parent
    }
  } catch {
    return undefined
  }
}

function shadowOf(
  specifier: string,
  loaded: ResolvedPackage | undefined,
  host: ResolvedPackage | undefined,
): ShadowedHostPackage | undefined {
  // Silence over a guess: a package that does not resolve on both sides — a host
  // that does not link this package, a layout that moved — is not a finding.
  if (loaded === undefined || host === undefined) return undefined
  if (loaded.path === host.path) return undefined
  // A dsh module proxy re-exports the installation's module, so an identical
  // version across a proxy boundary is the packaging layout doing its job and
  // the copies cannot be told apart by path. A version difference is a real
  // finding there too: the plugin would be bound to the other generation.
  if (loaded.version === host.version && (loaded.proxy || host.proxy)) return undefined
  return { specifier, loaded, host }
}

/**
 * Host packages this plugin resolves to a copy other than the host's. An empty
 * answer also means "could not tell", which is why only a resolved difference
 * is reported.
 */
export function findShadowedHostPackages(query: HostPackageQuery = {}): ShadowedHostPackage[] {
  const specifiers = query.specifiers ?? SHARED_HOST_PACKAGES
  const loadedAnchor = query.loadedAnchor ?? import.meta.url
  // `$DSH_HOME/profiles/node_modules` carries the installation dependency
  // closure for every profile, so resolving from inside it reaches the host's
  // own copy instead of this profile's pnpm-managed ones.
  const hostAnchor = query.hostAnchor
    ?? join(dshHomeDirectory(), 'profiles', 'node_modules', 'dsh-shared-host-package-audit.js')
  const shadowed: ShadowedHostPackage[] = []
  for (const specifier of specifiers) {
    const shadow = shadowOf(specifier, resolvePackage(loadedAnchor, specifier), resolvePackage(hostAnchor, specifier))
    if (shadow !== undefined) shadowed.push(shadow)
  }
  return shadowed
}

function describe(resolved: ResolvedPackage): string {
  const home = homedir()
  const path = resolved.path.startsWith(`${home}/`) ? `~${resolved.path.slice(home.length)}` : resolved.path
  return `${resolved.version ?? 'unknown version'} at ${path}`
}

/**
 * Report every host package that resolved to a private copy. This warns rather
 * than fails: the plugin loads and the host keeps serving, and a dependency
 * tree the user can repair by reinstalling is not worth refusing to start over.
 * It exists so the first clue is a named copy instead of a bare 404.
 */
export function reportShadowedHostPackages(logger: HostAuditLogger, query: HostPackageQuery = {}): void {
  const shadowed = findShadowedHostPackages(query)
  if (shadowed.length === 0) return
  const copies = shadowed
    .map(entry => `${entry.specifier} ${describe(entry.loaded)}, not the host's ${describe(entry.host)}`)
    .join('; ')
  logger.warn(`antigravity: private copies of the DSH host packages shadow the host installation — ${copies}`)
  logger.warn('antigravity: the host cannot recognize classes from these copies, so /api/antigravityAuth/* answers 404 and model calls fail with "prepareCall is not a function". Reinstall without peer auto-install (pnpm: auto-install-peers=false), or upgrade to dsh-antigravity-oauth 0.3.4+, whose host peers are optional')
}
