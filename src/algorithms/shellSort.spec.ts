import { describe, expect, it } from 'vitest'
import { getAlgorithm } from './index'
import { buildSteps } from '@/core/engine'

/**
 * 希尔排序 gap = 1 那一趟的回归用例。
 *
 * 起因（用户提的）：增量降到 1 时六根柱子**全紫**，而且解说写着"一共 1 组"，看着像 bug。
 *
 * 事实：分组数 = gap，所以最后一趟 gap = 1 时确实只有 1 组（整条数组），这句话本身是对的。
 * 真问题是**画面**：旧实现把"当前这一组"整组都当成高亮下标，gap = 1 时整组就是整条数组 ——
 * 于是最后一趟每帧都是一种颜色刷满全屏（mark 全紫 / compare 全橙 / set 全红），
 * 而紫色在图例里是「当前指针」，全紫直接和"所有元素都是指针"这种误读撞上了，
 * 还让"分组数从 3 组掉到 1 组"看起来像界面坏了。
 *
 * 本文件守住三件事：
 *   1. gap = 1 那一趟只圈**真正的指针**（紫色格子数 == 真实指针数），绝不是整组；
 *   2. gap > 1 的趟仍然高亮"当前整组"（别为了修最后一趟把前面的可视化改没）；
 *   3. 解说明确说出"分组数从上一趟的 N 组变成 1 组、这一趟就是普通直接插入排序"。
 * 另有一条"算法一个字没改"的锁：gap 序列、总帧数、比较/移动次数、终态全部冻结。
 *
 * ⚠️ 这三组用例都带"至少覆盖 N 帧"的守卫，防止筛选条件写错导致 silently 空跑。
 */
const SHELL = getAlgorithm('sort-shell')!

/** 三档规模：n = 6（默认数据）、8、12；gap 序列分别是 3→1、4→2→1、6→3→1 */
const CASES: Array<{ label: string; data: number[] }> = [
  { label: 'n = 6（默认数据）', data: [5, 2, 9, 1, 7, 3] },
  { label: 'n = 8', data: [8, 3, 7, 1, 9, 4, 6, 2] },
  { label: 'n = 12', data: [12, 5, 3, 9, 1, 7, 2, 8, 6, 11, 4, 10] },
]

function shellSteps(data: number[]) {
  return buildSteps(SHELL, data.slice(), {})
}

/** 某一帧属于哪一趟（gap）：靠 vars.gap 认，比数帧号稳 */
const gapOf = (step: { vars?: Record<string, number> }) => step.vars?.gap

describe('sort-shell 的 gap = 1 最后一趟：高亮只圈真正的指针', () => {
  it('gap = 1 那趟的高亮格子数 == 真实指针数（不能是整组，更不能是整条数组）', () => {
    for (const { label, data } of CASES) {
      const n = data.length
      const steps = shellSteps(data)
      const lastPass = steps.filter((s) => gapOf(s) === 1)

      // 守卫：一帧都没筛到就说明 gap 字段改名了 / 筛选条件写错了，用例在空跑
      expect(lastPass.length, `${label}：gap = 1 那一趟一帧都没有，用例在空跑`).toBeGreaterThan(n)

      const body = lastPass.filter((s) => s.line !== 2)
      expect(body.length, `${label}：gap = 1 那一趟没有实质帧`).toBeGreaterThan(n)

      for (const s of body) {
        // 核心断言：任何一帧都不许"整条数组一起上色"
        expect(
          s.indices.length,
          `${label}：第 ${s.line} 行这一帧圈了 ${s.indices.length} 个格子（共 ${n} 格）—— gap = 1 时整组就是整条数组，不能整组上色`,
        ).toBeLessThan(n)

        if (s.line === 4 || s.line === 3) {
          // 取出待插入的 key / 本位置处理完：真正的指针只有 i 一个
          expect(s.indices, `${label}：第 ${s.line} 行该只高亮指针 i`).toEqual([s.vars!.i])
        } else if (s.line === 6 || s.line === 7) {
          // 比较 / 后移：打交道的是相邻的 j 与 j + gap（gap = 1 时就是 j 和 j + 1）
          const j = s.vars!.j as number
          expect([...s.indices].sort((x, y) => x - y), `${label}：第 ${s.line} 行该高亮 j 与 j + 1`).toEqual([j, j + 1])
        } else if (s.line === 9) {
          // key 落位：只有落点这一个格子
          expect(s.indices.length, `${label}：第 9 行该只高亮 key 的落点`).toBe(1)
        }
      }

      // 反面证据：修之前 n = 6 的 gap = 1 趟里，10 个 mark 帧每个都是 6 格全紫
      const fullWidth = body.filter((s) => s.indices.length === n)
      expect(fullWidth, `${label}：还有帧把整条数组全上色了`).toEqual([])
    }
  })

  it('gap > 1 的趟仍然高亮"当前整组"（没有把别的趟一起改掉）', () => {
    for (const { label, data } of CASES) {
      const n = data.length
      const steps = shellSteps(data)
      const groupFrames = steps.filter((s) => gapOf(s) !== undefined && gapOf(s)! > 1 && s.line !== 2)

      expect(groupFrames.length, `${label}：gap > 1 的帧一帧都没有，用例在空跑`).toBeGreaterThan(n)

      for (const s of groupFrames) {
        const gap = gapOf(s)!
        const g = s.vars!.i % gap
        const expectGroup: number[] = []
        for (let k = g; k < n; k += gap) expectGroup.push(k)
        expect(s.indices, `${label}：gap = ${gap} 的帧该高亮第 ${g + 1} 组整组`).toEqual(expectGroup)
        // gap > 1 时一组必然比整条数组短
        expect(s.indices.length).toBeLessThan(n)
      }
    }
  })

  it('解说要说清"分组数从上一趟的 N 组变成 1 组、这一趟就是普通直接插入排序"', () => {
    const steps = shellSteps([5, 2, 9, 1, 7, 3])
    const headers = steps.filter((s) => s.line === 2)

    // n = 6 的 gap 序列就是 3、1（分组数 = gap，所以组数是 3 组、1 组）
    expect(headers.map((s) => gapOf(s))).toEqual([3, 1])

    const first = headers[0]!
    const last = headers.at(-1)!
    expect(first.comment).toContain('一共 3 组')
    expect(first.comment).toContain('分组数 = gap')

    expect(last.comment, '最后一趟该点明"只有 1 组"').toContain('1 组')
    expect(last.comment, '最后一趟该说清上一趟是 3 组，主动消解"怎么变成 1 组了"').toContain('3 组')
    expect(last.comment, '最后一趟该点明它等价于普通直接插入排序').toContain('直接插入排序')

    // 换增量的那一帧不该给任何格子标成"当前指针"（旧版这里也就是全紫的来源之一）
    for (const h of headers) expect(h.indices).toEqual([])

    // gap = 1 那趟的行首解说里不该再出现"第 1 组（下标 0、1、2、3、4、5）"这种"整组"说法
    const lastBody = steps.filter((s) => gapOf(s) === 1 && s.line !== 2)
    expect(lastBody.length).toBeGreaterThan(6)
    for (const s of lastBody) {
      expect(s.comment, `${s.line} 行还在用"第 1 组"讲最后一趟`).not.toContain('第 1 组（下标')
      expect(s.comment.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('sort-shell 的算法本体一个字没改（锁死 gap 序列 / 帧数 / 比较与移动次数 / 终态）', () => {
  const FROZEN = [
    { data: [5, 2, 9, 1, 7, 3], gaps: [3, 1], steps: 38, compares: 8, swaps: 10 },
    { data: [8, 3, 7, 1, 9, 4, 6, 2], gaps: [4, 2, 1], steps: 103, compares: 30, swaps: 34 },
    { data: [12, 5, 3, 9, 1, 7, 2, 8, 6, 11, 4, 10], gaps: [6, 3, 1], steps: 144, compares: 42, swaps: 45 },
  ]

  it('帧数、gap 序列、比较/移动次数、终态逐一锁定', () => {
    for (const f of FROZEN) {
      const n = f.data.length
      const steps = shellSteps(f.data)

      expect(steps.length, `n = ${n}：总帧数变了（高亮改动不该增删任何一帧）`).toBe(f.steps)
      expect(steps.filter((s) => s.line === 2).map((s) => gapOf(s)), `n = ${n}：gap 序列变了`).toEqual(f.gaps)

      const last = steps.at(-1)!
      expect(
        { compares: last.stats.compares, swaps: last.stats.swaps },
        `n = ${n}：比较 / 移动次数变了（算法本体被动过）`,
      ).toEqual({ compares: f.compares, swaps: f.swaps })
      expect(last.action, `n = ${n}：最后一帧该是 done`).toBe('done')
      expect(last.array, `n = ${n}：排序结果不对`).toEqual([...f.data].sort((x, y) => x - y))

      // 中间过程的计数单调不减（引擎按 action 累加，和原来一致）
      const compares = steps.map((s) => s.stats.compares)
      const swaps = steps.map((s) => s.stats.swaps)
      for (let k = 1; k < steps.length; k++) {
        expect(compares[k]! >= compares[k - 1]!).toBe(true)
        expect(swaps[k]! >= swaps[k - 1]!).toBe(true)
      }
      expect(compares[0]).toBe(0)
      expect(swaps[0]).toBe(0)
    }
  })

  it('n = 2 时只有一趟 gap = 1，解说不能瞎说"上一趟是 1 组"', () => {
    const steps = buildSteps(SHELL, [2, 1], {})
    const headers = steps.filter((s) => s.line === 2)
    expect(headers.map((s) => gapOf(s))).toEqual([1])
    expect(headers[0]!.comment).toContain('1 组')
    expect(headers[0]!.comment).not.toContain('上一趟')
    expect(steps.at(-1)!.array).toEqual([1, 2])
    // 这唯一一趟也不能整组上色：mark 帧只圈指针 i 一个格子
    // （比较帧圈的本来就是"相邻两个"，n = 2 时正好是全部两格，那是对的）
    for (const s of steps.filter((x) => x.line === 4 || x.line === 3)) {
      expect(s.indices).toEqual([s.vars!.i])
    }
  })
})
