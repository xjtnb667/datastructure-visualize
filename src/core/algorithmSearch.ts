import { algorithmRegistry } from '@/algorithms'
import { CATEGORIES } from '@/core/categories'
import type { AlgorithmSpec, AlgoCategoryId } from '@/core/types'

/**
 * 算法搜索：**跨所有大类**按「名称 / 算法 id」模糊匹配（不区分大小写）。
 *
 * 为什么要单开一个文件而不是写在 `AlgorithmPicker.vue` 里：
 *   选择器里那 9 个大类 × 98 个算法点起来太慢，用户要的是"打两个字就出来"。
 *   匹配规则是**纯函数**（进去是关键词、出来是列表），放在这里不带任何 DOM，
 *   组件只管把结果画出来、键盘上下移动、回车选中。
 *
 * 匹配规则（`searchAlgorithms`）：
 *   1. 关键词去掉首尾空格后为空 -> 返回空数组（= 回到原来的两级选择器）；
 *   2. 命中的是**算法名称**或**算法 id**，两边都转小写，所以"快速"和"quick"都能搜到；
 *   3. 排序分三档：名称前缀命中 > 名称中间命中 > id 命中，同一档里命中位置越靠前越前，
 *      完全相同的仍按注册表顺序（`Array#sort` 现在是稳定的），所以结果不会跳来跳去。
 *
 * `AlgoCategoryId` 也一起导出，省得用它的组件再多 import 一次。
 */
export type { AlgoCategoryId }

export interface AlgoSearchHit {
  /** 命中的算法（原样是注册表里的那个对象，不改它） */
  spec: AlgorithmSpec
  /** 大类中文名（跨类搜索时得让人知道它在哪里） */
  categoryName: string
  /** 子类名；算法没有子类时是空串（界面按"没有"处理） */
  group: string
  /** 命中位置：'name' = 算法名，'id' = 算法 id */
  matched: 'name' | 'id'
}

/** id -> 大类中文名。大类只有 9 个，建一次表比每次查找都 `find` 一遍省事 */
const CATEGORY_NAME = new Map<string, string>(
  CATEGORIES.map((cat) => [cat.id, cat.name] as const),
)

/**
 * 注册表的**可搜索索引**，模块加载时建一次。
 * 里面只放开一个 `nameLower` 用于匹配，免得每次输入都对 98 个算法各转一遍小写。
 */
interface IndexRow {
  spec: AlgorithmSpec
  nameLower: string
  idLower: string
  categoryName: string
  group: string
}

const INDEX: IndexRow[] = algorithmRegistry.map((spec) => ({
  spec,
  nameLower: spec.name.toLowerCase(),
  idLower: spec.id.toLowerCase(),
  categoryName: CATEGORY_NAME.get(spec.category) ?? spec.category,
  group: spec.group ?? '',
}))

/** 命中分档：越小越靠前（名称前缀 > 名称中间 > id 里有） */
function rank(row: IndexRow, q: string): number {
  const at = row.nameLower.indexOf(q)
  if (at === 0) return 0
  if (at > 0) return 1
  return row.idLower.includes(q) ? 2 : -1
}

/**
 * 搜算法。关键词为空 / 只有空格时返回**空数组**（调用方据此回到两级选择器）。
 * 不限制条数：98 个算法里再宽的关键词也出不了几条，画满一屏反而看得全。
 */
export function searchAlgorithms(query: string): AlgoSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const hits: Array<{ row: IndexRow; score: number }> = []
  for (const row of INDEX) {
    const score = rank(row, q)
    if (score < 0) continue
    hits.push({ row, score })
  }

  // 先按档位（0 名称前缀 / 1 名称中间 / 2 只在 id 里），同档再按命中位置靠前优先。
  // 两档都相同时不改顺序（Array#sort 是稳定的），于是完全并列的仍按注册表顺序显示。
  hits.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    const at = a.row.nameLower.indexOf(q)
    const bt = b.row.nameLower.indexOf(q)
    const ap = at >= 0 ? at : 999
    const bp = bt >= 0 ? bt : 999
    return ap - bp
  })

  return hits.map(({ row }) => ({
    spec: row.spec,
    categoryName: row.categoryName,
    group: row.group,
    matched: row.nameLower.includes(q) ? ('name' as const) : ('id' as const),
  }))
}
