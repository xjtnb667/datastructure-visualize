import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { algorithmRegistry, getAlgorithm } from '@/algorithms/index'
import { buildSteps } from '@/core/engine'
import {
  PTR_BADGE_H,
  PTR_BADGE_PAD,
  PTR_CELL,
  PTR_COL_LABEL_X,
  PTR_EDGE,
  PTR_LANE_H,
  PTR_MIN_GAP,
  PTR_RING_SIZE,
  TREE_PAD,
  layoutBoardPointers,
  pointerMetrics,
  ptrPadTopFor,
  treePtrSeats,
  treeSeatPad,
  type PlacedPtrLabel,
} from '@/core/pointerLabels'
import ScenePanel from '@/components/ScenePanel.vue'
import TreePanel from '@/components/TreePanel.vue'
import { useAlgorithmStore } from '@/stores/algorithm'
import type { AlgorithmSpec, AlgoStep, BoardView, RunnerContext } from '@/core/types'

/**
 * 指针标签的几何断言（守的还是用户截图里那个问题）。
 *
 * 「堆排序的建堆阶段，`2i+1` 和 `较大的孩子` 两个黄标签叠在一起、字压字」
 * 之所以会出现，是因为标签位置以前是纯 CSS 算的（只看自己那一格），
 * 同格/邻格的两个指针必然叠住。现在位置由 `src/core/pointerLabels.ts` 的纯函数算，
 * 所以这里可以在 **Node 里把全部算法、全部帧**都跑一遍，逐帧断言：
 *   1. 同一块板子上的标签两两不相交（横向或纵向至少空出 PTR_MIN_GAP）；
 *   2. 没有标签被挤到板子外面（环形连上下边界一起看）；
 *   3. 一个标签都不能少（指针有几个，标签就有几个）；
 *   4. 板子留出的空白（padding-top / row-gap）真能装下最高的那一层。
 * 不用开浏览器 —— 浏览器里量矩形太贵，留给 CDP 抽查（见任务记录）。
 */

function ctxOf(spec: AlgorithmSpec, input: number[]): RunnerContext {
  return {
    target: spec.defaultTarget ? input[Math.floor(input.length / 2)] : undefined,
    pos: spec.defaultPos?.(input),
    value: spec.defaultValue?.(input),
    capacity: spec.capacity,
  }
}

function prepared(spec: AlgorithmSpec): number[] {
  const raw = spec.defaultData()
  return spec.prepareData ? spec.prepareData(raw) : raw
}

/** 两个标签真的叠住了吗（横竖都挤在一起才算） */
function stacked(a: PlacedPtrLabel, b: PlacedPtrLabel): boolean {
  const hitX = a.rect.l < b.rect.r + PTR_MIN_GAP && b.rect.l < a.rect.r + PTR_MIN_GAP
  const hitY = a.rect.t < b.rect.b + PTR_MIN_GAP && b.rect.t < a.rect.b + PTR_MIN_GAP
  return hitX && hitY
}

/** 同一块板子上两个指针指向同一格的标签名（用户截图里就是这种） */
function sameCellPairs(b: BoardView): Array<[string, string]> {
  const entries = Object.entries(b.pointers ?? {})
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i][1] === entries[j][1]) pairs.push([entries[i][0], entries[j][0]])
    }
  }
  return pairs
}

describe('指针标签的几何：全算法逐帧断言', () => {
  it('同一块板子上两两不相交、不出板子、一个都不少', () => {
    const bad: string[] = []
    let algos = 0
    let frames = 0
    let ptrBoards = 0
    let labels = 0
    let sameCell = 0

    for (const spec of algorithmRegistry) {
      algos += 1
      const input = prepared(spec)
      const sizes = spec.sizes ?? [input.length]
      const ctx = ctxOf(spec, input)
      for (const n of sizes) {
        const data = input.slice(0, n)
        if (!data.length) continue
        let steps: AlgoStep[]
        try {
          steps = buildSteps(spec, data, ctx)
        } catch {
          continue // 数据不合法之类，别的测试会管；这里只看几何
        }
        for (const [fi, step] of steps.entries()) {
          frames += 1
          for (const [bi, b] of (step.boards ?? []).entries()) {
            const names = Object.keys(b.pointers ?? {})
            if (!names.length) continue
            ptrBoards += 1
            sameCell += sameCellPairs(b).length
            const lay = layoutBoardPointers(b)
            labels += lay.labels.length
            const where = `${spec.id} 帧${fi} 板${bi}(${b.layout})`

            // ① 一个都不能少、名字不能变
            if (lay.labels.length !== names.length) {
              bad.push(`${where}: 标签 ${lay.labels.length} 个，指针却有 ${names.length} 个`)
            }
            const got = new Set(lay.labels.map((l) => l.name))
            for (const nm of names) {
              if (!got.has(nm)) bad.push(`${where}: 丢了指针 ${nm}`)
            }

            // ② 两两不相交
            for (let i = 0; i < lay.labels.length; i += 1) {
              for (let j = i + 1; j < lay.labels.length; j += 1) {
                const a = lay.labels[i]
                const c = lay.labels[j]
                if (stacked(a, c)) {
                  bad.push(
                    `${where}: ${a.name}#${a.idx}[${a.rect.l.toFixed(1)},${a.rect.r.toFixed(1)}]` +
                      ` 压住 ${c.name}#${c.idx}[${c.rect.l.toFixed(1)},${c.rect.r.toFixed(1)}]`,
                  )
                }
              }
            }

            // ③ 不出板子（标签本身就比板子宽时，至少贴在左边缘）
            for (const l of lay.labels) {
              const w = l.rect.r - l.rect.l
              if (w <= lay.boardW - 2 * PTR_EDGE + 0.01) {
                if (l.rect.l < PTR_EDGE - 0.01 || l.rect.r > lay.boardW - PTR_EDGE + 0.01) {
                  bad.push(`${where}: ${l.name} 横着跑出板子 [${l.rect.l.toFixed(1)},${l.rect.r.toFixed(1)}] / 板宽 ${lay.boardW}`)
                }
              } else if (Math.abs(l.rect.l - PTR_EDGE) > 0.01) {
                bad.push(`${where}: ${l.name} 比板子还宽，却没贴住左边缘`)
              }
              if (b.layout === 'ring') {
                if (l.rect.t < PTR_EDGE - 0.01 || l.rect.b > PTR_RING_SIZE - PTR_EDGE + 0.01) {
                  bad.push(`${where}: ${l.name} 竖着跑出环形 [${l.rect.t.toFixed(1)},${l.rect.b.toFixed(1)}]`)
                }
              }
              // ④ 上方留的空白要装得下这一层（横排 / 折行的标签挂在格子上方）
              if (b.layout === 'row' || b.layout === 'grid') {
                const need = PTR_BADGE_PAD + PTR_BADGE_H - l.dy
                if (lay.padTop < need - 1e-6) {
                  bad.push(`${where}: ${l.name} 要 ${need}px 上方空白，只留了 ${lay.padTop}px`)
                }
                if (b.layout === 'grid' && lay.rowGap < need - 1e-6) {
                  bad.push(`${where}: ${l.name} 要 ${need}px 行间距，只留了 ${lay.rowGap}px`)
                }
              }
            }
          }
        }
      }
    }

    // 扫到的规模要够大，否则这条断言没有意义
    expect(labels).toBeGreaterThan(5000)
    expect(ptrBoards).toBeGreaterThan(3000)
    expect(sameCell, '居然没有"两个指针指同一格"的帧？扫描逻辑可能坏了').toBeGreaterThan(100)
    console.log(
      `[指针标签几何] 算法 ${algos}、帧 ${frames}、含指针板子 ${ptrBoards}、` +
        `标签 ${labels}、同格指针组合 ${sameCell}、问题 ${bad.length}`,
    )
    expect(bad.slice(0, 20)).toEqual([])
  })

  it('整条轨迹的留白覆盖得上每一帧（板子才不会逐帧上下跳）', () => {
    const bad: string[] = []
    for (const spec of algorithmRegistry) {
      const input = prepared(spec)
      const sizes = spec.sizes ?? [input.length]
      const ctx = ctxOf(spec, input)
      for (const n of sizes) {
        const data = input.slice(0, n)
        if (!data.length) continue
        let steps: AlgoStep[]
        try {
          steps = buildSteps(spec, data, ctx)
        } catch {
          continue
        }
        const m = pointerMetrics(steps)
        if (m.padTop !== ptrPadTopFor(m.lanes)) bad.push(`${spec.id}: padTop 和层数对不上`)
        for (const [fi, step] of steps.entries()) {
          for (const b of step.boards ?? []) {
            if (!Object.keys(b.pointers ?? {}).length) continue
            const lay = layoutBoardPointers(b)
            if (lay.padTop > m.padTop || lay.rowGap > m.rowGap || lay.padRight > m.padRight) {
              bad.push(`${spec.id} 帧${fi}: 这一帧要的留白比整条轨迹留的还大`)
            }
            // 竖排的标签贴在格子右边，右边留的宽度要够
            if (b.layout === 'column') {
              for (const l of lay.labels) {
                const need = l.rect.r - PTR_COL_LABEL_X
                if (lay.padRight - (PTR_COL_LABEL_X - PTR_CELL) < need - 1e-6) {
                  bad.push(`${spec.id} 帧${fi}: 竖排右边的留白不够放下 ${l.name}`)
                }
              }
            }
          }
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([])
  })

  it('带指针的板子：要么不写显式 row / col，写了就必须和"行优先序号"完全一致', () => {
    /*
     * pointerLabels 按「格子序号 = 第几行第几列」算位置。所以一块挂了指针的板子只有两种
     * 合法形态：
     *   (a) 不写 row/col —— 就走原来的折行模型（矩阵 / DP / 稀疏矩阵全靠它）；
     *   (b) 写了 row/col，但**逐格都等于行优先序号反推出来的位置**，也就是第 k 格
     *       恰好是第 floor(k / cols) 行、第 k % cols 列，而且格子稠密、一格不落。
     *
     * 基数排序的桶板走的是 (b)：它显式写坐标（桶号占第一行、元素竖着挂），但 items 仍是
     * 行优先稠密的 10 列网格，所以「当前桶」的格子序号和坐标是同一套，不会悄悄错位。
     * 哈希表那种"空桶不留格子"的稀疏板子属于写不了坐标的形态 —— 它因此也没有指针。
     */
    const bad: string[] = []
    let explicitBoards = 0
    for (const spec of algorithmRegistry) {
      const input = prepared(spec)
      const sizes = spec.sizes ?? [input.length]
      const ctx = ctxOf(spec, input)
      for (const n of sizes) {
        const data = input.slice(0, n)
        if (!data.length) continue
        let steps: AlgoStep[]
        try {
          steps = buildSteps(spec, data, ctx)
        } catch {
          continue
        }
        for (const [fi, step] of steps.entries()) {
          for (const b of step.boards ?? []) {
            if (!Object.keys(b.pointers ?? {}).length) continue
            const explicit = b.items.some((it) => it.row !== undefined || it.col !== undefined)
            if (!explicit) continue
            explicitBoards += 1
            const cols = b.cols ?? 1
            b.items.forEach((it, k) => {
              const wantRow = Math.floor(k / cols) + 1
              const wantCol = (k % cols) + 1
              if (it.row !== wantRow || it.col !== wantCol) {
                bad.push(
                  `${spec.id} 帧${fi}: 第 ${k} 格写了 row/col ${it.row}/${it.col}，` +
                    `但按行优先序号应该是 ${wantRow}/${wantCol} —— 指针会挂到别的格子上`,
                )
              }
            })
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([])
    expect(explicitBoards, '守卫：一块"显式写坐标 + 挂指针"的板子都没查到，这条断言等于没跑').toBeGreaterThan(0)
  })
})

/** 从 SSR 出来的 HTML 里抠出指针标签：样式 + 文字（不做整段 HTML 匹配） */
function tagsOf(html: string, cls: string): Array<{ style: string; text: string }> {
  const re = new RegExp(`<span class="${cls}"[^>]*style="([^"]*)"[^>]*>([^<]*)</span>|<div class="${cls}"[^>]*style="([^"]*)"[^>]*>([^<]*)</div>`, 'g')
  return [...html.matchAll(re)].map((m) => ({ style: m[1] ?? m[3], text: m[2] ?? m[4] }))
}

describe('用户反馈的那两帧（建堆 / 堆调整）', () => {
  it('2i+1 / 2i+2 和 较大孩子 指同一格时，DOM 里的两个标签不再落在同一处', async () => {
    const spec = getAlgorithm('heap-build')
    const steps = buildSteps(spec, prepared(spec), ctxOf(spec, prepared(spec)))
    const fi = steps.findIndex((s) => (s.boards ?? []).some((b) => sameCellPairs(b).length > 0))
    expect(fi, '建堆里居然找不到"两个指针指同一格"的帧').toBeGreaterThanOrEqual(0)

    // 纯函数这一侧：两个标签必须错开层
    const board = (steps[fi].boards ?? []).find((b) => sameCellPairs(b).length > 0) as BoardView
    const lay = layoutBoardPointers(board)
    const [n1, n2] = sameCellPairs(board)[0]
    const l1 = lay.labels.find((l) => l.name === n1) as PlacedPtrLabel
    const l2 = lay.labels.find((l) => l.name === n2) as PlacedPtrLabel
    expect(l1.rect.b <= l2.rect.t - PTR_MIN_GAP || l2.rect.b <= l1.rect.t - PTR_MIN_GAP).toBe(true)

    // DOM 这一侧：真的把不同的位置写进了 style（老代码这里两个 style 完全相同）
    const pinia = createPinia()
    setActivePinia(pinia)
    const algo = useAlgorithmStore(pinia)
    algo.selectAlgorithm('heap-build')
    expect(algo.steps.length, 'SSR 用的帧号和 buildSteps 对不上').toBe(steps.length)
    algo.goToStep(fi)

    const app = createSSRApp(ScenePanel)
    app.use(pinia)
    const tags = tagsOf(await renderToString(app), 'ptr-badge')
    const s1 = tags.find((t) => t.text === n1)
    const s2 = tags.find((t) => t.text === n2)
    expect(s1, `页面上没找到标签 ${n1}`).toBeTruthy()
    expect(s2, `页面上没找到标签 ${n2}`).toBeTruthy()
    expect(s1?.style, `${n1} 和 ${n2} 还是画在同一个位置`).not.toBe(s2?.style)
  })

})

/**
 * 树上也会出现"两个指针挂同一个结点"（并查集的 `x` + `下一步`、二叉搜索树删除的 `p` + `sp`），
 * 老代码把两个标签画在同一个坐标上 —— 和用户截图里那对堆标签是同一类 bug。
 * 树没有 canvas，位置在 TreePanel 里算，所以这里分两层守：
 *   ① 纯函数层：`treePtrSeats` 发的座位号必须唯一、`treeSeatPad` 留的边距必须够高（全算法逐帧）；
 *   ② DOM 层：真的把错层写进了 style（自动挑出有重复的算法，不写死算法名）。
 */
describe('树上的指针标签（两个指针挂同一个结点）', () => {
  it('同一个结点上的多个指针各自占一个座位，而且都没顶出上边缘（全算法逐帧）', () => {
    const bad: string[] = []
    let frames = 0
    let labels = 0
    let groups = 0

    for (const spec of algorithmRegistry) {
      const input = prepared(spec)
      const sizes = spec.sizes ?? [input.length]
      const ctx = ctxOf(spec, input)
      for (const n of sizes) {
        const data = input.slice(0, n)
        if (!data.length) continue
        let steps: AlgoStep[]
        try {
          steps = buildSteps(spec, data, ctx)
        } catch {
          continue // 数据不合法之类，别的测试会管；这里只看几何
        }
        // 和 TreePanel 一样：边距取整条轨迹的最大值
        const pad = treeSeatPad(steps, TREE_PAD)
        for (const [fi, step] of steps.entries()) {
          const seats = treePtrSeats(step.tree?.pointers)
          if (!seats.length) continue
          frames += 1
          labels += seats.length
          const where = `${spec.id} 帧${fi}`
          const seen = new Set<string>()
          const perNode = new Map<string, number>()
          let maxSeat = 0
          for (const s of seats) {
            maxSeat = Math.max(maxSeat, s.seat)
            perNode.set(s.id, (perNode.get(s.id) ?? 0) + 1)
            const key = `${s.id}#${s.seat}`
            if (seen.has(key)) bad.push(`${where}: 结点 ${s.id} 的座位 ${s.seat} 被两个标签占了（又叠住了）`)
            seen.add(key)
          }
          for (const c of perNode.values()) if (c > 1) groups += c - 1
          // 标签挂在结点上方 20px、每个座位再往上 19px：最上面那个的顶边不能为负
          const top = pad - 20 - maxSeat * PTR_LANE_H
          if (top < 0) bad.push(`${where}: 最上面的标签顶边到了 ${top.toFixed(1)}px（画布外）`)
        }
      }
    }

    expect(labels).toBeGreaterThan(1000)
    expect(groups, '居然没有"两个指针挂同一结点"的帧？扫描逻辑可能坏了').toBeGreaterThan(0)
    console.log(`[树上指针标签] 帧 ${frames}、标签 ${labels}、同结点多指针 ${groups} 组、问题 ${bad.length}`)
    expect(bad.slice(0, 20)).toEqual([])
  })

  it('错层真的写进了 DOM（自动挑出有重复的算法，不写死算法名）', async () => {
    const found: Array<{ id: string; fi: number; total: number; a: string; b: string }> = []

    for (const spec of algorithmRegistry) {
      const input = prepared(spec)
      let steps: AlgoStep[]
      try {
        steps = buildSteps(spec, input, ctxOf(spec, input))
      } catch {
        continue
      }
      for (const [fi, step] of steps.entries()) {
        const perNode = new Map<string, string[]>()
        for (const s of treePtrSeats(step.tree?.pointers)) {
          const arr = perNode.get(s.id) ?? []
          arr.push(s.name)
          perNode.set(s.id, arr)
        }
        const dup = [...perNode.values()].find((ns) => ns.length > 1)
        if (dup) {
          found.push({ id: spec.id, fi, total: steps.length, a: dup[0], b: dup[1] })
          break
        }
      }
    }

    expect(found.length, '居然没有"两个指针挂同一结点"的算法？扫描逻辑可能坏了').toBeGreaterThan(0)
    console.log(`[树上标签 DOM] 命中 ${found.length} 个算法：${found.map((f) => `${f.id}(${f.a}+${f.b})`).join('、')}`)

    for (const c of found) {
      const pinia = createPinia()
      setActivePinia(pinia)
      const algo = useAlgorithmStore(pinia)
      algo.selectAlgorithm(c.id)
      expect(algo.steps.length, `${c.id}: SSR 用的帧号和 buildSteps 对不上`).toBe(c.total)
      algo.goToStep(c.fi)

      const app = createSSRApp(TreePanel)
      app.use(pinia)
      const tags = tagsOf(await renderToString(app), 'tptr')
      const s1 = tags.find((t) => t.text === c.a)
      const s2 = tags.find((t) => t.text === c.b)
      expect(s1, `${c.id}: 页面上没找到 ${c.a}`).toBeTruthy()
      expect(s2, `${c.id}: 页面上没找到 ${c.b}`).toBeTruthy()
      expect(s1?.style, `${c.id}: ${c.a} 和 ${c.b} 还是画在同一个位置`).not.toBe(s2?.style)
    }
  })
})
