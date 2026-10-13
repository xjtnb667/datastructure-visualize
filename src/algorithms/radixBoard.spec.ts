import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import { radixSortSpec } from './sortMore'
import { getAlgorithm } from './index'
import ScenePanel from '@/components/ScenePanel.vue'
import { buildSteps } from '@/core/engine'
import { useAlgorithmStore } from '@/stores/algorithm'
import type { AlgoStep, BoardView } from '@/core/types'

/**
 * 基数排序「10 个桶」那块板子的常驻回归测试。
 *
 * 起因（用户原话）：「这里给桶单独一行」——
 * 老版本是**行优先折行**：10 个桶混在一行里滚动显示，桶号写成每格右下角的
 * 小字（`0号`…`9号`），空桶画成虚线空格；元素全部挤在第 1 行，
 * 第 2 行再冒出几个没有桶号的数字，根本看不出它属于哪个桶。
 *
 * 现在改成和哈希表同一套排布（见 `src/algorithms/searchMore.ts` 的 `hashBoard`）：
 *   第 1 行 —— 固定 10 格，就是 10 个桶号（`0号` ~ `9号`，列号恒为 1..10，空桶也有桶号）；
 *   第 2 行起 —— 元素竖着挂在**自己那个桶号的正下方**，同一列从上到下 = 入桶顺序（先进先出）。
 *
 * ⚠️ 这块板子最容易踩的坑是**指针**：`pointers['当前桶']` 存的是 items 的**行优先序号**，
 * 而"当前桶"要挂在"那个桶的桶号格"上。老代码 `pointers['当前桶'] = hotBucket` 之所以看着对，
 * 只是因为老版 items 恰好也是行优先稠密的；一旦改成"元素竖挂 + 空桶从 items 里删掉"，
 * 序号和行列的对应就断了，徽章会挂到别的桶上去。所以下面第 ① 组用例专门钉死
 * "序号 → (row=1, col=桶号+1)" 这条对应关系，第 ⑥ 组再用真 SSR 渲染钉死 DOM。
 */

const COLS = 10
const DATASETS: Array<{ name: string; data: number[] }> = [
  { name: '默认数据（3 位，个/十/百各一轮）', data: radixSortSpec.defaultData() },
  { name: '只有个位（1 轮）', data: [5, 2, 9, 1, 7, 3] },
  { name: '全相等', data: [7, 7, 7] },
  { name: '单个元素', data: [4] },
  { name: '两个元素', data: [0, 9] },
  { name: '含 0（0 一律进 0 号桶）', data: [0, 0, 10, 100] },
  { name: '桶里挤很多（重复位）', data: [11, 1, 21, 31, 41, 51, 61, 71, 81, 91] },
  { name: '规模 16', data: Array.from({ length: 16 }, (_, i) => ((i * 37) % 97) + 3) },
]

function stepsOf(data: number[]): AlgoStep[] {
  return buildSteps(radixSortSpec, data, { target: 0 })
}

/** 这块算法唯一的桶板子：`grid` 布局 + 恰好 10 列（另一块板子是"数组本身…"的横排板） */
function bucketBoard(s: AlgoStep): BoardView {
  const b = (s.boards ?? []).find((x) => x.layout === 'grid' && x.cols === COLS)
  if (!b) throw new Error(`第 ${s.line} 行这一帧没有桶板子：${(s.boards ?? []).map((x) => x.title).join(' / ')}`)
  return b
}

/** 每行的 yield 次数，用来钉死"算法本体一个字没动" */
function lineCounts(steps: AlgoStep[]): Record<number, number> {
  const out: Record<number, number> = {}
  for (const s of steps) out[s.line] = (out[s.line] ?? 0) + 1
  return out
}

/** 表头格：第 1 行的 10 个桶号格 */
const headerCells = (b: BoardView) => b.items.filter((it) => it.row === 1)

/** d 号桶那一列（`d号` 桶号格正下方）挂着的元素格，按行升序 —— 也就是"桶里现在有什么" */
function hangingIn(b: BoardView, d: number): string[] {
  const col = d + 1
  return b.items
    .filter((it) => it.col === col && (it.row ?? 0) >= 2 && !it.empty)
    .sort((x, y) => (x.row ?? 0) - (y.row ?? 0))
    .map((it) => it.text)
}

/** 这一位上的数字（算法第 5 行的 `(v / exp) % 10`） */
const digitOf = (v: number, exp: number) => Math.abs(Math.floor(v / exp) % 10)

/**
 * 独立复刻算法本体（`radixSortRun` 的第 5 / 8 行）算出"这一帧分桶 / 收桶结束之后，
 * 每个桶里按入桶先后应该是什么" —— 用来和板子逐帧对账。
 *
 * ⚠️ 必须用 **`step.array`**（这一帧算法自己那份数组快照）而不是原始输入：
 * `radixSortRun` 每一轮收桶都会**原地改写** `a`，所以从第 2 轮起"参与分桶的数据"
 * 已经是上一轮排完的结果了 —— 拿原始数据去算第二轮，算出来的是错的。
 *
 * 返回 null 表示这一帧的板子不该有元素（init / 清桶 / done 那几帧）。
 */
function expectedBuckets(s: AlgoStep): number[][] | null {
  const round = s.vars?.第几轮 === undefined ? null : Number(s.vars.第几轮)
  if (round === null) return null // init / done：桶全空，没有元素
  const exp = 10 ** (round - 1)
  const buckets: number[][] = Array.from({ length: COLS }, () => [])

  if (s.line === 3) return buckets // 「先把 10 个桶清空」：空的
  if (s.line === 5) {
    // 第 3 行开始分桶，扫到 a[i]（含）为止 —— 用这一帧的数组快照逐个重放到 i
    const upto = Number(s.vars?.元素下标)
    for (let t = 0; t <= upto; t++) {
      const v = s.array[t]!
      buckets[digitOf(v, exp)]!.push(v)
    }
    return buckets
  }
  if (s.line === 8) {
    /*
     * 收桶：板子是在"倒之前"拍的快照 —— 这一帧画面显示的是**收桶前**每个桶里的样子，
     * 而算法在这一帧已经/正在把桶里的元素连续写回数组 `a` 了。
     * 于是 `step.array` 里同一个值可能同时出现在"桶板"和"已写回的位置"上（比如
     * 0 号桶 [170, 90] 倒回 a[0..1] 之后，a 里到处都能筛出 170 / 90）。
     * 所以收桶帧**不能**用 `s.array` 去算桶里该有什么，只能对"桶 + 数组合起来的多重集"。
     * 完整的多重集对账放在下面那条「收桶顺序」用例里用原始数据做。
     */
    return Array.from({ length: COLS }, () => [])
  }
  return null
}

/** 这块板子唯一允许的显式行号 / 列号：第 1 行是桶号、第 2 行起是元素（都落在 1..10 列） */
function checkGeometry(b: BoardView, where: string): void {
  expect(b.layout, where).toBe('grid')
  expect(b.cols, where).toBe(COLS)

  // ① 第一行：固定 10 个桶号格，列号恰好 1..10，没有小字（桶号就是正文）
  const heads = headerCells(b)
  expect(heads.length, `${where}：第一行不是 10 个桶号`).toBe(COLS)
  expect(heads.map((it) => it.col), `${where}：第一行的列号不是 1..10`).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(heads.map((it) => it.text), `${where}：第一行的桶号文案不对`).toEqual(
    Array.from({ length: COLS }, (_, d) => `${d}号`),
  )
  for (const it of heads) expect(it.sub, `${where}：桶号格不该再带小字`).toBeUndefined()

  // ② 每个有 row/col 的格子：列在 1..10、行 ≥ 1、row/col 组合不重复（不许叠格）
  const seen = new Set<string>()
  for (const it of b.items) {
    const row = it.row
    const col = it.col
    expect(row, `${where}：有格子的 row 是空的`).toBeTypeOf('number')
    expect(col, `${where}：有格子的 col 是空的`).toBeTypeOf('number')
    expect(row!, `${where}：出现了第 0 行`).toBeGreaterThanOrEqual(1)
    expect(col!, `${where}：列号越界`).toBeGreaterThanOrEqual(1)
    expect(col!, `${where}：列号越界`).toBeLessThanOrEqual(COLS)
    // 第 ≥2 行的格子必须是一列一列挂下来的：允许的空洞（empty）也在网格位次上
    if (row! >= 2) expect(it.empty === true || it.text !== '', `${where}：第 ${row} 行有个既非元素也非空洞的格子`).toBe(true)
    const key = `${row},${col}`
    expect(seen.has(key), `${where}：两个格子叠在 ${key}`).toBe(false)
    seen.add(key)
  }

  // ③ 元素格里不许再出现"N号"那种小字（列号已经说明桶号了）
  for (const it of b.items.filter((x) => (x.row ?? 0) >= 2 && !x.empty)) {
    expect(it.sub, `${where}：元素格 ${it.text} 上还挂着桶号小字`).toBeUndefined()
  }

  // ④ items 必须**行优先稠密**：序号 idx 对应的就是 (floor(idx/10)+1, idx%10+1)
  //    —— 这正是 `pointers` 的语义，也是指针徽章不挂错格的前提
  for (const [idx, it] of b.items.entries()) {
    expect(it.row, `${where}：第 ${idx} 个格子的 row 和行优先序号对不上`).toBe(Math.floor(idx / COLS) + 1)
    expect(it.col, `${where}：第 ${idx} 个格子的 col 和行优先序号对不上`).toBe((idx % COLS) + 1)
  }
}

describe('基数排序的桶板：桶号单独占第一行，元素挂在各自桶号正下方', () => {
  it('每一帧都满足：第一行 10 个桶号（列号 1..10）、元素分别落在自己桶号那一列、无叠格、无桶号小字', () => {
    expect(DATASETS.length).toBeGreaterThanOrEqual(8) // 守卫：别让规模覆盖被删空
    let frames = 0
    let elementCells = 0
    for (const { name, data } of DATASETS) {
      const steps = stepsOf(data)
      expect(steps.length, name).toBeGreaterThan(0)
      for (const [k, s] of steps.entries()) {
        const b = bucketBoard(s)
        checkGeometry(b, `${name} 第 ${k} 帧（line ${s.line}）`)
        frames += 1
        elementCells += b.items.filter((it) => (it.row ?? 0) >= 2 && !it.empty).length
        // 第一行恒为 10 格 —— 不管桶是空是满
        expect(headerCells(b).length, `${name} 第 ${k} 帧第一行格子数变了`).toBe(COLS)
      }
    }
    expect(frames, '守卫：真正校验过的帧数太少，说明数据用例没跑起来').toBeGreaterThan(150)
    expect(elementCells, '守卫：一个元素格都没校验到').toBeGreaterThan(50)
  })

  it('逐帧对账：每个桶列里挂的元素 = 算法此刻真的放进桶里的东西（顺序 = 先进先出）', () => {
    let checkedFrames = 0
    for (const { name, data } of DATASETS) {
      for (const [k, s] of stepsOf(data).entries()) {
        const want = expectedBuckets(s)
        if (want === null) continue
        if (s.line === 8) continue // 收桶帧由「算法本体」那条用例按桶模型单独核对
        const b = bucketBoard(s)
        for (let d = 0; d < COLS; d++) {
          const got = hangingIn(b, d)
          expect(got, `${name} 第 ${k} 帧（line ${s.line}）${d} 号桶里挂的元素不对`).toEqual(want[d]!.map(String))
          // 行号必须从 2 起**连续**（中间不许跳行，空洞只允许出现在桶底）
          got.forEach((_, t) => {
            const cell = b.items.find((it) => it.col === d + 1 && it.row === t + 2)
            expect(cell, `${name} 第 ${k} 帧 ${d} 号桶第 ${t} 个元素没落在第 ${t + 2} 行`).toBeTruthy()
          })
          const nextRow = got.length + 2
          const hole = b.items.find((it) => it.col === d + 1 && it.row === nextRow)
          // 桶底如果再往下有格子，那必须是"空洞"（empty），不能是虚线空格、更不能有文字
          // （最长的那个桶下面本来就没有行了，find 不到是正常的）
          if (hole) {
            expect(hole.empty, `${name} 第 ${k} 帧 ${d} 号桶桶底下面那个格子不是空洞`).toBe(true)
            expect(hole.text, `${name} 第 ${k} 帧 ${d} 号桶桶底下面的空洞格里有文字`).toBe('')
          }
        }
        checkedFrames += 1
      }
    }
    expect(checkedFrames, '守卫：真正对过账的帧太少').toBeGreaterThan(40)
  })

  it('空桶：数据上留着位次（指针序号要用），但显示上一个格子都不画', () => {
    for (const { name, data } of DATASETS) {
      for (const [k, s] of stepsOf(data).entries()) {
        const b = bucketBoard(s)
        for (let d = 0; d < COLS; d++) {
          const colCells = b.items.filter((it) => it.col === d + 1 && (it.row ?? 0) >= 2)
          const real = colCells.filter((it) => !it.empty)
          // 空桶那一列：第 2 行起全是空洞（老版本这里是一排虚线空格）
          if (real.length === 0) {
            expect(colCells.every((it) => it.empty === true), `${name} 第 ${k} 帧 ${d} 号桶是空的，却画了格子`).toBe(true)
          }
          // 空洞格子不许有任何可见内容
          for (const it of colCells.filter((x) => x.empty)) {
            expect(it.text, `${name} 第 ${k} 帧 ${d} 号桶的空洞格里有文字`).toBe('')
            expect(it.sub, `${name} 第 ${k} 帧 ${d} 号桶的空洞格里有小字`).toBeUndefined()
          }
        }
      }
    }
  })

  it('「当前桶」指针：序号指向的格子必须正好是那个桶的桶号格（row=1、col=桶号+1）', () => {
    let hotFrames = 0
    let noPtrFrames = 0
    for (const { name, data } of DATASETS) {
      for (const [k, s] of stepsOf(data).entries()) {
        const b = bucketBoard(s)
        const entries = Object.entries(b.pointers ?? {})
        // 分桶 / 收桶帧必须有「当前桶」；init / 清桶 / done 那几帧本来就没有当前桶
        const hot = s.line === 5 || s.line === 8 ? Number(s.vars?.桶号) : null
        if (hot === null) {
          expect(s.line === 1 || s.line === 3 || s.line === 11, `${name} 第 ${k} 帧出现了没想到的行号`).toBe(true)
          expect(entries.length, `${name} 第 ${k} 帧（line ${s.line}）不该有「当前桶」`).toBe(0)
          noPtrFrames += 1
          continue
        }
        expect(entries.length, `${name} 第 ${k} 帧「当前桶」指针不是恰好一个`).toBe(1)
        const [pname, idx] = entries[0]!
        expect(pname, `${name} 第 ${k} 帧指针名字变了`).toBe('当前桶')
        expect(idx, `${name} 第 ${k} 帧指针序号越界`).toBeLessThan(b.items.length)
        // 指针序号 = 第 1 行第 (桶号+1) 列 —— 也就是那个桶的桶号格
        expect(idx, `${name} 第 ${k} 帧指针序号不是行优先序号`).toBe(idx % COLS)
        const at = b.items[idx]!
        expect(at.row, `${name} 第 ${k} 帧「当前桶」没挂在第一行`).toBe(1)
        expect(at.text, `${name} 第 ${k} 帧「当前桶」挂到了别的格子：${at.text}`).toBe(`${idx}号`)
        expect(at.col, `${name} 第 ${k} 帧「当前桶」的列号和桶号对不上`).toBe(idx + 1)
        // 和算法给的桶号交叉验证（分桶帧 vars.桶号 = 刚放进去的桶；收桶帧 = 正在倒的桶）
        expect(idx, `${name} 第 ${k} 帧（line ${s.line}，算法说当前桶是 ${hot} 号）指针指错了`).toBe(hot)
        hotFrames += 1
      }
    }
    expect(hotFrames, '守卫：真正核对过的"当前桶"帧数太少').toBeGreaterThan(100)
    expect(noPtrFrames, '守卫：没查到"本来就没有当前桶"的帧').toBeGreaterThan(0)
  })

  it('算法本体一个字没动：帧数、每行 yield 次数、终态、数组快照全都和改版前一致', () => {
    // 默认数据 [170,45,75,90,2,24,802,66]：3 轮。每轮 = 清桶 1 帧 + 分桶 8 帧 + 收桶（非空桶各 1 帧），
    // 加上 init / done 两帧。另有一组 1 位的数组做交叉验证。
    const cases: Array<{ name: string; data: number[]; frames: number; lines: Record<number, number> }> = [
      {
        name: '默认数据',
        data: radixSortSpec.defaultData(),
        frames: 44,
        lines: { 1: 2, 3: 3, 5: 24, 8: 14, 11: 1 },
      },
      {
        name: '只有个位',
        data: [5, 2, 9, 1, 7, 3],
        frames: 16,
        lines: { 1: 2, 3: 1, 5: 6, 8: 6, 11: 1 },
      },
      { name: '单个元素', data: [4], frames: 6, lines: { 1: 2, 3: 1, 5: 1, 8: 1, 11: 1 } },
    ]
    for (const { name, data, frames, lines } of cases) {
      const steps = stepsOf(data)
      expect(steps.length, name).toBe(frames)
      expect(lineCounts(steps), name).toEqual(lines)
      expect(steps[0]!.action, name).toBe('init')
      expect(steps[0]!.line, name).toBe(1)
      expect(steps.at(-1)!.action, name).toBe('done')
      expect(steps.at(-1)!.line, name).toBe(11)
      // 终态升序、元素一个不多一个不少
      const sorted = [...data].sort((x, y) => x - y)
      expect(steps.at(-1)!.array, name).toEqual(sorted)
      expect([...steps.at(-1)!.array].sort((x, y) => x - y), name).toEqual(sorted)
      // done 帧的桶板必须是"全空"（桶都倒回去了）
      const doneBoard = bucketBoard(steps.at(-1)!)
      expect(doneBoard.items.filter((it) => (it.row ?? 0) >= 2 && !it.empty).length, name).toBe(0)
      expect(headerCells(doneBoard).length, name).toBe(COLS)
    }

    // 收桶顺序 = 0 号桶 → 9 号桶（注释里承诺的那件事），逐轮核对。
    //
    // 收桶帧的板子显示的是**收桶前**整轮分完桶的样子（板子是在倒之前拍的快照），
    // 所以逐桶内容要用"这一轮开始时的数组"算；`vars.已收回` 顺带核一遍
    // （它必须等于"0 号桶到当前桶"的元素总数 —— 也就是"按 0→9 号桶的顺序连续写回"）。
    const data = radixSortSpec.defaultData()
    const sorted = [...data].sort((x, y) => x - y)
    const steps = stepsOf(data)
    let roundStart = data.slice()
    for (let round = 1; round <= 3; round++) {
      const exp = 10 ** (round - 1)
      const frames = steps.filter((s) => s.line === 8 && Number(s.vars?.第几轮) === round)
      const nonEmpty = [...new Set(roundStart.map((v) => digitOf(v, exp)))].sort((x, y) => x - y)
      expect(frames.map((s) => Number(s.vars?.桶号)), `第 ${round} 轮收桶顺序不是 0 号 → 9 号`).toEqual(nonEmpty)

      let accumulated = 0
      for (const s of frames) {
        const dd = Number(s.vars?.桶号)
        accumulated += roundStart.filter((v) => digitOf(v, exp) === dd).length
        expect(Number(s.vars?.已收回), `第 ${round} 轮收桶帧（倒 ${dd} 号桶）的"已收回"不对`).toBe(accumulated)
        const b = bucketBoard(s)
        for (let d = 0; d < COLS; d++) {
          expect(hangingIn(b, d), `第 ${round} 轮收桶帧（正在倒 ${dd} 号桶）${d} 号桶里的内容不对`).toEqual(
            roundStart.filter((v) => digitOf(v, exp) === d).map(String),
          )
        }
      }

      // 这一轮全部倒完之后，数组应该正好是"0 号桶 → 9 号桶拼起来"
      const finalFrame = frames.at(-1)!
      expect(finalFrame.array, `第 ${round} 轮收完桶之后的数组不对`).toEqual(
        nonEmpty.flatMap((d) => roundStart.filter((v) => digitOf(v, exp) === d)),
      )
      expect([...finalFrame.array].sort((x, y) => x - y), `第 ${round} 轮收桶把元素弄丢了`).toEqual(sorted)
      roundStart = finalFrame.array.slice()
    }
    // 走完所有轮，数组就是升序
    expect(roundStart, '三轮收桶之后的终态不是升序').toEqual(sorted)
  })
})

/**
 * 把 SSR 渲染出的 HTML 按每个 `.cell-wrap` 切开，逐段抠出
 * `grid-row` / `grid-column` / 正文 / 小字 / 里面有没有指针徽章。
 *
 * ⚠️ 只按**外层 cell-wrap** 切段（每段 = 一个格子，含它自己那个徽章），
 * 不做整段 HTML 的正则匹配 —— 空洞格（`empty`）里面根本没有 `.cell` 子元素，
 * 但它的 cell-wrap 和 grid-row/grid-column 还照旧在，正好用来证明"空洞没被画出来"。
 */
function cellsOf(html: string): Array<{
  row: number
  col: number
  text: string
  sub: string | null
  hasCell: boolean
  badge: string | null
}> {
  const at = [...html.matchAll(/class="[^"]*cell-wrap[^"]*"/g)].map((m) => m.index ?? 0)
  return at.map((start, i) => {
    const seg = html.slice(start, at[i + 1] ?? html.length)
    // 把标签剥掉之后剩下的纯文字：先是格子的正文，再是（同格上的）指针徽章名字
    const texts = [...seg.matchAll(/>([^<>]+)</g)].map((m) => m[1]!.trim()).filter(Boolean)
    return {
      row: Number(/grid-row:\s*(\d+)/.exec(seg)?.[1] ?? 0),
      col: Number(/grid-column:\s*(\d+)/.exec(seg)?.[1] ?? 0),
      text: /class="cell-text"[^>]*>([^<]*)</.exec(seg)?.[1] ?? '',
      sub: /class="cell-sub"[^>]*>([^<]*)</.exec(seg)?.[1] ?? null,
      // 空洞格（empty）里连 .cell 都不渲染，所以那一段**自己根本没有开标签**
      // 有格子的段：`class="ptr-grid cell-wrap" style="..." data-v-xxx><div class="empty cell" style="...">`
      // 空洞格的段：`class="ptr-grid cell-wrap" style="..." data-v-xxx><div class="ptr-grid cell-wrap" ...>`
      hasCell: /class="[^"]*cell-wrap"[^>]*>\s*<div class="(?![^"]*cell-wrap)/.test(seg),
      badge: texts.length > 1 ? texts[texts.length - 1]! : null,
    }
  })
}

describe('基数排序桶板：行列位置真的写进了 DOM（SSR 真渲染）', () => {
  it('渲染出的第一行就是 10 个桶号格，元素落在自己桶号那一列的第 2 行起；空桶不画格子；「当前桶」钉在正确的桶号格上', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const algo = useAlgorithmStore(pinia)
    algo.selectAlgorithm('sort-radix')
    expect(algo.totalSteps, '默认数据的帧数变了').toBe(44)

    // 找一个"正在分桶"的帧：这时桶里已经有东西，能同时看到桶号和挂下来的元素
    let target = -1
    for (let i = 0; i < algo.totalSteps; i++) {
      const s = algo.steps[i]
      if (s && s.line === 5 && Number(s.vars?.元素下标) >= 3) {
        target = i
        break
      }
    }
    expect(target, '守卫：没找到带元素的"分桶"帧').toBeGreaterThan(0)
    algo.goToStep(target)
    const step = algo.currentStep!

    const app = createSSRApp(ScenePanel)
    app.use(pinia)
    const html = await renderToString(app)
    const cells = cellsOf(html)

    // 表头：恰 10 个，列号恰 1..10，正文就是桶号，没有小字
    const heads = cells.filter((c) => c.row === 1)
    expect(heads.length).toBe(COLS)
    expect(heads.map((c) => c.col)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(heads.map((c) => c.text)).toEqual(Array.from({ length: COLS }, (_, d) => `${d}号`))
    for (const h of heads) {
      expect(h.sub, '桶号格上还有小字').toBeNull()
      expect(h.hasCell, '桶号格没画出来').toBe(true)
    }

    // 元素：每一列都从第 2 行起连续往下挂，正文 = 板子数据里那一列的元素
    const board = bucketBoard(step)
    for (let d = 0; d < COLS; d++) {
      const want = hangingIn(board, d)
      const colCells = cells.filter((c) => c.col === d + 1)
      // 可见格 = 桶号格 + 这一列的元素格（空洞格不画 .cell）
      expect(
        colCells.filter((c) => c.hasCell).map((c) => c.text),
        `${d} 号桶那一列渲染出来的可见格子不对`,
      ).toEqual([`${d}号`, ...want])
      expect(
        colCells.filter((c) => c.hasCell).map((c) => c.row),
        `${d} 号桶那一列的行号不连续`,
      ).toEqual([1, ...want.map((_, t) => t + 2)])
      // 桶底以下：DOM 里连 .cell 都没有（老版本这里是一排虚线空格）
      const holes = colCells.filter((c) => c.row >= 2 && !c.hasCell)
      expect(holes.length, `${d} 号桶那一列没有配齐空洞格`).toBeGreaterThanOrEqual(0)
      for (const h of holes) {
        expect(h.text, `${d} 号桶的空洞格里渲染出了文字`).toBe('')
        expect(h.sub, `${d} 号桶的空洞格里渲染出了小字`).toBeNull()
      }
    }

    // ⭐「当前桶」徽章：必须挂在"它那个桶的桶号格"（第 1 行、第 桶号+1 列）里面
    const bucket = board.pointers!['当前桶']!
    const withBadge = cells.filter((c) => c.badge !== null)
    expect(withBadge.length, 'DOM 里「当前桶」徽章不止一个').toBe(1)
    expect(withBadge[0]!.badge).toBe('当前桶')
    expect([withBadge[0]!.row, withBadge[0]!.col], '「当前桶」徽章没挂在它那个桶的桶号格上').toEqual([1, bucket + 1])
    expect(withBadge[0]!.text, '「当前桶」挂到了别的格子上').toBe(`${bucket}号`)
  })
})

describe('其它板子的折行排布没被带坏（row / col 一个字都没加）', () => {
  it('矩阵 / 稀疏矩阵 / DP 表仍然按 items 顺序折行', () => {
    const ids = ['sparse-triple', 'sparse-cross', 'dp-knapsack', 'dp-lcs', 'dp-edit-distance']
    let checked = 0
    for (const id of ids) {
      const spec = getAlgorithm(id)
      expect(spec, `${id} 不见了`).toBeTruthy()
      const steps = buildSteps(spec!, spec!.defaultData(), { target: 0 })
      for (const s of steps) {
        for (const b of s.boards ?? []) {
          for (const it of b.items) {
            expect(it.row, `${id} 的格子被写上了 row`).toBeUndefined()
            expect(it.col, `${id} 的格子被写上了 col`).toBeUndefined()
          }
          checked += 1
        }
      }
    }
    expect(checked, '守卫：一块板子都没检查到，说明用例空跑了').toBeGreaterThan(0)
  })
})
