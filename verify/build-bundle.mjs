/**
 * 验证构建器：用 esbuild 把联合域 TS 源码打成单文件 ESM，
 * 输出到独立的 verify/build 目录（与源码隔离），再由 Node 跑场景断言。
 */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../frontend/src/domain/heat-scroll/index.ts')
const outfile = resolve(here, 'build/heat-scroll.bundle.mjs')

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile,
  logLevel: 'info',
})

console.log(`bundled -> ${outfile}`)
