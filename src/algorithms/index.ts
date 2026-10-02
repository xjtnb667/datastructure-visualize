import type { AlgoCategoryId, AlgorithmSpec } from '@/core/types'
import { bubbleSortSpec } from './bubbleSort'
import { selectionSortSpec } from './selectionSort'
import { insertionSortSpec } from './insertionSort'
import {
  binInsertSortSpec,
  countSortSpec,
  mergeSortSpec,
  quickSortSpec,
  shellSortSpec,
} from './sortBasic'
import {
  externalSortSpec,
  heapSortSpec,
  loserTreeSpec,
  optimalMergeSpec,
  radixSortSpec,
  replaceSelectSpec,
} from './sortMore'
import { sequentialSearchSpec } from './sequentialSearch'
import { binarySearchSpec } from './binarySearch'
import { seqDeleteSpec, seqGetSpec, seqInsertSpec, seqLocateSpec } from './seqList'
import {
  sllCreateHeadSpec,
  sllCreateTailSpec,
  sllDeleteSpec,
  sllGetByIndexSpec,
  sllInsertSpec,
  sllLocateSpec,
} from './singlyLinkedList'
import { dllDeleteSpec, dllInsertSpec } from './doublyLinkedList'
import { cycleDetectSpec, cycleEntrySpec } from './circularLinkedList'
import { stackSeqSpecs } from './stackSeq'
import { stackMoreSpecs } from './stackMore'
import { queueSpecs } from './queue'
import { matrixSpecs } from './matrix'
import { stringMatchSpecs } from './stringMatch'
import { treeSpecs } from './treeTraverse'
import { treeTraverse2Specs } from './treeTraverse2'
import { treeThreadForestSpecs } from './treeThreadForest'
import { treeSearchSpecs } from './treeSearch'
import { heapSpecs, treeApplySpecs } from './treeApply'
import { graphStorageSpecs } from './graphStorage'
import { graphTraverseSpecs } from './graphTraverse'
import { graphPathSpecs } from './graphPath'
import { dpSpecs } from './dp'
import { searchTreeSpecs } from './searchTree'
import { blockSearchSpec, hashSearchSpec } from './searchMore'

/**
 * 算法注册表（SRS EF-09 可扩展性）。
 * 新增算法只需要写一个 spec + 在这里加一行，
 * 两级选择器 / 播放器 / 代码面板 / 渲染器 / 控制器统统不用改。
 *
 * ⚠️ 这个数组的顺序就是**选择器右列的显示顺序**，而且 `getGroupedByCategory`
 * 只把**相邻**的同 `group` 合并成一组。所以同一个子类的算法必须连着写：
 * 中间插进别的子类，界面上就会多冒出一个同名的小标题（排序 / 查找这两块尤其要注意，
 * 它们的 spec 分散在好几个文件里 —— 文件里的导出顺序**不影响**这里的顺序，以本文件为准）。
 *
 * 大类之间也按 CATEGORIES 的顺序排（线性表 → … → 查找 → 排序），纯粹为了好读，
 * 大类顺序本身由 src/core/categories.ts 决定。
 */
export const algorithmRegistry: AlgorithmSpec[] = [
  // 线性表 · 顺序表
  seqInsertSpec,
  seqDeleteSpec,
  seqLocateSpec,
  seqGetSpec,
  // 线性表 · 单链表
  sllCreateHeadSpec,
  sllCreateTailSpec,
  sllGetByIndexSpec,
  sllLocateSpec,
  sllInsertSpec,
  sllDeleteSpec,
  // 线性表 · 双链表
  dllInsertSpec,
  dllDeleteSpec,
  // 线性表 · 循环链表与环
  cycleDetectSpec,
  cycleEntrySpec,
  // 栈 · 顺序栈
  ...stackSeqSpecs,
  // 栈 · 链栈 / 共享栈 / 栈的应用 / 递归
  ...stackMoreSpecs,
  // 队列 · 循环队列 / 链队列
  ...queueSpecs,
  // 数组与矩阵 · 特殊矩阵 / 稀疏矩阵
  ...matrixSpecs,
  // 串 · 模式匹配 / next 数组
  ...stringMatchSpecs,
  // 树与二叉树（treeSearchSpecs 里全是「查找」大类的 BST / AVL，登记在下面的查找段）
  ...treeSpecs,
  ...treeTraverse2Specs,
  ...treeThreadForestSpecs,
  ...treeApplySpecs,
  // 图
  ...graphStorageSpecs,
  ...graphTraverseSpecs,
  ...graphPathSpecs,
  // 动态规划 · 背包问题 / 双串模型
  ...dpSpecs,

  // ---------- 查找 ----------
  // 线性表的查找：顺序 / 折半 / 分块
  sequentialSearchSpec,
  binarySearchSpec,
  blockSearchSpec,
  // 二叉排序树：插入 / 查找 / 删除（treeSearchSpecs 的前三个）
  // 平衡二叉树：AVL 四种旋转（treeSearchSpecs 的后四个）+ 红黑树（下一段的第一个），
  // 两段必须连在一起 —— 中间插了别的子类，「平衡二叉树」就会裂成两个标题
  ...treeSearchSpecs,
  // 多路平衡查找树：B 树 / B+ 树（searchTreeSpecs 的后两个）
  ...searchTreeSpecs,
  // 散列表：哈希表
  hashSearchSpec,

  // ---------- 排序 ----------
  // 插入类排序：直接插入 / 折半插入 / 希尔
  insertionSortSpec,
  binInsertSortSpec,
  shellSortSpec,
  // 交换类排序：冒泡 / 快速
  bubbleSortSpec,
  quickSortSpec,
  // 选择类排序：选择 / 堆排序 / 建堆 / 堆调整（后两个必须紧跟在堆排序后面）
  selectionSortSpec,
  heapSortSpec,
  ...heapSpecs,
  // 归并类排序：归并
  mergeSortSpec,
  // 分配类排序：计数 / 基数（中间不能插别的子类，否则会裂成两组标题）
  countSortSpec,
  radixSortSpec,
  // 外部排序：多趟归并 / 败者树 / 置换-选择 / 最佳归并树
  externalSortSpec,
  loserTreeSpec,
  replaceSelectSpec,
  optimalMergeSpec,
]

/**
 * 取算法；id 不认识时退回**默认算法**。
 *
 * 这里刻意**不写 `algorithmRegistry[0]`**：注册表是按大类排的，"第一条"属于哪个大类
 * 会随大类增删 / 排序而变（大类顺序调整前第一条是排序，调整后成了线性表），
 * 拿它兜底等于把"默认算法是谁"这个决定交给数组顺序。
 */
export function getAlgorithm(id: string): AlgorithmSpec {
  return (
    algorithmRegistry.find((a) => a.id === id) ??
    algorithmRegistry.find((a) => a.id === DEFAULT_ALGORITHM_ID) ??
    algorithmRegistry[0]!
  )
}

/** 取某个大类下的所有算法，供两级选择器的第二列使用 */
export function getAlgorithmsByCategory(category: AlgoCategoryId): AlgorithmSpec[] {
  return algorithmRegistry.filter((a) => a.category === category)
}

/** 某个大类下有几个算法 */
export function countByCategory(category: AlgoCategoryId): number {
  return getAlgorithmsByCategory(category).length
}

/** 某个大类下的算法按 sub-group 分组（组内保持注册顺序）；没有 group 的归到空组 */
export function getGroupedByCategory(
  category: AlgoCategoryId,
): Array<{ group: string; items: AlgorithmSpec[] }> {
  const out: Array<{ group: string; items: AlgorithmSpec[] }> = []
  for (const item of getAlgorithmsByCategory(category)) {
    const group = item.group ?? ''
    const last = out[out.length - 1]
    if (last && last.group === group) last.items.push(item)
    else out.push({ group, items: [item] })
  }
  return out
}

/**
 * 默认算法：冒泡排序。
 * **显式指定**（不是注册表第一条）—— 曾经排序排在最前面时它恰好是第一项，
 * 现在大类顺序改成"线性表在最上、排序在最下"，它依然是默认算法。
 */
export const DEFAULT_ALGORITHM_ID = bubbleSortSpec.id
