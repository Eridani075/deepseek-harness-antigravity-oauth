import { defineConfig } from 'tsdown'

const clientExternals = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/login.ts'],
    format: 'esm',
    platform: 'node',
    dts: true,
    clean: true,
    outDir: 'lib',
  },
  {
    entry: { client: 'src/client.tsx' },
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    outDir: 'lib',
    external: clientExternals,
    noExternal: id => clientExternals.includes(id) ? undefined : true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: 'dsh-antigravity-oauth', factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
