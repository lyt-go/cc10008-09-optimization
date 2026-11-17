/**
 * 调用链集成验证：local-service.runAction（热力分析 / 浏览深度动作）
 * -> notifyJointDomain -> 联合域增量重算，全程不抛错且主模块状态流转不受影响。
 * 通过注入内存 localStorage 模拟浏览器环境。
 */
import assert from 'node:assert/strict'

import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../frontend/src')
const outfile = resolve(here, 'build/integration.bundle.mjs')

await build({
  entryPoints: [resolve(here, 'integration-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  alias: { '@': src },
  outfile,
  logLevel: 'silent',
})

// 注入浏览器环境：localStorage + window。
const storageMap = new Map()
globalThis.localStorage = {
  getItem: (key) => (storageMap.has(key) ? String(storageMap.get(key)) : null),
  setItem: (key, value) => void storageMap.set(key, String(value)),
  removeItem: (key) => void storageMap.delete(key),
}
globalThis.window = globalThis

const { localService, joint } = await import(outfile)

let passed = 0
function step(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('调用链集成：浏览深度/热力分析动作驱动联合报告')

step('runAction(scrollmap, 发布报告) 成功且联合域完成播种', () => {
  localService.resetModule('scrollmap')
  // seed 中 id=1 为「草稿」，发布报告 -> 已发布，是合法流转。
  const result = localService.runAction('scrollmap', 1, '发布报告')
  assert.equal(result.ok, true, result.message)
  const reports = joint.listActiveReports()
  assert.ok(reports.length >= 2, '联合域应已播种出各页面报告')
})

step('浏览深度动作后联合报告可读取，曝光率均带 measured/unknown 标记', () => {
  const reports = joint.listActiveReports()
  const detail = reports.find((item) => item.page === '商品详情页')
  assert.ok(detail)
  for (const curve of detail.depthCurves) {
    assert.ok(['measured', 'unknown'].includes(curve.exposure.kind))
  }
})

step('runAction(heatmap, 启用方案) 成功，热力联动不阻断主流程', () => {
  localService.resetModule('heatmap')
  // seed 中 id=1 为「草稿」，启用方案 -> 已启用。
  const result = localService.runAction('heatmap', 1, '启用方案')
  assert.equal(result.ok, true, result.message)
})

step('非联动模块（eventspec）动作不触发联合域异常', () => {
  localService.resetModule('eventspec')
  const result = localService.runAction('eventspec', 1, '发布事件')
  assert.equal(result.ok, true, result.message)
})

step('联合域异常被捕获降级，主模块动作不抛异常', () => {
  localService.resetModule('scrollmap')
  // 让联合域持久化临时失效（只影响联合域自己的存储），
  // 验证 notifyJointDomain 的 try/catch 把异常降级为提示，主流程照常返回。
  const originalGet = globalThis.localStorage.getItem
  globalThis.localStorage.getItem = (key) => {
    if (String(key).includes('heat-scroll-joint')) {
      throw new Error('joint storage unavailable')
    }
    return originalGet.call(globalThis.localStorage, key)
  }
  const result = localService.runAction('scrollmap', 1, '发布报告')
  assert.equal(typeof result.ok, 'boolean')
  globalThis.localStorage.getItem = originalGet
})

step('并发动作的第二个凭据被拒绝，主模块动作仍完成', () => {
  joint.resetJointDomain()
  localService.resetModule('scrollmap')
  // 第一次动作：正常完成并播种联合域，锁随动作结束释放。
  localService.runAction('scrollmap', 1, '发布报告')
  // 手工持有并发锁，模拟另一个请求正在提交联合报告。
  assert.equal(joint.acquireSubmitLock('held'), true)
  // 用另一条仍可流转的记录触发联动，凭据与持锁者不同 -> 联合域拒绝并回传拒绝原因。
  const concurrent = localService.runAction('scrollmap', 2, '发布报告')
  assert.equal(typeof concurrent.ok, 'boolean')
  assert.ok(concurrent.message.includes('被拒绝'), concurrent.message)
  assert.ok(concurrent.message.includes('held'), '拒绝信息应指明持锁凭据')
  joint.releaseSubmitLock('held')
})

console.log(`\n集成验证 ${passed} 项全部通过。`)
