import type { AlgoCategoryId, AlgorithmSpec } from '@/core/types'
import { bubbleSortSpec } from './bubbleSort'
import { selectionSortSpec } from './selectionSort'
import { insertionSortSpec } from './insertionSort'
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

/**
 * 算法注册表（SRS EF-09 可扩展性）。
 * 新增算法只需要写一个 spec + 在这里加一行，
 * 两级选择器 / 播放器 / 代码面板 / 渲染器 / 控制器统统不用改。
 */
export const algorithmRegistry: AlgorithmSpec[] = [
  // 排序
  bubbleSortSpec,
  selectionSortSpec,
  insertionSortSpec,
  // 查找
  sequentialSearchSpec,
  binarySearchSpec,
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
]

export function getAlgorithm(id: string): AlgorithmSpec {
  return algorithmRegistry.find((a) => a.id === id) ?? algorithmRegistry[0]!
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

/** 默认算法：第一个排序算法 */
export const DEFAULT_ALGORITHM_ID = bubbleSortSpec.id
