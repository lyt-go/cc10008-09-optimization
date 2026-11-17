import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ensureSeeded,
  readDepthAnalyses,
  readHeatSchemes,
  submitIncrementalUpdate,
} from '@/domain/heat-scroll/service'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

/**
 * 跨模块更新钩子（调用链：热力分析 / 浏览深度 -> 页面热力浏览联合数据报告）。
 *
 * - 热力分析(heatmap)动作：联合报告只更新热力方案快照，深度曲线整条沿用原版本。
 * - 浏览深度(scrollmap)动作：联合报告只重算受影响页面的浏览深度曲线，
 *   热力方案沿用原版本；并发动作只有第一个凭据能提交，其余收到拒绝凭据。
 * 纯前端本地链路里没有真实页面/设备字段，故默认按模块全量页面增量重算，
 * 合并仍按页面/设备做未知与零值区分，未变化设备/页面不会产生覆盖。
 */
function notifyJointDomain(moduleKey: string, rowId: number, credential: string): ActionResult | null {
  try {
    ensureSeeded()
    if (moduleKey === 'scrollmap') {
      const result = submitIncrementalUpdate({
        credential,
        source: 'scrollmap',
        page: null,
        heatSchemes: readHeatSchemes(),
        depthAnalyses: readDepthAnalyses(),
      })
      if (!result.ok) {
        return { ok: false, message: result.message }
      }
      return null
    }
    if (moduleKey === 'heatmap') {
      const result = submitIncrementalUpdate({
        credential,
        source: 'heatmap',
        page: null,
        heatSchemes: readHeatSchemes(),
        depthAnalyses: readDepthAnalyses(),
      })
      if (!result.ok) {
        return { ok: false, message: result.message }
      }
      return null
    }
    return null
  } catch (error) {
    // 联合域是派生报告，不能因为它失败而阻断主模块的状态流转。
    return {
      ok: false,
      message: error instanceof Error ? `联合报告联动失败：${error.message}` : '联合报告联动失败',
    }
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 跨模块联动：浏览深度/热力分析的状态动作驱动联合报告增量重算。
  const credential = `${key}-${id}-${action}-${Date.now()}`
  const jointFeedback = notifyJointDomain(key, id, credential)
  if (jointFeedback && !jointFeedback.ok) {
    return { ok: false, message: `${meta.entity}已${action}，当前状态「${target}」；但${jointFeedback.message}` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
