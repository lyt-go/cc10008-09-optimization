/**
 * 页面热力浏览联合数据报告服务。
 *
 * 职责（对应需求逐条落地）：
 * - 增量重算读取热力方案与深度分析，按页面/设备合并；未知(null)与零值(0)严格区分。
 * - 缺失分段补齐与重新汇总同批发生时，整页只提交一次覆盖更新，旧报告归档且保留未知标记。
 * - 并发提交以凭据加锁：只接受一个请求，其余请求原样拿到拒绝凭据。
 * - 跨模块更新落在浏览深度(scrollmap)时，只重算受影响页面的深度曲线，
 *   热力方案快照与其余页面报告沿用原版本。
 * - 版本冲突仲裁两种策略：未知覆盖保留(unknown-override) 产出带覆盖缺口的可用报告；
 *   缺失段延后发布(defer-missing) 产出暂存报告，待补采完成再发布。
 */
import {
  buildDepthCurve,
  buildHeatSnapshot,
  collectCoverageGaps,
  mergeDepthCurveFromRaw,
} from './merge'
import {
  DEPTH_ANALYSIS_SEED,
  HEAT_SCHEME_SEED,
} from './seed'
import { loadJointState, saveJointState } from './store'
import type {
  ConflictPolicy,
  DepthAnalysisInput,
  DepthCurve,
  DepthSegment,
  HeatSchemeInput,
  HeatSchemeSnapshot,
  IncrementalUpdateRequest,
  IncrementalUpdateResult,
  JointReport,
  JointStoreState,
} from './types'
import { DEPTH_SEGMENTS } from './types'

const DEFAULT_POLICY: ConflictPolicy = 'unknown-override'

/** 并发锁：同一时刻只允许一个增量更新凭据持锁。 */
type SubmitLock = {
  credential: string
  acquiredAt: string
} | null

let submitLock: SubmitLock = null

function nowText(): string {
  return new Date().toISOString()
}

function nextReportId(state: JointStoreState, page: string): string {
  state.sequence += 1
  return `JOINT-${page}-v${state.sequence}`
}

function groupByPage<T extends { page?: string; targetPage?: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const page = String(row.page ?? row.targetPage ?? '')
    if (!page) {
      continue
    }
    const bucket = map.get(page) ?? []
    bucket.push(row)
    map.set(page, bucket)
  }
  return map
}

function findActiveReport(state: JointStoreState, page: string): JointReport | undefined {
  const id = state.activeReportIdByPage[page]
  return id ? state.reports[id] : undefined
}

/** 把现行报告整份归档（状态改写，保留其未知标记，不做任何数值重写）。 */
function archiveReport(state: JointStoreState, report: JointReport): JointReport {
  const archived: JointReport = { ...report, status: '已归档', updatedAt: nowText() }
  state.reports[report.reportId] = archived
  return archived
}

/** 读取最新热力方案：首次播种用结构化 seed；之后返回持久化工作集。 */
export function readHeatSchemes(overrides?: HeatSchemeInput[]): HeatSchemeInput[] {
  if (overrides) {
    return overrides.map((row) => ({ ...row }))
  }
  const state = loadJointState()
  const source = state.heatSchemeSources.length ? state.heatSchemeSources : HEAT_SCHEME_SEED
  return source.map((row) => ({ ...row }))
}

/** 读取最新深度分析：首次播种用结构化 seed；之后返回持久化工作集（含移除/补回结果）。 */
export function readDepthAnalyses(overrides?: DepthAnalysisInput[]): DepthAnalysisInput[] {
  if (overrides) {
    return overrides.map((row) => ({ ...row, segments: { ...row.segments } }))
  }
  const state = loadJointState()
  const source = state.depthAnalysisSources.length ? state.depthAnalysisSources : DEPTH_ANALYSIS_SEED
  return source.map((row) => ({ ...row, segments: { ...row.segments } }))
}

/** 把刷新后的源数据写回工作集，作为后续增量重算的读取基线。 */
export function saveSourceWorkingSets(
  heatSchemes: HeatSchemeInput[],
  depthAnalyses: DepthAnalysisInput[],
): void {
  const state = loadJointState()
  state.heatSchemeSources = heatSchemes.map((row) => ({ ...row }))
  state.depthAnalysisSources = depthAnalyses.map((row) => ({ ...row, segments: { ...row.segments } }))
  saveJointState(state)
}

/**
 * 首次播种：没有任何联合报告时，用当前热力方案 + 深度分析全量构建现行报告。
 * 缺失分段（如商品详情页/移动端二屏）以 null 进入曲线与覆盖缺口，不补零。
 */
export function ensureSeeded(
  heatOverrides?: HeatSchemeInput[],
  depthOverrides?: DepthAnalysisInput[],
): JointReport[] {
  const state = loadJointState()
  if (Object.keys(state.activeReportIdByPage).length > 0) {
    return listActiveReports()
  }
  const schemes = readHeatSchemes(heatOverrides)
  const analyses = readDepthAnalyses(depthOverrides)
  // 播种时把源数据固化为工作集，之后移除/补回分段都在工作集上推进。
  state.heatSchemeSources = schemes.map((row) => ({ ...row }))
  state.depthAnalysisSources = analyses.map((row) => ({ ...row, segments: { ...row.segments } }))
  const heatByPage = groupByPage(schemes)
  const depthByPage = groupByPage(analyses)
  const pages = new Set([...heatByPage.keys(), ...depthByPage.keys()])
  const committed: JointReport[] = []
  for (const page of pages) {
    const heatSchemes = (heatByPage.get(page) ?? []).map(buildHeatSnapshot)
    const depthCurves = (depthByPage.get(page) ?? []).map(buildDepthCurve)
    const report = publishNewReport(state, page, heatSchemes, depthCurves, 'seed', 'unknown-override')
    committed.push(report)
  }
  saveJointState(state)
  return committed
}

function publishNewReport(
  state: JointStoreState,
  page: string,
  heatSchemes: HeatSchemeSnapshot[],
  depthCurves: DepthCurve[],
  source: JointReport['changedSource'],
  policy: ConflictPolicy,
): JointReport {
  const previous = findActiveReport(state, page)
  if (previous) {
    archiveReport(state, previous)
  }
  const heatVersion = previous ? previous.heatVersion + (source === 'heatmap' ? 1 : 0) : 1
  const depthVersion = previous ? previous.depthVersion + (source === 'scrollmap' ? 1 : 0) : 1
  const report: JointReport = {
    reportId: nextReportId(state, page),
    page,
    version: previous ? previous.version + 1 : 1,
    status: '已发布',
    heatVersion,
    depthVersion,
    heatSchemes,
    depthCurves,
    coverageGaps: collectCoverageGaps(depthCurves),
    conflictPolicy: policy,
    changedSource: source,
    updatedAt: nowText(),
  }
  state.reports[report.reportId] = report
  state.activeReportIdByPage[page] = report.reportId
  return report
}

/** 列出全部现行报告（页面入口唯一，归档/暂存不占入口）。 */
export function listActiveReports(): JointReport[] {
  const state = loadJointState()
  return Object.values(state.activeReportIdByPage)
    .map((id) => state.reports[id])
    .filter((report): report is JointReport => Boolean(report))
}

/** 列出某页面的全部历史版本（含已发布、已归档、暂存）。 */
export function listReportHistory(page: string): JointReport[] {
  const state = loadJointState()
  return Object.values(state.reports)
    .filter((report) => report.page === page)
    .sort((a, b) => b.version - a.version)
}

/** 尝试获取增量提交锁；已被别的凭据持锁时返回 null。 */
export function acquireSubmitLock(credential: string): boolean {
  if (submitLock) {
    return submitLock.credential === credential
  }
  submitLock = { credential, acquiredAt: nowText() }
  return true
}

export function releaseSubmitLock(credential: string): void {
  if (submitLock?.credential === credential) {
    submitLock = null
  }
}

export function currentLockCredential(): string | null {
  return submitLock?.credential ?? null
}

/**
 * 增量重算入口。
 *
 * 流程：凭据加锁 -> 按来源模块决定重算范围 -> 逐页合并（未知复用旧值）->
 * 冲突仲裁（覆盖保留 / 延后暂存）-> 每页至多一次覆盖更新 -> 释放锁。
 */
export function submitIncrementalUpdate(request: IncrementalUpdateRequest): IncrementalUpdateResult {
  const notes: string[] = []
  if (!acquireSubmitLock(request.credential)) {
    // 并发提交：只保留一个联合报告更新，本请求收到拒绝凭据。
    return {
      ok: false,
      rejectedCredential: request.credential,
      message: `凭据 ${request.credential} 被拒绝：已有增量更新（${submitLock?.credential ?? ''}）持锁，本请求不产生任何报告覆盖。`,
      committedReports: [],
      notes,
    }
  }
  try {
    ensureSeeded()
    const state = loadJointState()
    const policy: ConflictPolicy = request.conflictPolicy ?? DEFAULT_POLICY
    const heatByPage = groupByPage(request.heatSchemes)
    const depthByPage = groupByPage(request.depthAnalyses)
    const targetPages = resolveTargetPages(state, request.page, heatByPage, depthByPage)
    const committed: JointReport[] = []

    for (const page of targetPages) {
      const previous = findActiveReport(state, page)
      const result = rebuildPage(state, page, request.source, policy, previous, heatByPage, depthByPage, notes)
      if (result) {
        committed.push(result)
      }
    }

    if (committed.length === 0) {
      notes.push('所有受影响页面均无有效变化，未提交覆盖更新。')
    }
    saveJointState(state)
    return {
      ok: true,
      message: `增量重算完成，提交 ${committed.length} 份有效覆盖更新（每个页面至多一份）。`,
      committedReports: committed,
      notes,
    }
  } finally {
    releaseSubmitLock(request.credential)
  }
}

function resolveTargetPages(
  state: JointStoreState,
  requestedPage: string | null,
  heatByPage: Map<string, unknown[]>,
  depthByPage: Map<string, unknown[]>,
): string[] {
  if (requestedPage) {
    return [requestedPage]
  }
  return [...new Set([
    ...Object.keys(state.activeReportIdByPage),
    ...heatByPage.keys(),
    ...depthByPage.keys(),
  ])]
}

function rebuildPage(
  state: JointStoreState,
  page: string,
  source: IncrementalUpdateRequest['source'],
  policy: ConflictPolicy,
  previous: JointReport | undefined,
  heatByPage: Map<string, HeatSchemeInput[]>,
  depthByPage: Map<string, DepthAnalysisInput[]>,
  notes: string[],
): JointReport | null {
  if (!previous) {
    // 新页面：直接用输入构建，输入缺什么就保留什么未知，不补零。
    const heatSchemes = (heatByPage.get(page) ?? []).map(buildHeatSnapshot)
    const depthCurves = (depthByPage.get(page) ?? []).map(buildDepthCurve)
    if (heatSchemes.length === 0 && depthCurves.length === 0) {
      notes.push(`页面 ${page} 没有任何热力/深度输入，跳过。`)
      return null
    }
    return publishNewReport(state, page, heatSchemes, depthCurves, source, policy)
  }

  if (source === 'scrollmap') {
    return rebuildDepthOnly(state, page, policy, previous, depthByPage.get(page) ?? [], notes)
  }
  return rebuildHeatOnly(state, page, policy, previous, heatByPage.get(page) ?? [], notes)
}

/**
 * 跨模块更新落在浏览深度：
 * 只重算受影响页面的深度曲线，热力方案快照原样沿用旧版本；
 * 输入缺失的分段/曝光率复用旧曲线，未知不会瞬时变零。
 */
function rebuildDepthOnly(
  state: JointStoreState,
  page: string,
  policy: ConflictPolicy,
  previous: JointReport,
  incomingAnalyses: DepthAnalysisInput[],
  notes: string[],
): JointReport | null {
  const mergedCurves: DepthCurve[] = previous.depthCurves.map((curve) => ({
    ...curve,
    segments: { ...curve.segments },
  }))
  for (const analysis of incomingAnalyses) {
    const index = mergedCurves.findIndex((curve) => curve.device === analysis.device)
    const previousCurve = index < 0 ? undefined : mergedCurves[index]
    const merged = mergeDepthCurveFromRaw(previousCurve, analysis)
    if (index < 0) {
      mergedCurves.push(merged)
    } else {
      mergedCurves[index] = merged
    }
  }

  const unchanged = curvesEqual(previous.depthCurves, mergedCurves)
  if (unchanged) {
    notes.push(`页面 ${page} 深度曲线无有效变化，沿用报告 ${previous.reportId}，不提交覆盖。`)
    return null
  }

  // 热力方案整条沿用旧版本（含 schemeVersion），只让深度版本递增。
  const heatSchemes = previous.heatSchemes.map((snapshot) => ({ ...snapshot }))
  return finalizeRebuild(state, page, policy, previous, heatSchemes, mergedCurves, 'scrollmap', notes)
}

/** 热力侧更新：只替换热力方案快照，深度曲线整条沿用原版本。 */
function rebuildHeatOnly(
  state: JointStoreState,
  page: string,
  policy: ConflictPolicy,
  previous: JointReport,
  incomingSchemes: HeatSchemeInput[],
  notes: string[],
): JointReport | null {
  const heatSchemes = previous.heatSchemes.map((snapshot) => ({ ...snapshot }))
  for (const scheme of incomingSchemes) {
    const snapshot = buildHeatSnapshot(scheme)
    const index = heatSchemes.findIndex((item) => item.device === scheme.device)
    if (index < 0) {
      heatSchemes.push(snapshot)
    } else {
      heatSchemes[index] = snapshot
    }
  }
  const unchanged = heatSchemesEqual(previous.heatSchemes, heatSchemes)
  if (unchanged) {
    notes.push(`页面 ${page} 热力方案无版本变化，沿用报告 ${previous.reportId}，不提交覆盖。`)
    return null
  }
  // 深度曲线整条沿用，缺口清单也随之不变。
  const depthCurves = previous.depthCurves.map((curve) => ({
    ...curve,
    segments: { ...curve.segments },
  }))
  return finalizeRebuild(state, page, policy, previous, heatSchemes, depthCurves, 'heatmap', notes)
}

/**
 * 冲突仲裁与落盘：
 * - unknown-override：发布带覆盖缺口的可用报告（缺口显式保留，未知不显示为零）。
 * - defer-missing：存在缺口时只写暂存报告，现行入口仍指向上一版，待补采完成再发布。
 */
function finalizeRebuild(
  state: JointStoreState,
  page: string,
  policy: ConflictPolicy,
  previous: JointReport,
  heatSchemes: HeatSchemeSnapshot[],
  depthCurves: DepthCurve[],
  source: JointReport['changedSource'],
  notes: string[],
): JointReport {
  const gaps = collectCoverageGaps(depthCurves)
  const base: JointReport = {
    reportId: nextReportId(state, page),
    page,
    version: previous.version + 1,
    status: '已发布',
    heatVersion: source === 'heatmap' ? previous.heatVersion + 1 : previous.heatVersion,
    depthVersion: source === 'scrollmap' ? previous.depthVersion + 1 : previous.depthVersion,
    heatSchemes,
    depthCurves,
    coverageGaps: gaps,
    conflictPolicy: policy,
    changedSource: source,
    updatedAt: nowText(),
  }

  if (policy === 'defer-missing' && gaps.length > 0) {
    const stashed: JointReport = { ...base, status: '暂存' }
    state.reports[stashed.reportId] = stashed
    // 不覆盖 activeReportIdByPage：旧联合报告继续在入口可见，且保留它自己的未知标记。
    notes.push(
      `页面 ${page} 仍有 ${gaps.length} 个覆盖缺口，按「缺失段延后发布」写入暂存报告 ${stashed.reportId}，现行报告 ${previous.reportId} 不变。`,
    )
    return stashed
  }

  archiveReport(state, previous)
  state.reports[base.reportId] = base
  state.activeReportIdByPage[page] = base.reportId
  if (gaps.length > 0) {
    notes.push(
      `页面 ${page} 按「未知覆盖保留」发布 ${base.reportId}，带 ${gaps.length} 个覆盖缺口（未知分段保持标记，不显示为零）。`,
    )
  }
  return base
}

/**
 * 暂存报告补采完成后发布。
 * 发布前用最新深度分析工作集对暂存曲线做一次增量重算并重新统计缺口：
 * 只有缺口真正清零才允许转「已发布」并接管页面入口；否则继续暂存。
 */
export function publishStashedReport(reportId: string, credential: string): IncrementalUpdateResult {
  const notes: string[] = []
  if (!acquireSubmitLock(credential)) {
    return {
      ok: false,
      rejectedCredential: credential,
      message: `凭据 ${credential} 被拒绝：暂存发布期间已有其他增量更新持锁。`,
      committedReports: [],
      notes,
    }
  }
  try {
    const state = loadJointState()
    const stashed = state.reports[reportId]
    if (!stashed || stashed.status !== '暂存') {
      return { ok: false, message: `报告 ${reportId} 不是暂存状态，无法发布。`, committedReports: [], notes }
    }

    // 用最新工作集重算暂存曲线，判断补采是否真的补齐了缺口。
    const latestAnalyses = state.depthAnalysisSources.filter((row) => row.page === stashed.page)
    let curves = stashed.depthCurves.map((curve) => ({ ...curve, segments: { ...curve.segments } }))
    for (const analysis of latestAnalyses) {
      const index = curves.findIndex((curve) => curve.device === analysis.device)
      curves[index] = mergeDepthCurveFromRaw(index < 0 ? undefined : curves[index], analysis)
      if (index < 0) {
        curves.push(mergeDepthCurveFromRaw(undefined, analysis))
      }
    }
    const gaps = collectCoverageGaps(curves)
    if (gaps.length > 0) {
      // 回填最新曲线与缺口，保持暂存报告与补采进度同步，但仍不接管入口。
      state.reports[reportId] = {
        ...stashed,
        depthCurves: curves,
        coverageGaps: gaps,
        updatedAt: nowText(),
      }
      saveJointState(state)
      return {
        ok: false,
        message: `报告 ${reportId} 仍有 ${gaps.length} 个覆盖缺口，待补采完成后再发布。`,
        committedReports: [],
        notes,
      }
    }

    const previous = findActiveReport(state, stashed.page)
    if (previous) {
      archiveReport(state, previous)
    }
    const published: JointReport = {
      ...stashed,
      status: '已发布',
      conflictPolicy: 'defer-missing',
      depthCurves: curves,
      coverageGaps: [],
      updatedAt: nowText(),
    }
    state.reports[reportId] = published
    state.activeReportIdByPage[stashed.page] = reportId
    saveJointState(state)
    notes.push(`暂存报告 ${reportId} 补采完成，已接管 ${stashed.page} 入口。`)
    return { ok: true, message: '暂存报告已发布。', committedReports: [published], notes }
  } finally {
    releaseSubmitLock(credential)
  }
}

/**
 * 移除某页面某设备的一条深度分段（模拟二屏记录被删/采集中断）。
 * 先把工作集里该分段置为未知 null 并持久化，再触发一次 scrollmap 增量重算；
 * 联合报告显示未知而非零，且同批次只产生一次覆盖更新。
 */
export function removeDepthSegment(
  page: string,
  device: string,
  segment: DepthSegment,
  credential: string,
  policy: ConflictPolicy = DEFAULT_POLICY,
): IncrementalUpdateResult {
  if (!DEPTH_SEGMENTS.includes(segment)) {
    return { ok: false, message: `非法分段 ${segment}`, committedReports: [], notes: [] }
  }
  const heatSchemes = readHeatSchemes()
  const analyses = readDepthAnalyses()
  let touched = false
  for (const analysis of analyses) {
    if (analysis.page === page && analysis.device === device) {
      analysis.segments[segment] = null
      touched = true
    }
  }
  if (!touched) {
    return { ok: false, message: `没有找到 ${page}/${device} 的深度分析记录`, committedReports: [], notes: [] }
  }
  saveSourceWorkingSets(heatSchemes, analyses)
  return submitIncrementalUpdate({
    credential,
    source: 'scrollmap',
    page,
    heatSchemes,
    depthAnalyses: analyses.filter((row) => row.page === page),
    conflictPolicy: policy,
  })
}

/** 补回某页面某设备的深度分段（模拟补采完成），仅该设备曲线发生变化，其余设备/热力沿用。 */
export function restoreDepthSegment(
  page: string,
  device: string,
  segment: DepthSegment,
  value: number,
  credential: string,
  policy: ConflictPolicy = DEFAULT_POLICY,
): IncrementalUpdateResult {
  if (!DEPTH_SEGMENTS.includes(segment)) {
    return { ok: false, message: `非法分段 ${segment}`, committedReports: [], notes: [] }
  }
  const heatSchemes = readHeatSchemes()
  const analyses = readDepthAnalyses()
  let touched = false
  for (const analysis of analyses) {
    if (analysis.page === page && analysis.device === device) {
      analysis.segments[segment] = value
      touched = true
    }
  }
  if (!touched) {
    return { ok: false, message: `没有找到 ${page}/${device} 的深度分析记录`, committedReports: [], notes: [] }
  }
  saveSourceWorkingSets(heatSchemes, analyses)
  return submitIncrementalUpdate({
    credential,
    source: 'scrollmap',
    page,
    heatSchemes,
    depthAnalyses: analyses.filter((row) => row.page === page),
    conflictPolicy: policy,
  })
}

function curvesEqual(previous: DepthCurve[], next: DepthCurve[]): boolean {
  return JSON.stringify(previous) === JSON.stringify(next)
}

function heatSchemesEqual(previous: HeatSchemeSnapshot[], next: HeatSchemeSnapshot[]): boolean {
  return JSON.stringify(previous) === JSON.stringify(next)
}

/** 测试/重置入口：清掉锁与持久化状态（工作集回到空，下次读取重新播种）。 */
export function resetJointDomain(): void {
  submitLock = null
  const state = loadJointState()
  state.reports = {}
  state.activeReportIdByPage = {}
  state.sequence = 0
  state.schemeVersionLedger = {}
  state.heatSchemeSources = []
  state.depthAnalysisSources = []
  saveJointState(state)
}
