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
 * ⚠️ 但这块板子**必须只说代码真正做过的事**：第一趟的 C 代码是
 *     `if (a[i] < minV) minV = a[i]; if (a[i] > maxV) maxV = a[i];`
 * —— 一个计数都没做（真正的计数在 `line 8`：`cnt[a[i] - minV]++`）。
 * 所以第二、三条用例钉死：第一趟**每一格正文恒为 0**、颜色只由 minV/maxV 决定、
 * 文案里不许出现"加一 / 计数 / 边扫边数"。
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

  it('第一趟逐帧：高亮的那一格就是这一帧新扫到的 a[i]，而且每一格都是 0（一个都没数）', () => {
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

        // ⚠️ 这一趟的 C 代码只做 min/max，一个 `++` 都没有 —— 所以每一格正文必须恒为 0。
        // （老版本这里断言"那一格的正文 = 这个值在已扫过的前缀里出现过几次"，
        //   那是把"板子在替代码数数"这个错误行为固化了下来，见文件头注释。）
        const nums = board.items.map((it) => it.text)
        expect(
          nums.every((t) => t === '0'),
          `${name} 第一趟第 ${k} 帧有格子不是 0（说明这一趟真的在数数了）：${nums.join(',')}`,
        ).toBe(true)
        expect(new Set(nums).size, `${name} 第一趟第 ${k} 帧的格子取值不止一种`).toBe(1)
      }
    }
  })

  it('第一趟的解说与板子标题里不许出现"加一 / 计数"，因为这一趟没在数数', () => {
    // 守卫：别让"边扫边数 / 这一格加一"这类和代码对不上的说法又溜回来
    const FORBIDDEN = ['加一', '计数', '边扫边数']
    const seenTexts = new Set<string>()
    for (const { name, data } of DATASETS) {
      for (const s of firstPass(stepsOf(data))) {
        const b = bottomBoards(s)[0]!
        for (const [what, text] of [
          ['comment', String(s.comment ?? '')],
          ['title', b.title],
          ['note', b.note ?? ''],
        ] as const) {
          seenTexts.add(text)
          for (const bad of FORBIDDEN) {
            expect(text.includes(bad), `${name} 第一趟的 ${what} 里出现了"${bad}"：${text}`).toBe(false)
          }
        }
      }
    }
    expect(seenTexts.size, '守卫：真正检查过的文案太少，说明规模没跑起来').toBeGreaterThan(10)
    // 而且这些文案必须真的在讲"探明范围 / 预告"，不能是空话
    const joined = [...seenTexts].join('\n')
    expect(joined).toContain('探明')
    expect(joined).toContain('预告')
    expect(joined).toContain('还没开始数数')
  })

  it('第一趟的板子：格子数是整个数组的取值范围，逐帧恒定；范围外的格子淡显，范围一格格长进来', () => {
    for (const { name, data } of DATASETS) {
      const pass = firstPass(stepsOf(data))
      if (pass.length === 0) continue
      const fullMin = Math.min(...data)
      const fullMax = Math.max(...data)
      const width = fullMax - fullMin + 1
      let dimCounts: number[] = []
      for (const [k, s] of pass.entries()) {
        const b = bottomBoards(s)[0]!
        // 帧宽恒定：格子 = 整个取值范围的每一个整数（下标 = 数值，全程不错位）
        expect(subValues(b), `${name} 第一趟第 ${k} 帧的格子不是完整的取值范围`).toEqual(
          Array.from({ length: width }, (_, t) => fullMin + t),
        )
        // 颜色只能说代码算出来的话：范围外 dim、范围内 base、当前扫到的那格 hot
        const minV = Number(s.vars?.minV)
        const maxV = Number(s.vars?.maxV)
        const expected = b.items.map((it) =>
          Number(it.sub) === s.array[Number(s.vars?.i)] ? 'hot' : Number(it.sub) < minV || Number(it.sub) > maxV ? 'dim' : 'base',
        )
        expect(b.items.map((it) => it.tone), `${name} 第一趟第 ${k} 帧的颜色和 minV/maxV 对不上`).toEqual(expected)
        dimCounts.push(b.items.filter((it) => it.tone === 'dim').length)
      }
      // "范围在长"这件事本身：淡显的格子只减不增，而且真的少下去了
      for (let k = 1; k < dimCounts.length; k++) {
        expect(dimCounts[k]!, `${name} 第一趟第 ${k} 帧淡显的格子反而变多了`).toBeLessThanOrEqual(dimCounts[k - 1]!)
      }
      if (pass.length >= 2 && width > 1) {
        expect(dimCounts[0], `${name}：首帧就有范围外的格子，这条断言才有意义`).toBeGreaterThan(0)
      }
      expect(dimCounts.at(-1), `${name} 最后一帧不该还有范围外的格子（范围已经探完了）`).toBe(0)
    }
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

  it('逐帧对照：第一趟全是 0；到 line 8 那一趟计数才和真实出现次数逐个相等', () => {
    const data = countSortSpec.defaultData()
    const steps = stepsOf(data)
    const occurrences = (v: number) => data.filter((x) => x === v).length

    // ① 第一趟（line 4）：一个都没数，逐帧全 0
    let firstPassFrames = 0
    for (const s of firstPass(steps)) {
      const b = bottomBoards(s)[0]!
      expect(b.items.map((it) => it.text), `第一趟第 ${s.vars?.i} 帧不是全 0`).toEqual(
        b.items.map(() => '0'),
      )
      firstPassFrames += 1
    }
    expect(firstPassFrames, '守卫：第一趟一帧都没跑到').toBe(data.length - 1)

    // ② line 7 刚开出来的计数数组：全是 0
    const opened = bottomBoards(steps.find((s) => s.line === 7)!)[0]!
    expect(opened.items.map((it) => it.text)).toEqual(opened.items.map(() => '0'))

    // ③ line 8 那一趟：逐帧对账 —— 计数格必须正好是"算完这一帧之后"的值，
    //    也就是 [minV, a[i]] 里每个数值真实出现了几次（含当前这个）。板子和代码错开一帧
    //    就等于板子在说假话，所以这里卡的是"帧内"，不是"帧后"。
    let p = 0
    for (const s of steps.filter((x) => x.line === 8)) {
      p += 1
      const board = bottomBoards(s)[0]!
      const i = Number(s.vars?.i)
      const v = s.array[i]!
      const expected = board.items.map((it) =>
        String(data.slice(0, i + 1).filter((x) => x === Number(it.sub)).length),
      )
      expect(board.items.map((it) => it.text), `line 8 第 ${p} 帧（扫到 a[${i}] = ${v}）对不上真实出现次数`).toEqual(expected)
      // 这一格必须已经把自己算进去了（不能慢一帧）：等于"已扫过的前缀里出现几次"，至少是 1
      const seenSoFar = data.slice(0, i + 1).filter((x) => x === v).length
      expect(board.items[Number(v) - Number(s.vars?.minV)]!.text, `a[${i}] = ${v} 那一格没把自己算进去`).toBe(
        String(seenSoFar),
      )
      expect(seenSoFar, `a[${i}] = ${v} 自己都没算进去`).toBeGreaterThan(0)
    }
    expect(p, '守卫：line 8 一帧都没跑到').toBe(data.length)

    // ④ 计数跑完：每一格都等于整个数组里这个值真实出现的次数
    const lastCount = bottomBoards(steps.filter((s) => s.line === 8).at(-1)!)[0]!
    for (const it of lastCount.items) {
      expect(Number(it.text), `数值 ${it.sub} 的计数不对`).toBe(occurrences(Number(it.sub)))
    }
  })

  it('第一趟之后每一步的读数也是"算完这一步之后"的值：前缀和与倒序回填都不能慢一帧', () => {
    const data = countSortSpec.defaultData() // [4,1,4,2,7,2,4,1]，minV = 1
    const steps = stepsOf(data)

    // 前缀和：逐帧累加 cnt[v] += cnt[v-1]，第一帧（v = 1）就该把 cnt[1] 并进来
    const prefix = steps.filter((s) => s.line === 9)
    expect(prefix.length, '守卫：前缀和一帧都没跑到').toBeGreaterThan(0)
    // 第 1 帧（v = 1）：cnt[1] += cnt[0]，基础数据 [2,2,0,3,0,0,1] → 位置 1 变成 4
    expect(bottomBoards(prefix[0]!)[0]!.items.map((it) => it.text)).toEqual(['2', '4', '0', '3', '0', '0', '1'])
    expect(bottomBoards(prefix.at(-1)!)[0]!.items.map((it) => it.text)).toEqual(['2', '4', '4', '7', '7', '7', '8'])
    // 逐帧对账：第 j 帧（v = j）正好是"把 cnt[0..j] 累加"的结果
    for (const [j, s] of prefix.entries()) {
      const v = Number(s.vars?.v)
      expect(v, `前缀和第 ${j} 帧的 v 不对`).toBe(j + 1)
      expect(Number(s.vars?.value), `前缀和第 ${j} 帧的 value 不对`).toBe(v + 1)
      const counts: number[] = []
      for (let t = 0; t <= v; t++) counts.push(data.filter((x) => x === 1 + t).length)
      for (let t = 1; t <= v; t++) counts[t] = counts[t]! + counts[t - 1]!
      const got = bottomBoards(s)[0]!.items.map((it) => Number(it.text))
      expect(got.slice(0, v + 1), `前缀和第 ${j} 帧 cnt[0..${v}] 对不上真实累加结果`).toEqual(counts)
      // 还没轮到的格子不能被顺手改掉（下标 = 数值，所以下标 t 对应数值 1 + t）
      const untouched: number[] = []
      for (let t = v + 1; t < got.length; t++) untouched.push(data.filter((x) => x === 1 + t).length)
      expect(got.slice(v + 1), `前缀和第 ${j} 帧动到了还没轮到的格子`).toEqual(untouched)
    }

    // 倒序回填：每拿走一个元素，那一格的读数当场就往下掉 1
    const back = steps.filter((s) => s.line === 11)
    expect(back.length, '守卫：回填一帧都没跑到').toBe(data.length)
    for (const s of back) {
      const board = bottomBoards(s)[0]!
      const v = Number(s.vars?.value)
      const at = Number(s.vars?.at)
      expect(board.items[Number(v) - 1]!.text, `回填 a → ${v} 时 cnt[${v - 1}] 没减到 ${at}`).toBe(String(at))
    }
  })
})
