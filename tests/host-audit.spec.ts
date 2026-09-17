import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SHARED_HOST_PACKAGES,
  findShadowedHostPackages,
  reportShadowedHostPackages,
} from '../src/host-audit.js'

const PKG = '@deepseek-ai/dsh-llm'
const HOST_VERSION = '0.1.5-rc.2'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-audit-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Create `<parent>/node_modules/<specifier>` with a resolvable entry point. */
async function install(parent: string, specifier: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = join(parent, 'node_modules', ...specifier.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: specifier, ...manifest }))
  await writeFile(join(dir, 'index.js'), 'export {}\n')
}

async function touchFile(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '')
  return path
}

/**
 * Lay out a harness home the way the host does: the installation closure in
 * `<home>/profiles/node_modules` and the plugin inside one profile.
 */
async function harnessHome(): Promise<{ home: string; pluginAnchor: string; profileModules: string }> {
  const root = await tempRoot()
  const home = join(root, 'home')
  const profileModules = join(home, 'profiles', 'web', 'node_modules')
  const pluginAnchor = await touchFile(join(profileModules, 'dsh-antigravity-oauth', 'lib', 'index.mjs'))
  vi.stubEnv('DSH_HOME', home)
  return { home, pluginAnchor, profileModules }
}

describe('findShadowedHostPackages', () => {
  it('names the packages whose classes must come from the host', () => {
    expect(SHARED_HOST_PACKAGES).toContain('@deepseek-ai/dsh-llm')
    expect(SHARED_HOST_PACKAGES).toContain('@deepseek-ai/dsh-typert-protocol')
  })

  it('stays silent when the plugin resolves the host installation', async () => {
    const { home, pluginAnchor } = await harnessHome()
    await install(join(home, 'profiles'), PKG, { version: HOST_VERSION })

    expect(findShadowedHostPackages({ specifiers: [PKG], loadedAnchor: pluginAnchor })).toEqual([])
  })

  it('reports a copy the plugin resolves before the host installation', async () => {
    const { home, pluginAnchor, profileModules } = await harnessHome()
    await install(join(home, 'profiles'), PKG, { version: HOST_VERSION })
    await install(join(home, 'profiles', 'web'), PKG, { version: '0.1.0-rc.8' })

    const shadowed = findShadowedHostPackages({ specifiers: [PKG], loadedAnchor: pluginAnchor })

    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]?.specifier).toBe(PKG)
    expect(shadowed[0]?.loaded).toMatchObject({ version: '0.1.0-rc.8', proxy: false })
    expect(shadowed[0]?.loaded.path).toBe(await realpath(join(profileModules, ...PKG.split('/'))))
    expect(shadowed[0]?.host.version).toBe(HOST_VERSION)
  })

  it('reads a version a package hides from its exports map', async () => {
    const { home, pluginAnchor } = await harnessHome()
    await install(join(home, 'profiles'), PKG, { version: HOST_VERSION })
    await install(join(home, 'profiles', 'web'), PKG, {
      version: '0.1.0-rc.8',
      exports: { '.': './index.js' },
    })

    const shadowed = findShadowedHostPackages({ specifiers: [PKG], loadedAnchor: pluginAnchor })

    expect(shadowed[0]?.loaded.version).toBe('0.1.0-rc.8')
  })

  it('reports a same-version second copy, which is a different module instance', async () => {
    const { home, pluginAnchor } = await harnessHome()
    await install(join(home, 'profiles'), PKG, { version: HOST_VERSION })
    await install(join(home, 'profiles', 'web'), PKG, { version: HOST_VERSION })

    expect(findShadowedHostPackages({ specifiers: [PKG], loadedAnchor: pluginAnchor })).toHaveLength(1)
  })

  it('accepts a module proxy that re-exports the installation', async () => {
    const { home, pluginAnchor, profileModules } = await harnessHome()
    await install(join(home, 'profiles'), PKG, {
      version: HOST_VERSION,
      private: true,
      dsh: { moduleFallback: { targets: { '.': 'lib/index.js' } } },
    })
    await install(join(home, 'profiles', 'web'), PKG, { version: HOST_VERSION })

    // The plugin reaches the same proxy the host linked, so the instance is shared.
    expect(findShadowedHostPackages({ specifiers: [PKG], loadedAnchor: pluginAnchor })).toEqual([])

    await rm(join(profileModules, ...PKG.split('/')), { recursive: true })
    expect(findShadowedHostPackages({ specifiers: [PKG], loadedAnchor: pluginAnchor })).toEqual([])
  })

  it('follows a symlinked package to the copy its real path resolves', async () => {
    const { home } = await harnessHome()
    const root = await tempRoot()
    // pnpm layout: the package is linked into node_modules while its dependencies
    // sit beside the store copy, so only the real path resolves them.
    const store = join(root, 'store', 'dsh-antigravity-oauth@0.3.4')
    await install(store, PKG, { version: '0.1.0-rc.8' })
    const packageDir = join(store, 'node_modules', 'dsh-antigravity-oauth')
    await mkdir(join(packageDir, 'lib'), { recursive: true })
    await writeFile(join(packageDir, 'lib', 'index.mjs'), '')
    await install(join(home, 'profiles'), PKG, { version: HOST_VERSION })
    const link = join(home, 'profiles', 'web', 'node_modules', 'dsh-antigravity-oauth')
    await rm(link, { recursive: true, force: true })
    await symlink(packageDir, link, 'dir')

    const shadowed = findShadowedHostPackages({ specifiers: [PKG], loadedAnchor: join(link, 'lib', 'index.mjs') })

    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]?.loaded.version).toBe('0.1.0-rc.8')
  })

  it('stays silent when either side cannot resolve the package', async () => {
    const { home, pluginAnchor } = await harnessHome()
    await install(join(home, 'profiles', 'web'), PKG, { version: '0.1.0-rc.8' })

    expect(findShadowedHostPackages({ specifiers: [PKG], loadedAnchor: pluginAnchor })).toEqual([])
    expect(findShadowedHostPackages({ specifiers: [PKG], loadedAnchor: join(home, 'missing', 'anchor.js') })).toEqual([])
  })
})

describe('reportShadowedHostPackages', () => {
  it('warns with both copies and the way out', async () => {
    const { home, pluginAnchor } = await harnessHome()
    await install(join(home, 'profiles'), PKG, { version: HOST_VERSION })
    await install(join(home, 'profiles', 'web'), PKG, { version: '0.1.0-rc.8' })
    const warn = vi.fn()

    reportShadowedHostPackages({ warn }, { specifiers: [PKG], loadedAnchor: pluginAnchor })

    expect(warn).toHaveBeenCalledTimes(2)
    const detail = String(warn.mock.calls[0]?.[0])
    expect(detail).toContain('0.1.0-rc.8')
    expect(detail).toContain('profiles/web/node_modules/@deepseek-ai/dsh-llm')
    expect(detail).toContain(HOST_VERSION)
    const advice = String(warn.mock.calls[1]?.[0])
    expect(advice).toContain('auto-install-peers=false')
    expect(advice).toContain('404')
  })

  it('says nothing when the installation is intact', async () => {
    const { home, pluginAnchor } = await harnessHome()
    await install(join(home, 'profiles'), PKG, { version: HOST_VERSION })
    const warn = vi.fn()

    reportShadowedHostPackages({ warn }, { specifiers: [PKG], loadedAnchor: pluginAnchor })

    expect(warn).not.toHaveBeenCalled()
  })
})
