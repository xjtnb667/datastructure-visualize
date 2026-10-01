import type { AlgorithmSpec, AlgoRunner, RunnerContext } from '@/core/types'

/** 展示给用户看的源码：C++ 风格 */
export const SEQUENTIAL_SEARCH_CODE = `int sequentialSearch(int a[], int n, int target) {
    for (int i = 0; i < n; i++) {
        if (a[i] == target) {
            return i;
        }
    }
    return -1;
}`

export const SEQUENTIAL_SEARCH_CODE_LINES = SEQUENTIAL_SEARCH_CODE.split('\n')

/** 从数据里随便挑一个存在的值当目标，保证演示一定能命中 */
function pickTarget(data: number[]): number {
  return data[Math.floor(Math.random() * data.length)]!
}

/**
 * 顺序查找（线性查找）步骤生成器。
 *   line 2 -> 准备检查第 i 个元素（候选区间收缩到 [i, n-1]）
 *   line 3 -> 比较 a[i] 与 target
 *   line 4 -> 命中，返回下标
 *   line 7 -> 找遍了也没找到，返回 -1
 *
 * 用 range 表达"已经排除掉的下标"，渲染层会把区间外的柱子画暗 ——
 * 这样"一个一个往后看"的过程就看得见了。
 */
export function* sequentialSearch(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const n = a.length
  const target = ctx.target ?? a[0]!
  for (let i = 0; i < n; i++) {
    yield {
      line: 2,
      action: 'mark',
      array: a,
      indices: [i],
      range: [i, n - 1],
      vars: { i, n, target },
      comment: `检查第 ${i} 个元素，候选范围收缩到 a[${i}]..a[${n - 1}]`,
    }
    yield {
      line: 3,
      action: 'compare',
      array: a,
      indices: [i],
      range: [i, n - 1],
      vars: { i, n, target },
      comment: `比较 a[${i}] = ${a[i]} 与 target = ${target}`,
    }
    if (a[i] === target) {
      yield {
        line: 4,
        action: 'done',
        array: a,
        indices: [i],
        range: [i, i],
        vars: { i, n, target },
        comment: `命中！target = ${target} 在下标 ${i}，共比较 ${i + 1} 次`,
      }
      return
    }
  }
  // 目标值不在数组里（把 target 换成不存在的值就会走到这条路径）
  yield {
    line: 7,
    action: 'done',
    array: a,
    indices: [],
    range: [1, 0],
    vars: { n, target },
    comment: `查找失败：数组中不存在 target = ${target}`,
  }
}

export const sequentialSearchSpec: AlgorithmSpec = {
  id: 'sequential-search',
  name: '顺序查找',
  category: 'search',
  group: '线性表的查找',
  summary: '从头到尾一个一个比对',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'array',
  codeLines: SEQUENTIAL_SEARCH_CODE_LINES,
  defaultData: () => [7, 2, 9, 1, 5, 12, 3, 8],
  defaultTarget: pickTarget,
  createRunner: sequentialSearch,
}
