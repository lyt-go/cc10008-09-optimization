/**
 * 热力方案 + 深度分析的读取、规范化与合并（纯函数，无副作用，便于单测）。
 *
 * 核心纪律：
 * 1. 读取深度分析时，缺失分段规范化为 null（未知），数字 0 保留为实测零值。
 * 2. 关键内容曝光率未知时保留 unknown 标记，绝不写成 0。
 * 3. 增量合并时，输入里没出现的设备/分段不参与重算，旧版本原值复用。
 */
import {
  DEPTH_SEGMENTS,
  measuredExposure,
  unknownExposure,
} from './types'
import type {
  CoverageGap,
  DepthAnalysisInput,
  DepthCurve,
  DepthSegment,
  ExposureRate,
  HeatSchemeInput,
  HeatSchemeSnapshot,
  SegmentValue,
} from './types'

/** 输入对象里是否显式带了某字段：用来区分「字段缺省（复用旧值）」与「显式 null（未知）」。 */
function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

/** 判断一个原始值是否表示「分段缺失」。字段缺省、null、空串、'未知' 都算缺失。 */
export function isMissingSegment(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' || trimmed === '未知' || trimmed === 'N/A' || trimmed === '—'
  }
  return false
}

/**
 * 把原始分段值规范化为 SegmentValue。
 * 缺失 -> null（未知）；可解析数字 -> number（包括 0）；无法解析也按未知处理。
 */
export function normalizeSegment(value: unknown): SegmentValue {
  if (isMissingSegment(value)) {
    return null
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 规范化关键内容曝光率：缺失为 unknown，数字（含 0）为 measured。 */
export function normalizeExposure(value: unknown): ExposureRate {
  if (isMissingSegment(value)) {
    return unknownExposure()
  }
  const parsed = normalizeSegment(value)
  return parsed === null ? unknownExposure() : measuredExposure(parsed)
}

/** 由一条深度分析输入构造单设备深度曲线；未提供的分段保持 null。 */
export function buildDepthCurve(input: DepthAnalysisInput): DepthCurve {
  const segments = {} as Record<DepthSegment, SegmentValue>
  for (const segment of DEPTH_SEGMENTS) {
    segments[segment] = normalizeSegment(input.segments[segment])
  }
  return {
    device: input.device,
    sourceAnalysisId: input.analysisId,
    segments,
    averageRatio: normalizeSegment(input.averageRatio),
    exposure: normalizeExposure(input.exposure),
  }
}

/**
 * 深度曲线增量合并（按原始输入的字段存在性判断）：
 * - 输入「没有带」某分段字段：本批次未采集该分段，复用旧版本值，绝不归零；
 * - 输入「显式带了」分段且规范化为 null：分段被移除/确认缺采，覆盖为未知 null；
 * - 输入带数字（含 0）：采用实测值，0 不会被当成缺失丢弃。
 * 曝光率同理：字段缺省复用旧曝光率，显式 null 覆盖为 unknown。
 */
export function mergeDepthCurveFromRaw(
  previous: DepthCurve | undefined,
  input: DepthAnalysisInput,
): DepthCurve {
  const incoming = buildDepthCurve(input)
  if (!previous) {
    return incoming
  }
  const segments = {} as Record<DepthSegment, SegmentValue>
  for (const segment of DEPTH_SEGMENTS) {
    if (hasOwn(input.segments, segment)) {
      segments[segment] = incoming.segments[segment]
    } else {
      segments[segment] = previous.segments[segment]
    }
  }
  return {
    device: incoming.device,
    sourceAnalysisId: incoming.sourceAnalysisId || previous.sourceAnalysisId,
    segments,
    averageRatio:
      input.averageRatio === undefined ? previous.averageRatio : incoming.averageRatio,
    exposure: input.exposure === undefined ? previous.exposure : mergeExposure(previous.exposure, incoming.exposure),
  }
}

/** 由一条热力方案输入构造可冻结进报告的方案快照。 */
export function buildHeatSnapshot(input: HeatSchemeInput): HeatSchemeSnapshot {
  return {
    schemeId: input.schemeId,
    schemeVersion: input.schemeVersion,
    targetPage: input.targetPage,
    device: input.device,
    clickHeat: input.clickHeat,
    scrollHeat: input.scrollHeat,
    attentionHeat: input.attentionHeat,
    timeSegment: input.timeSegment,
    exportResolution: input.exportResolution,
  }
}

/** 汇总一组深度曲线里仍为未知（null）的分段，形成覆盖缺口清单。 */
export function collectCoverageGaps(curves: DepthCurve[]): CoverageGap[] {
  const gaps: CoverageGap[] = []
  for (const curve of curves) {
    for (const segment of DEPTH_SEGMENTS) {
      if (curve.segments[segment] === null) {
        gaps.push({ device: curve.device, segment })
      }
    }
  }
  return gaps
}

/**
 * 关键内容曝光率增量合并：
 * - 新输入未知（unknown）时，复用旧版本曝光率（旧版本可能是 measured，也可能仍是 unknown）；
 * - 新输入为实测值（含 0）时采用新值，0 不会被当成缺失丢弃；
 * - 没有旧版本可复用时，未知就如实保留 unknown，绝不补 0。
 */
export function mergeExposure(previous: ExposureRate | undefined, incoming: ExposureRate): ExposureRate {
  if (incoming.kind === 'measured') {
    return { ...incoming }
  }
  if (previous) {
    return { ...previous }
  }
  return unknownExposure()
}

/** 分段级增量合并：输入分段为 null 表示该分段本次没采到，复用旧值；数字（含 0）采用新值。 */
export function mergeSegment(previous: SegmentValue, incoming: SegmentValue): SegmentValue {
  if (incoming === null) {
    return previous
  }
  return incoming
}

/**
 * 深度曲线增量合并：
 * 只覆盖本次输入里实际采到的分段与曝光率；输入缺失的部分复用旧曲线，
 * 保证「补齐缺失分段」和「重新汇总」同批发生时，未变化分段沿用旧版本而非归零。
 */
export function mergeDepthCurve(previous: DepthCurve | undefined, incoming: DepthCurve): DepthCurve {
  if (!previous) {
    return {
      ...incoming,
      segments: { ...incoming.segments },
      exposure: mergeExposure(undefined, incoming.exposure),
    }
  }
  const segments = {} as Record<DepthSegment, SegmentValue>
  for (const segment of DEPTH_SEGMENTS) {
    segments[segment] = mergeSegment(previous.segments[segment], incoming.segments[segment])
  }
  return {
    device: incoming.device,
    sourceAnalysisId: incoming.sourceAnalysisId || previous.sourceAnalysisId,
    segments,
    averageRatio: incoming.averageRatio === null ? previous.averageRatio : incoming.averageRatio,
    exposure: mergeExposure(previous.exposure, incoming.exposure),
  }
}

/** 展示层统一格式化：未知分段渲染为「未知」，零值渲染为「0%」，避免两者混淆。 */
export function formatSegment(value: SegmentValue): string {
  if (value === null) {
    return '未知'
  }
  return `${Math.round(value * 100)}%`
}

/** 曝光率展示：unknown -> 「未知（缺采）」，measured(0) -> 「0%（实测零值）」。 */
export function formatExposure(exposure: ExposureRate): string {
  if (exposure.kind === 'unknown' || exposure.value === null) {
    return '未知（缺采）'
  }
  const label = Math.round(exposure.value * 100)
  return exposure.value === 0 ? `${label}%（实测零值）` : `${label}%`
}
