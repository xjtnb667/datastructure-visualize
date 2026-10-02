import { algorithmRegistry } from '@/algorithms'
import { CATEGORIES } from '@/core/categories'
import type { HistoryItem } from '@/api/client'
import type { AlgorithmSpec, AlgoCategoryId } from '@/core/types'

/**
 * 「我的学习报告」的数字**全在这里算**（`ReportView.vue` 只负责画）。
 *
 * 为什么单独一个纯函数文件：
 *   1. 报告页的每个数字都必须**从数据算出来**，不能写死。把它们集中在一个没有 DOM 的
 *      纯函数里，就能直接拿假数据核对（"学过 3 个 / 共 98 个 = 3%"这种）。
 *   2. 组件里只剩"怎么画"——环形进度是 SVG，条形图是 CSS 宽度百分比，都不需要库。
 *
 * 数据来源有两个，一个都不能少：
 *   - 后端 `listHistory()`：每个算法的 `views`（打开次数）/ `max_step`（最多看到第几步）
 *     / `total_steps`（总步数）/ `updated_at`（最近一次打开）；
 *   - 前端注册表 `algorithmRegistry`：总共几个算法、每个算法属于哪个大类 / 子类。
 *     没有它就算不出"覆盖率"的分母，也认不出记录里那个算法叫什么名字。
 *
 * 口径（一个都不能含糊，不然图上会出现"没看过却算学过"的数字）：
 *   - **学过**：`max_step >= 2`。第 1 步是初始帧（打开算法就有），
 *     看到第 2 步才算真的往下看过内容；也把数据库里可能存在的 `max_step = 0` 挡在外面。
 *   - **覆盖率** = 学过的算法数 / 注册表里的算法总数。
 *   - **完成度** = `max_step / total_steps`，超过 100% 的一律按 100% 记（步数口径变过时不至于画出 120%）。
 *   - 数据库里有、但前端注册表里没有的算法（管理员在后台加过的）**仍然会出现在**"最近学习"
 *     里（名字退回数据库给的名字），但**不算进覆盖率**——因为分母是前端的算法总数。
 */

/** 大类 -> 颜色。按 `CATEGORIES` 里第一个图例色取，和算法界面的图例是同一套颜色 */
const CATEGORY_COLOR: Record<string, string> = {
  linear: '#3f6fd8',
  stack: '#8b5cf6',
  queue: '#8b5cf6',
  matrix: '#f59e0b',
  string: '#10b981',
  tree: '#10b981',
  graph: '#ef4444',
  search: '#f59e0b',
  sort: '#3f6fd8',
}

export function categoryColor(id: AlgoCategoryId | null): string {
  return (id && CATEGORY_COLOR[id]) || '#3f6fd8'
}

/** 报告里的一行 = 一个算法 + 它的学习情况 */
export interface ReportRow {
  /** 算法 id（= 学习记录里的 algo_key） */
  key: string
  /** 算法名：注册表里有就用注册表的名字，否则退回后端元数据的名字，再退回 key */
  name: string
  /** 大类 id；注册表里查不到这个算法时是 null */
  category: AlgoCategoryId | null
  /** 大类中文名 */
  categoryName: string
  /** 子类名；没有就是空串 */
  group: string
  /** 打开次数 */
  views: number
  /** 最多看到第几步（1-based） */
  maxStep: number
  /** 总步数 */
  total: number
  /** 完成度百分比（0~100 的整数） */
  percent: number
  /** 最近一次打开的时间戳 */
  updatedAt: number
  /** 是否算"学过"（`maxStep >= 2`） */
  studied: boolean
}

export interface CategoryCoverage {
  id: AlgoCategoryId
  name: string
  color: string
  /** 这个大类下学过的算法数 */
  studied: number
  /** 这个大类下一共有几个算法 */
  total: number
  /** 学过 / 总数，0~100 的整数 */
  percent: number
}

export interface ReportData {
  /** 注册表里的算法总数（覆盖率的分母） */
  totalAlgorithms: number
  /** 学过的算法数（覆盖率的分子） */
  studiedAlgorithms: number
  /** 覆盖率百分比，0~100 的整数 */
  coveragePercent: number
  /** 学习记录条数（打开过的算法数，口径比"学过"宽） */
  openedAlgorithms: number
  /** 打开次数总和 */
  totalViews: number
  /** 9 个大类各学了多少 */
  categories: CategoryCoverage[]
  /** 打开次数最多的 Top 10 */
  topViews: ReportRow[]
  /** 最近学习的若干条（按 updated_at 倒序） */
  recent: ReportRow[]
  /** 看得最完整的若干条（完成度倒序，只看"学过"的） */
  mostComplete: ReportRow[]
}

/** 报告页展示的行数上限 */
export const TOP_N = 10
export const RECENT_N = 8
export const COMPLETE_N = 8

/** 数据库里的记录 + 前端注册表能认出来的信息 */
function toRow(item: HistoryItem, spec: AlgorithmSpec | undefined, fallbackName: string): ReportRow {
  const total = Math.max(0, Math.floor(item.total_steps) || 0)
  const maxStep = Math.max(0, Math.floor(item.max_step) || 0)
  const percent = total > 0 ? Math.min(100, Math.round((maxStep / total) * 100)) : 0
  return {
    key: item.algo_key,
    name: spec?.name || fallbackName || item.algo_key,
    category: spec?.category ?? null,
    categoryName: spec ? categoryNameOf(spec.category) : '其他',
    group: spec?.group ?? '',
    views: Math.max(0, Math.floor(item.views) || 0),
    maxStep,
    total,
    percent,
    updatedAt: item.updated_at,
    studied: maxStep >= 2,
  }
}

function categoryNameOf(id: AlgoCategoryId): string {
  return CATEGORIES.find((cat) => cat.id === id)?.name ?? '其他'
}

/**
 * 算出一份完整的学习报告。
 *
 * @param history     `listHistory()` 原样返回的数组（后端顺序无所谓，这里自己排）
 * @param nameOfKey   可选：注册表里没有的算法，用后端元数据的名字兜底
 */
export function computeReport(
  history: readonly HistoryItem[],
  nameOfKey: (key: string) => string = () => '',
): ReportData {
  const specByKey = new Map(algorithmRegistry.map((spec) => [spec.id, spec] as const))

  const rows = (history ?? []).map((item) =>
    toRow(item, specByKey.get(item.algo_key), nameOfKey(item.algo_key)),
  )

  const totalAlgorithms = algorithmRegistry.length
  const studiedAlgorithms = rows.filter((row) => row.studied).length
  const coveragePercent =
    totalAlgorithms > 0 ? Math.round((studiedAlgorithms / totalAlgorithms) * 100) : 0

  // 每个大类下有几个算法：分母来自注册表（不是"用户看过几个"），所以没学过的大类是 0/N
  const categories: CategoryCoverage[] = CATEGORIES.map((cat) => {
    const total = algorithmRegistry.filter((spec) => spec.category === cat.id).length
    const studied = rows.filter((row) => row.category === cat.id && row.studied).length
    return {
      id: cat.id,
      name: cat.name,
      color: categoryColor(cat.id),
      studied,
      total,
      percent: total > 0 ? Math.round((studied / total) * 100) : 0,
    }
  })

  const topViews = [...rows]
    .sort((a, b) => b.views - a.views || b.updatedAt - a.updatedAt)
    .slice(0, TOP_N)

  const recent = [...rows].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_N)

  const mostComplete = rows
    .filter((row) => row.studied && row.total > 0)
    .sort((a, b) => b.percent - a.percent || b.maxStep - a.maxStep)
    .slice(0, COMPLETE_N)

  return {
    totalAlgorithms,
    studiedAlgorithms,
    coveragePercent,
    openedAlgorithms: rows.length,
    totalViews: rows.reduce((sum, row) => sum + row.views, 0),
    categories,
    topViews,
    recent,
    mostComplete,
  }
}

/**
 * 时间戳 -> "2026-02-14 20:31"。
 * 和收藏页那个是同一种写法（本地时区、补零），**不引任何日期库**。
 */
export function formatReportTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间（"3 分钟前"），比一串时间戳更直观；超过 30 天就直接给日期 */
export function relativeTime(ms: number, now: number = Date.now()): string {
  if (!ms) return '—'
  const diff = now - ms
  if (diff < 0) return '刚刚'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  return formatReportTime(ms).slice(0, 10)
}

/**
 * 环形进度的几何值（`<circle stroke-dasharray>` 用）。
 * 半径 / 周长都算出来，**不写死数字**，改半径时两条一起变。
 */
export function ringGeometry(percent: number, radius = 54): {
  radius: number
  circumference: number
  dash: number
} {
  const safe = Math.min(100, Math.max(0, percent))
  const circumference = 2 * Math.PI * radius
  return { radius, circumference, dash: (circumference * safe) / 100 }
}
