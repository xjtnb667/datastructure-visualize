import { describe, expect, it } from 'vitest'
// 用 Vite 的 `?raw` 拿面板源文本：不引 node 内置模块（本项目 tsconfig 的 types 只有 vite/client）
import canvasPanel from './CanvasPanel.vue?raw'
import graphPanel from './GraphPanel.vue?raw'
import treePanel from './TreePanel.vue?raw'

/**
 * 常驻守卫：**动画区里的注释（note）不许被裁掉**。
 *
 * 背景（2026-10 修的 bug）：右栏 `.pane-body`（src/styles/main.css:165）是
 * `overflow: hidden`，它的内容盒就是面板根容器的高度（1440x900 下实测 596px），
 * 而面板自己 `overflow: visible`。于是只要面板里的子项加起来比 `.pane-body` 高，
 * 多出来的部分就被 `.pane-body` **无声裁掉**：
 *   - `.tree-note` / `.graph-note` 是 flex 列里**多出来的 24px 项**：
 *     `主区 60% + 24px + 板子槽 40% = 100% + 24px`，实测右栏溢出 12px
 *     → note 只露半行，而板子槽盒子也被顶出 `.pane-body` 12px，
 *       **槽最底下那条（板子的 note 就贴在最底下）永远滚不到**；
 *   - 19 个没有板子的树算法（bst-insert / rb-tree / avl-* / 线索树 …）：
 *     `.scroller` 100% + `.tree-note` 24px，同样只露半行。
 *
 * 修法（两件，缺一不可）：
 *   1) 三个面板的 `.boards-slot` 改 `flex: 0 1 auto; min-height: 0` —— 只能压缩自己，
 *      盒子绝不越出 `.pane-body`；主绘图区仍是 `flex: 0 0 60%`（**帧恒定，不许跳**，
 *      提交 7bf351f 修的就是"动画区上下跳"，所以主区不能写成 `flex: 1 1 auto`）；
 *   2) TreePanel 的 `.tree-note` 搬进 `.scroller` 里 —— 树矮时它就落在树下面那片空白里、
 *      不用滚动也完整可见；树高时它在滚动内容末尾，滚到底可见。
 *
 * jsdom 没有布局引擎，量不了真实盒子（真实盒子用 CDP 全量扫过：101 算法 2658 帧，
 * 改前树/图算法 `paneScroll` 12~28px、改后全帧 0），所以这里断言的是 .vue 源里的
 * CSS/模板不变量 + 把 flex 的账算一遍。
 * 谁把 `flex: 0 1` 改回 `flex: 0 0`、把 `min-height: 0` 删掉、或把 note 搬回 `.scroller`
 * 外面，这里就红。
 */

const panelStyles = {
  'CanvasPanel.vue': styleOf(canvasPanel),
  'TreePanel.vue': styleOf(treePanel),
  'GraphPanel.vue': styleOf(graphPanel),
}

function styleOf(vue: string): string {
  return [...vue.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

function templateOf(vue: string): string {
  // 注意：SFC 里还有嵌套的 `<template v-if>`，取**最后一个** `</template>` 才是根模板的收尾
  return vue.slice(vue.indexOf('<template>'), vue.lastIndexOf('</template>'))
}

/** 注释里也写着 `flex: 0 0 60%` 这种字样，不去掉会误判 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取某个选择器的声明（同名选择器后面的覆盖前面的，和 CSS 一致） */
function decls(style: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([^{}]+)\{([^{}]*)\}/g
  const css = stripComments(style)
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '))
    if (!sels.includes(selector)) continue
    for (const piece of m[2].split(';')) {
      const i = piece.indexOf(':')
      if (i < 0) continue
      const key = piece.slice(0, i).trim()
      const value = piece.slice(i + 1).trim()
      if (key) out[key] = value
    }
  }
  return out
}

/** `flex: 0 1 auto` → { grow: 0, shrink: 1, basis: 'auto' } */
function parseFlex(value: string): { grow: number; shrink: number; basis: string } {
  const t = value.trim().split(/\s+/)
  const num = (v: string | undefined, d: number) => (v !== undefined && /^[\d.]+$/.test(v) ? Number(v) : d)
  return { grow: num(t[0], 0), shrink: num(t[1], 1), basis: t[2] ?? '0%' }
}

function flexOf(style: string, selector: string) {
  const d = decls(style, selector)
  const flex = d.flex ? parseFlex(d.flex) : { grow: 0, shrink: 1, basis: 'auto' }
  if (d['flex-shrink'] !== undefined) flex.shrink = Number(d['flex-shrink'])
  if (d['flex-grow'] !== undefined) flex.grow = Number(d['flex-grow'])
  return { d, flex }
}

/** 主绘图区（帧恒定，必须刚性）——选择器 → flex 值 */
const MAIN_AREAS: Record<string, Record<string, string>> = {
  'CanvasPanel.vue': {
    '.array-wrap > .canvas-wrap': '0 0 100%',
    '.array-wrap.has-boards > .canvas-wrap': '0 0 60%',
  },
  'TreePanel.vue': {
    '.scroller': '0 0 100%',
    '.tree-wrap.has-boards > .scroller': '0 0 60%',
    '.tree-wrap.has-top-boards > .scroller': '0 0 80%',
    '.tree-wrap.has-top-boards.has-boards > .scroller': '0 0 40%',
  },
  'GraphPanel.vue': {
    '.canvas': '0 0 100%',
    '.graph-wrap.has-boards > .canvas': '0 0 60%',
  },
}

describe('note 不被裁：面板布局不变量', () => {
  for (const [file, style] of Object.entries(panelStyles)) {
    it(`${file}：板子槽只能压缩自己（flex-shrink 非 0 + min-height: 0 + 基准仍 40%）`, () => {
      const { d, flex } = flexOf(style, '.boards-slot')
      expect(Object.keys(d).length, '没找到 .boards-slot 规则').toBeGreaterThan(0)
      expect(flex.shrink, '.boards-slot 必须能被压缩（原来是 flex: 0 0 auto）').toBeGreaterThan(0)
      expect(flex.grow).toBe(0)
      expect(d['min-height'], '.boards-slot 需要显式 min-height: 0').toBe('0')
      expect(d.height, '板子槽的基准高度仍是 40%（不要改成按内容长）').toBe('40%')
      expect(d.overflow).toBe('auto')
    })

    it(`${file}：主绘图区仍是刚性固定比例（动画不上下跳）`, () => {
      for (const [selector, expected] of Object.entries(MAIN_AREAS[file])) {
        const { d, flex } = flexOf(style, selector)
        expect(Object.keys(d).length, `没找到 ${selector}`).toBeGreaterThan(0)
        expect(d.flex, `${selector} 的 flex 变了`).toBe(expected)
        expect(flex.grow).toBe(0)
        expect(flex.shrink, `${selector} 不能压缩`).toBe(0)
      }
    })
  }

  it('TreePanel.vue：.tree-note 在 .scroller 里面（否则会多占 24px 被裁掉）', () => {
    const tpl = templateOf(treePanel)
    expect(tpl).toContain('class="tree-note"')
    expect(inElement(tpl, '<div ref="scrollerEl" class="scroller">', 'class="tree-note"')).toBe(true)
  })

  it('GraphPanel.vue：.graph-note 留在 .canvas 外面（canvas 是固定坐标的绘图盒）', () => {
    const tpl = templateOf(graphPanel)
    expect(tpl).toContain('class="graph-note"')
    expect(inElement(tpl, '<div class="canvas">', 'class="graph-note"')).toBe(false)
  })
})

describe('note 不被裁：flex 的账', () => {
  it('note 那 24px 由板子槽让出来，正好填满 .pane-body（改前溢出 24px → 被裁 12px）', () => {
    const pane = PANE_CONTENT_H // 1440x900：右栏 .pane-body clientHeight 614 − padding(6+12)
    const main = pane * 0.6 // 357.59
    const note = NOTE_H // 24（一行）
    const slot = pane * 0.4 // 238.39
    // 行高 1 的文本块自动最小高度 = min-content = 一行，压不动
    const items = (slotShrink: number) => [
      { basis: main, grow: 0, shrink: 0, min: 0 }, // 主绘图区：刚性
      { basis: note, grow: 0, shrink: 1, min: note }, // note 一行
      { basis: slot, grow: 0, shrink: slotShrink, min: 0 }, // 板子槽
    ]
    const after = flexColumn(pane, items(1))
    expect(after[0]).toBeCloseTo(main, 6) // 主区高度一点没动
    expect(after[1]).toBe(note) // note 完整占 24px
    expect(after[2]).toBeCloseTo(slot - note, 6) // 槽让出 24px
    expect(after.reduce((a, b) => a + b, 0)).toBeCloseTo(pane, 6) // 不溢出

    const before = flexColumn(pane, items(0)) // 旧的 flex: 0 0 auto
    expect(before.reduce((a, b) => a + b, 0)).toBeCloseTo(pane + note, 6) // 溢出 24px
  })
})

function inElement(template: string, openTag: string, needle: string): boolean {
  const start = template.indexOf(openTag)
  if (start < 0) return false
  const after = template.slice(start + openTag.length)
  const at = after.indexOf(needle)
  if (at < 0) return false
  let depth = 1
  const re = /<\/?div\b/g
  let m: RegExpExecArray | null
  const before = after.slice(0, at)
  while ((m = re.exec(before)) !== null) depth += m[0] === '</div' ? -1 : 1
  return depth > 0
}

const PANE_CONTENT_H = 596
const NOTE_H = 24

type FlexItem = { basis: number; grow: number; shrink: number; min: number }

/** 够用的 flex 单行布局模型（正自由空间按 grow 分；负空间按 shrink×basis 加权，撞到 min 就冻结再分） */
function flexColumn(container: number, items: FlexItem[]): number[] {
  const sizes = items.map((i) => i.basis)
  const frozen = items.map(() => false)
  for (let guard = 0; guard < 16; guard++) {
    const free = container - sizes.reduce((a, b) => a + b, 0)
    if (Math.abs(free) < 1e-9) break
    const pool = items.map((it, k) => (frozen[k] ? 0 : free > 0 ? it.grow : it.shrink * it.basis))
    const total = pool.reduce((a, b) => a + b, 0)
    if (total === 0) break
    let hitMin = false
    for (let k = 0; k < items.length; k++) {
      if (frozen[k] || pool[k] === 0) continue
      const next = sizes[k] + (free * pool[k]) / total
      if (next < items[k].min) {
        sizes[k] = items[k].min
        frozen[k] = true
        hitMin = true
      } else {
        sizes[k] = next
      }
    }
    if (!hitMin) break
  }
  return sizes
}
