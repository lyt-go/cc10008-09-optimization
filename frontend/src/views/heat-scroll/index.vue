<template>
  <section class="page" data-module="heat-scroll">
    <header class="page-head">
      <div>
        <h2>页面热力浏览联合数据报告</h2>
        <p class="page-desc">
          热力方案与浏览深度的增量联合报告。缺失分段保留「未知」标记，与实测零值严格区分，不会被当成零浏览。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="seed">播种/刷新报告</button>
        <button class="btn ghost" type="button" @click="resetAll">重置联合域</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="filter-bar">
      <label class="filter-item">
        <span>版本冲突仲裁策略</span>
        <select v-model="policy">
          <option value="unknown-override">未知覆盖保留（带缺口发布）</option>
          <option value="defer-missing">缺失段延后发布（暂存待补采）</option>
        </select>
      </label>
      <label class="filter-item">
        <span>操作凭据</span>
        <input v-model="credential" placeholder="并发提交凭据" />
      </label>
    </div>

    <p v-if="message" class="status-legend">
      <span class="legend-item" :class="{ 'legend-error': !lastOk }">{{ message }}</span>
    </p>

    <article v-for="report in reports" :key="report.reportId" class="report-card">
      <header class="report-head">
        <div>
          <h3>{{ report.page }} · {{ report.reportId }}</h3>
          <p class="page-desc">
            报告版本 v{{ report.version }} · 状态「{{ report.status }}」 · 热力版本 v{{ report.heatVersion }}
            · 深度版本 v{{ report.depthVersion }} · 变更来源「{{ sourceLabel(report.changedSource) }}」
            · 仲裁「{{ policyLabel(report.conflictPolicy) }}」
          </p>
        </div>
        <div class="row-actions">
          <button class="link" type="button" @click="toggleHistory(report.page)">
            {{ expandedPage === report.page ? '收起历史' : '查看历史版本' }}
          </button>
        </div>
      </header>

      <table class="data-table">
        <thead>
          <tr>
            <th>设备</th>
            <th v-for="segment in segments" :key="segment">{{ segment }}占比</th>
            <th>平均浏览比例</th>
            <th>关键内容曝光率</th>
            <th>深度来源</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="curve in report.depthCurves" :key="curve.device">
            <td>{{ curve.device }}</td>
            <td v-for="segment in segments" :key="segment">
              <span :class="{ 'unknown-mark': curve.segments[segment] === null }">
                {{ formatSegment(curve.segments[segment]) }}
              </span>
            </td>
            <td>
              <span :class="{ 'unknown-mark': curve.averageRatio === null }">
                {{ formatSegment(curve.averageRatio) }}
              </span>
            </td>
            <td>
              <span :class="{ 'unknown-mark': curve.exposure.kind === 'unknown' }">
                {{ formatExposure(curve.exposure) }}
              </span>
            </td>
            <td>{{ curve.sourceAnalysisId }}</td>
          </tr>
        </tbody>
      </table>

      <div class="gap-bar">
        <span class="gap-title">覆盖缺口（未知分段，不会显示为零）：</span>
        <span v-if="!report.coverageGaps.length" class="gap-ok">无缺口，全部分段已采到样</span>
        <span v-for="(gap, idx) in report.coverageGaps" :key="idx" class="legend-item gap-chip">
          {{ gap.device }} / {{ gap.segment }}：未知
        </span>
      </div>

      <div class="heat-bar">
        <span class="gap-title">热力方案（深度增量时沿用原版本）：</span>
        <span v-for="snapshot in report.heatSchemes" :key="snapshot.schemeId" class="legend-item">
          {{ snapshot.device }} {{ snapshot.schemeId }} v{{ snapshot.schemeVersion }}
        </span>
      </div>

      <div class="row-actions action-row">
        <button
          class="btn"
          type="button"
          @click="removeSegment(report.page, '移动端', '二屏')"
        >
          移除移动端二屏记录
        </button>
        <button
          class="btn"
          type="button"
          @click="restoreSegment(report.page, '移动端', '二屏')"
        >
          补回移动端二屏记录
        </button>
        <button class="btn" type="button" @click="depthRecompute(report.page)">
          浏览深度跨模块增量重算
        </button>
        <button class="btn" type="button" @click="heatRecompute(report.page)">
          热力方案跨模块增量重算
        </button>
        <button
          v-if="hasStashed(report.page)"
          class="btn primary"
          type="button"
          @click="publishStashedForPage(report.page)"
        >
          发布补采完成的暂存报告
        </button>
      </div>

      <div v-if="expandedPage === report.page" class="history-box">
        <table class="data-table">
          <thead>
            <tr><th>报告编号</th><th>版本</th><th>状态</th><th>热力版本</th><th>深度版本</th><th>缺口数</th><th>更新时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in history(report.page)" :key="item.reportId">
              <td>{{ item.reportId }}</td>
              <td>v{{ item.version }}</td>
              <td>{{ item.status }}</td>
              <td>v{{ item.heatVersion }}</td>
              <td>v{{ item.depthVersion }}</td>
              <td>{{ item.coverageGaps.length }}</td>
              <td>{{ item.updatedAt }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>

    <p v-if="!reports.length" class="empty-state">暂无联合报告，点击「播种/刷新报告」生成首版。</p>

    <footer class="page-foot">
      <span>报告入口唯一：每个页面只展示现行报告，历史版本整份归档，未知标记随归档保留。</span>
      <span v-if="message" :class="lastOk ? '' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  DEPTH_SEGMENTS,
  ensureSeeded,
  formatExposure,
  formatSegment,
  listActiveReports,
  listReportHistory,
  publishStashedReport,
  readDepthAnalyses,
  readHeatSchemes,
  removeDepthSegment,
  resetJointStorage,
  restoreDepthSegment,
  submitIncrementalUpdate,
} from '@/domain/heat-scroll'
import type { ConflictPolicy, IncrementalUpdateResult, JointReport } from '@/domain/heat-scroll'

const reports = ref<JointReport[]>([])
const policy = ref<ConflictPolicy>('unknown-override')
const credential = ref('web-console')
const message = ref('')
const lastOk = ref(true)
const expandedPage = ref<string | null>(null)
const segments = DEPTH_SEGMENTS

const stats = computed(() => [
  { label: '现行联合报告', value: reports.value.length },
  { label: '带覆盖缺口报告', value: reports.value.filter((item) => item.coverageGaps.length > 0).length },
  {
    label: '未知分段总数',
    value: reports.value.reduce((sum, item) => sum + item.coverageGaps.length, 0),
  },
  {
    label: '暂存报告',
    value: reports.value.filter((item) => item.status === '暂存').length,
  },
])

function sourceLabel(source: JointReport['changedSource']): string {
  if (source === 'scrollmap') {
    return '浏览深度'
  }
  if (source === 'heatmap') {
    return '热力分析'
  }
  return '初始播种'
}

function policyLabel(value: ConflictPolicy): string {
  return value === 'defer-missing' ? '缺失段延后发布' : '未知覆盖保留'
}

function applyResult(result: IncrementalUpdateResult) {
  lastOk.value = result.ok
  message.value = [result.message, ...result.notes].filter(Boolean).join('；')
  reload()
}

function reload() {
  reports.value = listActiveReports()
}

function seed() {
  ensureSeeded()
  reload()
  message.value = '已按热力方案与深度分析播种联合报告，缺失分段保持未知。'
  lastOk.value = true
}

function resetAll() {
  resetJointStorage()
  reports.value = []
  expandedPage.value = null
  message.value = '联合域已重置。'
  lastOk.value = true
}

function removeSegment(page: string, device: string, segment: (typeof DEPTH_SEGMENTS)[number]) {
  applyResult(removeDepthSegment(page, device, segment, credential.value, policy.value))
}

function restoreSegment(page: string, device: string, segment: (typeof DEPTH_SEGMENTS)[number]) {
  // 补回一个真实非零占比，验证仅该设备曲线变化。
  applyResult(restoreDepthSegment(page, device, segment, 0.27, credential.value, policy.value))
}

function depthRecompute(page: string) {
  const result = submitIncrementalUpdate({
    credential: credential.value,
    source: 'scrollmap',
    page,
    heatSchemes: readHeatSchemes(),
    depthAnalyses: readDepthAnalyses().filter((row) => row.page === page),
    conflictPolicy: policy.value,
  })
  applyResult(result)
}

function heatRecompute(page: string) {
  const result = submitIncrementalUpdate({
    credential: credential.value,
    source: 'heatmap',
    page,
    heatSchemes: readHeatSchemes().map((row) =>
      row.targetPage === page ? { ...row, schemeVersion: row.schemeVersion + 1 } : row,
    ),
    depthAnalyses: readDepthAnalyses().filter((row) => row.page === page),
    conflictPolicy: policy.value,
  })
  applyResult(result)
}

function history(page: string): JointReport[] {
  return listReportHistory(page)
}

function hasStashed(page: string): boolean {
  return listReportHistory(page).some((item) => item.status === '暂存')
}

function publishStashedForPage(page: string) {
  const stashed = listReportHistory(page).find((item) => item.status === '暂存')
  if (!stashed) {
    return
  }
  applyResult(publishStashedReport(stashed.reportId, credential.value))
}

function toggleHistory(page: string) {
  expandedPage.value = expandedPage.value === page ? null : page
}

onMounted(() => {
  ensureSeeded()
  reload()
})
</script>

<style scoped>
.report-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 16px;
}
.report-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.report-head h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.unknown-mark {
  color: #b54708;
  font-weight: 600;
}
.gap-bar,
.heat-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
  font-size: 12px;
}
.gap-title {
  color: var(--muted);
}
.gap-ok {
  color: #067647;
}
.gap-chip {
  background: #fff4eb;
  color: #b54708;
}
.action-row {
  margin-top: 12px;
}
.history-box {
  margin-top: 12px;
}
.legend-error {
  color: #b42318;
}
select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
</style>
