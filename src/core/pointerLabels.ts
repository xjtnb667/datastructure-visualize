import type { AlgoStep, BoardView } from '@/core/types'

/**
 * 指针标签的**避让**计算（板子上的黄色小标签、树上的黄色小标签都用它）。
 *
 * 起因是用户发来的一张截图：堆排序的建堆阶段，`2i+1` 和 `较大的孩子` 两个黄标签
 * **落在同一根柱子上、字压字看不清**。
 *
 * 老做法是纯 CSS：标签 `left: 50%; transform: translateX(-50%)` —— 只按**自己那一格**
 * 水平居中，既不看自己有多宽（`较大的孩子` 有 58px，格子才 46px），也不看隔壁格子上
 * 有没有标签。于是两种情况必然叠在一起：
 *   - 两个指针指向**同一格**（堆里 `较大的孩子` 就是 `2i+1` 或 `2i+2` 那一格）→ 位置完全相同；
 *   - 两个指针指向**相邻格**、而两个标签都宽（各 69px 的 `上一个结点` / `新结点` 只有 52px 的格距）。
 *
 * 这里把「标签该放哪儿」抽成**纯函数**：输入板子数据，输出每个标签的矩形。
 * 好处是组件只管照着画，而测试可以在 Node 里对**全部算法全部帧**做几何断言，
 * 不必依赖浏览器（浏览器里量矩形太贵，留给 CDP 抽查）。
 *
 * 避让规则（按优先级逐个试，第一个不撞的就用）：
 *   1. 原地不动（和以前一模一样的位置）；
 *   2. 往上错层（同一格的两个标签一上一下，`lane` 每加一层抬高 19px）；
 *   3. 被板子边缘切到时，水平挪回来（`dx`）；
 *   4. 最后才左右微调（±13 / ±19 / ±26 …），且必须还在板子里。
 * 语义不变：标签指向哪一格、写什么字、什么颜色，全都没动 —— 动的只有它画在哪儿。
 */

/** 格子的边长与间距，和 ScenePanel 的 CSS 保持一致（CELL = 46、gap = 6） */
export const PTR_CELL = 46
export const PTR_GAP = 6
/** 相邻两格的**格心**距离：行内相邻格差 1，横坐标正好差这么多 */
export const PTR_PITCH = PTR_CELL + PTR_GAP
/** 标签自身的高度：font-size 11 + padding 1px*2 + border 1px*2 */
export const PTR_BADGE_H = 17
/** 横排 / 折行里，标签的**下沿**离格子上沿的像素数 */
export const PTR_BADGE_PAD = 4
/** 错一层的高度：标签高 17 + 2px 空隙 */
export const PTR_LANE_H = 19
/** 两个标签之间至少留出的空隙（也用字体宽度估算的误差余量） */
export const PTR_MIN_GAP = 4
/** 板子边缘留白 */
export const PTR_EDGE = 1
/** 原本的 padding-top / row-gap：不涉及错层时数值和从前完全一样 */
export const PTR_BASE_PAD = 24
/** 最多错几层（8 层 = 152px，够任何真实数据用；到顶就退化成"重叠最少"） */
export const PTR_MAX_LANE = 7
/** `.ptr-badge` 的左右 padding 与边框 */
const PAD_X = 6
const BORDER = 1
const FONT = 11

/** 环形（循环队列）的半径：标签画在 `PTR_RING_R + 36` 的圆周上 */
export const PTR_RING_R = 76
export const PTR_RING_LABEL_R = PTR_RING_R + 36
export const PTR_RING_SIZE = (PTR_RING_R + PTR_CELL + 24) * 2
/** 竖排板子右侧给标签留的宽度（`.col-board { padding-right }`） */
export const PTR_COL_PAD_RIGHT = 78
/** 竖排板子里标签离格子右沿的距离（`.col-ptr { left: calc(100% + 8px) }`） */
export const PTR_COL_LABEL_X = PTR_CELL + 8

export interface PtrRect {
  l: number
  t: number
  r: number
  b: number
}

export interface PlacedPtrLabel {
  name: string
  /** 指针指向第几格 */
  idx: number
  /** 错层：0 = 原地，越大越靠上（环形里是沿切线错开） */
  lane: number
  /** 相对**锚点**的水平偏移（锚点 = 格子中心 / 环上那个点 / 竖排的格子中心） */
  dx: number
  /** 相对锚点的垂直偏移（负数 = 往上） */
  dy: number
  /** 最终矩形（板子左上角为原点，单位 px）—— 测试断言的就是它 */
  rect: PtrRect
}

export interface BoardPtrLayout {
  labels: PlacedPtrLabel[]
  /** 按格子序号分组，模板里 `byIndex.get(k)` 就能拿到这一格的标签 */
  byIndex: Map<number, PlacedPtrLabel[]>
  /** 用到的层数（= 最大 lane + 1） */
  lanes: number
  /** 板子内容宽度：row/grid = cols*52-6，column = 46+78，ring = RING_SIZE */
  boardW: number
  /** row/grid 上方要留出的高度：24 + (lanes-1)*19 */
  padTop: number
  /** grid / row 的行间距：24 + (lanes-1)*19 */
  rowGap: number
  /** 竖排板子右侧要留出的宽度 */
  padRight: number
}

/** 整块面板（一条动画轨迹）用到的最大值 —— 逐帧取当前帧的话，板子会在有标签的帧之间上下跳 */
export interface PointerMetrics {
  lanes: number
  padTop: number
  rowGap: number
  padRight: number
}

/**
 * 标签宽度：中文按 1 字宽、ASCII 按 0.56 字宽估算（和 ScenePanel 里 `fitFont` 同一套估法），
 * 再加左右 padding 和边框。Consolas 在 11px 下的真实步进是 6.05px/字符，这里按 6.16px 估，略保守。
 */
export function ptrBadgeWidth(name: string): number {
  let units = 0
  for (const ch of name) units += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.56
  return 2 * (PAD_X + BORDER) + units * FONT
}

/** 不错层时上方要留的高度 */
export function ptrPadTopFor(lanes: number): number {
  return PTR_BASE_PAD + Math.max(0, lanes - 1) * PTR_LANE_H
}

/** 不错层时的行间距 */
export function ptrRowGapFor(lanes: number): number {
  return ptrPadTopFor(lanes)
}

interface Spec {
  name: string
  idx: number
  /** 基准矩形（lane 0、dx 0） */
  base: PtrRect
  /** 每错一层往哪个方向挪 */
  laneVec: { x: number; y: number }
}

function shift(r: PtrRect, dx: number, dy: number): PtrRect {
  return { l: r.l + dx, t: r.t + dy, r: r.r + dx, b: r.b + dy }
}

/** 在板子里放得下吗（横向必须放得下；纵向由 padTop / 板子自身高度兜住） */
function inBounds(r: PtrRect, bounds: { w: number; h?: number }): boolean {
  if (r.l < PTR_EDGE || r.r > bounds.w - PTR_EDGE) return false
  if (bounds.h !== undefined && (r.t < PTR_EDGE || r.b > bounds.h - PTR_EDGE)) return false
  return true
}

/** 和已经放好的标签至少隔开 PTR_MIN_GAP（横竖都挤在一起才算撞） */
function clearOf(r: PtrRect, placed: PlacedPtrLabel[]): boolean {
  for (const p of placed) {
    const hitX = r.l < p.rect.r + PTR_MIN_GAP && p.rect.l < r.r + PTR_MIN_GAP
    const hitY = r.t < p.rect.b + PTR_MIN_GAP && p.rect.t < r.b + PTR_MIN_GAP
    if (hitX && hitY) return false
  }
  return true
}

/** 越界了多少（越大越糟）；完全在板子里是 0 */
function overflow(r: PtrRect, bounds: { w: number; h?: number }): number {
  let out = Math.max(0, PTR_EDGE - r.l) + Math.max(0, r.r - (bounds.w - PTR_EDGE))
  if (bounds.h !== undefined) {
    out += Math.max(0, PTR_EDGE - r.t) + Math.max(0, r.b - (bounds.h - PTR_EDGE))
  }
  return out
}

/**
 * 逐个放标签：每个都按「原地 → 错层 → 挪回板内 → 左右微调」的顺序试，
 * 用第一个既不越界、又不和已放好的标签相撞的位置。
 *
 * 试完所有候选都还撞（真实数据里不会发生，8 层 + 左右各 52px 已经足够）时，
 * 退化成「撞得最少、越界最少」的那个，**绝不抛异常** —— 动画不能因为排版算不出来就停。
 */
function placeSpecs(specs: Spec[], bounds: { w: number; h?: number }): PlacedPtrLabel[] {
  const placed: PlacedPtrLabel[] = []
  for (const s of specs) {
    const w = s.base.r - s.base.l
    const at = (lane: number, dx: number): PlacedPtrLabel => {
      const dy = lane * s.laneVec.y
      const ddx = lane * s.laneVec.x + dx
      const rect = shift(s.base, ddx, dy)
      return { name: s.name, idx: s.idx, lane, dx: ddx, dy, rect }
    }
    /** 第 lane 层被边缘切到时，需要水平挪多少才能挪回板子里 */
    const clampDx = (lane: number): number => {
      const r = shift(s.base, lane * s.laneVec.x, 0)
      const lo = PTR_EDGE - r.l
      const hi = bounds.w - PTR_EDGE - r.r
      if (lo > hi) return lo // 标签比板子还宽：只能贴住左边
      return Math.min(Math.max(0, lo), hi)
    }

    const cands: PlacedPtrLabel[] = []
    for (let lane = 0; lane <= PTR_MAX_LANE; lane++) cands.push(at(lane, 0))
    for (let lane = 0; lane <= PTR_MAX_LANE; lane++) {
      const dx = clampDx(lane)
      if (dx !== 0) cands.push(at(lane, dx))
    }
    for (let lane = 0; lane <= PTR_MAX_LANE; lane++) {
      for (const dx of [13, -13, 26, -26, 39, -39, 52, -52]) {
        if (dx > 0 && dx + w > bounds.w) continue
        cands.push(at(lane, dx))
      }
    }

    let best: { label: PlacedPtrLabel; score: number } | null = null
    let found: PlacedPtrLabel | null = null
    for (const c of cands) {
      const collide = placed.filter((p) => {
        const hitX = c.rect.l < p.rect.r + PTR_MIN_GAP && p.rect.l < c.rect.r + PTR_MIN_GAP
        const hitY = c.rect.t < p.rect.b + PTR_MIN_GAP && p.rect.t < c.rect.b + PTR_MIN_GAP
        return hitX && hitY
      }).length
      const out = overflow(c.rect, bounds)
      const score = collide * 10000 + out
      if (!best || score < best.score) best = { label: c, score }
      if (collide === 0 && inBounds(c.rect, bounds)) {
        found = c
        break
      }
    }
    const pick = found ?? best?.label ?? at(0, 0)
    if (!inBounds(pick.rect, bounds)) {
      // 位置定不下来时至少别越界：贴回板子里（可能因此和邻居撞上，但那比被裁掉强）
      const dx = clampDx(pick.lane)
      const fixed = at(pick.lane, pick.dx + dx)
      if (clearOf(fixed.rect, placed)) {
        placed.push(fixed)
        continue
      }
    }
    placed.push(pick)
  }
  return placed
}

/** 环形布局：第 i 格在圆周上的偏移（12 点方向开始，顺时针），和 ScenePanel 的 ringPos 一致 */
function ringOffset(i: number, n: number, r: number): { x: number; y: number } {
  const a = (-90 + (i * 360) / Math.max(n, 1)) * (Math.PI / 180)
  return { x: Math.cos(a) * r, y: Math.sin(a) * r }
}

/**
 * 算一块板子上所有指针标签的位置。
 *
 * 三种布局的锚点：
 *   row / grid —— 标签挂在**格子上方**，水平以格心为准（格子序号按 cols 折行）；
 *   column    —— 标签挂在格子**右侧**，垂直以格子中心为准；
 *   ring      —— 标签挂在圆周外侧，同格的标签沿**切线**错开（往外挪会顶出环形容器）。
 */
export function layoutBoardPointers(b: BoardView): BoardPtrLayout {
  const entries = Object.entries(b.pointers ?? {})
  const byIndex = new Map<number, PlacedPtrLabel[]>()
  const empty: BoardPtrLayout = {
    labels: [],
    byIndex,
    lanes: 1,
    boardW: PTR_CELL + PTR_COL_PAD_RIGHT,
    padTop: PTR_BASE_PAD,
    rowGap: PTR_BASE_PAD,
    padRight: PTR_COL_PAD_RIGHT,
  }
  if (!entries.length) return empty

  const specs: Spec[] = []
  const bounds: { w: number; h?: number } = { w: 0 }
  let boardW = PTR_CELL + PTR_COL_PAD_RIGHT
  let padRight = PTR_COL_PAD_RIGHT

  if (b.layout === 'ring') {
    const n = Math.max(b.items.length, 1)
    boardW = PTR_RING_SIZE
    bounds.w = PTR_RING_SIZE
    bounds.h = PTR_RING_SIZE
    for (const [name, idx] of entries) {
      const w = ptrBadgeWidth(name)
      const p = ringOffset(idx, n, PTR_RING_LABEL_R)
      const c = PTR_RING_SIZE / 2
      // 切线方向：取"往上"的那一侧，和 row/grid 的错层方向一致
      const a = Math.atan2(p.y, p.x)
      let t = { x: -Math.sin(a), y: Math.cos(a) }
      if (t.y > 0) t = { x: -t.x, y: -t.y }
      specs.push({
        name,
        idx,
        base: {
          l: c + p.x - w / 2,
          t: c + p.y - PTR_BADGE_H / 2,
          r: c + p.x + w / 2,
          b: c + p.y + PTR_BADGE_H / 2,
        },
        laneVec: { x: t.x * PTR_LANE_H, y: t.y * PTR_LANE_H },
      })
    }
  } else if (b.layout === 'column') {
    const n = b.items.length
    for (const [name, idx] of entries) {
      const w = ptrBadgeWidth(name)
      const cy = (n - 1 - idx) * PTR_PITCH + PTR_CELL / 2
      specs.push({
        name,
        idx,
        base: {
          l: PTR_COL_LABEL_X,
          t: cy - PTR_BADGE_H / 2,
          r: PTR_COL_LABEL_X + w,
          b: cy + PTR_BADGE_H / 2,
        },
        laneVec: { x: 0, y: PTR_LANE_H },
      })
      padRight = Math.max(padRight, PTR_COL_LABEL_X - PTR_CELL + w + PTR_EDGE + 2)
    }
    // 竖排只有横向的边界：往下多挂一层是安全的（板子外面的空隙足够）
    bounds.w = PTR_CELL + padRight
    boardW = bounds.w
  } else {
    const cols = b.layout === 'grid' ? (b.cols ?? 1) : b.items.length
    boardW = Math.max(PTR_CELL, cols * PTR_PITCH - PTR_GAP)
    bounds.w = boardW
    for (const [name, idx] of entries) {
      const w = ptrBadgeWidth(name)
      const col = cols > 0 ? idx % cols : 0
      const row = cols > 0 ? Math.floor(idx / cols) : 0
      const cx = col * PTR_PITCH + PTR_CELL / 2
      const bottom = row * PTR_PITCH - PTR_BADGE_PAD
      specs.push({
        name,
        idx,
        base: { l: cx - w / 2, t: bottom - PTR_BADGE_H, r: cx + w / 2, b: bottom },
        laneVec: { x: 0, y: -PTR_LANE_H },
      })
    }
  }

  const labels = placeSpecs(specs, bounds)
  let lanes = 1
  for (const p of labels) {
    lanes = Math.max(lanes, p.lane + 1)
    const arr = byIndex.get(p.idx) ?? []
    arr.push(p)
    byIndex.set(p.idx, arr)
  }

  return {
    labels,
    byIndex,
    lanes,
    boardW,
    padTop: ptrPadTopFor(lanes),
    rowGap: ptrRowGapFor(lanes),
    padRight,
  }
}

/**
 * 一条动画轨迹（一次选中的算法 + 一份数据）里，标签排版需要的最大留白。
 *
 * 取**整条轨迹**的最大值而不是当前帧的：板子的内边距逐帧变化的话，
 * 格子会在"有标签的帧"之间上下跳动（这个项目最忌讳的就是动画区逐帧抖动）。
 */
export function pointerMetrics(
  steps: readonly AlgoStep[],
  pick?: (b: BoardView) => boolean,
): PointerMetrics {
  let lanes = 1
  let padRight = PTR_COL_PAD_RIGHT
  for (const s of steps) {
    for (const b of s.boards ?? []) {
      if (pick && !pick(b)) continue
      if (!b.pointers || !Object.keys(b.pointers).length) continue
      const lay = layoutBoardPointers(b)
      lanes = Math.max(lanes, lay.lanes)
      padRight = Math.max(padRight, lay.padRight)
    }
  }
  return { lanes, padTop: ptrPadTopFor(lanes), rowGap: ptrRowGapFor(lanes), padRight }
}

/** 树外面留的边距（TreePanel 的 PAD）：标签挂就要挂在结点上方，这个边距就是它们的余地 */
export const TREE_PAD = 26

/** 树上的指针标签：谁挂在哪个结点、排第几个座位 */
export interface TreePtrSeat {
  name: string
  /** 指向的结点 id */
  id: string
  /** 座位号：0 = 紧贴结点上方，越大越往上 */
  seat: number
}

/**
 * 树上的指针标签分座位。
 *
 * 两个指针指向同一个结点是常事（并查集的 `x` 和 `下一步`、二叉搜索树删除里的 `p` 和 `sp`），
 * 画在同一个位置就是"字压字"。这里按出现顺序发座位号，渲染时往上错开一层。
 */
export function treePtrSeats(pointers: Record<string, string | null> | undefined): TreePtrSeat[] {
  const out: TreePtrSeat[] = []
  const used = new Map<string, number>()
  for (const [name, id] of Object.entries(pointers ?? {})) {
    if (!id) continue
    const seat = used.get(id) ?? 0
    used.set(id, seat + 1)
    out.push({ name, id, seat })
  }
  return out
}

/**
 * 树顶上要多留的边距。
 * 标签是挂在结点**上方**的，根结点上多挂一个标签就多占一层，
 * 不留出来的话第二个标签会顶出画布上边缘被裁掉。同样取整条轨迹的最大值。
 */
export function treeSeatPad(steps: readonly AlgoStep[], base: number): number {
  let max = 1
  for (const s of steps) {
    for (const t of treePtrSeats(s.tree?.pointers)) max = Math.max(max, t.seat + 1)
  }
  return base + (max - 1) * PTR_LANE_H
}
