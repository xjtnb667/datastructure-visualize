import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { buildSteps } from '@/core/engine'
import { getAlgorithm } from './index'
import { hashSearchSpec } from './searchMore'
import { useAlgorithmStore } from '@/stores/algorithm'
import ScenePanel from '@/components/ScenePanel.vue'
import type { AlgoStep, BoardView, CellItem } from '@/core/types'

/**
 * 回归测试：哈希表板子的排布 ——「**桶号占第一行，桶里的元素竖着挂在桶号正下方**」。
 *
 * 守的是用户提的那个视觉问题：以前一个桶占两格（桶号一格、链一格）挤在一起，
 * 看不出某个元素到底挂在哪条链上。现在排成表格的形状：
 *
 *       第 1 行   0   1   2   3   4   5   6     ← 桶号（表头，tone: 'dim'）
 *       第 2 行       15                         ← 桶 1 的第一个元素，和桶号同一列
 *       第 3 行        8                         ← 链多长就往下挂多长
 *
 * 靠 `CellItem.row` / `col`（都从 1 开始）在 grid 里显式定位，
 * 所以第 1、2、3 组用例直接查**数据**（每一帧都查），第 4 组真渲染一遍组件，
 * 证明这两个字段确实落成了 DOM 上的 `grid-row` / `grid-column`。
 *
 * ⚠️ 最后一组是**反向**守卫：矩阵压缩、稀疏矩阵、DP 二维表都是 `layout: 'grid'` 折行，
 * 全靠"**不写 row/col 就按 items 顺序折行**"这条老行为。它们要是被顺手写上了行列号，
 * 排布就全乱了，所以这里逐格断言这两个字段在它们身上**必须是 undefined**。
 */
const M = 7
const DATA = [15, 8, 23, 4, 11, 29, 18, 7]

/** 桶 b 里应该挂哪些关键字（插入顺序 = 从上到下的顺序） */
const expectedChain = (b: number): number[] => DATA.filter((k) => k % M === b)

/** 整条动画每一帧的哈希板子 */
function hashBoards(): BoardView[] {
  const steps: AlgoStep[] = buildSteps(hashSearchSpec, hashSearchSpec.defaultData(), { target: 15 })
  return steps.map((s) => {
    const board = (s.boards ?? []).find((b) => b.layout === 'grid')
    expect(board, '哈希表某一帧没有格子板').toBeTruthy()
    return board!
  })
}

/** 某一帧里挂在第 col 列、第 2 行及以下的所有格子（按行号从上到下） */
function hangingIn(board: BoardView, col: number): CellItem[] {
  return board.items
    .filter((it) => it.col === col && (it.row ?? 0) >= 2)
    .sort((a, b) => (a.row ?? 0) - (b.row ?? 0))
}

describe('哈希表板子：桶号占第一行，元素竖着挂在桶号正下方', () => {
  it('每一帧的第一行都是全部桶号 0..M-1，而且桶号格里只有桶号', () => {
    for (const [f, board] of hashBoards().entries()) {
      const heads = board.items.filter((it) => it.row === 1)
      expect(heads.length, `第 ${f} 帧第一行的格子数不是 ${M}`).toBe(M)
      expect(heads.map((it) => it.col), `第 ${f} 帧第一行不是从左到右的 ${M} 列`).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ])
      /*
       * 桶号格子的文字必须**正好是它那一列的桶号**。
       * 这里不能用"文字不在数据里"来判：4 和 7 这种值既是桶号也是关键字，
       * 所以判据是"第 c 列的第一行格子必须写 c-1" —— 元素要是挤进了第一行，这条必红。
       */
      expect(heads.map((it) => it.text), `第 ${f} 帧第一行不是桶号`).toEqual([
        '0', '1', '2', '3', '4', '5', '6',
      ])
      // 桶号格是表头样式：不带右下角小字（小字是元素的"下标 / 个数"那一类信息）
      for (const it of heads) expect(it.sub, `第 ${f} 帧桶号格里塞了小字`).toBeUndefined()
    }
  })

  it('每个桶的元素都挂在自己桶号的正下方：同一列、从第 2 行起一行一个', () => {
    for (const [f, board] of hashBoards().entries()) {
      for (let b = 0; b < M; b++) {
        const cells = hangingIn(board, b + 1)
        // 插到第几帧就有几个元素，所以每一帧只能是"完整链的前缀"
        const want = expectedChain(b).slice(0, cells.length)
        expect(
          cells.map((it) => it.text),
          `第 ${f} 帧：桶 ${b} 下面挂的元素不对`,
        ).toEqual(want.map(String))
        expect(
          cells.map((it) => it.row),
          `第 ${f} 帧：桶 ${b} 的元素没有紧挨着桶号往下排`,
        ).toEqual(want.map((_, k) => k + 2))
        for (const it of cells) {
          expect(Number(it.text) % M, `第 ${f} 帧：${it.text} 挂错了桶`).toBe(b)
        }
      }
    }
  })

  it('没有两个格子叠在同一格（行,列），也没有元素落到第 1 行', () => {
    for (const [f, board] of hashBoards().entries()) {
      const seen = new Set<string>()
      for (const it of board.items) {
        expect(it.row, `第 ${f} 帧有格子没写行号`).toBeGreaterThan(0)
        expect(it.col, `第 ${f} 帧有格子没写列号`).toBeGreaterThan(0)
        const at = `${it.row},${it.col}`
        expect(seen.has(at), `第 ${f} 帧两个格子叠在了 (${at})`).toBe(false)
        seen.add(at)
        // 第 1 行只有桶号；元素一律从第 2 行开始
        if ((it.row ?? 0) >= 2) {
          expect(DATA.includes(Number(it.text)), `第 ${f} 帧第 ${it.row} 行出现了非关键字 ${it.text}`).toBe(true)
        }
      }
    }
  })

  it('全部插完之后，8 个关键字一个不少地挂在各自的桶下面', () => {
    const last = hashBoards().at(-1)!
    expect(
      last.items
        .filter((it) => (it.row ?? 0) >= 2)
        .map((it) => Number(it.text))
        .sort((a, b) => a - b),
      '终态的桶里缺了 / 多了关键字',
    ).toEqual([...DATA].sort((a, b) => a - b))
  })

  it('桶的配色没丢：桶号格是表头色，命中的那个元素是绿的，撞桶过的桶还是红的', () => {
    const steps = buildSteps(hashSearchSpec, DATA, { target: 23 })
    const last = steps.at(-1)!.boards![0]!
    const at = (text: string) => last.items.find((it) => it.text === text)!
    // 23 % 7 = 2，就在第 2 个桶的链上 -> 命中（绿），桶号格同时是"正在看的桶"（紫）
    expect(at('23').tone, '命中的元素不是绿的').toBe('done')
    expect(at('2').tone, '正在看的桶号没高亮').toBe('hot')
    // 15/8/29 撞在桶 1、4/11/18 撞在桶 4：这两个桶一直是红的
    expect(at('1').tone, '撞过桶的桶号不是红的').toBe('mark')
    expect(at('4').tone, '撞过桶的桶号不是红的').toBe('mark')
    expect(at('8').tone, '撞过桶里的元素不是红的').toBe('mark')
    // 没撞过的桶号格是表头灰，桶里第一条链是普通蓝
    expect(at('0').tone, '空桶的桶号格不是表头色').toBe('dim')
    expect(at('7').tone, '普通元素不是蓝色').toBe('base')
  })
})

/** 从 SSR 出来的 HTML 里抠出"每个格子：(行, 列, 文字)"，不做整段 HTML 匹配 */
function cellsOf(html: string): Array<{ row: number; col: number; text: string }> {
  const at = [...html.matchAll(/class="[^"]*cell-wrap[^"]*"/g)].map((m) => m.index ?? 0)
  return at.map((start, i) => {
    const seg = html.slice(start, at[i + 1] ?? html.length)
    return {
      row: Number(/grid-row:\s*(\d+)/.exec(seg)?.[1]),
      col: Number(/grid-column:\s*(\d+)/.exec(seg)?.[1]),
      text: /class="cell-text"[^>]*>([^<]*)</.exec(seg)?.[1] ?? '',
    }
  })
}

describe('哈希表板子的渲染：行列位置真的写进了 DOM', () => {
  it('桶号被钉在第 1 行各自那一列，15 / 8 挂在桶 1 下面第 2、3 行', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const algo = useAlgorithmStore(pinia)
    algo.selectAlgorithm('search-hash')
    algo.goToStep(algo.totalSteps - 1)

    const app = createSSRApp(ScenePanel)
    app.use(pinia)
    const cells = cellsOf(await renderToString(app))

    expect(cells.length, '渲染出来的格子比数据里的还少').toBeGreaterThanOrEqual(M)
    const heads = cells.filter((c) => c.row === 1)
    expect(heads.map((c) => c.col), '桶号没有排在第一行').toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(heads.map((c) => c.text)).toEqual(['0', '1', '2', '3', '4', '5', '6'])

    // 15 % 7 = 1、8 % 7 = 1：同在桶 1（第 2 列），先插 15、后插 8 -> 第 2、第 3 行
    expect(cells.filter((c) => c.text === '15')).toEqual([{ row: 2, col: 2, text: '15' }])
    expect(cells.filter((c) => c.text === '8')).toEqual([{ row: 3, col: 2, text: '8' }])
  })
})

describe('矩阵 / 稀疏矩阵 / DP 表的折行排布没被带坏', () => {
  it('它们的格子一个都没写上 row / col（写了就会打乱折行）', () => {
    for (const id of [
      'sparse-triple',
      'sparse-cross',
      'dp-knapsack',
      'dp-lcs',
      'dp-edit-distance',
    ]) {
      const spec = getAlgorithm(id)
      const steps = buildSteps(spec, spec.defaultData(), {})
      let checked = 0
      for (const board of steps.flatMap((s) => s.boards ?? [])) {
        for (const it of board.items) {
          expect(it.row, `${id} 的格子被写上了行号：折行排布会被打乱`).toBeUndefined()
          expect(it.col, `${id} 的格子被写上了列号：折行排布会被打乱`).toBeUndefined()
          checked++
        }
      }
      expect(checked, `${id} 一格都没查到，这条守卫等于没跑`).toBeGreaterThan(0)
    }
  })
})
