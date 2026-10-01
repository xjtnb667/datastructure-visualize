<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useAlgorithmStore } from '@/stores/algorithm'
import { PALETTE, css, type RGB } from '@/core/palette'
import type { ListNodeSnapshot } from '@/core/types'

const store = useAlgorithmStore()
const { currentList, currentStep, animDuration } = storeToRefs(store)

const NODE_W = 60
const NODE_H = 44
const GAP = 44
const STEP = NODE_W + GAP
const PAD_L = 16
const NODE_Y = 78
/**
 * 刚 new 出来、还没接进链表的游离结点摆在这一行（链表下方的空闲区）。
 * 这样它不挤占行的宽度，也不会和链尾的 NULL 标记撞在一起，
 * 接入的一瞬间还会"飞"到它该在的位置。
 */
const FLOAT_Y = 166
/** 成环的回头箭头走结点下方那条通道 */
const CYCLE_LANE_Y = NODE_Y + NODE_H + 76
const BOX_H = 268

/**
 * 箭头全部画成"固定形状 + 位移"：
 * SVG 的 x1/y1/x2/y2 是不能用 CSS 过渡的，但 transform 可以。
 * 所以每条箭头都按局部坐标画一次，再用 transform 平移到位置上 ——
 * 这样它就能和结点用同一个 transition 一起滑动，不会脱节。
 */
const ARROW_LEN = STEP - NODE_W - 2 // 相邻结点之间那截箭头的长度
const NODE_BOTTOM = NODE_Y + NODE_H
const NODE_MID_Y = NODE_Y + NODE_H / 2
/**
 * 双链表：在相邻两结点的空隙里画**一对反向箭头** ——
 * 上面那条向右是 next，下面那条向左是 prev。
 */
const ARROW_DY = 8
const CYCLE_DROP = CYCLE_LANE_Y - NODE_BOTTOM
const END_DROP = 8 // 箭头指回结点底部时留的那一点
/** 指针标签的纵坐标（在结点上方），以及多个指针挤在同一结点时的错开高度 */
const PTR_Y = 34
const PTR_SEAT_H = 28
/**
 * 游离结点的指针标签挂在它**下方**（而不是上方）。
 * 因为游离结点上方那条空间要留给"新结点接上后继"的指针线 ——
 * 标签挂在上面会正好把线压住。
 */
const FLOAT_PTR_Y = FLOAT_Y + NODE_H + 10

/**
 * "临时指针"画成**实心箭头**：细杆 + 宽头。
 * 一根指针就是一支箭头；两个结点之间两个方向都有指针时，
 * 就是两支并排的箭头（各往自己那一侧让开一点），而不是叠在一起。
 */
const LINK_SHAFT = 3.5 // 杆半宽
const LINK_HEAD = 8 // 头半宽
const LINK_HEAD_LEN = 13 // 头长
const LINK_PAIR_OFFSET = 9 // 并排的两支箭头各让开多少

const lv = computed(() => currentList.value)
const xOf = (index: number) => PAD_L + index * STEP
const centerXOf = (index: number) => xOf(index) + NODE_W / 2
/** 动画时长跟着播放速度走，和柱状图渲染器保持一致 */
const animMs = computed(() => `${animDuration.value}ms`)

/** 链上每个结点的行内位置下标（游离结点不在其中） */
const posOf = computed(() => {
  const map = new Map<string, number>()
  lv.value?.reachable.forEach((id, i) => map.set(id, i))
  return map
})

/** 链上结点数 —— 决定这一行画多宽；游离结点放在下方，不占行宽 */
const rowCount = computed(() => lv.value?.reachable.length ?? 0)

const boxWidth = computed(() => PAD_L * 2 + Math.max(1, rowCount.value) * STEP - GAP)

/** 还没接上链的游离结点（生成器同一时刻最多造一个） */
const floating = computed<ListNodeSnapshot[]>(() => {
  const l = lv.value
  if (!l) return []
  const onChain = new Set(l.reachable)
  return l.nodes.filter((n) => !onChain.has(n.id))
})

/** 游离结点摆在链表下方、横向居中 */
const floatX = computed(() => Math.max(PAD_L, Math.round((boxWidth.value - NODE_W) / 2)))

interface RenderNode {
  node: ListNodeSnapshot
  x: number
  y: number
  isFloating: boolean
}

/**
 * 真正用来 v-for 的列表：按**结点创建顺序**遍历。
 *
 * 渲染顺序必须钉死 —— 如果按显示顺序渲染，链序一变 Vue 就会去移动 DOM 结点，
 * 而移动 DOM 结点会打断 CSS transition，表现就是有的结点平滑滑动、有的直接瞬移。
 * 钉死之后只有 transform 在变，所有结点都能一起平滑滑动。
 */
const renderNodes = computed<RenderNode[]>(() => {
  const l = lv.value
  if (!l) return []
  const pos = posOf.value
  let floatSeat = 0
  return l.nodes.map((node) => {
    const index = pos.get(node.id)
    if (index !== undefined) return { node, x: xOf(index), y: NODE_Y, isFloating: false }
    const x = floatX.value + floatSeat * STEP
    floatSeat += 1
    return { node, x, y: FLOAT_Y, isFloating: true }
  })
})

/** 结点配色：环入口优先标绿，其余看本步高亮 */
function colorOf(node: ListNodeSnapshot): RGB {
  const l = lv.value
  if (!l) return PALETTE.base
  if (l.cycleEntry === node.id) return PALETTE.sorted
  if (!l.hot.includes(node.id)) return PALETTE.base
  switch (currentStep.value?.action) {
    case 'compare':
      return PALETTE.compare
    case 'set':
    case 'swap':
      return PALETTE.swap
    case 'done':
    case 'sorted':
      return PALETTE.sorted
    default:
      return PALETTE.mark
  }
}

/** 双向链表才会画 prev 箭头，也才需要把 next 箭头往上让位 */
const isDoubly = computed(() => !!lv.value?.nodes.some((n) => n.prev !== undefined))

/**
 * next 箭头。按"源结点 id"作 key，同样按结点创建顺序遍历，
 * 这样同一条箭头不会因为重排而重建，形状固定、只有位置在变。
 */
const nextArrows = computed(() => {
  const l = lv.value
  if (!l) return []
  const pos = posOf.value
  // 单链表（含循环链表）没有反向箭头，next 就画在结点中线上，不上移
  const dy = isDoubly.value ? ARROW_DY : 0
  const out: Array<{ key: string; x: number; y: number }> = []
  for (const n of l.nodes) {
    const i = pos.get(n.id)
    if (i === undefined || n.next === null) continue
    // 只有"下一个结点正好排在它右边一格"时才画箭头；
    // 游离结点、以及链尾回头成环的情况都不画在这里
    if (pos.get(n.next) !== i + 1) continue
    out.push({ key: n.id, x: xOf(i) + NODE_W, y: NODE_MID_Y - dy })
  }
  return out
})

/**
 * prev 箭头（双链表）：和 next 一样画在相邻两结点之间的空隙里，
 * 只是方向相反、往下偏一点，两条箭头形成一对反向箭头。
 */
const prevArrows = computed(() => {
  const l = lv.value
  if (!l || !l.nodes.some((n) => n.prev !== undefined)) return []
  const pos = posOf.value
  const out: Array<{ key: string; x: number; y: number }> = []
  for (const n of l.nodes) {
    const i = pos.get(n.id)
    if (i === undefined || !n.prev) continue
    if (pos.get(n.prev) !== i - 1) continue
    out.push({ key: n.id, x: xOf(i), y: NODE_MID_Y + ARROW_DY })
  }
  return out
})

/**
 * 链尾的 next 指向哪里：null（到头了）/ 回头成环。
 * 只看 reachable（真的走得到的这一串）。
 */
const tail = computed(() => {
  const l = lv.value
  if (!l || l.reachable.length === 0) return null
  const byId = new Map(l.nodes.map((n) => [n.id, n]))
  const lastId = l.reachable[l.reachable.length - 1]!
  const last = byId.get(lastId)!
  const pos = posOf.value
  const lastIdx = pos.get(lastId)
  if (lastIdx === undefined) return null
  const x = xOf(lastIdx) + NODE_W
  const y = NODE_MID_Y
  if (last.next === null) return { kind: 'null' as const, x, y }
  const toIdx = pos.get(last.next)
  if (toIdx === undefined) return { kind: 'null' as const, x, y }
  return { kind: 'cycle' as const, x, y, toIdx, tailIdx: lastIdx }
})

/** 成环回头箭头：环的结构在运行期间不变，所以形状固定，也能整体平移 */
const cycleArrow = computed(() => {
  const t = tail.value
  if (!t || t.kind !== 'cycle') return null
  const delta = (t.toIdx - t.tailIdx) * STEP
  return {
    x: centerXOf(t.tailIdx),
    y: NODE_BOTTOM,
    d: `M 0 0 L 0 ${CYCLE_DROP} L ${delta} ${CYCLE_DROP} L ${delta} ${END_DROP}`,
  }
})

/**
 * 画一支实心箭头：从 p1 指到 p2，细杆 + 宽头（像手绘的那种方块箭头）。
 * 返回 <polygon> 用的 points 串。
 */
function blockArrow(p1: { x: number; y: number }, p2: { x: number; y: number }): string {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy)
  if (len < 2) return ''
  const ux = dx / len
  const uy = dy / len
  const nx = -uy // 左法线：用来把杆和头"撑开"成有宽度的形状
  const ny = ux
  const head = Math.min(LINK_HEAD_LEN, len * 0.45) // 头不能比整支箭头还长
  const bx = p2.x - ux * head // 箭头底（颈部）
  const by = p2.y - uy * head
  const p = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`
  return [
    p(p1.x + nx * LINK_SHAFT, p1.y + ny * LINK_SHAFT),
    p(bx + nx * LINK_SHAFT, by + ny * LINK_SHAFT),
    p(bx + nx * LINK_HEAD, by + ny * LINK_HEAD),
    p(p2.x, p2.y),
    p(bx - nx * LINK_HEAD, by - ny * LINK_HEAD),
    p(bx - nx * LINK_SHAFT, by - ny * LINK_SHAFT),
    p(p1.x - nx * LINK_SHAFT, p1.y - ny * LINK_SHAFT),
  ].join(' ')
}

/**
 * 游离结点（刚 new 出来、还没接进链表）和别的结点之间的指针。
 *
 * 普通箭头只画"链上相邻的两格"，所以"新结点接上后继"这类步骤
 * （`s->next = p->next`、`q->next->prev = p`）原本在画面上什么都看不见。
 * 这里给每一根这样的指针单独画一支实心箭头：
 * - 两根指针方向相反时，两支箭头**并排**（各往自己那一侧让开），不会叠在一起；
 * - 游离结点那一端沿顶边朝对方偏一点，一个结点挂多条指针时不会挤成"Λ"形。
 */
const floatLinks = computed(() => {
  const l = lv.value
  if (!l) return []
  const onChain = new Set(l.reachable)
  const byId = new Map(l.nodes.map((n) => [n.id, n]))

  const floatIdx = new Map<string, number>()
  floating.value.forEach((n, i) => floatIdx.set(n.id, i))

  /** 锚点：链上结点取底部中心、游离结点取顶部中心 */
  const rawAnchor = (id: string) => {
    const i = posOf.value.get(id)
    if (i !== undefined) return { x: xOf(i) + NODE_W / 2, y: NODE_BOTTOM, floating: false }
    const k = floatIdx.get(id) ?? 0
    return { x: floatX.value + k * STEP + NODE_W / 2, y: FLOAT_Y, floating: true }
  }

  /** 游离结点那一端沿顶边偏向对方（本来就上下对齐就不偏，免得白白画斜） */
  const endPoint = (me: { x: number; y: number; floating: boolean }, other: { x: number }) => {
    if (!me.floating) return { x: me.x, y: me.y }
    const dx = other.x - me.x
    if (Math.abs(dx) < 8) return { x: me.x, y: me.y }
    return { x: me.x + (dx > 0 ? 1 : -1) * NODE_W * 0.26, y: me.y }
  }

  // 收集有向指针（两边都在链上的由格间普通箭头负责，这里不重复画）
  const dirs: Array<{ from: string; to: string }> = []
  for (const n of l.nodes) {
    for (const field of ['next', 'prev'] as const) {
      const target = n[field]
      if (!target || !byId.has(target)) continue
      if (onChain.has(n.id) && onChain.has(target)) continue
      dirs.push({ from: n.id, to: target })
    }
  }
  const present = new Set(dirs.map((d) => `${d.from}>${d.to}`))

  return dirs.map((d) => {
    const ra = rawAnchor(d.from)
    const rb = rawAnchor(d.to)
    const a = endPoint(ra, rb)
    const b = endPoint(rb, ra)
    // 反向那根指针也存在 -> 两支并排，各往自己方向的左侧让开，正好分居轴线两侧
    const paired = present.has(`${d.to}>${d.from}`)
    let p1 = a
    let p2 = b
    if (paired) {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
      const nx = -(b.y - a.y) / len
      const ny = (b.x - a.x) / len
      p1 = { x: a.x + nx * LINK_PAIR_OFFSET, y: a.y + ny * LINK_PAIR_OFFSET }
      p2 = { x: b.x + nx * LINK_PAIR_OFFSET, y: b.y + ny * LINK_PAIR_OFFSET }
    }
    return {
      key: `${d.from}>${d.to}`,
      points: blockArrow(p1, p2),
      paired,
    }
  })
})

/**
 * 命名指针标签。
 * key 用**指针名**（而不是它指向的结点），这样指针换目标时是同一个 DOM 结点
 * 在改 transform，于是"移动"才有动画，而不是消失再出现。
 * 多个指针落在同一结点上时按座位号错开一行，避免叠在一起。
 */
const pointerLabels = computed(() => {
  const l = lv.value
  if (!l) return []
  const pos = posOf.value
  const floatSeats = new Map<string, number>()
  const seats = new Map<string, number>()
  const out: Array<{ name: string; x: number; y: number; below: boolean }> = []
  for (const [name, id] of Object.entries(l.pointers)) {
    if (!id) continue
    const i = pos.get(id)
    if (i !== undefined) {
      const seat = seats.get(id) ?? 0
      seats.set(id, seat + 1)
      out.push({ name, x: xOf(i), y: PTR_Y - seat * PTR_SEAT_H, below: false })
      continue
    }
    // 指针指向游离结点：标签挂在它下方
    const seat = floatSeats.get(id) ?? 0
    floatSeats.set(id, seat + 1)
    out.push({ name, x: floatX.value, y: FLOAT_PTR_Y + seat * PTR_SEAT_H, below: true })
  }
  return out
})
</script>

<template>
  <div v-if="!lv" class="empty">该算法没有链表结构</div>
  <div v-else class="linked">
    <div class="scroller">
      <div
        class="board"
        :style="{ width: `${boxWidth}px`, height: `${BOX_H}px`, '--anim': animMs }"
      >
        <svg class="edges" :width="boxWidth" :height="BOX_H">
          <defs>
            <marker
              id="arrow-next"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#4d5561" />
            </marker>
            <marker
              id="arrow-prev"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#5c6674" />
            </marker>
            <marker
              id="arrow-cycle"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#10b981" />
            </marker>
          </defs>

          <!-- next 箭头：固定形状，靠 translate 跟着结点滑动 -->
          <g
            v-for="a in nextArrows"
            :key="`n-${a.key}`"
            class="edge"
            :style="{ transform: `translate(${a.x}px, ${a.y}px)` }"
          >
            <line
              x1="0"
              y1="0"
              :x2="ARROW_LEN"
              y2="0"
              stroke="#4d5561"
              stroke-width="2"
              marker-end="url(#arrow-next)"
            />
          </g>

          <!-- prev 箭头（双链表）：就画在空隙里，方向相反、位置略低 -->
          <g
            v-for="a in prevArrows"
            :key="`p-${a.key}`"
            class="edge"
            :style="{ transform: `translate(${a.x}px, ${a.y}px)` }"
          >
            <line
              x1="0"
              y1="0"
              :x2="-ARROW_LEN"
              y2="0"
              stroke="#5c6674"
              stroke-width="1.6"
              marker-end="url(#arrow-prev)"
            />
          </g>

          <!--
            游离结点相关的指针：每根指针一支实心箭头，
            让"新结点接上后继"这类步骤看得见。双向就是两支并排的箭头。
          -->
          <polygon
            v-for="p in floatLinks"
            :key="p.key"
            class="float-link"
            :points="p.points"
            fill="#4d5561"
          />

          <!-- 成环的回头箭头 -->
          <g
            v-if="cycleArrow"
            class="edge"
            :style="{ transform: `translate(${cycleArrow.x}px, ${cycleArrow.y}px)` }"
          >
            <path
              :d="cycleArrow.d"
              fill="none"
              stroke="#10b981"
              stroke-width="2"
              marker-end="url(#arrow-cycle)"
            />
          </g>

          <!-- 链尾 NULL：做得紧凑些，免得和后面的东西叠在一起 -->
          <g
            v-if="tail && tail.kind === 'null'"
            class="edge"
            :style="{ transform: `translate(${tail.x}px, ${tail.y}px)` }"
          >
            <line x1="0" y1="0" x2="12" y2="0" stroke="#4d5561" stroke-width="2" />
            <text x="17" y="4" fill="#5c6674" font-size="10.5">NULL</text>
          </g>

          <!-- 游离结点下方不再放标注：那块位置留给指针标签，上方留给指针线 -->
        </svg>

        <!-- 命名指针标签：key 用指针名，指针换目标就是同一个元素在改 transform，所以会滑过去 -->
        <div
          v-for="p in pointerLabels"
          :key="p.name"
          class="ptr"
          :class="{ below: p.below }"
          :style="{ transform: `translate(${p.x}px, ${p.y}px)`, width: `${NODE_W}px` }"
        >
          <span v-if="p.below" class="ptr-tip">↑</span>
          <span class="ptr-text">{{ p.name }}</span>
          <span v-if="!p.below" class="ptr-tip">↓</span>
        </div>

        <!-- 结点：按创建顺序渲染，位置只靠 transform 表达 -->
        <div
          v-for="p in renderNodes"
          :key="p.node.id"
          class="node"
          :class="{ dummy: p.node.dummy, floating: p.isFloating }"
          :style="{
            transform: `translate(${p.x}px, ${p.y}px)`,
            width: `${NODE_W}px`,
            height: `${NODE_H}px`,
            background: css(colorOf(p.node)),
          }"
        >
          <span v-if="p.node.dummy" class="dummy-text">头结点</span>
          <span v-else class="data">{{ p.node.value }}</span>
        </div>
      </div>
    </div>

    <p v-if="lv.hasCycle" class="cycle-note">
      <span class="dot"></span>
      {{ lv.cycleEntry ? '已找到环的入口（绿色结点）' : '检测到链表中有环' }}
    </p>
  </div>
</template>

<style scoped>
.linked {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.scroller {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.board {
  position: relative;
}

.edges {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

/*
 * 位置过渡统一走 transform（可以 GPU 加速，也正好是 CSS 能过渡的属性）。
 * 时长用 --anim，由播放速度决定，和柱状图渲染器保持一致。
 */
.node,
.ptr {
  position: absolute;
  top: 0;
  left: 0;
  transition-property: transform;
  transition-timing-function: cubic-bezier(0.33, 1, 0.68, 1); /* easeOutCubic */
  transition-duration: var(--anim, 300ms);
}

/* SVG 里的装饰（箭头 / NULL）也一起平移，这样不会和结点脱节 */
.edge {
  transition-property: transform;
  transition-timing-function: cubic-bezier(0.33, 1, 0.68, 1);
  transition-duration: var(--anim, 300ms);
  will-change: transform;
}

/* 新长出来的指针：淡入，而不是"啪"地蹦出来 */
.float-link {
  animation: link-in var(--anim, 300ms) cubic-bezier(0.33, 1, 0.68, 1) both;
}

@keyframes link-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.node {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: #fff;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 16px;
  font-weight: 600;
  will-change: transform;
  /* 位置跟着 --anim 走；配色变化快一点 */
  transition-property: transform, background-color;
  transition-duration: var(--anim, 300ms), 160ms;
}

.node.dummy {
  background: #2b323c !important;
  border: 1px dashed #4d5561;
  color: #8b949e;
}

/* 还没接入链表的游离结点：描一圈虚线，表示"它还在外面" */
.node.floating {
  box-shadow: 0 0 0 2px #0b0e13, 0 0 0 3px #4d5561;
}

.dummy-text {
  font-size: 11px;
  font-weight: 400;
}

.ptr {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.1;
  pointer-events: none;
  will-change: transform;
}

.ptr-text {
  padding: 1px 6px;
  font-size: 11px;
  font-family: Consolas, Monaco, monospace;
  color: #f5c518;
  background: rgba(245, 197, 24, 0.13);
  border: 1px solid rgba(245, 197, 24, 0.35);
  border-radius: 5px;
  white-space: nowrap;
}

.ptr-tip {
  font-size: 11px;
  color: #f5c518;
}

.cycle-note {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 8px 2px 0;
  font-size: 13px;
  color: #10b981;
}

.cycle-note .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #10b981;
}

.empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: #6e7681;
  font-size: 13px;
}
</style>
