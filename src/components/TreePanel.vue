<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useAlgorithmStore } from '@/stores/algorithm'
import { PALETTE, css, type RGB } from '@/core/palette'
import type { TreeNodeSnapshot, TreeView } from '@/core/types'
import ScenePanel from '@/components/ScenePanel.vue'

/**
 * 树 / 二叉树渲染器。
 *
 * 布局分两步，刻意保持简单（树类算法的结点数都是个位数，不需要 Reingold-Tilford）：
 *   1. 纵坐标 = 深度（从根出发走一遍就得到）
 *   2. 横坐标分两种：
 *      - **二叉树**（结点上有 left / right）用**中序序号**。这样"只有左孩子"的结点
 *        天然落在父结点左边、"只有右孩子"的落在右边，一眼就能看出左右之分。
 *      - **多叉树 / 森林**（用 children）用"叶子依次占位、父结点居中于孩子"的办法，
 *        这样任意多叉树都不会重叠。
 */
const store = useAlgorithmStore()
const { currentStep, currentTree, animDuration } = storeToRefs(store)

const NODE_W = 46
const NODE_H = 40
const X_STEP = 66
const Y_STEP = 76
const PAD = 26

const tv = computed<TreeView | null>(() => currentTree.value)
const animMs = computed(() => `${animDuration.value}ms`)
/**
 * 树下面的补充板子。
 * 非递归遍历光看结点上的小标签说不清"栈里到底存了什么、什么时候压弹"，
 * 所以这些算法额外给一块数组板画栈 / 队列本身，这里把它接在树下面一起显示。
 */
const boards = computed(() => currentStep.value?.boards ?? [])

/** 一个结点往下连的孩子（二叉树取 left/right，多叉树取 children） */
function childrenOf(n: TreeNodeSnapshot): string[] {
  if (n.children && n.children.length) return n.children
  const out: string[] = []
  if (n.left) out.push(n.left)
  if (n.right) out.push(n.right)
  return out
}

/**
 * 实际的父子关系表。
 *
 * 关键点：如果整棵树只给了 `parent`（双亲表示法、并查集就是这么存的），
 * 就**从 parent 反推孩子**。否则这些结点会被当成一堆互不相连的孤立结点，
 * 全挤在同一行、虚线横穿而过，完全看不出层次。
 */
const childMap = computed(() => {
  const t = tv.value
  const m = new Map<string, string[]>()
  if (!t) return m
  const hasExplicit = t.nodes.some((n) => childrenOf(n).length > 0)
  for (const n of t.nodes) {
    m.set(n.id, hasExplicit ? childrenOf(n).filter((c) => t.nodes.some((x) => x.id === c)) : [])
  }
  if (!hasExplicit) {
    for (const n of t.nodes) {
      if (n.parent) m.get(n.parent)?.push(n.id)
    }
  }
  return m
})

/** 只靠 parent 连起来的结点对（不画实线，交给 parent 虚线） */
const parentPairs = computed(() => {
  const t = tv.value
  const s = new Set<string>()
  for (const l of t?.links ?? []) if (l.kind === 'parent') s.add(`${l.from}>${l.to}`)
  return s
})

interface Placed {
  node: TreeNodeSnapshot
  /** 格子坐标（第几列 / 第几层） */
  gx: number
  gy: number
}

const placed = computed<Placed[]>(() => {
  const t = tv.value
  if (!t) return []
  const byId = new Map(t.nodes.map((n) => [n.id, n]))
  const roots = (t.roots?.length ? t.roots : t.root ? [t.root] : []).filter((r) => byId.has(r))

  // ---- 纵坐标：深度 ----
  const depth = new Map<string, number>()
  const seen = new Set<string>()
  const walkDepth = (id: string, d: number): void => {
    if (seen.has(id) || !byId.has(id)) return
    seen.add(id)
    depth.set(id, d)
    for (const c of childMap.value.get(id) ?? []) walkDepth(c, d + 1)
  }
  for (const r of roots) walkDepth(r, 0)
  // 从根走不到的游离结点也画出来（比如还没挂上去的新结点），统一放最上层
  for (const n of t.nodes) {
    if (!seen.has(n.id)) {
      seen.add(n.id)
      depth.set(n.id, 0)
    }
  }

  // ---- 横坐标 ----
  const gx = new Map<string, number>()
  const isBinary = t.nodes.some((n) => n.left !== undefined || n.right !== undefined)
  let cursor = 0
  if (isBinary) {
    const inorder = (id: string): void => {
      const n = byId.get(id)
      if (!n) return
      if (n.left) inorder(n.left)
      gx.set(id, cursor++)
      if (n.right) inorder(n.right)
    }
    for (const r of roots) inorder(r)
    for (const n of t.nodes) if (!gx.has(n.id)) gx.set(n.id, cursor++)
  } else {
    const post = (id: string): void => {
      const n = byId.get(id)
      if (!n) return
      const cs = childMap.value.get(id) ?? []
      if (!cs.length) {
        gx.set(id, cursor++)
        return
      }
      for (const c of cs) post(c)
      const xs = cs.map((c) => gx.get(c) ?? 0)
      gx.set(id, (Math.min(...xs) + Math.max(...xs)) / 2)
    }
    for (const r of roots) post(r)
    for (const n of t.nodes) if (!gx.has(n.id)) gx.set(n.id, cursor++)
  }

  // 按**结点创建顺序**返回：渲染顺序钉死，Vue 才不会挪 DOM，过渡才生效
  return t.nodes.map((node) => ({
    node,
    gx: gx.get(node.id) ?? 0,
    gy: depth.get(node.id) ?? 0,
  }))
})

const px = (p: Placed) => PAD + p.gx * X_STEP
const py = (p: Placed) => PAD + p.gy * Y_STEP

const boxW = computed(() => PAD * 2 + (Math.max(0, ...placed.value.map((p) => p.gx)) + 1) * X_STEP)
const boxH = computed(() => PAD * 2 + (Math.max(0, ...placed.value.map((p) => p.gy)) + 1) * Y_STEP)

const pos = computed(() => {
  const m = new Map<string, Placed>()
  for (const p of placed.value) m.set(p.node.id, p)
  return m
})

/** 父子实线：父结点底部中点 -> 子结点顶部中点 */
const edges = computed(() => {
  const out: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }> = []
  for (const p of placed.value) {
    for (const c of childMap.value.get(p.node.id) ?? []) {
      const q = pos.value.get(c)
      if (!q) continue
      // 这条关系如果已经由 parent 虚线表达，就不再画实线（否则两条线重叠）
      if (parentPairs.value.has(`${p.node.id}>${c}`)) continue
      out.push({
        key: `${p.node.id}>${c}`,
        x1: px(p) + NODE_W / 2,
        y1: py(p) + NODE_H,
        x2: px(q) + NODE_W / 2,
        y2: py(q),
      })
    }
  }
  return out
})

function edgePath(e: { x1: number; y1: number; x2: number; y2: number }): string {
  return `M ${e.x1} ${e.y1} L ${e.x2} ${e.y2}`
}

/** 额外连线：线索（虚线）和双亲 / 并查集的向上指针 */
const extraLinks = computed(() => {
  const t = tv.value
  if (!t?.links?.length) return []
  return t.links
    .map((l) => {
      const a = pos.value.get(l.from)
      const b = pos.value.get(l.to)
      if (!a || !b) return null
      return {
        key: `${l.kind}-${l.from}-${l.to}`,
        kind: l.kind,
        x1: px(a) + NODE_W / 2,
        y1: py(a) + NODE_H / 2,
        x2: px(b) + NODE_W / 2,
        y2: py(b) + NODE_H / 2,
      }
    })
    .filter((v): v is NonNullable<typeof v> => !!v)
})

function colorOf(node: TreeNodeSnapshot): RGB {
  const t = tv.value
  if (!t) return PALETTE.base
  if (t.hot?.includes(node.id)) {
    const a = currentStep.value?.action
    if (a === 'compare') return PALETTE.compare
    if (a === 'swap' || a === 'set') return PALETTE.swap
    if (a === 'done' || a === 'sorted') return PALETTE.sorted
    return PALETTE.mark
  }
  if (t.done?.includes(node.id)) return PALETTE.sorted
  return PALETTE.base
}

const pointerLabels = computed(() => {
  const t = tv.value
  if (!t) return []
  const out: Array<{ name: string; x: number; y: number }> = []
  for (const [name, id] of Object.entries(t.pointers ?? {})) {
    if (!id) continue
    const p = pos.value.get(id)
    if (!p) continue
    out.push({ name, x: px(p), y: py(p) - 20 })
  }
  return out
})
</script>

<template>
  <div v-if="!tv" class="empty">该算法没有树结构</div>
  <div v-else class="tree-wrap">
    <div class="scroller">
      <div class="board" :style="{ width: `${boxW}px`, height: `${boxH}px`, '--anim': animMs }">
        <svg class="edges" :width="boxW" :height="boxH">
          <!-- 父子实线：同时给 d 属性和 CSS d，支持的浏览器就走 CSS（能过渡） -->
          <path
            v-for="e in edges"
            :key="e.key"
            class="edge"
            :d="edgePath(e)"
            :style="{ d: `path('${edgePath(e)}')` }"
            fill="none"
            stroke="#4d5561"
            stroke-width="2"
          />
          <!-- 线索 / 双亲指针：虚线，颜色区分 -->
          <path
            v-for="l in extraLinks"
            :key="l.key"
            class="edge"
            :d="`M ${l.x1} ${l.y1} L ${l.x2} ${l.y2}`"
            :style="{ d: `path('M ${l.x1} ${l.y1} L ${l.x2} ${l.y2}')` }"
            fill="none"
            :stroke="l.kind === 'thread' ? '#f59e0b' : '#7c8aa0'"
            stroke-width="1.8"
            stroke-dasharray="5 4"
          />
        </svg>

        <div
          v-for="p in placed"
          :key="p.node.id"
          class="tnode"
          :style="{
            transform: `translate(${px(p)}px, ${py(p)}px)`,
            width: `${NODE_W}px`,
            height: `${NODE_H}px`,
            background: css(colorOf(p.node)),
          }"
        >
          <span class="tval">{{ p.node.value }}</span>
          <span v-if="p.node.sub" class="tsub">{{ p.node.sub }}</span>
        </div>

        <div
          v-for="p in pointerLabels"
          :key="`ptr-${p.name}`"
          class="tptr"
          :style="{ transform: `translate(${p.x}px, ${p.y}px)` }"
        >{{ p.name }}</div>
      </div>
    </div>

    <p v-if="tv.note" class="tree-note">{{ tv.note }}</p>

    <!-- 栈 / 队列的画面：接在树下面 -->
    <div v-if="boards.length" class="boards-slot">
      <ScenePanel />
    </div>
  </div>
</template>

<style scoped>
.tree-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.scroller {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 10px 0;
}

/* 树下面的栈 / 队列板子：最多占 42% 高度，自己内部滚动 */
.boards-slot {
  flex: 0 0 auto;
  max-height: 42%;
  overflow: auto;
  border-top: 1px solid #232a35;
  padding-top: 6px;
}

.boards-slot :deep(.scene) {
  height: auto;
  padding-top: 6px;
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

/* 结点：位置只靠 transform 表达，换位时平滑滑过去 */
.tnode,
.tptr,
.edge {
  transition-property: transform, d;
  transition-timing-function: cubic-bezier(0.33, 1, 0.68, 1);
  transition-duration: var(--anim, 300ms);
}

.tnode {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: #fff;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 15px;
  font-weight: 600;
  will-change: transform;
  transition-property: transform, background-color;
  transition-duration: var(--anim, 300ms), 160ms;
}

.tval {
  line-height: 1.05;
}

.tsub {
  font-size: 9.5px;
  font-weight: 400;
  opacity: 0.75;
  line-height: 1.05;
}

.tptr {
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
}

.tree-note {
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
