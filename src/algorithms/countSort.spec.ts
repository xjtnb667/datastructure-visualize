import { describe, expect, it } from 'vitest'
import { countSortSpec } from './sortBasic'
import { buildSteps } from '@/core/engine'
import type { AlgoStep, BoardView } from '@/core/types'

/**
 * 计数排序「第一趟」（找最小值 / 最大值，`line 4`）的常驻回归测试。
 *
 * 这一趟以前**一帧板子都不给**，而 CanvasPanel 只要发现"这个算法后面有板子"，
 * 就会一直保留下方那块板子槽（动画区逐帧高度恒定的代价），槽里于是长挂一句
 * "该算法没有可显示的结构" —— 用户看到的就是这个空屏。下面第一条用例负责钉死它。
 *
 * 同时钉死"算法本身一个字没动"：帧结构（每行 yield 几次）、比较 / 移动次数、终态。
 */

const ascending = (a: number[]) => [...a].sort((x, y) => x - y)

function stepsOf(data: number[]): AlgoStep[] {
  return buildSteps(countSortSpec, data, { target: data[data.length - 1] })
}

/** 下方板子：ScenePanel 的占位文字只在"这块槽里一块板子都没有"时才出现 */
function bottomBoards(s: AlgoStep): BoardView[] {
  return (s.boards ?? []).filter((b) => b.position !== 'top')
}

/** 复刻 CanvasPanel：算法里只要有一帧带下方板子，这个槽位就整段渲染 */
const usesBottomSlot = (steps: AlgoStep[]) => steps.some((s) => bottomBoards(s).length > 0)

/** 第一趟的帧（找最小 / 最大值那一趟） */
const firstPass = (steps: AlgoStep[]) => steps.filter((s) => s.line === 4)

/** 每行的 yield 次数，用来钉死帧结构 */
function lineCounts(steps: AlgoStep[]): Record<number, number> {
  const out: Record<number, number> = {}
  for (const s of steps) out[s.line] = (out[s.line] ?? 0) + 1
  return out
}

/** 板子小字（= 数值）转回数字 */
const subValues = (b: BoardView) => b.items.map((it) => Number(it.sub))

// 规模 / 形态覆盖：默认数据、全不重复、全相等、1 个、2 个、含 0、跨度大、规模 16
const DATASETS: Array<{ name: string; data: number[] }> = [
  { name: '默认数据（重复值多）', data: countSortSpec.defaultData() },
  { name: '全不重复', data: [5, 2, 9, 1, 7, 3] },
  { name: '全相等', data: [3, 3, 3] },
  { name: '最小值在中间', data: [4, 1, 4, 0, 7, 2, 4, 1] },
  { name: '单个元素', data: [42] },
  { name: '两个元素', data: [0, 9] },
  { name: '含 0 且跨度大', data: [0, 0, 1, 9] },
  { name: '中间全是空档', data: [1, 100] },
  { name: '规模 16', data: Array.from({ length: 16 }, (_, i) => ((i * 7) % 13) + 1) },
  { name: '规模 40', data: Array.from({ length: 40 }, (_, i) => ((i * 11) % 5) + 1) },
]

describe('计数排序 · 第一趟不能是空屏', () => {
  it('每个规模、每一帧，下方板子槽里都有真内容（绝不是"该算法没有可显示的结构"）', () => {
    expect(DATASETS.length).toBeGreaterThanOrEqual(10) // 守卫：别让规模覆盖被删空

    let checked = 0
    for (const { name, data } of DATASETS) {
      const steps = stepsOf(data)
      expect(steps.length, name).toBeGreaterThan(0)
      expect(usesBottomSlot(steps), `${name}：连一块下方板子都没有的话，这条用例就没意义了`).toBe(true)

      for (const s of steps) {
        const boards = bottomBoards(s)
        expect(boards.length, `${name} 第 ${steps.indexOf(s)} 帧（line ${s.line}）槽里是空的`).toBeGreaterThan(0)
        for (const b of boards) expect(b.items.length, `${name}：${b.title} 是一块空格子板`).toBeGreaterThan(0)
        checked += 1
      }
    }
    expect(checked, '守卫：真正校验过的帧数太少，说明数据用例没跑起来').toBeGreaterThan(100)
  })

  it('第一趟逐帧：高亮的那一格，就是这一帧新扫到的数 a[i] 对应的格子', () => {
    for (const { name, data } of DATASETS) {
      const pass = firstPass(stepsOf(data))
      expect(pass.length, `${name}：第一趟一帧都没有（n < 2 时本来就没有，这里只统计 n ≥ 2 的规模）`).toBe(
        Math.max(0, data.length - 1),
      )
      for (const [k, s] of pass.entries()) {
        const i = Number(s.vars?.i)
        expect(i, `${name} 第一趟第 ${k} 帧没有 i`).toBe(k + 1)
        const v = s.array[i]!
        const board = bottomBoards(s)[0]!
        const hot = board.items.filter((it) => it.tone === 'hot')
        expect(hot.length, `${name} 第一趟第 ${k} 帧没有唯一的高亮格`).toBe(1)
        expect(Number(hot[0]!.sub), `${name} 第一趟第 ${k} 帧高亮的是别的格子`).toBe(v)
        // 那一格的正文 = 这个值在已扫过的前缀 a[0..i] 里出现过几次
        const prefix = s.array.slice(0, i + 1).filter((x) => x === v).length
        expect(hot[0]!.text, `${name} 第一趟第 ${k} 帧那一格的计数不对`).toBe(String(prefix))
      }
    }
  })

  it('第一趟的板子是"边扫边长"的：格子只增不减，且扫完覆盖完整取值范围', () => {
    const data = countSortSpec.defaultData()
    const pass = firstPass(stepsOf(data))
    expect(pass.length).toBeGreaterThan(1) // 守卫

    const widths = pass.map((s) => subValues(bottomBoards(s)[0]!).length)
    for (let k = 1; k < widths.length; k++) {
      expect(widths[k]!, `第 ${k} 帧的范围比上一帧还小`).toBeGreaterThanOrEqual(widths[k - 1]!)
    }
    expect(widths[0]).toBeLessThan(widths.at(-1)!)

    const last = subValues(bottomBoards(pass.at(-1)!) [0]!)
    expect(last).toEqual(Array.from({ length: 7 }, (_, k) => k + 1)) // 默认数据是 1..7
  })

  it('算法本身没动：帧结构、比较 / 移动次数、终态都和原来一模一样', () => {
    // 默认数据 n = 8、k = 7：init 1 帧 + 第一趟 7 帧 + 开数组 1 + 计数 8 + 前缀和 6 + 回填 8 + 写回 1 + done 1
    const steps = stepsOf(countSortSpec.defaultData())
    expect(steps.length).toBe(33)
    expect(lineCounts(steps)).toEqual({ 1: 1, 4: 7, 7: 1, 8: 8, 9: 6, 11: 8, 12: 1, 14: 1 })

    // 另一个规模同样对得上：n = 6、k = 9
    const other = stepsOf([5, 2, 9, 1, 7, 3])
    expect(other.length).toBe(29)
    expect(lineCounts(other)).toEqual({ 1: 1, 4: 5, 7: 1, 8: 6, 9: 8, 11: 6, 12: 1, 14: 1 })

    const pairs: Array<{ name: string; data: number[]; list: AlgoStep[] }> = [
      { name: '默认数据', data: countSortSpec.defaultData(), list: steps },
      { name: '全不重复', data: [5, 2, 9, 1, 7, 3], list: other },
    ]
    for (const { name, data, list } of pairs) {
      expect(list[0]!.action, name).toBe('init')
      expect(list.at(-1)!.action, name).toBe('done')
      // 计数排序不比较元素（第 0 帧是引擎造的 init 帧，没有 vars）；搬动次数 = 每个元素往输出数组放一次
      for (const s of list) expect(s.vars?.compares ?? 0, `${name} line ${s.line}`).toBe(0)
      // 最后一帧（引擎补的 done 帧）没有 vars，看倒数第二帧的计数
      const lastVars = [...list].reverse().find((s) => s.vars)
      expect(lastVars!.vars?.moves, name).toBe(data.length)
      expect(lastVars!.vars?.compares ?? 0, name).toBe(0)
      expect(list.at(-1)!.array, name).toEqual(ascending(data))
      expect([...list.at(-1)!.array].sort((x, y) => x - y), name).toEqual(ascending(data))
    }
  })

  it('第一趟以后（开数组 / 前缀和 / 回填）的板子照旧，还是那块真计数数组', () => {
    const steps = stepsOf(countSortSpec.defaultData())
    for (const s of steps.filter((x) => x.line >= 7)) {
      const boards = bottomBoards(s)
      expect(boards.length, `line ${s.line} 少了板子`).toBe(2)
      expect(boards[0]!.title).toContain('计数数组 cnt')
      expect(boards[1]!.title).toContain('输出数组 out')
      expect(subValues(boards[0]!)).toEqual([1, 2, 3, 4, 5, 6, 7])
    }
    // 前缀和那一步的读数 = 各值的累计个数（1 出现 2 次、2 出现 2 次、4 出现 3 次、7 出现 1 次）
    const lastPrefix = bottomBoards(steps.filter((s) => s.line === 9).at(-1)!)[0]!
    expect(lastPrefix.items.map((it) => it.text)).toEqual(['2', '4', '4', '7', '7', '7', '8'])
    // 输出数组最后按序落位
    expect(bottomBoards(steps.at(-1)!)[1]!.items.map((it) => it.text)).toEqual([
      '1', '1', '2', '2', '4', '4', '4', '7',
    ])
  })
})
