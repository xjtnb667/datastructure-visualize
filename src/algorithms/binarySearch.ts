import type { AlgorithmSpec, AlgoRunner, RunnerContext } from '@/core/types'

/** 展示给用户看的源码：C++ 风格 */
export const BINARY_SEARCH_CODE = `int binarySearch(int a[], int n, int target) {
    int low = 0, high = n - 1;
    while (low <= high) {
        int mid = (low + high) / 2;
        if (a[mid] == target) return mid;
        if (a[mid] < target) low = mid + 1;
        else high = mid - 1;
    }
    return -1;
}`

export const BINARY_SEARCH_CODE_LINES = BINARY_SEARCH_CODE.split('\n')

function pickTarget(data: number[]): number {
  return data[Math.floor(Math.random() * data.length)]!
}

/**
 * 折半查找（二分查找）步骤生成器。
 *   line 4 -> 取中间位置 mid
 *   line 5 -> 比较 a[mid] 与 target
 *   line 6 -> a[mid] < target，丢掉左半部分
 *   line 7 -> a[mid] > target，丢掉右半部分
 *   line 9 -> 区间空了，没找到
 *
 * 用 range = [low, high] 表达"当前候选区间"，渲染层把区间外的柱子画暗，
 * 这样"每次排除一半"的效果一眼就能看见 —— 这正是折半查找的精髓。
 *
 * 前提：数组必须是有序的。spec 里的 prepareData 会在载入前兜底排序，
 * 所以点「随机数据」也不会喂进来一个无序数组。
 */
export function* binarySearch(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const n = a.length
  const target = ctx.target ?? a[0]!
  let low = 0
  let high = n - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)

    yield {
      line: 4,
      action: 'mark',
      array: a,
      indices: [mid],
      range: [low, high],
      vars: { low, high, mid, n, target },
      comment: `mid = (${low} + ${high}) / 2 = ${mid}，先看中间这个`,
    }
    yield {
      line: 5,
      action: 'compare',
      array: a,
      indices: [mid],
      range: [low, high],
      vars: { low, high, mid, n, target },
      comment: `比较 a[${mid}] = ${a[mid]} 与 target = ${target}`,
    }

    if (a[mid] === target) {
      yield {
        line: 5,
        action: 'done',
        array: a,
        indices: [mid],
        range: [mid, mid],
        vars: { low, high, mid, n, target },
        comment: `命中！target = ${target} 在下标 ${mid}`,
      }
      return
    }

    if (a[mid]! < target) {
      low = mid + 1
      yield {
        line: 6,
        action: 'mark',
        array: a,
        indices: [mid],
        range: [low, high],
        vars: { low, high, mid, n, target },
        comment: `a[${mid}] = ${a[mid]} < target，左半部分全部排除，low = ${low}`,
      }
    } else {
      high = mid - 1
      yield {
        line: 7,
        action: 'mark',
        array: a,
        indices: [mid],
        range: [low, high],
        vars: { low, high, mid, n, target },
        comment: `a[${mid}] = ${a[mid]} > target，右半部分全部排除，high = ${high}`,
      }
    }
  }

  yield {
    line: 9,
    action: 'done',
    array: a,
    indices: [],
    range: [1, 0],
    vars: { n, target },
    comment: `查找失败：候选区间已空，数组中不存在 target = ${target}`,
  }
}

export const binarySearchSpec: AlgorithmSpec = {
  id: 'binary-search',
  name: '折半查找',
  category: 'search',
  summary: '每次砍掉一半（要求有序）',
  complexity: { time: 'O(log n)', space: 'O(1)' },
  renderer: 'array',
  codeLines: BINARY_SEARCH_CODE_LINES,
  // 折半查找的前提是有序：随机/自定义数据先过一遍排序，否则算法结果没有意义
  prepareData: (raw) => [...raw].sort((x, y) => x - y),
  defaultData: () => [2, 5, 7, 11, 14, 19, 23, 28],
  defaultTarget: pickTarget,
  createRunner: binarySearch,
}
