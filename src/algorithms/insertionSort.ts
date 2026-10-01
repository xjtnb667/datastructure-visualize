import type { AlgorithmSpec, AlgoRunner } from '@/core/types'

/** 展示给用户看的源码：C++ 风格 */
export const INSERTION_SORT_CODE = `void insertionSort(int a[], int n) {
    for (int i = 1; i < n; i++) {
        int key = a[i];
        int j = i - 1;
        while (j >= 0 && a[j] > key) {
            a[j + 1] = a[j];
            j--;
        }
        a[j + 1] = key;
    }
}`

export const INSERTION_SORT_CODE_LINES = INSERTION_SORT_CODE.split('\n')

/**
 * 插入排序步骤生成器。
 *   line 3 -> 取出待插入的 key
 *   line 5 -> 比较 a[j] 与 key
 *   line 6 -> a[j] 后移一位
 *   line 9 -> 把 key 放到最终位置
 *   line 2 -> 本轮结束，前 i+1 个元素有序
 */
export function* insertionSort(a: number[]): AlgoRunner {
  const n = a.length
  for (let i = 1; i < n; i++) {
    const key = a[i]!
    yield {
      line: 3,
      action: 'mark',
      array: a,
      indices: [i],
      vars: { i, key, n },
      comment: `取出 key = a[${i}] = ${key}，准备插入左边已排好序的区间`,
    }

    let j = i - 1
    while (j >= 0 && a[j]! > key) {
      yield {
        line: 5,
        action: 'compare',
        array: a,
        indices: [j],
        vars: { i, j, key, n },
        comment: `a[${j}] = ${a[j]} > key = ${key}，需要继续往后腾位置`,
      }
      a[j + 1] = a[j]!
      yield {
        line: 6,
        action: 'set',
        array: a,
        indices: [j + 1],
        vars: { i, j, key, n },
        comment: `把 a[${j}] = ${a[j + 1]} 后移到位置 ${j + 1}`,
      }
      j--
    }

    a[j + 1] = key
    yield {
      line: 9,
      action: 'set',
      array: a,
      indices: [j + 1],
      vars: { i, j, key, n },
      comment: `把 key = ${key} 放到位置 ${j + 1}`,
    }

    yield {
      line: 2,
      action: 'sorted',
      array: a,
      indices: Array.from({ length: i + 1 }, (_, k) => k),
      vars: { i, n },
      comment: `前 ${i + 1} 个元素已经有序`,
    }
  }
}

export const insertionSortSpec: AlgorithmSpec = {
  id: 'insertion-sort',
  name: '直接插入排序',
  category: 'sort',
  group: '插入类排序',
  summary: '把新元素插入到左边有序区',
  complexity: { time: 'O(n²)', space: 'O(1)', stable: true },
  renderer: 'array',
  codeLines: INSERTION_SORT_CODE_LINES,
  defaultData: () => [5, 2, 9, 1, 7, 3],
  createRunner: insertionSort,
}
