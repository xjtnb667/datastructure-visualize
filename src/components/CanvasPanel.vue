<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { scaleBand, scaleLinear } from 'd3-scale'
import { useAlgorithmStore } from '@/stores/algorithm'
import { PALETTE, css, lerpRgb, type RGB } from '@/core/palette'
import type { AlgoStep } from '@/core/types'

const store = useAlgorithmStore()
const { currentStep, currentStepIndex, steps, maxValue, animDuration, sortedIndices, target } =
  storeToRefs(store)

const wrapEl = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

/** 柱状图四周留白：上方放数值，下方放下标 */
const PAD = { top: 36, right: 20, bottom: 36, left: 20 }
/** 被排除在候选区间外的柱子画多淡 */
const DIM_ALPHA = 0.18

let ctx: CanvasRenderingContext2D | null = null
let observer: ResizeObserver | null = null
let rafId = 0
/** 当前画面上每根柱子的高度（动画中可能是小数） */
let shown: number[] = []
/** 当前画面上每根柱子的颜色（动画中可能是插值出来的中间色） */
let shownColors: RGB[] = []
let size = { w: 0, h: 0 }

/**
 * 某一根柱子该是什么颜色。
 * 优先级：已就位/已命中 > 本步操作 > 默认。
 * 注意"就位/命中"一律看 sortedIndices（由 engine 累积），
 * 不能看到 action === 'done' 就整片刷绿 —— 那样查找命中时会把所有柱子刷绿。
 */
function colorAt(index: number, step: AlgoStep | undefined, settled: number[]): RGB {
  if (!step) return PALETTE.base
  if (settled.includes(index)) return PALETTE.sorted
  if (!step.indices.includes(index)) return PALETTE.base
  switch (step.action) {
    case 'compare':
      return PALETTE.compare
    case 'swap':
    case 'set':
      return PALETTE.swap
    case 'mark':
      return PALETTE.mark
    case 'done':
      return PALETTE.sorted
    default:
      return PALETTE.base
  }
}

/** 某一帧、某一"格"步骤下，所有柱子的目标颜色 */
function colorsFor(step: AlgoStep | undefined, settled: number[], count: number): RGB[] {
  return Array.from({ length: count }, (_, i) => colorAt(i, step, settled))
}

function draw(): void {
  if (!ctx) return
  const { w, h } = size
  ctx.clearRect(0, 0, w, h)
  if (w < 20 || h < 20) return

  const step = currentStep.value
  const values = shown.length ? shown : (step?.array ?? [])
  if (!values.length) return

  const baseline = h - PAD.bottom
  // 查找类算法给出的"当前候选区间"；区间外的柱子画暗，一眼看出搜索范围在缩
  const range = step?.range

  // D3 负责算几何：x 用 band 比例尺分槽位，y 用线性比例尺把数值映射成像素高度
  const x = scaleBand<number>()
    .domain(values.map((_, i) => i))
    .range([PAD.left, w - PAD.right])
    .paddingInner(0.22)
    .paddingOuter(0.1)

  const y = scaleLinear().domain([0, maxValue.value]).range([baseline, PAD.top]).nice()

  const barWidth = x.bandwidth()

  values.forEach((value, i) => {
    const bx = x(i) ?? 0
    const top = y(value)
    const barHeight = Math.max(3, baseline - top)
    const radius = Math.min(7, barWidth / 2, barHeight / 2)

    // 区间外：整根柱子（含数值）一起变淡
    const dimmed = !!range && (i < range[0] || i > range[1])
    ctx!.globalAlpha = dimmed ? DIM_ALPHA : 1

    ctx!.beginPath()
    if (typeof ctx!.roundRect === 'function') {
      ctx!.roundRect(bx, top, barWidth, barHeight, [radius, radius, 0, 0])
    } else {
      ctx!.rect(bx, top, barWidth, barHeight)
    }
    // 用"当前这一帧"的颜色，而不是目标颜色 —— 颜色就是这样渐变的
    ctx!.fillStyle = css(shownColors[i] ?? PALETTE.base)
    ctx!.fill()

    // 柱子顶上的数值
    ctx!.fillStyle = '#e6edf3'
    ctx!.font = `600 ${Math.min(14, Math.max(10, barWidth * 0.4))}px system-ui, sans-serif`
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'bottom'
    ctx!.fillText(String(Math.round(value)), bx + barWidth / 2, top - 6)

    // 柱子底下的下标
    ctx!.fillStyle = '#6e7681'
    ctx!.font = '11px system-ui, sans-serif'
    ctx!.textBaseline = 'top'
    ctx!.fillText(String(i), bx + barWidth / 2, baseline + 9)

    ctx!.globalAlpha = 1
  })

  // 查找类算法：目标值画一条虚线，这样"要找多高的柱子"一目了然
  const targetValue = target.value
  if (targetValue !== null) {
    const ty = y(targetValue)
    ctx!.setLineDash([7, 5])
    ctx!.strokeStyle = '#f59e0b'
    ctx!.lineWidth = 1.5
    ctx!.beginPath()
    ctx!.moveTo(PAD.left, ty + 0.5)
    ctx!.lineTo(w - PAD.right, ty + 0.5)
    ctx!.stroke()
    ctx!.setLineDash([])

    ctx!.fillStyle = '#f59e0b'
    ctx!.font = '600 12px system-ui, sans-serif'
    ctx!.textAlign = 'right'
    ctx!.textBaseline = 'bottom'
    ctx!.fillText(`目标值 ${targetValue}`, w - PAD.right - 2, ty - 5)
  }

  // 基线
  ctx!.strokeStyle = '#2b323c'
  ctx!.lineWidth = 1
  ctx!.beginPath()
  ctx!.moveTo(PAD.left, baseline + 0.5)
  ctx!.lineTo(w - PAD.right, baseline + 0.5)
  ctx!.stroke()
}

function cancelAnim(): void {
  cancelAnimationFrame(rafId)
}

/** 不做动画，直接吸附到目标状态（换算法 / 换数据 / 首次渲染时用） */
function snapTo(targetArr: number[], repaint = true): void {
  cancelAnim()
  shown = targetArr.slice()
  shownColors = colorsFor(currentStep.value, sortedIndices.value, targetArr.length)
  if (repaint) draw()
}

/**
 * 从当前画面平滑过渡到目标快照：高度和颜色用同一个进度值一起插值，
 * 所以"柱子长高"和"柱子变色"是同时开始、同时结束的，不会各走各的。
 * 上一步和下一步走的是同一条路径 —— 回退时只是 begin/target 反过来。
 */
function animateTo(targetArr: number[], ms: number): void {
  cancelAnim()
  const step = currentStep.value
  const targetColors = colorsFor(step, sortedIndices.value, targetArr.length)

  if (!shown.length || shown.length !== targetArr.length || ms <= 0) {
    snapTo(targetArr)
    return
  }

  const beginHeights = shown.slice()
  const beginColors = shownColors.slice()
  const t0 = performance.now()

  const tick = (now: number): void => {
    const p = Math.min(1, (now - t0) / ms)
    const eased = 1 - Math.pow(1 - p, 3) // easeOutCubic
    shown = beginHeights.map((v, i) => v + (targetArr[i]! - v) * eased)
    shownColors = beginColors.map((c, i) => lerpRgb(c, targetColors[i] ?? c, eased))
    draw()
    if (p < 1) {
      rafId = requestAnimationFrame(tick)
    } else {
      snapTo(targetArr)
    }
  }
  rafId = requestAnimationFrame(tick)
}

/** 按容器尺寸重建画布（含高分屏适配） */
function resize(): void {
  const wrap = wrapEl.value
  const canvas = canvasEl.value
  if (!wrap || !canvas) return

  const rect = wrap.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(rect.width))
  const h = Math.max(1, Math.round(rect.height))
  size = { w, h }

  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`

  ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  draw()
}

/** 上一次处理过的步骤序列，用来区分"走了一步"和"换了一整份序列" */
let lastTrace: AlgoStep[] | null = null

onMounted(() => {
  resize()
  snapTo(currentStep.value?.array ?? [])
  // 关键：挂载时就把"当前这份序列"记为已处理。
  // 否则第一次点「下一步」时 lastTrace 还是 null，会被误判成"换了整份序列"
  // 而走直接吸附的分支 —— 表现就是第一次点击没有渐变，第二次起才有。
  lastTrace = steps.value

  observer = new ResizeObserver(() => resize())
  if (wrapEl.value) observer.observe(wrapEl.value)
})

onBeforeUnmount(() => {
  cancelAnim()
  observer?.disconnect()
  observer = null
})

// 光标动了就动一下动画（高度 + 颜色一起过渡）；整份序列换了就吸附
watch([currentStepIndex, steps], () => {
  const next = currentStep.value?.array ?? []
  const isNewTrace = steps.value !== lastTrace
  lastTrace = steps.value
  if (isNewTrace) snapTo(next)
  else animateTo(next, animDuration.value)
})
</script>

<template>
  <div ref="wrapEl" class="canvas-wrap">
    <canvas ref="canvasEl"></canvas>
  </div>
</template>

<style scoped>
.canvas-wrap {
  position: relative;
  height: 100%;
  min-height: 0;
}

.canvas-wrap canvas {
  display: block;
  position: absolute;
  inset: 0;
}
</style>
