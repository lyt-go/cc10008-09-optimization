/**
 * 联合域本地持久化。
 *
 * 与 data/local-store.ts 同一思路（localStorage + 内存缓存 + 离线回退），
 * 但独立成域、独立 key，避免污染通用模块清单。
 * 所有读写都不直接依赖 window：测试环境注入 memory storage，浏览器环境用 localStorage。
 */
import { emptyJointState } from './seed'
import type { JointStoreState } from './types'

const STORAGE_KEY = 'behavior-event-trace-hub:heat-scroll-joint'

export interface KVStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function createMemoryStorage(): KVStorage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => (map.has(key) ? String(map.get(key)) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

/** 默认存储：浏览器 localStorage；不可用时降级到内存（node/测试）。 */
function defaultStorage(): KVStorage {
  if (typeof globalThis !== 'undefined') {
    const candidate = (globalThis as { localStorage?: KVStorage }).localStorage
    if (candidate && typeof candidate.getItem === 'function') {
      return candidate
    }
  }
  return createMemoryStorage()
}

let storage: KVStorage = defaultStorage()
let cache: JointStoreState | null = null

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 测试或跨模块初始化时可替换存储（例如每个用例换一块干净的内存存储）。 */
export function bindJointStorage(custom?: KVStorage): KVStorage {
  storage = custom ?? createMemoryStorage()
  cache = null
  return storage
}

export function resetJointStorage(): JointStoreState {
  const fresh = emptyJointState()
  cache = clone(fresh)
  storage.setItem(STORAGE_KEY, JSON.stringify(cache))
  return clone(cache)
}

export function loadJointState(): JointStoreState {
  if (cache) {
    return cache
  }
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = emptyJointState()
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as JointStoreState
    cache = {
      reports: parsed.reports ?? {},
      activeReportIdByPage: parsed.activeReportIdByPage ?? {},
      sequence: parsed.sequence ?? 0,
      schemeVersionLedger: parsed.schemeVersionLedger ?? {},
      heatSchemeSources: parsed.heatSchemeSources ?? [],
      depthAnalysisSources: parsed.depthAnalysisSources ?? [],
    }
    return cache
  } catch {
    cache = emptyJointState()
    return cache
  }
}

export function saveJointState(state: JointStoreState): JointStoreState {
  cache = clone(state)
  storage.setItem(STORAGE_KEY, JSON.stringify(cache))
  return clone(cache)
}

export function jointStorageKey(): string {
  return STORAGE_KEY
}
