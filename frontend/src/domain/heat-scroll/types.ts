/**
 * 页面热力浏览联合数据报告领域模型。
 *
 * 设计要点：
 * - 深度分段（首屏/二屏/三屏/底部）取值统一用 SegmentValue = number | null。
 *   null 表示「分段缺失 / 未知」（没有采到样），0 表示「确实有人采到样但占比为零」。
 *   任何合并逻辑都禁止把 null 强转成 0，避免把未曝光误报成零浏览。
 * - 联合报告是热力方案与深度分析按「目标页面 + 设备」合并后的增量快照，
 *   每个页面只保留一份现行报告，历史版本整份归档。
 */

/** 深度分段值：number 为有效占比（含 0），null 为该分段缺失（未知）。 */
export type SegmentValue = number | null

/** 深度分段的标准顺序与展示名，曲线按此顺序渲染。 */
export const DEPTH_SEGMENTS = ['首屏', '二屏', '三屏', '底部'] as const
export type DepthSegment = (typeof DEPTH_SEGMENTS)[number]

/** 关键内容曝光率的来源标记，用来区分未知与零值。 */
export type ExposureKind = 'measured' | 'unknown'

/** 关键内容曝光率：measured 时 value 为真实占比（含 0）；unknown 时 value 恒为 null。 */
export type ExposureRate = {
  kind: ExposureKind
  value: SegmentValue
}

/** 单设备的页面浏览深度曲线，逐分段取值，未知分段保留 null。 */
export type DepthCurve = {
  /** 设备类型，与热力方案的设备维度对齐。 */
  device: string
  /** 来源深度分析编号，便于从热力分析到浏览深度溯源。 */
  sourceAnalysisId: string
  /** 分段 -> 占比；缺失分段为 null，绝不写 0。 */
  segments: Record<DepthSegment, SegmentValue>
  /** 平均浏览比例；样例缺失时为 null。 */
  averageRatio: SegmentValue
  /** 关键内容曝光率，带 unknown/measured 标记。 */
  exposure: ExposureRate
}

/** 热力方案快照：联合报告里冻结的热力侧版本，深度侧变化时原样沿用。 */
export type HeatSchemeSnapshot = {
  schemeId: string
  /** 方案数据版本号，沿用热力方案处理点给出的版本。 */
  schemeVersion: number
  targetPage: string
  device: string
  clickHeat: string
  scrollHeat: string
  attentionHeat: string
  timeSegment: string
  exportResolution: string
}

/** 联合报告生命周期状态。 */
export type JointReportStatus = '已发布' | '已归档' | '暂存'

/** 版本冲突仲裁策略。 */
export type ConflictPolicy = 'unknown-override' | 'defer-missing'

/** 覆盖缺口：本报告哪些设备的哪些分段仍是未知（null）。 */
export type CoverageGap = {
  device: string
  segment: DepthSegment
}

/** 单页面的热力浏览联合数据报告（一个页面同一时刻只有一份现行报告）。 */
export type JointReport = {
  reportId: string
  page: string
  /** 报告版本，每次有效覆盖更新 +1。 */
  version: number
  status: JointReportStatus
  /** 热力方案沿用版本：报告里热力侧的版本号，未受影响时保持不变。 */
  heatVersion: number
  /** 深度曲线重算版本：深度侧每次受影响重算后 +1。 */
  depthVersion: number
  /** 本报告依据的热力方案快照（按设备），深度增量更新时原样复用。 */
  heatSchemes: HeatSchemeSnapshot[]
  /** 页面浏览深度曲线（按设备），只在深度侧受影响时重算。 */
  depthCurves: DepthCurve[]
  /** 当前仍存在的覆盖缺口（未知分段清单）。 */
  coverageGaps: CoverageGap[]
  /** 仲裁策略；暂存报告固定为 defer-missing。 */
  conflictPolicy: ConflictPolicy
  /** 本次版本相比上一版本变更了哪个模块；跨模块更新落在浏览深度时为 scrollmap。 */
  changedSource: 'heatmap' | 'scrollmap' | 'seed'
  updatedAt: string
}

/** 联合域的完整持久化状态。 */
export type JointStoreState = {
  /** 报告 id -> 报告（含已发布与已归档、暂存）。 */
  reports: Record<string, JointReport>
  /** 页面 -> 当前报告 id（现行报告唯一入口；归档/暂存报告不占用入口）。 */
  activeReportIdByPage: Record<string, string>
  /** 自增序列。 */
  sequence: number
  /** 方案版本账本：schemeId -> 最新版本，供热力方案处理点递增。 */
  schemeVersionLedger: Record<string, number>
  /** 热力方案工作集：联合域当前读取到的热力侧源数据（由热力分析模块流入）。 */
  heatSchemeSources: HeatSchemeInput[]
  /** 深度分析工作集：联合域当前读取到的深度侧源数据（由浏览深度模块流入），移除/补回分段都落在这里。 */
  depthAnalysisSources: DepthAnalysisInput[]
}

/** 深度侧输入：读取自浏览深度（scrollmap）模块的一条深度分析。 */
export type DepthAnalysisInput = {
  analysisId: string
  page: string
  device: string
  segments: Partial<Record<DepthSegment, SegmentValue>>
  averageRatio: SegmentValue
  /** 关键内容曝光率原始值；null/缺字段表示未知，数字 0 是真实零值。 */
  exposure: SegmentValue
}

/** 热力侧输入：读取自热力分析（heatmap）模块的一条热力方案。 */
export type HeatSchemeInput = {
  schemeId: string
  schemeVersion: number
  targetPage: string
  device: string
  clickHeat: string
  scrollHeat: string
  attentionHeat: string
  timeSegment: string
  exportResolution: string
}

/** 增量重算请求。 */
export type IncrementalUpdateRequest = {
  /** 请求凭据，并发时只接受第一个持锁凭据，其余收到拒绝凭据。 */
  credential: string
  /** 触发来源模块；跨模块更新落在浏览深度时传 scrollmap。 */
  source: 'heatmap' | 'scrollmap'
  /** 受影响页面；为 null 表示全量重算。 */
  page: string | null
  /** 最新热力方案读取结果（热力侧变化时给全量，深度侧变化时可给缓存版本）。 */
  heatSchemes: HeatSchemeInput[]
  /** 最新深度分析读取结果。 */
  depthAnalyses: DepthAnalysisInput[]
  /** 缺失分段补齐与旧报告归档同批次时的仲裁策略。 */
  conflictPolicy?: ConflictPolicy
}

/** 增量重算结果。 */
export type IncrementalUpdateResult = {
  ok: boolean
  /** 失败时的拒绝凭据或原因。 */
  rejectedCredential?: string
  message: string
  /** 成功时本次真正写出的覆盖更新（一个批次只提交一次）。 */
  committedReports: JointReport[]
  /** 被拒绝、暂存或未变化的报告说明。 */
  notes: string[]
}

/** 构造一个「未知」曝光率。 */
export function unknownExposure(): ExposureRate {
  return { kind: 'unknown', value: null }
}

/** 构造一个「实测」曝光率，value 为 0 也是有效零值而非未知。 */
export function measuredExposure(value: number): ExposureRate {
  return { kind: 'measured', value }
}
