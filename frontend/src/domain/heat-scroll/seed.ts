/**
 * 页面热力浏览联合域的结构化示例数据。
 *
 * 现有 heatmap / scrollmap 模块的 seed 是占位文本，无法表达分段缺失；
 * 联合域需要可计算的数值源，因此在这里维护一份结构化源数据：
 * - HEAT_SCHEME_SEED：热力方案（热力分析模块 -> 联合域热力侧）
 * - DEPTH_ANALYSIS_SEED：深度分析（浏览深度模块 -> 联合域深度侧）
 * 真实接入后端时，这两组数据改由对应模块的接口提供，合并逻辑不变。
 *
 * 约定：分段字段缺省或显式 null = 该分段未采到样（未知）；数字 0 = 实测零值。
 */
import type { DepthAnalysisInput, HeatSchemeInput, JointStoreState } from './types'

export const HEAT_SCHEME_SEED: HeatSchemeInput[] = [
  {
    schemeId: 'HEAT-P1-PC',
    schemeVersion: 1,
    targetPage: '首页',
    device: 'PC',
    clickHeat: '首页-PC-点击热力-v1',
    scrollHeat: '首页-PC-滚动热力-v1',
    attentionHeat: '首页-PC-注意力热力-v1',
    timeSegment: '全天',
    exportResolution: '1920x1080',
  },
  {
    schemeId: 'HEAT-P1-MOBILE',
    schemeVersion: 1,
    targetPage: '首页',
    device: '移动端',
    clickHeat: '首页-移动-点击热力-v1',
    scrollHeat: '首页-移动-滚动热力-v1',
    attentionHeat: '首页-移动-注意力热力-v1',
    timeSegment: '全天',
    exportResolution: '390x844',
  },
  {
    schemeId: 'HEAT-P2-PC',
    schemeVersion: 1,
    targetPage: '商品详情页',
    device: 'PC',
    clickHeat: '详情页-PC-点击热力-v1',
    scrollHeat: '详情页-PC-滚动热力-v1',
    attentionHeat: '详情页-PC-注意力热力-v1',
    timeSegment: '全天',
    exportResolution: '1920x1080',
  },
  {
    schemeId: 'HEAT-P2-MOBILE',
    schemeVersion: 1,
    targetPage: '商品详情页',
    device: '移动端',
    clickHeat: '详情页-移动-点击热力-v1',
    scrollHeat: '详情页-移动-滚动热力-v1',
    attentionHeat: '详情页-移动-注意力热力-v1',
    timeSegment: '全天',
    exportResolution: '390x844',
  },
]

/**
 * 深度分析源数据。
 * 初始即包含一个真实缺失场景：商品详情页 / 移动端 的「二屏」分段没有采到样（null），
 * 用来验证未知不会被合并成 0；同页 PC 端二屏为实测 0.31，形成对照。
 */
export const DEPTH_ANALYSIS_SEED: DepthAnalysisInput[] = [
  {
    analysisId: 'SCRO-P1-PC',
    page: '首页',
    device: 'PC',
    segments: { 首屏: 0.92, 二屏: 0.68, 三屏: 0.41, 底部: 0.22 },
    averageRatio: 0.55,
    exposure: 0.74,
  },
  {
    analysisId: 'SCRO-P1-MOBILE',
    page: '首页',
    device: '移动端',
    segments: { 首屏: 0.88, 二屏: 0.57, 三屏: 0.3, 底部: 0.12 },
    averageRatio: 0.47,
    exposure: 0.66,
  },
  {
    analysisId: 'SCRO-P2-PC',
    page: '商品详情页',
    device: 'PC',
    segments: { 首屏: 0.95, 二屏: 0.31, 三屏: 0.18, 底部: 0.09 },
    averageRatio: 0.38,
    exposure: 0.58,
  },
  {
    analysisId: 'SCRO-P2-MOBILE',
    page: '商品详情页',
    device: '移动端',
    // 二屏初始为实测值；场景验证里通过「移除二屏记录」制造缺失（null=未知），
    // 与 PC 端的实测数值形成未知/零值对照。
    segments: { 首屏: 0.9, 二屏: 0.27, 三屏: 0.14, 底部: 0.05 },
    averageRatio: 0.36,
    exposure: 0.49,
  },
]

/** 联合域初始状态为空：首次读取时由源数据播种，之后以 localStorage 为准。 */
export function emptyJointState(): JointStoreState {
  return {
    reports: {},
    activeReportIdByPage: {},
    sequence: 0,
    schemeVersionLedger: {},
    heatSchemeSources: [],
    depthAnalysisSources: [],
  }
}
