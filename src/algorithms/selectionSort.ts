import type { AlgorithmSpec, AlgoRunner } from '@/core/types'

/** 展示给用户看的源码：C++ 风格 */
export const SELECTION_SORT_CODE = `void selectionSort(int a[], int n) {
    for (int i = 0; i < n - 1; i++) {
        int minIdx = i;
        for (int j = i + 1; j < n; j++) {
            if (a[j] < a[minIdx]) {
                minIdx = j;
            }
        }
        int t = a[i]; a[i] = a[minIdx]; a[minIdx] = t;
    }
}`

export const SELECTION_SORT_CODE_LINES = SELECTION_SORT_CODE.split('\n')

/**
 * 选择排序步骤生成器。
 *   line 5 -> 比较 a[j] 与当前最小值
 *   line 6 -> 发现更小值，更新 minIdx
 *   line 9 -> 把最小值换到位置 i
 *   line 2 -> 本轮结束，a[i] 就位
 */
export function* selectionSort(a: number[]): AlgoRunner {
  const n = a.length
  for (let i = 0; i < n - 1; i++) {
    let minIdx = i
    for (let j = i + 1; j < n; j++) {
      yield {
        line: 5,
        action: 'compare',
        array: a,
        indices: [j, minIdx],
        vars: { i, j, minIdx, n },
        comment: `比较 a[${j}] = ${a[j]} 与当前最小值 a[${minIdx}] = ${a[minIdx]}`,
      }
      if (a[j]! < a[minIdx]!) {
        minIdx = j
        yield {
          line: 6,
          action: 'mark',
          array: a,
          indices: [minIdx],
          vars: { i, j, minIdx, n },
          comment: `a[${j}] = ${a[j]} 更小，记住 minIdx = ${j}`,
        }
      }
    }

    const minValue = a[minIdx]!
    if (minIdx !== i) {
      const t = a[i]!
      a[i] = minValue
      a[minIdx] = t
      yield {
        line: 9,
        action: 'swap',
        array: a,
        indices: [i, minIdx],
        vars: { i, minIdx, n },
        comment: `把最小值 ${minValue} 从位置 ${minIdx} 换到位置 ${i}`,
      }
    } else {
      yield {
        line: 9,
        action: 'mark',
        array: a,
        indices: [i],
        vars: { i, minIdx, n },
        comment: `a[${i}] = ${minValue} 本来就是最小值，无需交换`,
      }
    }

    yield {
      line: 2,
      action: 'sorted',
      array: a,
      indices: [i],
      vars: { i, n },
      comment: `第 ${i + 1} 轮结束，a[${i}] = ${a[i]} 已就位`,
    }
  }
}

export const selectionSortSpec: AlgorithmSpec = {
  id: 'selection-sort',
  name: '选择排序',
  category: 'sort',
  group: '选择类排序',
  summary: '每轮选出最小值放到前面',
  complexity: { time: 'O(n²)', space: 'O(1)', stable: false },
  renderer: 'array',
  codeLines: SELECTION_SORT_CODE_LINES,
  defaultData: () => [5, 2, 9, 1, 7, 3],
  createRunner: selectionSort,
}
