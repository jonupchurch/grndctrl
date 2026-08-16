import { build, context } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Three bundles, and the reasons tsc cannot produce any of them.
 *
 * **Main must be CommonJS.** The rest of this repo is ESM, and Electron 33 will
 * happily load an ESM main — right up until it imports `better-sqlite3`. Node's
 * ESM loader preparses a CJS dependency to work out its named exports, and that
 * preparse throws on a native addon: `Cannot read properties of undefined
 * (reading 'exports')`, from inside `node:internal/modules/esm/translators`,
 * with nothing in the stack belonging to this project. Bundling main to CJS
 * removes the interop question rather than answering it, and it is what
 * packaging wants anyway (T160–T168). The native modules stay external — they
 * are `.node` binaries and cannot be bundled.
 *
 * **The preload must be one CommonJS file.** A sandboxed renderer's preload runs
 * in a restricted context with no ESM loader at all.
 *
 * **The renderer must be a bundle.** The page is loaded over `file:`, where a
 * bare `import 'react'` resolves to nothing.
 *
 * **There is no dev server, deliberately.** The obvious setup serves the
 * renderer from `http://localhost:5173` in development and from `file:` when
 * packaged, which makes the CSP and the load-blocking in `main/security.ts`
 * *different in development from production* — so the configuration that ships
 * is the one nobody has been running all day. `--watch` writes to disk instead
 * and the window loads from `file:` either way. The cost is losing hot module
 * replacement; the gain is that the security posture under test is the security
 * posture that ships.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const watch = process.argv.includes('--watch')

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  // Chromium and Node as they are inside Electron 33. Targeting the real
  // runtime rather than `esnext` keeps the output free of syntax it has not
  // shipped.
  target: ['chrome130', 'node20'],
}

/** Native addons. Not bundleable, and not ours to relocate. */
const NATIVE = ['better-sqlite3', '@napi-rs/keyring']

const configs = [
  {
    ...common,
    entryPoints: [join(PKG, 'src/main/index.ts')],
    outfile: join(PKG, 'dist/main/index.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron', ...NATIVE],
    // `main/index.ts` locates the preload and the renderer relative to itself,
    // idiomatically, with `import.meta.url` — which does not exist in CommonJS.
    // Shimming it here keeps the source honest ESM rather than making it carry
    // the bundler's output format around in its imports.
    banner: {
      js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;",
    },
    define: { 'import.meta.url': 'import_meta_url' },
  },
  {
    ...common,
    entryPoints: [join(PKG, 'src/preload/index.ts')],
    outfile: join(PKG, 'dist/preload/index.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [join(PKG, 'src/renderer/main.tsx')],
    outfile: join(PKG, 'dist/renderer/app.js'),
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    // The renderer is production code even in development: there is no dev
    // server to be lenient for, and `NODE_ENV` is what React reads to decide
    // whether to ship its development warnings.
    define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
    minify: !watch,
    // The bundled Archivo subset. `file`, deliberately, not `dataurl`: the CSP
    // in `main/security.ts` is `font-src 'self'`, and inlining the font as a
    // data URL would have meant loosening it to `'self' data:` — widening the
    // policy for every font-shaped thing on the page in order to ship one.
    // Emitted next to `app.css`, where the rewritten relative URL resolves.
    loader: { '.woff2': 'file' },
    assetNames: '[name]',
  },
]

await mkdir(join(PKG, 'dist/renderer'), { recursive: true })
await copyFile(join(PKG, 'src/renderer/index.html'), join(PKG, 'dist/renderer/index.html'))

if (watch) {
  const contexts = await Promise.all(configs.map((config) => context(config)))
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('watching src/main, src/preload and src/renderer')
} else {
  await Promise.all(configs.map((config) => build(config)))
}
