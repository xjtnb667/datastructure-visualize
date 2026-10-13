<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useAlgorithmStore } from '@/stores/algorithm'
import {
  layoutBoardPointers,
  pointerMetrics,
  PTR_BADGE_PAD,
  PTR_CELL,
  PTR_RING_LABEL_R,
  PTR_RING_R,
  PTR_RING_SIZE,
  type BoardPtrLayout,
  type PlacedPtrLabel,
  type PointerMetrics,
} from '@/core/pointerLabels'
import type { BoardView, CellTone, TapeView } from '@/core/types'

/**
 * 通用「场景」渲染器。
 *
 * 栈、队列、矩阵、压缩表、调用栈…… 这些东西形状各不相同，
 * 但都可以归结成"一组格子 + 若干命名指针（+ 一点连线）"。
 * 所以这里只做一种渲染：**格子板**，靠 layout 换布局：
 *   column = 竖着（顺序栈 / 递归调用栈）
 *   row    = 横着（数组、压缩后的一维表）
 *   grid   = 折行（矩阵、三元组表、十字链表）
 *   ring   = 环形（循环队列）
 * 外加**纸带**用来表示"正在扫描的字符串"（括号匹配、表达式求值）。
 */
const store = useAlgorithmStore()
const { currentStep, steps } = storeToRefs(store)

/**
 * 只渲染指定位置的板子。
 * 树类算法会把板子摆到树的上下两边（哈夫曼构造的"游离结点池"就在树上面），
 * 所以同一个面板里会出现两个 ScenePanel，各自负责一边。
 * 不传 = 全都渲染（普通场景类算法用）。
 */
const props = defineProps<{ only?: 'top' | 'bottom' }>()

const boards = computed<BoardView[]>(() => {
  const all = currentStep.value?.boards ?? []
  if (!props.only) return all
  return all.filter((b) =>
    props.only === 'top' ? b.position === 'top' : b.position !== 'top',
  )
})
const tapes = computed<TapeView[]>(() => currentStep.value?.tapes ?? [])

/**
 * 格子里的字**按宽度自动缩**。
 *
 * 格子宽度是固定的（CELL = 46），长文字会被撑出格子、挤到隔壁去 ——
 * 十字链表表头的「同弧头链」「同弧尾链」就是这么和邻格叠在一起的。
 * 中文按 1 个字宽、ASCII 按 0.56 个字宽估算，装不下就等比缩小字号（下限 8px）。
 * 装得下时返回 undefined，交给 CSS 的默认字号。
 */
const CELL_INNER = 38
function fitFont(text: string | undefined, base: number, inner = CELL_INNER): string | undefined {
  if (!text) return undefined
  let units = 0
  for (const ch of text) units += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.56
  const need = units * base
  if (need <= inner) return undefined
  return `${Math.round(Math.max(8, inner / units) * 10) / 10}px`
}

const TONE: Record<CellTone, string> = {  base: '#3f6fd8',
  hot: '#8b5cf6',
  done: '#10b981',
  mark: '#ef4444',
  dim: '#2b323c',
}

const CELL = PTR_CELL
const RING_R = PTR_RING_R
/** 环形容器边长：要把环外的指针标签也装进去 */
const RING_SIZE = PTR_RING_SIZE

function toneColor(t?: CellTone): string {
  return TONE[t ?? 'base']
}

/**
 * 一块板子上的指针标签摆在哪儿 —— 交给纯函数算（`src/core/pointerLabels.ts`）。
 *
 * 老做法是纯 CSS（`.ptr-badge { left: 50%; transform: translateX(-50%) }`）：
 * 只按**自己那一格**居中，既不看自己多宽，也不看隔壁有没有标签。于是：
 *   - 两个指针指**同一格**（堆排序里 `较大的孩子` 就是 `2i+1` 或 `2i+2` 那一格）
 *     → 两个标签位置完全相同，字压字；
 *   - 两个指针指**相邻格**、而标签比格距还宽 → 也叠。
 * 避让逻辑放在纯函数里，组件只负责照着画；测试就能在 Node 里对全部算法全部帧
 * 断言"两两不相交、不出板子"，不用开浏览器。
 *
 * 每帧的板子对象都是新的，模板里每个格子又要查一次，所以用 WeakMap 缓存一次结果。
 */
const ptrLayouts = new WeakMap<BoardView, BoardPtrLayout>()
function boardLayout(b: BoardView): BoardPtrLayout {
  let lay = ptrLayouts.get(b)
  if (!lay) {
    lay = layoutBoardPointers(b)
    ptrLayouts.set(b, lay)
  }
  return lay
}

/** 板子挂在树的上边还是下边（和 boards 的过滤规则保持一致） */
function boardSide(b: BoardView): 'top' | 'bottom' {
  return b.position === 'top' ? 'top' : 'bottom'
}

/**
 * 整条动画轨迹里指针标签需要的最大留白。
 * 取**整条轨迹**的最大值而不是当前帧的：板子的内边距逐帧变化的话，
 * 格子会在"有标签的帧"之间上下跳动。
 */
const ptrMetrics = computed<PointerMetrics>(() =>
  pointerMetrics(steps.value, (b) => (props.only ? boardSide(b) === props.only : true)),
)

function boardStyle(b: BoardView): Record<string, string> {
  const style: Record<string, string> = {
    '--ptr-pad': `${ptrMetrics.value.padTop}px`,
    '--ptr-rowgap': `${ptrMetrics.value.rowGap}px`,
    '--ptr-pad-r': `${ptrMetrics.value.padRight}px`,
  }
  if (b.layout === 'grid') style['--cols'] = String(b.cols ?? 3)
  return style
}

/**
 * 格子落在网格的第几行第几列。
 *
 * 只对**显式写了 row / col** 的格子生效（哈希表要"桶号占第一行、元素挂在桶号正下方"）；
 * 没写的格子返回空对象，仍旧按 items 顺序从左到右折行 ——
 * 矩阵 / 稀疏矩阵 / DP 二维表走的都是那条路，这里不能碰。
 */
function cellPlace(b: BoardView, it: { row?: number; col?: number }): Record<string, string> {
  if (b.layout !== 'grid') return {}
  const style: Record<string, string> = {}
  if (it.row !== undefined) style.gridRow = String(it.row)
  if (it.col !== undefined) style.gridColumn = String(it.col)
  return style
}

/**
 * 元素从哪一侧滑进来。
 * 竖排默认从上方；横排/折行默认从左侧（绝大多数表都是从左往右填）。
 * 但共享栈的栈2 是从右端往左长的，它的格子必须显式声明 'right'。
 */
function slideOf(b: BoardView, item: { slide?: 'left' | 'right' | 'top' }): string {
  return item.slide ?? (b.layout === 'column' ? 'top' : 'left')
}

/** 环形布局：第 i 格在圆周上的位置（12 点方向开始，顺时针） */
function ringPos(i: number, n: number, r: number): { x: number; y: number } {
  const a = (-90 + (i * 360) / Math.max(n, 1)) * (Math.PI / 180)
  return { x: Math.cos(a) * r, y: Math.sin(a) * r }
}

function ringBox(): Record<string, string> {
  return { width: `${RING_SIZE}px`, height: `${RING_SIZE}px`, '--ring': `${RING_R}px` }
}

function ringCellStyle(i: number, n: number): Record<string, string> {
  const p = ringPos(i, n, RING_R)
  return { transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` }
}

/**
 * 指针标签画在**环形外侧**：画在格子内部的话会被圆周上后面的格子盖住。
 * 同一格上的多个标签沿着圆周的**切线**错开 —— 再往外挪就顶出环形容器了。
 */
function ringPtrStyle(p: PlacedPtrLabel, n: number): Record<string, string> {
  const at = ringPos(p.idx, n, PTR_RING_LABEL_R)
  return { transform: `translate(-50%, -50%) translate(${at.x + p.dx}px, ${at.y + p.dy}px)` }
}

/**
 * 竖排板子的指针标签：贴在格子右侧，同一格上的多个标签**往下错层**
 * （往上会滑出板子顶部，往下是板子外面的空白，安全）。
 */
function colPtrStyle(p: PlacedPtrLabel, n: number): Record<string, string> {
  return { top: `${colPtrTop(p.idx, n) + p.dy}px` }
}

/** 横幅 / 折行板子的指针标签：挂在格子上方，同一格上的多个标签**往上错层** */
function rowPtrStyle(p: PlacedPtrLabel): Record<string, string> {
  return {
    bottom: `calc(100% + ${PTR_BADGE_PAD - p.dy}px)`,
    transform: `translateX(calc(-50% + ${p.dx}px))`,
  }
}

/** 板子上有没有指针标签 —— 有的话横排 / 折行布局要给它留出上方空间 */
function hasPointers(b: BoardView): boolean {
  return Object.keys(b.pointers ?? {}).length > 0
}

/**
 * 竖排板子里，第 i 格**中心**距板子顶部的距离（像素）。
 * 竖排是 column-reverse，所以 0 号格在最下面 —— 指针要滑上去就靠这个算 top。
 */
function colPtrTop(i: number, n: number): number {
  return (n - 1 - i) * (CELL + 6) + CELL / 2
}

/** 十字链表的连线：把格子序号换成格子中心坐标 */
function linkLine(b: BoardView, l: { from: number; to: number; dir: 'right' | 'down' }) {
  const cols = b.cols ?? 1
  const at = (i: number) => ({
    x: (i % cols) * (CELL + 6) + CELL / 2,
    y: Math.floor(i / cols) * (CELL + 6) + CELL / 2,
  })
  const a = at(l.from)
  const c = at(l.to)
  if (l.dir === 'right') return { x1: a.x + CELL / 2, y1: a.y, x2: c.x - CELL / 2, y2: c.y }
  return { x1: a.x, y1: a.y + CELL / 2, x2: c.x, y2: c.y - CELL / 2 }
}
</script>

<template>
  <div class="scene">
    <div v-if="!boards.length && !tapes.length" class="empty">该算法没有可显示的结构</div>

    <!-- 纸带：正在扫描的字符串 -->
    <div v-for="(t, i) in tapes" :key="`t${i}`" class="tape-wrap">
      <span class="board-title">{{ t.label }}</span>
      <div class="tape">
        <!-- pad：前面空出几格，用来把模式串压在主串对应位置下面 -->
        <span
          v-for="n in t.pad ?? 0"
          :key="`pad${n}`"
          class="tchar pad"
          aria-hidden="true"
        ></span>
        <span
          v-for="(ch, k) in t.items"
          :key="k"
          class="tchar"
          :class="{
            on: t.pos === k,
            passed: t.pos !== undefined && k < t.pos,
            out: t.tone === 'out',
          }"
        >
          {{ ch === ' ' ? '␣' : ch }}
        </span>
      </div>
    </div>

    <!-- 格子板 -->
    <div class="boards">
      <div v-for="(b, i) in boards" :key="`b${i}`" class="board">
        <span class="board-title">{{ b.title }}</span>

        <!-- 环形（循环队列） -->
        <div v-if="b.layout === 'ring'" class="ring" :style="{ ...ringBox(), ...boardStyle(b) }">
          <span
            v-for="(it, k) in b.items"
            :key="`c${k}`"
            class="ring-cell"
            :style="{
              ...ringCellStyle(k, b.items.length),
              background: toneColor(it.tone),
            }"
          >
            <span class="cell-text" :style="{ fontSize: fitFont(it.text, 15) }">{{ it.text }}</span>
            <span v-if="it.sub" class="cell-sub" :style="{ fontSize: fitFont(it.sub, 9.5, 40) }">{{ it.sub }}</span>
          </span>
          <!-- 指针标签单独画在环外，z-index 抬高，免得被圆周上的格子盖住 -->
          <span
            v-for="p in boardLayout(b).labels"
            :key="`p${p.name}`"
            class="ring-ptr"
            :style="ringPtrStyle(p, b.items.length)"
          >{{ p.name }}</span>
        </div>

        <!--
          竖排（栈）：格子位置固定，元素做**上下滑动**（进栈从上方滑入、出栈向上滑出）；
          指针单独画一层、按名字作 key，所以"栈顶上移"也是滑上去的。
        -->
        <div v-else-if="b.layout === 'column'" class="col-board" :style="boardStyle(b)">
          <div class="col-cells">
            <div v-for="(it, k) in b.items" :key="k" class="cell-wrap">
              <div
                class="cell"
                :class="{ empty: it.tone === 'dim' }"
                :style="{ background: toneColor(it.tone) }"
              >
                <TransitionGroup name="sitem">
                  <span
                    v-if="it.text"
                    :key="`${it.text}#${it.sub ?? ''}`"
                    class="cell-item"
                    :class="`slide-${slideOf(b, it)}`"
                  >
                    <span class="cell-text" :style="{ fontSize: fitFont(it.text, 15) }">{{ it.text }}</span>
                    <span v-if="it.sub" class="cell-sub" :style="{ fontSize: fitFont(it.sub, 9.5, 40) }">{{ it.sub }}</span>
                  </span>
                </TransitionGroup>
              </div>
            </div>
            <span
              v-for="p in boardLayout(b).labels"
              :key="p.name"
              class="col-ptr"
              :style="colPtrStyle(p, b.items.length)"
            >{{ p.name }}</span>
          </div>
        </div>

        <!-- 横排 / 折行：元素做左右滑动 -->
        <div
          v-else
          class="grid-box"
          :class="[`layout-${b.layout}`, { 'has-ptr': hasPointers(b), 'has-ptr-grid': hasPointers(b) && b.layout === 'grid' }]"
          :style="boardStyle(b)"
        >
          <svg
            v-if="b.links?.length"
            class="links"
            :width="(b.cols ?? 1) * (CELL + 6)"
            :height="Math.ceil(b.items.length / (b.cols ?? 1)) * (CELL + 6)"
          >
            <defs>
              <marker
                id="scene-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
              </marker>
            </defs>
            <line
              v-for="(l, k) in b.links"
              :key="k"
              v-bind="linkLine(b, l)"
              stroke="#f59e0b"
              stroke-width="2"
              marker-end="url(#scene-arrow)"
            />
          </svg>

          <div
            v-for="(it, k) in b.items"
            :key="k"
            class="cell-wrap"
            :class="`ptr-${b.layout}`"
            :style="cellPlace(b, it)"
          >
            <div
              v-if="!it.empty"
              class="cell"
              :class="{ empty: it.tone === 'dim' }"
              :style="{ background: toneColor(it.tone) }"
            >
              <TransitionGroup name="sitem">
                <span
                  v-if="it.text"
                  :key="`${it.text}#${it.sub ?? ''}`"
                  class="cell-item"
                  :class="`slide-${slideOf(b, it)}`"
                >
                  <span class="cell-text" :style="{ fontSize: fitFont(it.text, 15) }">{{ it.text }}</span>
                  <span v-if="it.sub" class="cell-sub" :style="{ fontSize: fitFont(it.sub, 9.5, 40) }">{{ it.sub }}</span>
                </span>
              </TransitionGroup>
            </div>
            <span
              v-for="p in boardLayout(b).byIndex.get(k) ?? []"
              :key="p.name"
              class="ptr-badge"
              :style="rowPtrStyle(p)"
            >{{ p.name }}</span>
          </div>
        </div>

        <p v-if="b.note" class="board-note">{{ b.note }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scene {
  display: flex;
  flex-direction: column;
  gap: 18px;
  /* 顶部多留一点：进栈的元素是从上方滑进来的，得有地方给它 */
  padding: 46px 4px 4px;
  overflow: auto;
  height: 100%;
}

.empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: #6e7681;
  font-size: 13px;
}

.board-title {
  display: block;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: #8b949e;
}

/* ---------- 纸带 ---------- */
.tape-wrap {
  flex: none;
}

.tape {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tchar {
  display: grid;
  place-items: center;
  min-width: 26px;
  height: 30px;
  padding: 0 5px;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 15px;
  color: #c9d4e0;
  background: #1a1f28;
  border: 1px solid #2b323c;
  border-radius: 6px;
  /* 游标靠配色表达，不用额外的箭头 */
  transition: background-color 160ms, color 160ms, border-color 160ms;
}

.tchar.passed {
  color: #6e7681;
}

/* 占位格：只占宽度，不画出来 */
.tchar.pad {
  visibility: hidden;
}

.tchar.out {
  border-color: #2f4a3a;
  color: #9fd8b8;
}

.tchar.on {
  color: #fff;
  background: #8b5cf6;
  border-color: #a78bfa;
  font-weight: 600;
}

/* ---------- 格子板 ---------- */
.boards {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.board {
  flex: none;
}

.grid-box {
  position: relative;
  display: flex;
}

/*
 * 横排 / 折行的指针标签挂在格子**上方**（bottom: 100% + 4px），
 * 不给它留位置的话，第一行的标签会顶上去压住板子标题。
 *
 * 留多高由 --ptr-pad 决定：同一格上有两个指针时要错层，每多一层多留 19px
 * （见 src/core/pointerLabels.ts 的 ptrPadTopFor）。这个变量按**整条动画轨迹**
 * 取最大值，所以它逐帧是恒定值，格子不会一格一格地上下跳。
 */
.grid-box.has-ptr {
  padding-top: var(--ptr-pad, 24px);
}

/*
 * 连线层是绝对定位在 top:0 的，上面加了内边距之后它会跟着错位
 * （箭头整体上移、掉进行与行之间的缝里）。这里让它跟着往下挪，和内边距对齐。
 */
.grid-box.has-ptr > .links {
  top: var(--ptr-pad, 24px);
}

.layout-row {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 6px;
}

/* 栈的 0 号格在底部 -> 反过来排 */
.layout-column {
  flex-direction: column-reverse;
  gap: 6px;
  width: max-content;
}

.layout-grid {
  display: grid;
  grid-template-columns: repeat(var(--cols), 46px);
  gap: 6px;
  width: max-content;
}

/*
 * 网格里的指针标签挂在"格子上方 4px"处（见 .ptr-row / .ptr-grid 那段）。
 * 行间距只有 6px，而标签有 17px 高，于是压进了上一行的格子里 ——
 * 十字链表那类带指针的表格上，标签就会盖住上一行的内容。
 * 这里把行间距撑开，标签正好落在两行之间的空档里（两个指针错层时还要再多留）。
 */
.layout-grid.has-ptr-grid {
  row-gap: var(--ptr-rowgap, 24px);
}

/* 横排板子折行以后，第二行的标签同样会压到第一行的格子上，一视同仁撑开 */
.layout-row.has-ptr {
  row-gap: var(--ptr-rowgap, 6px);
}

.links {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.cell-wrap {
  position: relative;
}

.cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 46px;
  height: 46px;
  padding: 0 8px;
  border-radius: 8px;
  color: #fff;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  transition: background-color 160ms;
}

/* ---------- 元素进出：上下滑动 / 左右滑动 ---------- */
/* 元素绝对定位在格子里，这样"进"和"出"的两个元素不会互相挤动布局 */
.cell-item {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.sitem-enter-active,
.sitem-leave-active {
  transition:
    transform 260ms cubic-bezier(0.33, 1, 0.68, 1),
    opacity 260ms linear;
}

/* 从哪一侧滑进来，由每个格子自己声明（CellItem.slide），默认见 slideOf() */
.slide-top.sitem-enter-from,
.slide-top.sitem-leave-to {
  transform: translateY(-38px);
  opacity: 0;
}

.slide-left.sitem-enter-from,
.slide-left.sitem-leave-to {
  transform: translateX(-38px);
  opacity: 0;
}

.slide-right.sitem-enter-from,
.slide-right.sitem-leave-to {
  transform: translateX(38px);
  opacity: 0;
}

/* ---------- 竖排板子 + 会滑动的指针 ---------- */
.col-board {
  display: flex;
  /* 右边留出位置给指针标签，否则会被裁掉（标签再宽也兜得住，见 pointerLabels 的 padRight） */
  padding-right: var(--ptr-pad-r, 78px);
}

.col-cells {
  position: relative;
  display: flex;
  flex-direction: column-reverse;
  gap: 6px;
}

.col-ptr {
  position: absolute;
  left: calc(100% + 8px);
  padding: 1px 6px;
  font-size: 11px;
  font-family: Consolas, Monaco, monospace;
  color: #f5c518;
  background: rgba(245, 197, 24, 0.13);
  border: 1px solid rgba(245, 197, 24, 0.35);
  border-radius: 5px;
  white-space: nowrap;
  transform: translateY(-50%);
  /* 指针换格子时是"滑上去"的，不是跳上去的 */
  transition: top 260ms cubic-bezier(0.33, 1, 0.68, 1);
}

.layout-grid .cell {
  width: 46px;
  padding: 0 2px;
}

.cell.empty {
  color: #5c6674;
  border: 1px dashed #3a4150;
}

.cell-text {
  line-height: 1.1;
}

.cell-sub {
  font-size: 9.5px;
  font-weight: 400;
  opacity: 0.7;
  line-height: 1.1;
}

/* 指针小标签 */
.ptr-badge {
  position: absolute;
  padding: 1px 6px;
  font-size: 11px;
  font-family: Consolas, Monaco, monospace;
  color: #f5c518;
  background: rgba(245, 197, 24, 0.13);
  border: 1px solid rgba(245, 197, 24, 0.35);
  border-radius: 5px;
  white-space: nowrap;
}

/*
 * 横排 / 折行的标签默认"挂在本格正上方 4px 处"。
 * 同一格上有多个指针时，行内的 style 会覆盖 bottom / transform 把标签错层、微调
 * （位置由 src/core/pointerLabels.ts 算好），这里的值就是"只有一个标签"时的样子。
 */
.ptr-row .ptr-badge,
.ptr-grid .ptr-badge {
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
}

.ptr-column .ptr-badge {
  left: calc(100% + 6px);
  top: 50%;
  transform: translateY(-50%);
}

/* ---------- 环形（循环队列） ---------- */
.ring {
  position: relative;
  margin: 10px auto 10px;
}

.ring-cell {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 10px;
  color: #fff;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 15px;
  font-weight: 600;
  transition: transform 200ms, background-color 160ms;
}

.ring-cell .cell-sub {
  color: rgba(255, 255, 255, 0.6);
}

.ring-ptr {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 3;
  padding: 1px 6px;
  font-size: 11px;
  font-family: Consolas, Monaco, monospace;
  color: #f5c518;
  background: #23262d;
  border: 1px solid rgba(245, 197, 24, 0.5);
  border-radius: 5px;
  white-space: nowrap;
  transition: transform 200ms;
}

.board-note {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: #8b949e;
}
</style>
