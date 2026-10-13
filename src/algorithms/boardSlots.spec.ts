import { describe, expect, it } from 'vitest'
import { algorithmRegistry } from './index'
import { buildSteps } from '@/core/engine'
import type { AlgorithmSpec, AlgoStep, BoardView, RunnerContext } from '@/core/types'

/**
 * 常驻守卫：**每一帧的板子槽里都得有板子**。
 *
 * 为什么需要它：渲染器是"只要整条轨迹里出现过这个位置的板子，就常驻一个槽"
 *  —— CanvasPanel（数组）只有下方槽、TreePanel 上下两个槽、GraphPanel 的下方槽，
 * 都是 `v-if="hasBottomBoards"` 这种**整条轨迹**判定。
 * 于是只要有**一帧**没给这个位置的板子，那一帧的槽里就空着，
 * 露出 ScenePanel 的占位文案「该算法没有可显示的结构」（ScenePanel.vue:225）。
 *
 * 2026-02 修过一批（12 个算法：6 个树遍历/存储结构 + 5 个图算法 + 最佳归并树），
 * 修法都是"补一块**代码在这一步真的做了的事**的板子"，没有一帧是编的：
 *   - 第 0 帧（engine 造的初始化帧）→ 用 spec.initScene 补初始状态板子；
 *   - sort-optimal-merge 的中间帧 → 补"WPL 还没算"的板子（层数写 —，因为那时真的没有）。
 * 这个文件把结论锁死：以后新增/改动算法时，谁把某一帧的板子撤了，这里就红。
 */

function ctxOf(spec: AlgorithmSpec, input: number[], target?: number): RunnerContext {
  const t = target ?? (spec.defaultTarget ? input[Math.floor(input.length / 2)] : undefined)
  return {
    target: t,
    pos: spec.defaultPos?.(input),
    value: spec.defaultValue?.(input),
    capacity: spec.capacity,
  }
}

function prepared(spec: AlgorithmSpec): number[] {
  const raw = spec.defaultData()
  return spec.prepareData ? spec.prepareData(raw) : raw
}

function stepsOf(spec: AlgorithmSpec): AlgoStep[] {
  const input = prepared(spec)
  return buildSteps(spec, input, ctxOf(spec, input))
}

type Side = 'top' | 'bottom'

const sideOf = (b: BoardView): Side => (b.position === 'top' ? 'top' : 'bottom')

/**
 * 这个算法在页面上**真的有**哪些板子槽 —— 必须和渲染器里的判定一致：
 *  - array（CanvasPanel.vue:26-28 hasBottomBoards）只有下方槽，整条轨迹判定；
 *  - tree（TreePanel.vue:49-51）上下两个槽，都是整条轨迹判定；
 *  - graph（GraphPanel.vue:211 上槽是逐帧 v-if，264 下槽是整条轨迹）只有下方槽会空；
 *  - seqlist / linked / scene 不渲染 boards，没有槽（scene 的板子直接画在主面板里）。
 */
function slotsOf(spec: AlgorithmSpec, steps: AlgoStep[]): Side[] {
  const has = (side: Side): boolean =>
    steps.some((s) => (s.boards ?? []).some((b) => sideOf(b) === side))
  if (spec.renderer === 'array') return has('bottom') ? ['bottom'] : []
  if (spec.renderer === 'tree') {
    const out: Side[] = []
    if (has('top')) out.push('top')
    if (has('bottom')) out.push('bottom')
    return out
  }
  if (spec.renderer === 'graph') return has('bottom') ? ['bottom'] : []
  return []
}

/** 某一侧槽空着的那些帧的序号 */
function emptyFrames(steps: AlgoStep[], side: Side): number[] {
  return steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !(s.boards ?? []).some((b) => sideOf(b) === side))
    .map(({ i }) => i)
}

/** 每一行代码被执行了几帧（算法本体的指纹之一） */
function lineCounts(steps: AlgoStep[]): Record<number, number> {
  const m: Record<number, number> = {}
  for (const s of steps) m[s.line] = (m[s.line] ?? 0) + 1
  return m
}

/**
 * 去掉 boards 之后整条轨迹的指纹 —— 补板子只该动 boards，这个值必须不变。
 *
 * 它把**帧数、每一帧的 line / action / comment / vars / stats / tree / graph 快照**
 * 全都包进来了，也就是"算法本体"的全部痕迹。
 * 这里用自带的 FNV-1a（两遍不同种子拼成 16 位十六进制），不引 node:crypto：
 * 项目 tsconfig 的 types 只有 vite/client，用不了 node: 内置模块的类型。
 * （改动前后各自用 sha256 复核过一次，值完全一致。）
 */
function bodyHash(steps: AlgoStep[]): string {
  const stripped = steps.map((s) => {
    const { boards, ...rest } = s
    void boards
    return rest
  })
  return fnv16(JSON.stringify(stripped))
}

function fnv16(text: string): string {
  const pass = (seed: number): number => {
    let h = seed >>> 0
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    return h >>> 0
  }
  return (
    pass(0x811c9dc5).toString(16).padStart(8, '0') + pass(0x01000193).toString(16).padStart(8, '0')
  )
}

describe('板子槽：每一帧都不许空', () => {
  it('全部 101 个算法：凡是有槽的那一侧，每一帧都有板子（空帧 = 0）', () => {
    const bad: string[] = []
    for (const spec of algorithmRegistry) {
      const steps = stepsOf(spec)
      for (const side of slotsOf(spec, steps)) {
        const empty = emptyFrames(steps, side)
        if (empty.length) {
          bad.push(`${spec.id}（${spec.renderer}）${side} 槽空了 ${empty.length} 帧：${empty.join(',')}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('全部 101 个算法：板子槽的判定范围没被改窄（101 个算法、29 个有槽）', () => {
    const withSlots = algorithmRegistry.filter((s) => slotsOf(s, stepsOf(s)).length > 0)
    expect(algorithmRegistry.length).toBe(101)
    // 29 = 所有 array 里有下方板子的 + 所有 tree/graph 里有板子的；数字变了说明
    // 有人新增/删除了算法，或者某一侧槽的板子整批没了 —— 都要人工确认一遍。
    expect(withSlots.length).toBe(29)
    expect(withSlots.map((s) => s.id)).toContain('sort-optimal-merge')
  })
})

/**
 * 这 12 个算法本次补过板子。下面的表是**改动前**的读数：
 * 帧数、每行 yield 的次数、以及"去掉 boards 之后的整条轨迹指纹"。
 * 补板子只该动 boards，所以这三样都必须**一模一样** —— 一旦哪个变了，
 * 说明算法本体的帧/动作/数值被改到了，必须回退。
 */
const LOCKED: Record<
  string,
  { renderer: string; frames: number; lines: Record<number, number>; hash: string; slots: Side[] }
> = {
  'sort-optimal-merge': {
    renderer: 'tree',
    frames: 16,
    lines: { 1: 1, 2: 1, 4: 1, 6: 4, 7: 4, 9: 4, 12: 1 },
    hash: 'ddd18299fdb703bb',
    slots: ['top', 'bottom'],
  },
  'tree-level': {
    renderer: 'tree',
    frames: 24,
    lines: { 1: 2, 3: 1, 5: 7, 6: 7, 7: 3, 8: 3, 10: 1 },
    hash: 'f7510ab945dd004f',
    slots: ['bottom'],
  },
  'tree-preorder-iter': {
    renderer: 'tree',
    frames: 24,
    lines: { 1: 2, 3: 1, 5: 7, 6: 7, 7: 3, 8: 3, 10: 1 },
    hash: 'da198a4d967c1e57',
    slots: ['bottom'],
  },
  'tree-inorder-iter': {
    renderer: 'tree',
    frames: 39,
    lines: { 1: 2, 3: 1, 6: 7, 7: 7, 9: 7, 10: 7, 11: 7, 14: 1 },
    hash: 'c5c00d7d651fadd7',
    slots: ['bottom'],
  },
  'tree-postorder-iter': {
    renderer: 'tree',
    frames: 52,
    lines: { 1: 2, 3: 1, 6: 7, 7: 7, 9: 10, 11: 3, 13: 7, 14: 7, 15: 7, 19: 1 },
    hash: 'c4a8ca5b027bb51d',
    slots: ['bottom'],
  },
  'tree-parent-repr': {
    renderer: 'tree',
    frames: 20,
    lines: { 1: 1, 11: 1, 12: 1, 13: 6, 17: 2, 21: 1, 22: 7, 24: 1 },
    hash: '581cb2d429e04b1a',
    slots: ['bottom'],
  },
  'tree-child-repr': {
    renderer: 'tree',
    frames: 20,
    lines: { 1: 1, 14: 1, 16: 6, 18: 6, 20: 1, 23: 1, 25: 3, 27: 1 },
    hash: '0037169687305e68',
    slots: ['bottom'],
  },
  'graph-prim': {
    renderer: 'graph',
    frames: 21,
    lines: { 1: 1, 4: 1, 5: 6, 6: 6, 9: 6, 11: 1 },
    hash: 'e2833f60b06aa6e2',
    slots: ['bottom'],
  },
  'graph-kruskal': {
    renderer: 'graph',
    frames: 17,
    lines: { 1: 1, 3: 1, 5: 8, 6: 6, 9: 1 },
    hash: '1bf087c972a9de1b',
    slots: ['bottom'],
  },
  'graph-dijkstra': {
    renderer: 'graph',
    frames: 20,
    lines: { 1: 1, 4: 1, 6: 7, 9: 10, 11: 1 },
    hash: 'a67c0ffc3bdac72e',
    slots: ['bottom'],
  },
  'graph-floyd': {
    renderer: 'graph',
    frames: 41,
    lines: { 1: 1, 3: 7, 6: 32, 7: 1 },
    hash: 'eab7ce189c305366',
    slots: ['bottom'],
  },
  'graph-critical-path': {
    renderer: 'graph',
    frames: 26,
    lines: { 1: 1, 3: 8, 4: 7, 7: 4, 8: 6 },
    hash: '2aad21f6f61eae10',
    slots: ['bottom'],
  },
}

describe('补过板子的 12 个算法：算法本体一个字节都没动', () => {
  for (const [id, lock] of Object.entries(LOCKED)) {
    it(`${id}：帧数 / 每行 yield 次数 / 轨迹指纹 全部不变`, () => {
      const spec = algorithmRegistry.find((s) => s.id === id)
      expect(spec, `找不到算法 ${id}`).toBeTruthy()
      const steps = stepsOf(spec!)
      expect(spec!.renderer).toBe(lock.renderer)
      expect(steps.length).toBe(lock.frames)
      expect(lineCounts(steps)).toEqual(lock.lines)
      expect(bodyHash(steps)).toBe(lock.hash)
      expect(slotsOf(spec!, steps)).toEqual(lock.slots)
    })

    it(`${id}：第 0 帧（初始化帧）就有板子`, () => {
      const spec = algorithmRegistry.find((s) => s.id === id)!
      const steps = stepsOf(spec)
      expect(steps[0]!.action).toBe('init')
      expect((steps[0]!.boards ?? []).length).toBeGreaterThan(0)
    })
  }
})

describe('sort-optimal-merge 的 WPL 板子：中间帧如实写"还没算"', () => {
  const spec = algorithmRegistry.find((s) => s.id === 'sort-optimal-merge')!
  const steps = stepsOf(spec)

  it('每一帧的下方槽恰好一块板子，整条轨迹都叫「带权路径长度 WPL = Σ(段长 × 层数)」', () => {
    for (const [i, s] of steps.entries()) {
      const bottom = (s.boards ?? []).filter((b) => sideOf(b) === 'bottom')
      expect(bottom.length, `第 ${i} 帧的下方板子数`).toBe(1)
      expect(bottom[0]!.title).toBe('带权路径长度 WPL = Σ(段长 × 层数)')
    }
  })

  it('格子数每帧都等于初始归并段个数（8），逐帧高度不会跳', () => {
    for (const [i, s] of steps.entries()) {
      const bottom = (s.boards ?? []).filter((b) => sideOf(b) === 'bottom')[0]!
      expect(bottom.items.length, `第 ${i} 帧的格子数`).toBe(8)
    }
  })

  it('中间帧的层数写 —（那时真的还没算），末帧才是真实层数', () => {
    const itemsOf = (i: number): string[] =>
      (steps[i]!.boards ?? [])
        .filter((b) => sideOf(b) === 'bottom')[0]!
        .items.map((it) => it.text)
    // 段长从第 2 行起就是已知的：8 段的长度 9/30/12/18/3/17/2/6 每帧都在
    for (const i of [0, 1, 2, 5, 14]) {
      expect(itemsOf(i)).toEqual([
        '9×—',
        '30×—',
        '12×—',
        '18×—',
        '3×—',
        '17×—',
        '2×—',
        '6×—',
      ])
    }
    // 末帧（第 12 行 done）层数算出来了
    expect(itemsOf(steps.length - 1).every((t) => /^\d+×\d+$/.test(t))).toBe(true)
    expect(itemsOf(steps.length - 1).join(' + ')).toBe('9×2 + 30×1 + 12×2 + 18×2 + 3×3 + 17×2 + 2×3 + 6×2')
  })
})
