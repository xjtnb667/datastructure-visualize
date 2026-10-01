import type { AlgorithmSpec, AlgoRunner } from '@/core/types'

/**
 * 展示给用户看的源码：C++ 风格（与《数据结构》教材一致）。
 * 行号就是这里的物理行号（1-based）；yield 里写的 line 必须和它对齐，
 * 对不上 engine 在校验阶段会直接抛错（而不是默默显示错误的行）。
 *
 * 注意：这份 C++ 代码是"给人看的展示代码"；真正产出步骤序列的是下面那个
 * TypeScript 生成器（两者逻辑一一对应，行号由自动化测试守着）。
 */
export const BUBBLE_SORT_CODE = `void bubbleSort(int a[], int n) {
    for (int i = 0; i < n - 1; i++) {
        for (int j = 0; j < n - 1 - i; j++) {
            if (a[j] > a[j + 1]) {
                int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t;
            }
        }
    }
}`

export const BUBBLE_SORT_CODE_LINES = BUBBLE_SORT_CODE.split('\n')

/**
 * 冒泡排序步骤生成器。
 *
 * 与 C++ 源码的对应关系：
 *   line 4 -> 比较 a[j] 与 a[j+1]
 *   line 5 -> 交换完成
 *   line 2 -> 本轮结束，最大值已冒泡到位（一行可以被多个事件共用）
 *
 * 注意：yield 出的 array 就是算法内部的活数组（故意这样写，让生成器读起来和真实算法一致）。
 * engine 会在入栈时 slice() 拷一份，所以这里不需要手动拷贝。
 */
export function* bubbleSort(a: number[]): AlgoRunner {
  const n = a.length
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1 - i; j++) {
      yield {
        line: 4,
        action: 'compare',
        array: a,
        indices: [j, j + 1],
        vars: { i, j, n },
        comment: `比较 a[${j}] = ${a[j]} 与 a[${j + 1}] = ${a[j + 1]}`,
      }
      if (a[j]! > a[j + 1]!) {
        const left = a[j]!
        const right = a[j + 1]!
        const t = a[j]!
        a[j] = a[j + 1]!
        a[j + 1] = t
        yield {
          line: 5,
          action: 'swap',
          array: a,
          indices: [j, j + 1],
          vars: { i, j, n },
          comment: `${left} > ${right}，交换 a[${j}] 与 a[${j + 1}]`,
        }
      }
    }
    const settled = n - 1 - i
    yield {
      line: 2,
      action: 'sorted',
      array: a,
      indices: [settled],
      vars: { i, n },
      comment: `第 ${i + 1} 轮结束，a[${settled}] = ${a[settled]} 已就位`,
    }
  }
}

export const bubbleSortSpec: AlgorithmSpec = {
  id: 'bubble-sort',
  name: '冒泡排序',
  category: 'sort',
  summary: '相邻两两比较，大的往后冒',
  complexity: { time: 'O(n²)', space: 'O(1)', stable: true },
  renderer: 'array',
  codeLines: BUBBLE_SORT_CODE_LINES,
  defaultData: () => [5, 2, 9, 1, 7, 3],
  createRunner: bubbleSort,
}
