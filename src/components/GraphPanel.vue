<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAlgorithmStore } from '@/stores/algorithm'
import { PALETTE, css, type RGB } from '@/core/palette'
import type { CellTone, GraphNodeSnapshot, GraphView } from '@/core/types'
import ScenePanel from '@/components/ScenePanel.vue'

/**
 * 图渲染器：顶点 + 有向/无向边 + 边上的权值。
 *
 * 顶点坐标由算法自己给（**相对坐标 0..1**），渲染器只负责换算成像素。
 * 图的布局本来就是任意的，让算法决定位置的好处是：整个算法过程中顶点位置固定不动，
 * 变化的只有颜色和边上的标注 —— 这样"哪一步动了什么"才好看出来。
 */
const store = useAlgorithmStore()
const { currentStep, currentGraph, animDuration, steps } = storeToRefs(store)

const NODE_R = 21
const PAD = 46

const gv = computed<GraphView | null>(() => currentGraph.value)
const animMs = computed(() => `${animDuration.value}ms`)
const boards = computed(() => currentStep.value?.boards ?? [])
const topBoards = computed(() => boards.value.filter((b) => b.position === 'top'))
/**
 * 这个算法任意一帧有没有下方板子，用来决定"板子区"这个槽位留不留。
 * 用 `bottomBoards.length` 当 v-if 的话，板子出现/消失的那一帧会把图画布挤一下。
 */
const hasBottomBoards = computed(() =>
  steps.value.some((s) => (s.boards ?? []).some((b) => b.position !== 'top')),
)

/* 面板尺寸：顶点用相对坐标，得知道画布多大才能换算成像素 */
const boxEl = ref<HTMLElement | null>(null)
const size = ref({ w: 640, h: 440 })
let ro: ResizeObserver | null = null
function measure(): void {
  const el = boxEl.value
  if (el && el.clientWidth > 0) size.value = { w: el.clientWidth, h: el.clientHeight }
}
onMounted(() => {
  measure()
  ro = new ResizeObserver(measure)
  if (boxEl.value) ro.observe(boxEl.value)
})
onBeforeUnmount(() => ro?.disconnect())

const px = (n: GraphNodeSnapshot) => PAD + n.x * Math.max(1, size.value.w - PAD * 2)
const py = (n: GraphNodeSnapshot) => PAD + n.y * Math.max(1, size.value.h - PAD * 2)

const posOf = computed(() => {
  const m = new Map<string, { x: number; y: number }>()
  for (const n of gv.value?.nodes ?? []) m.set(n.id, { x: px(n), y: py(n) })
  return m
})

/** 同一条边两端都有（有向图互通）时，两条线要错开，不然会完全重合看不出来 */
const pairCount = computed(() => {
  const c = new Map<string, number>()
  for (const e of gv.value?.edges ?? []) {
    const k = [e.from, e.to].sort().join('|')
    c.set(k, (c.get(k) ?? 0) + 1)
  }
  return c
})

interface DrawnEdge {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  /** 箭头三角形（有向边才有） */
  head: string
  color: string
  /** 本步是否高亮（决定线宽） */
  hot: boolean
  w?: number
  label?: string
  lx: number
  ly: number
  dashed: boolean
}

function toneColor(t: CellTone | undefined): RGB {
  switch (t) {
    case 'hot':
      return PALETTE.mark
    case 'done':
      return PALETTE.sorted
    case 'mark':
      return PALETTE.swap
    case 'dim':
      return [92, 102, 116]
    default:
      return [108, 124, 148]
  }
}

/**
 * 权值标签的避让。
 *
 * 图的边中点经常重合 —— 正六边形里 V1-V4 / V2-V5 / V3-V6 三条对角线的中点
 * 全都在圆心，标签直接画就会叠成一团。所以先从边中点往两边依次挪（t 从 0.5
 * 往外试），挪到没有别的标签挨着为止。
 */
const TS = [0.5, 0.36, 0.64, 0.27, 0.73, 0.19, 0.81, 0.12, 0.88]
const LABEL_MIN_DIST = 30

const drawnEdges = computed<DrawnEdge[]>(() => {
  const g = gv.value
  if (!g) return []
  const out: DrawnEdge[] = []
  const placed: Array<{ x: number; y: number }> = []
  g.edges.forEach((e, i) => {
    const a = posOf.value.get(e.from)
    const b = posOf.value.get(e.to)
    if (!a || !b) return
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    // 双向边：两个方向各偏开一点，不然两条线完全重合看不出来
    const both = (pairCount.value.get([e.from, e.to].sort().join('|')) ?? 0) > 1
    const off = both ? (e.from < e.to ? 7 : -7) : 0
    const ox = -uy * off
    const oy = ux * off
    const x1 = a.x + ux * NODE_R + ox
    const y1 = a.y + uy * NODE_R + oy
    const x2 = b.x - ux * NODE_R + ox
    const y2 = b.y - uy * NODE_R + oy
    // 箭头贴在终点那端
    const hw = 6
    const hl = 13
    const bx = x2 - ux * hl
    const by = y2 - uy * hl
    // 标签：先垂直偏移 11px，再沿边找一个不撞车的位置
    const nx = dy / len
    const ny = -dx / len
    let lx = 0
    let ly = 0
    let ok = false
    for (const t of TS) {
      const mx = x1 + (x2 - x1) * t
      const my = y1 + (y2 - y1) * t
      const cx = mx + nx * 11
      const cy = my + ny * 11
      if (!placed.some((p) => Math.hypot(p.x - cx, p.y - cy) < LABEL_MIN_DIST)) {
        lx = cx
        ly = cy
        ok = true
        break
      }
    }
    if (!ok) {
      lx = (x1 + x2) / 2 + nx * 11
      ly = (y1 + y2) / 2 + ny * 11
    }
    placed.push({ x: lx, y: ly })
    out.push({
      key: `${e.from}>${e.to}#${i}`,
      x1,
      y1,
      x2,
      y2,
      head: e.directed ? `${x2},${y2} ${bx - uy * hw},${by + ux * hw} ${bx + uy * hw},${by - ux * hw}` : '',
      color: css(toneColor(e.tone)),
      hot: e.tone === 'hot',
      w: e.w,
      label: e.label,
      lx,
      ly,
      dashed: e.tone === 'dim',
    })
  })
  return out
})

function nodeColor(n: GraphNodeSnapshot): RGB {
  const g = gv.value
  if (!g) return PALETTE.base
  if (g.hot?.includes(n.id)) {
    const a = currentStep.value?.action
    if (a === 'compare') return PALETTE.compare
    if (a === 'done' || a === 'sorted') return PALETTE.sorted
    return PALETTE.mark
  }
  if (g.done?.includes(n.id)) return PALETTE.sorted
  return PALETTE.base
}

const badges = computed(() => {
  const g = gv.value
  if (!g?.badges) return []
  const out: Array<{ id: string; text: string; x: number; y: number }> = []
  for (const [id, text] of Object.entries(g.badges)) {
    if (!text) continue
    const p = posOf.value.get(id)
    if (!p) continue
    out.push({ id, text, x: p.x + NODE_R + 2, y: p.y - NODE_R + 8 })
  }
  return out
})
</script>

<template>
  <div v-if="!gv" class="empty">该算法没有图结构</div>
  <div v-else class="graph-wrap" :class="{ 'has-boards': hasBottomBoards }">
    <div v-if="topBoards.length" class="boards-slot boards-top">
      <ScenePanel only="top" />
    </div>

    <div ref="boxEl" class="canvas" :style="{ '--anim': animMs }">
      <svg class="edges" :width="size.w" :height="size.h">
        <g v-for="e in drawnEdges" :key="e.key">
          <line
            :x1="e.x1"
            :y1="e.y1"
            :x2="e.x2"
            :y2="e.y2"
            :stroke="e.color"
            :stroke-width="e.hot ? 3.4 : 2"
            :stroke-dasharray="e.dashed ? '6 5' : undefined"
            stroke-linecap="round"
          />
          <polygon v-if="e.head" :points="e.head" :fill="e.color" />
          <text v-if="e.w !== undefined" :x="e.lx" :y="e.ly" class="ew" :fill="e.color">
            {{ e.w }}
          </text>
          <text v-if="e.label" :x="e.lx" :y="e.ly + 13" class="el" :fill="e.color">
            {{ e.label }}
          </text>
        </g>
      </svg>

      <div
        v-for="n in gv.nodes"
        :key="n.id"
        class="gnode"
        :style="{
          transform: `translate(${px(n)}px, ${py(n)}px) translate(-50%, -50%)`,
          width: `${NODE_R * 2}px`,
          height: `${NODE_R * 2}px`,
          background: css(nodeColor(n)),
        }"
      >
        <span class="glabel">{{ n.label }}</span>
        <span v-if="n.sub" class="gsub">{{ n.sub }}</span>
      </div>

      <div
        v-for="b in badges"
        :key="`b-${b.id}`"
        class="gbadge"
        :title="b.text"
        :style="{ transform: `translate(${b.x}px, ${b.y}px)` }"
      >{{ b.text }}</div>
    </div>

    <p v-if="gv.note" class="graph-note">{{ gv.note }}</p>

    <div v-if="hasBottomBoards" class="boards-slot">
      <ScenePanel only="bottom" />
    </div>
  </div>
</template>

<style scoped>
.graph-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 有板子的算法：图画布固定 60%、板子区固定 40%，两边都不随帧变 */
.graph-wrap.has-boards > .canvas {
  flex: 0 0 60%;
}

.canvas {
  position: relative;
  /* 固定占满（没有板子时）/ 占 60%（有板子时）—— 见下面的 .has-boards。
     原来是 flex: 1 1 auto，板子一变高就把图画布挤矮。 */
  flex: 0 0 100%;
  min-height: 220px;
  overflow: hidden;
}

.edges {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.ew {
  font-size: 12px;
  font-family: Consolas, Monaco, monospace;
  font-weight: 600;
  text-anchor: middle;
  dominant-baseline: middle;
  paint-order: stroke;
  stroke: #161b22;
  stroke-width: 3.5px;
}

.el {
  font-size: 10.5px;
  font-family: Consolas, Monaco, monospace;
  text-anchor: middle;
  dominant-baseline: middle;
  paint-order: stroke;
  stroke: #161b22;
  stroke-width: 3.5px;
}

.gnode {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #fff;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 14px;
  font-weight: 600;
  will-change: transform;
  transition: transform var(--anim, 300ms) cubic-bezier(0.33, 1, 0.68, 1),
    background-color 160ms ease;
}

.glabel {
  line-height: 1.05;
}

.gsub {
  font-size: 9px;
  font-weight: 400;
  opacity: 0.75;
  line-height: 1.05;
}

.gbadge {
  position: absolute;
  top: 0;
  left: 0;
  padding: 1px 5px;
  font-size: 11px;
  font-family: Consolas, Monaco, monospace;
  color: #f5c518;
  background: rgba(245, 197, 24, 0.13);
  border: 1px solid rgba(245, 197, 24, 0.35);
  border-radius: 5px;
  white-space: nowrap;
  pointer-events: none;
  will-change: transform;
  transition: transform var(--anim, 300ms) cubic-bezier(0.33, 1, 0.68, 1);
  /*
   * 长标签（比如 Floyd 挂在顶点上的"整行距离"）会一路横穿到隔壁顶点上。
   * 顶点在圆环上相邻约 97px，标签从顶点中心往右 23px 处开始，
   * 所以限到 68px 就不会压到下一个顶点；超出部分省略号，鼠标悬停看全文。
   */
  max-width: 68px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.boards-slot {
  flex: 0 0 auto;
  /* 固定 40%（原来是 max-height: 55% 按内容长，会把图画布挤得上下跳），装不下就内部滚动 */
  height: 40%;
  overflow: auto;
  border-top: 1px solid #232a35;
}

.boards-top {
  border-top: none;
  border-bottom: 1px solid #232a35;
}

.boards-slot :deep(.scene) {
  height: auto;
  padding-top: 6px;
  padding-bottom: 2px;
}

.graph-note {
  margin: 0;
  padding: 8px 2px 0;
  font-size: 12.5px;
  color: #8b949e;
}

.empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: #6e7681;
  font-size: 13px;
}
</style>
