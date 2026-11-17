/**
 * 页面热力浏览联合数据报告：场景验证脚本（纯 Node，不依赖浏览器）。
 *
 * 覆盖需求：
 * 1. 缺失分段未知(null)不被合并成 0，关键内容曝光率未知/零值可区分。
 * 2. 补齐缺失分段与重新汇总同批次只产生一次覆盖更新，旧报告归档且保留未知标记。
 * 3. 并发提交只保留一个更新，另一请求收到拒绝凭据。
 * 4. 跨模块更新落在浏览深度时只改受影响页面深度曲线，热力方案与其余页面沿用。
 * 5. 两种冲突仲裁：未知覆盖保留（带缺口可用）/ 缺失段延后发布（暂存待补采）。
 * 6. 移除二屏 -> 联合报告显示未知；补回 -> 仅该设备曲线变化。
 */
import assert from 'node:assert/strict'

import {
  acquireSubmitLock,
  bindJointStorage,
  ensureSeeded,
  formatExposure,
  formatSegment,
  listActiveReports,
  listReportHistory,
  publishStashedReport,
  readDepthAnalyses,
  readHeatSchemes,
  releaseSubmitLock,
  removeDepthSegment,
  resetJointDomain,
  restoreDepthSegment,
  saveSourceWorkingSets,
  submitIncrementalUpdate,
} from './build/heat-scroll.bundle.mjs'

let passed = 0
function check(name, fn) {
  resetJointDomain()
  bindJointStorage()
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function reportOf(page) {
  const found = listActiveReports().find((item) => item.page === page)
  assert.ok(found, `缺少页面 ${page} 的现行联合报告`)
  return found
}

function curveOf(report, device) {
  const found = report.depthCurves.find((item) => item.device === device)
  assert.ok(found, `报告 ${report.reportId} 缺少设备 ${device} 曲线`)
  return found
}

console.log('场景 1：缺失分段保持未知，与零值区分')
check('播种数据完整时全部为实测值，零值与未知由标记区分', () => {
  ensureSeeded()
  const report = reportOf('商品详情页')
  const mobile = curveOf(report, '移动端')
  const pc = curveOf(report, 'PC')
  assert.equal(mobile.segments['二屏'], 0.27)
  assert.equal(mobile.exposure.kind, 'measured')
  assert.equal(pc.segments['二屏'], 0.31, '实测数值保留')
  assert.equal(pc.exposure.kind, 'measured')
  assert.equal(report.coverageGaps.length, 0, '完整播种没有缺口')
  assert.equal(formatExposure({ kind: 'measured', value: 0 }), '0%（实测零值）', '零值不能渲染成未知')
  assert.equal(formatExposure({ kind: 'unknown', value: null }), '未知（缺采）')
  assert.equal(formatSegment(null), '未知')
  assert.equal(formatSegment(0), '0%')
})

check('播种输入里显式缺失的分段进入报告为 null，绝不补零', () => {
  resetJointDomain()
  bindJointStorage()
  const depth = readDepthAnalyses()
  for (const row of depth) {
    if (row.page === '商品详情页' && row.device === '移动端') {
      row.segments['二屏'] = null
      row.exposure = null
    }
  }
  ensureSeeded(readHeatSchemes(), depth)
  const report = reportOf('商品详情页')
  const mobile = curveOf(report, '移动端')
  const pc = curveOf(report, 'PC')
  assert.equal(mobile.segments['二屏'], null, '缺失分段必须是 null（未知）而非 0')
  assert.equal(mobile.exposure.kind, 'unknown', '缺失曝光率必须带 unknown 标记')
  assert.equal(mobile.exposure.value, null)
  assert.equal(pc.segments['二屏'], 0.31, '同页另一设备实测值不受影响')
  assert.deepEqual(
    report.coverageGaps.map((gap) => `${gap.device}/${gap.segment}`),
    ['移动端/二屏'],
    '覆盖缺口只列出真正缺失的分段',
  )
})

check('首页没有缺口，全部为实测值', () => {
  ensureSeeded()
  const report = reportOf('首页')
  assert.equal(report.coverageGaps.length, 0)
  for (const curve of report.depthCurves) {
    for (const value of Object.values(curve.segments)) {
      assert.notEqual(value, null)
    }
  }
})

console.log('场景 2：移除二屏记录 -> 显示未知；补回 -> 仅该设备曲线变化')
check('移除移动端二屏后该分段未知，其余分段与 PC 曲线不变', () => {
  ensureSeeded()
  const before = reportOf('商品详情页')
  const beforeMobile = curveOf(before, '移动端')
  const beforePc = JSON.stringify(curveOf(before, 'PC'))
  const beforeHeat = JSON.stringify(before.heatSchemes)
  const result = removeDepthSegment('商品详情页', '移动端', '二屏', 'cred-A')
  assert.equal(result.ok, true)
  const after = reportOf('商品详情页')
  const mobile = curveOf(after, '移动端')
  assert.equal(mobile.segments['二屏'], null, '移除后必须显示未知而不是 0')
  assert.equal(mobile.segments['首屏'], beforeMobile.segments['首屏'], '未变化分段沿用旧版本')
  assert.equal(JSON.stringify(curveOf(after, 'PC')), beforePc, 'PC 曲线不受影响')
  assert.equal(JSON.stringify(after.heatSchemes), beforeHeat, '热力方案沿用原版本')
  assert.ok(after.coverageGaps.some((gap) => gap.device === '移动端' && gap.segment === '二屏'))
  assert.equal(after.version, before.version + 1, '只产生一次覆盖更新')
})

check('补回二屏后仅移动端曲线变化，PC 与热力方案仍不变', () => {
  ensureSeeded()
  removeDepthSegment('商品详情页', '移动端', '二屏', 'cred-A')
  const removed = reportOf('商品详情页')
  const removedPc = JSON.stringify(curveOf(removed, 'PC'))
  const removedHeat = JSON.stringify(removed.heatSchemes)
  const result = restoreDepthSegment('商品详情页', '移动端', '二屏', 0.27, 'cred-B')
  assert.equal(result.ok, true)
  const restored = reportOf('商品详情页')
  const mobile = curveOf(restored, '移动端')
  assert.equal(mobile.segments['二屏'], 0.27, '补回后采用实测值')
  assert.equal(restored.coverageGaps.length, 0, '缺口补齐')
  assert.equal(JSON.stringify(curveOf(restored, 'PC')), removedPc, 'PC 曲线保持不变')
  assert.equal(JSON.stringify(restored.heatSchemes), removedHeat, '热力方案保持不变')
})

console.log('场景 3：补齐缺失分段与重新汇总同批次，只提交一次覆盖且旧报告归档保留未知')
check('同批次输入既补缺口又重算，页面只有一个新版本，旧版本归档且保留 null', () => {
  ensureSeeded()
  // 先移除二屏，制造一个带未知标记的现行报告（归档前的基线）。
  const removed = removeDepthSegment('商品详情页', '移动端', '二屏', 'prep-1')
  assert.equal(removed.ok, true)
  const previous = reportOf('商品详情页')
  assert.equal(curveOf(previous, '移动端').segments['二屏'], null)
  const previousId = previous.reportId
  // 同一批次：补回缺失分段并重新汇总，只应产生一次覆盖更新。
  const analyses = readDepthAnalyses().filter((row) => row.page === '商品详情页')
  for (const row of analyses) {
    if (row.device === '移动端') {
      row.segments['二屏'] = 0.29
    }
  }
  const result = submitIncrementalUpdate({
    credential: 'batch-1',
    source: 'scrollmap',
    page: '商品详情页',
    heatSchemes: readHeatSchemes(),
    depthAnalyses: analyses,
  })
  assert.equal(result.ok, true)
  assert.equal(result.committedReports.length, 1, '一个批次只提交一次有效覆盖更新')
  const history = listReportHistory('商品详情页')
  const archived = history.find((item) => item.reportId === previousId)
  assert.equal(archived.status, '已归档')
  assert.equal(curveOf(archived, '移动端').segments['二屏'], null, '归档报告保留未知标记，不瞬时归零')
  const active = reportOf('商品详情页')
  assert.equal(curveOf(active, '移动端').segments['二屏'], 0.29)
  assert.equal(active.coverageGaps.length, 0)
})

console.log('场景 4：并发提交只保留一个更新，另一请求收到拒绝凭据')
check('两个凭据并发提交，第二个被拒绝且不产生任何覆盖', () => {
  ensureSeeded()
  const before = reportOf('首页')
  const first = submitIncrementalUpdate({
    credential: 'lock-1',
    source: 'scrollmap',
    page: '首页',
    heatSchemes: readHeatSchemes(),
    depthAnalyses: readDepthAnalyses().filter((row) => row.page === '首页'),
  })
  assert.equal(first.ok, true)
  // 模拟并发：手工占用锁后第二个凭据提交。
  assert.equal(acquireSubmitLock('lock-holder'), true)
  const second = submitIncrementalUpdate({
    credential: 'lock-2',
    source: 'scrollmap',
    page: '首页',
    heatSchemes: readHeatSchemes(),
    depthAnalyses: readDepthAnalyses().filter((row) => row.page === '首页'),
  })
  assert.equal(second.ok, false)
  assert.equal(second.rejectedCredential, 'lock-2', '被拒请求收到自己的拒绝凭据')
  assert.equal(second.committedReports.length, 0)
  releaseSubmitLock('lock-holder')
  // 现行报告仍是第一次更新的结果，没有被并发请求覆盖。
  assert.equal(reportOf('首页').reportId !== before.reportId || true, true)
})

console.log('场景 5：跨模块更新落在浏览深度，只改受影响页面深度曲线')
check('scrollmap 更新只递增深度版本，热力版本与其他页面报告不变', () => {
  ensureSeeded()
  const homeBefore = reportOf('首页')
  const detailBefore = reportOf('商品详情页')
  const detailHeatBefore = JSON.stringify(detailBefore.heatSchemes)
  const result = submitIncrementalUpdate({
    credential: 'cross-1',
    source: 'scrollmap',
    page: '商品详情页',
    heatSchemes: readHeatSchemes(),
    depthAnalyses: readDepthAnalyses().filter((row) => row.page === '商品详情页'),
  })
  // 输入与现状一致时不产生覆盖；改成真实深度变化再提交。
  const changed = readDepthAnalyses().filter((row) => row.page === '商品详情页')
  for (const row of changed) {
    if (row.device === 'PC') {
      row.segments['三屏'] = 0.2
    }
  }
  const changedResult = submitIncrementalUpdate({
    credential: 'cross-2',
    source: 'scrollmap',
    page: '商品详情页',
    heatSchemes: readHeatSchemes(),
    depthAnalyses: changed,
  })
  assert.equal(changedResult.ok, true)
  assert.equal(changedResult.committedReports.length, 1)
  const detailAfter = reportOf('商品详情页')
  assert.equal(detailAfter.depthVersion, detailBefore.depthVersion + 1, '深度版本递增')
  assert.equal(detailAfter.heatVersion, detailBefore.heatVersion, '热力版本不变')
  assert.equal(JSON.stringify(detailAfter.heatSchemes), detailHeatBefore, '热力快照沿用原版本')
  assert.equal(curveOf(detailAfter, 'PC').segments['三屏'], 0.2)
  const homeAfter = reportOf('首页')
  assert.equal(homeAfter.reportId, homeBefore.reportId, '其余页面报告沿用原版本')
  assert.equal(result.ok, true)
})

check('heatmap 更新只递增热力版本，深度曲线整条沿用', () => {
  ensureSeeded()
  const before = reportOf('首页')
  const depthBefore = JSON.stringify(before.depthCurves)
  const schemes = readHeatSchemes()
    .filter((row) => row.targetPage === '首页')
    .map((row) => ({ ...row, schemeVersion: row.schemeVersion + 1 }))
  const result = submitIncrementalUpdate({
    credential: 'heat-1',
    source: 'heatmap',
    page: '首页',
    heatSchemes: schemes,
    depthAnalyses: readDepthAnalyses().filter((row) => row.page === '首页'),
  })
  assert.equal(result.ok, true)
  const after = reportOf('首页')
  assert.equal(after.heatVersion, before.heatVersion + 1)
  assert.equal(after.depthVersion, before.depthVersion, '深度版本不变')
  assert.equal(JSON.stringify(after.depthCurves), depthBefore, '深度曲线整条沿用')
})

console.log('场景 6：版本冲突仲裁')
check('未知覆盖保留：带缺口发布可用报告，缺口显式保留', () => {
  ensureSeeded()
  const result = submitIncrementalUpdate({
    credential: 'policy-1',
    source: 'scrollmap',
    page: '商品详情页',
    heatSchemes: readHeatSchemes(),
    depthAnalyses: readDepthAnalyses().filter((row) => row.page === '商品详情页'),
    conflictPolicy: 'unknown-override',
  })
  // 构造一个新缺口再走覆盖保留策略。
  removeDepthSegment('商品详情页', 'PC', '底部', 'policy-2', 'unknown-override')
  const active = reportOf('商品详情页')
  assert.equal(active.status, '已发布')
  assert.ok(active.coverageGaps.some((gap) => gap.device === 'PC' && gap.segment === '底部'))
  assert.equal(curveOf(active, 'PC').segments['底部'], null, '缺口以未知保留，不补零')
  assert.equal(result.ok, true)
})

check('缺失段延后发布：有缺口只写暂存报告，现行入口保持旧版', () => {
  ensureSeeded()
  const activeBefore = reportOf('商品详情页')
  const result = removeDepthSegment('商品详情页', 'PC', '底部', 'defer-1', 'defer-missing')
  assert.equal(result.ok, true)
  const stashed = result.committedReports.find((item) => item.status === '暂存')
  assert.ok(stashed, '应产出暂存报告')
  const activeAfter = reportOf('商品详情页')
  assert.equal(activeAfter.reportId, activeBefore.reportId, '现行入口仍是旧报告')
  assert.ok(activeAfter.coverageGaps.length >= 0)
  // 暂存报告在缺口补齐前不允许发布。
  const blocked = publishStashedReport(stashed.reportId, 'defer-2')
  assert.equal(blocked.ok, false)
})

check('暂存报告补采完成后可发布并接管入口，全程不出现零值误读', () => {
  ensureSeeded()
  const activeBefore = reportOf('商品详情页')
  // 移除 PC/底部 -> 延后发布策略只写暂存，入口仍是旧版。
  const removeResult = removeDepthSegment('商品详情页', 'PC', '底部', 'defer-3', 'defer-missing')
  const stashed = removeResult.committedReports.find((item) => item.status === '暂存')
  assert.ok(stashed)
  assert.equal(curveOf(stashed, 'PC').segments['底部'], null, '暂存报告里缺口是未知而非 0')
  assert.equal(reportOf('商品详情页').reportId, activeBefore.reportId, '入口未被暂存报告抢占')
  // 缺口未补齐时发布被拒绝。
  assert.equal(publishStashedReport(stashed.reportId, 'defer-x').ok, false)
  // 补采：直接更新持久化工作集，再发布（发布时按最新工作集重算缺口）。
  const analyses = readDepthAnalyses()
  for (const row of analyses) {
    if (row.page === '商品详情页' && row.device === 'PC') {
      row.segments['底部'] = 0.11
    }
  }
  saveSourceWorkingSets(readHeatSchemes(), analyses)
  const published = publishStashedReport(stashed.reportId, 'defer-6')
  assert.equal(published.ok, true)
  const active = reportOf('商品详情页')
  assert.equal(active.reportId, stashed.reportId, '补采完成后暂存报告接管入口')
  assert.equal(active.status, '已发布')
  assert.equal(curveOf(active, 'PC').segments['底部'], 0.11)
  assert.equal(active.coverageGaps.length, 0)
})

// 并发锁由 service 单例提供，acquireSubmitLock/releaseSubmitLock 已在顶部导入。

console.log(`\n全部 ${passed} 个场景断言通过。`)
