import type { AlgorithmSpec, AlgoRunner, BoardView, CellItem, CellTone } from '@/core/types'

/**
 * 动态规划：0-1 背包 / 最长公共子序列 / 编辑距离。
 *
 * **不需要新渲染器**：DP 就是在填一张二维表，所以直接复用
 * `renderer: 'scene'` + `boards` 里的 `layout: 'grid'`，
 * 和 `matrix.ts` 画矩阵是同一套路。约定：
 *   - **第 0 行和第 0 列是表头**（`tone: 'dim'`；当前正在算的那一行 / 一列的表头画成 `hot`）；
 *   - 值格子从 (1,1) 开始，dp[i][j] 落在格子序号 `(i+1) * (值列数 + 1) + (j+1)`；
 *   - 每个值格子的 `sub` 就是它的 `i,j`，方便和代码里的公式对照；
 *   - 配色：正在算的格子 `hot`、这一步用到的来源格子 `mark`、
 *     已经算好的 `done`、还没轮到的 `dim`；
 *   - 指向来源格子的 `pointers`，名字就是"这一步在做哪种操作"
 *     （不放 / 放，上 / 左，删 / 插 / 换），所以公式里那两个来源在表上一眼可见；
 *   - 另外挂一块小的 `row` 板子放"物品清单 / 公共子序列 / 编辑操作"。
 *
 * 每帧的 `array` 是**当前 dp 表按行优先展平**的数字序列（空格子算 0）——`scene` 渲染器
 * 不画它，但快照必须是独立的一份，所以每帧都用新数组。
 *
 * 规模声明的依据（见 types.ts 里 `sizes` 的注释）：
 *   - 背包：输入是"每两个数一件物品（重量、价值）"，所以 6 / 8 / 10 个数 = 3 / 4 / 5 件物品，
 *     容量固定 7 —— 物品再多，表格就会挤到看不清，所以不让用户选到；
 *   - 两个串：前半段是 s、后半段是 t，8 / 10 个数 = 两个串各 4 个或各 5 个字符。
 *     再长表格同样会挤，所以固定这两个规模（字符一律映射成字母 A~Z / a~z）。
 */

/* ------------------------- 输入整形 ------------------------- */

/** 取模映射到 1..m（0、负数都安全，而且映射两次结果不变） */
function mod1(x: number, m: number): number {
  const v = Number.isFinite(x) ? Math.floor(x) : 1
  return (((v - 1) % m) + m) % m + 1
}

/** 数字 -> 字符：本来就是字母就原样留着，其余按 26 循环映射成大写字母 */
function letterOf(x: number): number {
  const v = Number.isFinite(x) ? Math.floor(x) : 65
  if ((v >= 65 && v <= 90) || (v >= 97 && v <= 122)) return v
  return 65 + (((v % 26) + 26) % 26)
}

/** 背包容量：列数 = 容量 + 1 */
const KNAP_CAP = 7
/** 最多 5 件物品：再多表格就挤得看不清了 */
const KNAP_MAX_ITEMS = 5

/** 0-1 背包的输入：**每两个数一件物品**（第一个是重量 w，第二个是价值 v） */
function normalizeKnapsack(raw: number[]): number[] {
  const items = Math.min(KNAP_MAX_ITEMS, Math.max(1, Math.floor(raw.length / 2)))
  const out: number[] = []
  for (let k = 0; k < items; k++) {
    out.push(mod1(raw[2 * k] ?? 1, KNAP_CAP), mod1(raw[2 * k + 1] ?? 1, 9))
  }
  return out
}

/** 一件物品 */
interface KnapItem {
  w: number
  v: number
}

/** 把规整过的数据拆成物品清单 */
function knapItems(data: number[]): KnapItem[] {
  const d = normalizeKnapsack(data)
  const out: KnapItem[] = []
  for (let k = 0; k + 1 < d.length; k += 2) out.push({ w: d[k]!, v: d[k + 1]! })
  return out
}

/** 两个串一共最多 10 个字符（各 5 个）：再长表格就挤得看不清了 */
const STR_TOTAL_MAX = 10

/** 两个串的输入：前半段是 s，后半段是 t，字符用 charCode 表示 */
function normalizeStrings(raw: number[]): number[] {
  const len = Math.min(STR_TOTAL_MAX, Math.max(2, raw.length))
  return Array.from({ length: len }, (_, k) => letterOf(raw[k] ?? 65))
}

/** 拆成两个字符数组：s 拿前半段，t 拿后半段 */
function twoStrings(data: number[]): { s: string[]; t: string[] } {
  const d = normalizeStrings(data)
  const n = Math.floor(d.length / 2)
  const ch = (c: number) => String.fromCharCode(c)
  return { s: d.slice(0, n).map(ch), t: d.slice(n).map(ch) }
}

/* ------------------------- 表格板 ------------------------- */

/** dp[i][j] 在板子里的格子序号（行优先；多了一行一列的表头，所以要各加一格） */
function dpCellIndex(cols: number, i: number, j: number): number {
  return (i + 1) * (cols + 1) + (j + 1)
}

/** 一块 DP 表格板的公共参数 */
interface TableOpts {
  /** 正在算的格子，形如 '3,5' */
  hot?: string[]
  /** 这一步用到的来源格子（回推走过的路也塞这里） */
  mark?: string[]
  pointers?: Record<string, number>
  note?: string
  /** 当前正在算的行 / 列（它的表头画成 hot，-1 = 不画） */
  row?: number
  col?: number
}

/**
 * 一块 DP 表格板：第一行 / 第一列是表头，值格子从 (1,1) 开始。
 * 配色优先级：hot（正在算）> mark（来源 / 回推路径）> dim（还没算）> done（算好了）。
 */
function dpTable(opts: {
  title: string
  note?: string
  corner: CellItem
  rowHeads: CellItem[]
  colHeads: CellItem[]
  values: Array<Array<number | null>>
  hot?: string[]
  mark?: string[]
  pointers?: Record<string, number>
}): BoardView {
  const cols = opts.colHeads.length
  const hot = new Set(opts.hot ?? [])
  const mark = new Set(opts.mark ?? [])
  const items: CellItem[] = [{ ...opts.corner, tone: opts.corner.tone ?? 'dim' }]
  for (const h of opts.colHeads) items.push({ ...h, tone: h.tone ?? 'dim' })
  opts.values.forEach((row, i) => {
    const head = opts.rowHeads[i] ?? { text: '' }
    items.push({ ...head, tone: head.tone ?? 'dim' })
    for (let j = 0; j < cols; j++) {
      const v = row[j] ?? null
      const key = `${i},${j}`
      const tone: CellTone = hot.has(key)
        ? 'hot'
        : mark.has(key)
          ? 'mark'
          : v === null
            ? 'dim'
            : 'done'
      items.push({ text: v === null ? '' : String(v), sub: `${i},${j}`, tone })
    }
  })
  return {
    title: opts.title,
    layout: 'grid',
    cols: cols + 1,
    items,
    pointers: opts.pointers,
    note: opts.note,
  }
}

/** 背包的 dp 表：行表头是物品（重量 / 价值），列表头是容量 */
function knapTable(
  dp: Array<Array<number | null>>,
  items: KnapItem[],
  opts: TableOpts = {},
): BoardView {
  const n = items.length
  const cols = KNAP_CAP + 1
  const row = opts.row ?? -1
  return dpTable({
    title: `dp 表：${n + 1} 行 × ${cols} 列（行 = 只看前 i 件物品，列 = 容量 j）`,
    note: opts.note ?? '第 0 行 = 一件物品都不选，第 0 列 = 容量为 0：这两条边都是 0',
    corner: { text: 'dp', sub: 'i,j' },
    rowHeads: Array.from({ length: n + 1 }, (_, i) =>
      i === 0
        ? { text: '∅', sub: '不选', tone: row === 0 ? ('hot' as CellTone) : undefined }
        : {
            text: `物${i}`,
            sub: `w${items[i - 1]!.w} v${items[i - 1]!.v}`,
            tone: row === i ? ('hot' as CellTone) : undefined,
          },
    ),
    colHeads: Array.from({ length: cols }, (_, j) => ({ text: String(j) })),
    values: dp,
    hot: opts.hot,
    mark: opts.mark,
    pointers: opts.pointers,
  })
}

/** 物品清单板：正在考虑的物品画 hot，回推认定选中的画绿 */
function knapList(items: KnapItem[], chosen: number[], curItem: number, note?: string): BoardView {
  return {
    title: `物品清单（重量 w, 价值 v）　背包容量 C = ${KNAP_CAP}`,
    layout: 'row',
    items: items.map((it, k) => {
      const no = k + 1
      const tone: CellTone = chosen.includes(no) ? 'done' : curItem === no ? 'hot' : 'base'
      return { text: `${it.w},${it.v}`, sub: `物${no}`, tone }
    }),
    pointers: curItem > 0 ? { 当前: curItem - 1 } : undefined,
    note: note ?? '绿色 = 回推认定装进背包的物品',
  }
}

/** 两个串的 dp 表：行表头是 s 的字符，列表头是 t 的字符 */
function stringTable(
  title: string,
  defaultNote: string,
  s: string[],
  t: string[],
  dp: Array<Array<number | null>>,
  opts: TableOpts = {},
): BoardView {
  const row = opts.row ?? -1
  const col = opts.col ?? -1
  return dpTable({
    title,
    note: opts.note ?? defaultNote,
    corner: { text: 'dp', sub: 'i,j' },
    rowHeads: Array.from({ length: s.length + 1 }, (_, i) =>
      i === 0
        ? { text: '∅', sub: '空串', tone: row === 0 ? ('hot' as CellTone) : undefined }
        : { text: s[i - 1]!, sub: `s${i}`, tone: row === i ? ('hot' as CellTone) : undefined },
    ),
    colHeads: Array.from({ length: t.length + 1 }, (_, j) =>
      j === 0
        ? { text: '∅', sub: '空串', tone: col === 0 ? ('hot' as CellTone) : undefined }
        : { text: t[j - 1]!, sub: `t${j}`, tone: col === j ? ('hot' as CellTone) : undefined },
    ),
    values: dp,
    hot: opts.hot,
    mark: opts.mark,
    pointers: opts.pointers,
  })
}

/** LCS 的长度表 */
function lcsTable(
  s: string[],
  t: string[],
  dp: Array<Array<number | null>>,
  opts: TableOpts = {},
): BoardView {
  return stringTable(
    `LCS 长度表：${s.length + 1} 行 × ${t.length + 1} 列（行 = s 的前 i 个字符，列 = t 的前 j 个字符）`,
    `表头就是两个串：上边一行 t = ${t.join('')}，左边一列 s = ${s.join('')}`,
    s,
    t,
    dp,
    opts,
  )
}

/** 公共子序列板：收集顺序是从后往前，展示时反过来（左边是子序列的开头） */
function seqList(picked: string[], note?: string): BoardView {
  return {
    title: `公共子序列（长 ${picked.length}）`,
    layout: 'row',
    items: picked.length
      ? [...picked]
          .reverse()
          .map((c, k) => ({ text: c, sub: String(k + 1), tone: (k === 0 ? 'hot' : 'done') as CellTone }))
      : [{ text: '空', sub: '还没收', tone: 'dim' as CellTone }],
    note: note ?? '回推时"两个字符相等"的那些格子，它们的字符就是公共子序列',
  }
}

/** 编辑距离表 */
function editTable(
  s: string[],
  t: string[],
  dp: Array<Array<number | null>>,
  opts: TableOpts = {},
): BoardView {
  return stringTable(
    `编辑距离表：${s.length + 1} 行 × ${t.length + 1} 列（dp[i][j] = s 前 i 个字符改成 t 前 j 个字符的最少步数）`,
    `表头就是两个串：上边一行 t = ${t.join('')}，左边一列 s = ${s.join('')}；第 0 列是 0,1,2…（只能删），第 0 行是 0,1,2…（只能插）`,
    s,
    t,
    dp,
    opts,
  )
}

/** 一步编辑操作 */
interface EditOp {
  /** 删除 / 插入 / 替换 */
  text: string
  /** 小字：这一步动的是哪个字符 */
  sub: string
}

/** 编辑操作板：收集顺序是从后往前，展示时反过来（从左到右就是照着改的顺序） */
function opList(ops: EditOp[], note?: string): BoardView {
  return {
    title: `编辑操作（共 ${ops.length} 步）`,
    layout: 'row',
    items: ops.length
      ? [...ops]
          .reverse()
          .map((op, k) => ({ text: op.text, sub: op.sub, tone: (k === 0 ? 'hot' : 'done') as CellTone }))
      : [{ text: '空', sub: '还没定', tone: 'dim' as CellTone }],
    note: note ?? '回推每退回一格就是一步操作；从左到右就是照着改的顺序',
  }
}

/** 按"性价比 v/w"贪心能拿到的价值（最后一步拿来和最优解对比：0-1 背包贪心不一定最优） */
function greedyValue(items: KnapItem[], cap: number): number {
  const order = [...items].sort((a, b) => b.v / b.w - a.v / a.w)
  let left = cap
  let sum = 0
  for (const it of order) {
    if (it.w <= left) {
      left -= it.w
      sum += it.v
    }
  }
  return sum
}

/* ------------------------- 0-1 背包 ------------------------- */

const CODE_KNAPSACK = [
  '// 0-1 背包：n 件物品各只有一件，背包容量 C，求能装下的最大总价值',
  'int dp[N + 1][C + 1];                          // dp[i][j]：只看前 i 件、容量 j 时的最大价值',
  'for (int j = 0; j <= C; j++) dp[0][j] = 0;     // 边界：一件都不选，价值只能是 0',
  'for (int i = 0; i <= n; i++) dp[i][0] = 0;     // 边界：容量是 0，什么都装不下',
  'for (int i = 1; i <= n; i++) {                 // 一件一件地加进来',
  '  for (int j = 1; j <= C; j++) {               // 容量从小到大都算一遍',
  '    if (j < w[i]) dp[i][j] = dp[i - 1][j];     // 装不下：只能不选第 i 件',
  '    int no  = dp[i - 1][j];                    // 来源一：不选第 i 件（上一行同一列）',
  '    int yes = dp[i - 1][j - w[i]] + v[i];      // 来源二：选第 i 件（上一行"腾出 w[i] 容量"那格）',
  '    dp[i][j] = max(no, yes);                   // 两个来源取大的，填进这一格',
  '  }',
  '}',
  '// 答案是 dp[n][C]；倒着回推：dp[i][j] != dp[i-1][j] 就说明第 i 件被选了',
]

function* runKnapsack(data: number[]): AlgoRunner {
  const items = knapItems(data)
  const n = items.length
  const C = KNAP_CAP
  const cols = C + 1
  /** dp[i][j]；null = 还没填（第 0 行 / 第 0 列是边界，一开始就是 0） */
  const dp: Array<Array<number | null>> = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 || j === 0 ? 0 : null)),
  )
  /** 回推走过的格子（画成 mark） */
  const trace: string[] = []
  /** 回推认定装进背包的物品号（1-based） */
  const chosen: number[] = []
  /** 当前正在考虑的物品号（0 = 没有；表格里那一行的表头会跟着高亮） */
  let curItem = 0

  /** 当前 dp 表展平成数字序列（空格子算 0），每帧都新建一份 */
  const flat = (): number[] => dp.map((row) => row.map((v) => v ?? 0)).flat()
  const table = (opts: TableOpts = {}): BoardView =>
    knapTable(dp, items, { row: opts.row ?? curItem, ...opts, mark: [...trace, ...(opts.mark ?? [])] })

  yield {
    line: 3,
    action: 'init',
    array: flat(),
    boards: [
      table({
        hot: Array.from({ length: cols }, (_, j) => `0,${j}`),
        row: 0,
        note: '边界：一件物品都不选，容量再大价值也是 0',
      }),
      knapList(items, chosen, 0, '先填边界，再一件一件地加物品'),
    ],
    comment: `0-1 背包：${n} 件物品、背包容量 C = ${C}。dp[i][j] 表示"只看前 i 件、容量为 j"能拿到的最大价值。第 0 行是"一件都不选"，所以整行都是 0`,
    vars: { n, C },
  }

  yield {
    line: 4,
    action: 'mark',
    array: flat(),
    boards: [
      table({
        hot: Array.from({ length: n + 1 }, (_, i) => `${i},0`),
        note: '边界：容量为 0，一件也装不下，所以整列都是 0',
      }),
      knapList(items, chosen, 0),
    ],
    comment: '第 0 列是"容量为 0"：一件也装不下，dp[i][0] = 0。两条边都就位了，接着从 (1,1) 开始一格一格地填，每格都拿上一行的两个格子来比',
    vars: { n, C },
  }

  for (let i = 1; i <= n; i++) {
    const { w, v } = items[i - 1]!
    curItem = i
    for (let j = 1; j <= C; j++) {
      const no = dp[i - 1]![j]!
      const cur = `${i},${j}`
      if (j < w) {
        // 装不下：只能照抄上一行
        dp[i]![j] = no
        yield {
          line: 7,
          action: 'set',
          array: flat(),
          boards: [
            table({
              hot: [cur],
              mark: [`${i - 1},${j}`],
              pointers: { 不放: dpCellIndex(cols, i - 1, j) },
              row: i,
              note: `第 ${i} 件重 ${w}，容量 ${j} 装不下，只能看"不放"这个来源`,
            }),
            knapList(items, chosen, i),
          ],
          comment: `容量 j = ${j} 装不下第 ${i} 件（它重 ${w} > ${j}）→ 只能照抄上一行：dp[${i}][${j}] = dp[${i - 1}][${j}] = ${no}`,
          vars: { i, j, w, v },
        }
        continue
      }
      const back = dp[i - 1]![j - w]!
      const yes = back + v
      yield {
        line: 8,
        action: 'compare',
        array: flat(),
        boards: [
          table({
            hot: [cur],
            mark: [`${i - 1},${j}`, `${i - 1},${j - w}`],
            pointers: { 不放: dpCellIndex(cols, i - 1, j), 放: dpCellIndex(cols, i - 1, j - w) },
            row: i,
            note: `第 ${i} 件重 ${w}、值 ${v}：先看两个来源的格子`,
          }),
          knapList(items, chosen, i, `容量 ${j} 装得下第 ${i} 件，所以两个来源都要算`),
        ],
        comment: `算 dp[${i}][${j}] 的两个来源：不放第 ${i} 件 → dp[${i - 1}][${j}] = ${no}；放第 ${i} 件 → 先腾出 ${w} 的容量，dp[${i - 1}][${j - w}] + ${v} = ${back} + ${v} = ${yes}`,
        vars: { i, j, w, v, 不放: no, 放: yes },
      }
      const best = Math.max(no, yes)
      dp[i]![j] = best
      yield {
        line: 10,
        action: 'set',
        array: flat(),
        boards: [
          table({
            hot: [cur],
            pointers: { [yes > no ? '放' : '不放']: dpCellIndex(cols, i - 1, yes > no ? j - w : j) },
            row: i,
            note: `两个来源取大的：max(${no}, ${yes}) = ${best}`,
          }),
          knapList(items, chosen, i),
        ],
        comment:
          yes > no
            ? `dp[${i}][${j}] = max(${no}, ${yes}) = ${yes}：把第 ${i} 件装进去更划算，比不装多 ${yes - no}`
            : `dp[${i}][${j}] = max(${no}, ${yes}) = ${no}：不装第 ${i} 件更好${yes === no ? `（装与不装一样大，都按"不装"处理）` : ''}`,
        vars: { i, j, 最大价值: best },
      }
    }
  }

  const best = dp[n]![C]!
  curItem = 0
  trace.push(`${n},${C}`)
  yield {
    line: 13,
    action: 'mark',
    array: flat(),
    boards: [
      table({ hot: [`${n},${C}`], note: `答案格：dp[${n}][${C}] = ${best}` }),
      knapList(items, chosen, 0, '下面从右下角往回推，看具体选了哪几件'),
    ],
    comment: `表填完了：dp[${n}][${C}] = ${best}，容量 ${C} 时最多能装下价值 ${best} 的东西。接下来从这一格倒着往回推，把具体选了哪些物品找出来`,
    vars: { n, C, 最大价值: best },
  }

  let i = n
  let j = C
  while (i > 0) {
    const { w, v } = items[i - 1]!
    curItem = i
    const here = dp[i]![j]!
    const up = dp[i - 1]![j]!
    if (here === up) {
      yield {
        line: 13,
        action: 'mark',
        array: flat(),
        boards: [
          table({
            hot: [`${i},${j}`],
            pointers: { 上: dpCellIndex(cols, i - 1, j) },
            row: i,
            note: `dp[${i}][${j}] = dp[${i - 1}][${j}] → 第 ${i} 件没装`,
          }),
          knapList(items, chosen, i, `第 ${i} 件没被选中`),
        ],
        comment: `回推：dp[${i}][${j}] = ${here} 和正上方的 dp[${i - 1}][${j}] = ${up} 一样 → 这一格不是"装了第 ${i} 件"换来的，第 ${i} 件（重 ${w}、值 ${v}）没装进去，往上走一格`,
        vars: { i, j, 当前值: here },
      }
      i -= 1
      trace.push(`${i},${j}`)
    } else {
      yield {
        line: 13,
        action: 'mark',
        array: flat(),
        boards: [
          table({
            hot: [`${i},${j}`],
            mark: [`${i - 1},${j - w}`],
            pointers: { 跳到: dpCellIndex(cols, i - 1, j - w) },
            row: i,
            note: `dp[${i}][${j}] > dp[${i - 1}][${j}] → 第 ${i} 件装进去了`,
          }),
          knapList(items, chosen, i, `第 ${i} 件被选中`),
        ],
        comment: `回推：dp[${i}][${j}] = ${here} 比正上方的 dp[${i - 1}][${j}] = ${up} 大 ${here - up} → 第 ${i} 件（重 ${w}、值 ${v}）被装进去了；它占掉 ${w} 的容量，所以 j 从 ${j} 跳到 ${j - w}，再往左上走`,
        vars: { i, j, 当前值: here },
      }
      chosen.push(i)
      j -= w
      i -= 1
      trace.push(`${i},${j}`)
    }
  }

  const picked = [...chosen].sort((a, b) => a - b)
  const weight = picked.reduce((sum, no) => sum + items[no - 1]!.w, 0)
  const names = picked.length
    ? picked.map((no) => `第 ${no} 件(w${items[no - 1]!.w},v${items[no - 1]!.v})`).join(' + ')
    : '一件都没装'
  const greedy = greedyValue(items, C)
  yield {
    line: 13,
    action: 'done',
    array: flat(),
    boards: [
      table({
        hot: [`${n},${C}`],
        note: '红色格子就是回推走过的路，它记下了每一次"装不装第 i 件"的决定',
      }),
      knapList(items, picked, 0, `装进背包的：${picked.length ? picked.map((no) => `第 ${no} 件`).join('、') : '没有'}`),
    ],
    comment: `最大价值 = ${best}：选 ${names}，总重量 ${weight} <= ${C}。${
      greedy < best
        ? `注意：按"性价比 v/w"贪心只能拿到 ${greedy}，而 DP 拿到 ${best} —— 0-1 背包里物品不能切开，贪心不一定最优`
        : `这个例子里按性价比贪心也能拿到 ${greedy}，和最优解一样`
    }`,
    vars: { n, C, 最大价值: best, 总重量: weight },
  }
}

function knapsackInitScene(data: number[]): { boards: BoardView[] } {
  const items = knapItems(data)
  const n = items.length
  const cols = KNAP_CAP + 1
  const dp: Array<Array<number | null>> = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 || j === 0 ? 0 : null)),
  )
  return {
    boards: [
      knapTable(dp, items, { note: '灰暗的格子 = 还没算，第一行和第一列（边界 0）已经就位' }),
      knapList(items, [], 0, '每两个数一件物品：第一个是重量，第二个是价值'),
    ],
  }
}

/* ------------------------- 最长公共子序列 ------------------------- */

const CODE_LCS = [
  '// 最长公共子序列（LCS）：两个串里都能按原顺序找出来的最长子序列',
  'int dp[N + 1][M + 1];                          // dp[i][j]：s 前 i 个字符与 t 前 j 个字符的 LCS 长度',
  'for (int i = 0; i <= n; i++) dp[i][0] = 0;     // 边界：t 是空串，公共长度只能是 0',
  'for (int j = 0; j <= m; j++) dp[0][j] = 0;     // 边界：s 是空串，同理',
  'for (int i = 1; i <= n; i++) {',
  '  for (int j = 1; j <= m; j++) {',
  '    if (s[i] == t[j])                              // 两个字符相等：这个字符能接上',
  '      dp[i][j] = dp[i - 1][j - 1] + 1;             // 来源：左上角那个子序列后面再接一个字符',
  '    else                                           // 不相等：两边各让一步，取大的',
  '      dp[i][j] = max(dp[i - 1][j], dp[i][j - 1]);  // 上 = 不要 s[i]，左 = 不要 t[j]',
  '  }',
  '}',
  '// 答案 dp[n][m]；回推时字符相等就斜着走（收进子序列），不等就朝大的那边走',
]

function* runLcs(data: number[]): AlgoRunner {
  const { s, t } = twoStrings(data)
  const n = s.length
  const m = t.length
  const dp: Array<Array<number | null>> = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 || j === 0 ? 0 : null)),
  )
  /** 回推收到的公共字符（收集顺序是从后往前） */
  const picked: string[] = []
  /** 回推走过的格子 */
  const trace: string[] = []
  let curRow = 0
  let curCol = 0

  const flat = (): number[] => dp.map((row) => row.map((v) => v ?? 0)).flat()
  const table = (opts: TableOpts = {}): BoardView =>
    lcsTable(s, t, dp, {
      row: opts.row ?? curRow,
      col: opts.col ?? curCol,
      ...opts,
      mark: [...trace, ...(opts.mark ?? [])],
    })

  yield {
    line: 3,
    action: 'init',
    array: flat(),
    boards: [
      table({
        hot: Array.from({ length: m + 1 }, (_, j) => `0,${j}`),
        row: 0,
        note: '边界：t 是空串，公共子序列长度只能是 0',
      }),
      seqList(picked, '先把两条边填 0，再一格一格地填'),
    ],
    comment: `最长公共子序列：s = ${s.join('')}（${n} 个字符）、t = ${t.join('')}（${m} 个字符）。dp[i][j] 是"s 的前 i 个字符"和"t 的前 j 个字符"的 LCS 长度，表头一行一列就是这两个串本身`,
    vars: { n, m },
  }

  yield {
    line: 4,
    action: 'mark',
    array: flat(),
    boards: [
      table({
        hot: Array.from({ length: n + 1 }, (_, i) => `${i},0`),
        note: '边界：s 是空串，公共子序列长度只能是 0',
      }),
      seqList(picked),
    ],
    comment: '第 0 列是"s 取前 0 个字符"（空串）：和谁比都是 0。两条边就位了，接下来对比 s 的第 i 个字符和 t 的第 j 个字符，分"相等"和"不相等"两种情形填表',
    vars: { n, m },
  }

  for (let i = 1; i <= n; i++) {
    curRow = i
    for (let j = 1; j <= m; j++) {
      curCol = j
      const cur = `${i},${j}`
      const a = s[i - 1]!
      const b = t[j - 1]!
      if (a === b) {
        const diag = dp[i - 1]![j - 1]!
        yield {
          line: 7,
          action: 'compare',
          array: flat(),
          boards: [
            table({
              hot: [cur],
              mark: [`${i - 1},${j - 1}`],
              pointers: { 斜: dpCellIndex(m, i - 1, j - 1) },
              note: `s 的第 ${i} 个字符 '${a}' 和 t 的第 ${j} 个字符 '${b}' 相等`,
            }),
            seqList(picked),
          ],
          comment: `比较 s[${i}] = '${a}' 和 t[${j}] = '${b}'：相等 → 这个字符可以接在左上角那格的公共子序列后面，所以只看 dp[${i - 1}][${j - 1}] = ${diag} 这一格`,
          vars: { i, j, 左上: diag },
        }
        dp[i]![j] = diag + 1
        yield {
          line: 8,
          action: 'set',
          array: flat(),
          boards: [
            table({
              hot: [cur],
              note: `s[${i}] == t[${j}] → dp[${i}][${j}] = dp[${i - 1}][${j - 1}] + 1`,
            }),
            seqList(picked),
          ],
          comment: `dp[${i}][${j}] = dp[${i - 1}][${j - 1}] + 1 = ${diag} + 1 = ${diag + 1}：把 '${a}' 接到前面的公共子序列后面，长度加了 1`,
          vars: { i, j },
        }
      } else {
        const up = dp[i - 1]![j]!
        const left = dp[i]![j - 1]!
        const best = Math.max(up, left)
        yield {
          line: 9,
          action: 'compare',
          array: flat(),
          boards: [
            table({
              hot: [cur],
              mark: [`${i - 1},${j}`, `${i},${j - 1}`],
              pointers: { 上: dpCellIndex(m, i - 1, j), 左: dpCellIndex(m, i, j - 1) },
              note: `'${a}' != '${b}'：两边各让一步，比一比上面和左边`,
            }),
            seqList(picked),
          ],
          comment: `比较 s[${i}] = '${a}' 和 t[${j}] = '${b}'：不相等，谁也不能白拿 → 两种让步：不要 s[${i}] 就看上面 dp[${i - 1}][${j}] = ${up}，不要 t[${j}] 就看左边 dp[${i}][${j - 1}] = ${left}`,
          vars: { i, j, 上: up, 左: left },
        }
        dp[i]![j] = best
        yield {
          line: 10,
          action: 'set',
          array: flat(),
          boards: [
            table({
              hot: [cur],
              pointers: {
                [up >= left ? '上' : '左']: dpCellIndex(m, up >= left ? i - 1 : i, up >= left ? j : j - 1),
              },
              note: `max(${up}, ${left}) = ${best}`,
            }),
            seqList(picked),
          ],
          comment: `dp[${i}][${j}] = max(${up}, ${left}) = ${best}${
            up === left
              ? `（两边一样大，按"先看上边"处理）`
              : up > left
                ? `：上边更大，等于这一格扔掉了 s[${i}]`
                : `：左边更大，等于这一格扔掉了 t[${j}]`
          }`,
          vars: { i, j, 值: best },
        }
      }
    }
  }

  const len = dp[n]![m]!
  curRow = n
  curCol = m
  trace.push(`${n},${m}`)
  yield {
    line: 13,
    action: 'mark',
    array: flat(),
    boards: [
      table({ hot: [`${n},${m}`], note: `答案格 dp[${n}][${m}] = ${len}` }),
      seqList(picked, '长度就是右下角这一格；子序列本身还要回推着找'),
    ],
    comment: `表填完了：dp[${n}][${m}] = ${len}，也就是最长公共子序列的长度是 ${len}。下面从右下角往回推，把这 ${len} 个字符一个个找出来`,
    vars: { n, m, 长度: len },
  }

  let i = n
  let j = m
  while (i > 0 && j > 0) {
    curRow = i
    curCol = j
    const a = s[i - 1]!
    const b = t[j - 1]!
    if (a === b) {
      picked.push(a)
      yield {
        line: 13,
        action: 'mark',
        array: flat(),
        boards: [
          table({
            hot: [`${i},${j}`],
            pointers: { 斜: dpCellIndex(m, i - 1, j - 1) },
            note: `s[${i}] == t[${j}] == '${a}'：这个字符属于公共子序列`,
          }),
          seqList(picked, `刚收进来的是 '${a}'`),
        ],
        comment: `回推：s[${i}] = t[${j}] = '${a}' 相等 → 这一格的值是"斜着从左上角加 1"来的，所以 '${a}' 是公共子序列的一员，收下它，然后 i、j 同时减 1 往左上走`,
        vars: { i, j },
      }
      i -= 1
      j -= 1
      trace.push(`${i},${j}`)
    } else {
      const up = dp[i - 1]![j]!
      const left = dp[i]![j - 1]!
      if (up >= left) {
        yield {
          line: 13,
          action: 'mark',
          array: flat(),
          boards: [
            table({
              hot: [`${i},${j}`],
              pointers: { 上: dpCellIndex(m, i - 1, j) },
              note: `'${a}' != '${b}'，上面 ${up} >= 左边 ${left} → 往上走`,
            }),
            seqList(picked),
          ],
          comment: `回推：s[${i}] = '${a}' 和 t[${j}] = '${b}' 不相等，上面 dp[${i - 1}][${j}] = ${up} 不小于左边 dp[${i}][${j - 1}] = ${left} → 这一格的值来自上边，说明 s[${i}] = '${a}' 不在公共子序列里，往上走一格`,
          vars: { i, j },
        }
        i -= 1
      } else {
        yield {
          line: 13,
          action: 'mark',
          array: flat(),
          boards: [
            table({
              hot: [`${i},${j}`],
              pointers: { 左: dpCellIndex(m, i, j - 1) },
              note: `'${a}' != '${b}'，左边 ${left} 更大 → 往左走`,
            }),
            seqList(picked),
          ],
          comment: `回推：s[${i}] = '${a}' 和 t[${j}] = '${b}' 不相等，左边 dp[${i}][${j - 1}] = ${left} 比上面 ${up} 大 → 这一格的值来自左边，说明 t[${j}] = '${b}' 不在公共子序列里，往左走一格`,
          vars: { i, j },
        }
        j -= 1
      }
      trace.push(`${i},${j}`)
    }
  }

  const seq = [...picked].reverse().join('')
  yield {
    line: 13,
    action: 'done',
    array: flat(),
    boards: [
      table({
        hot: [`${n},${m}`],
        note: '红色格子就是回推路线：斜着走的那几格收下了字符，其余只是"绕开"',
      }),
      seqList(picked, `这就是最长公共子序列："${seq}"`),
    ],
    comment: `最长公共子序列是 "${seq}"，长度 ${len}。回推的规律：字符相等就斜着走、顺手把这个字符收进答案；不相等就朝大的那边走，一个字符都不收`,
    vars: { n, m, 长度: len },
  }
}

function lcsInitScene(data: number[]): { boards: BoardView[] } {
  const { s, t } = twoStrings(data)
  const dp: Array<Array<number | null>> = Array.from({ length: s.length + 1 }, (_, i) =>
    Array.from({ length: t.length + 1 }, (_, j) => (i === 0 || j === 0 ? 0 : null)),
  )
  return {
    boards: [
      lcsTable(s, t, dp, { note: '灰暗的格子 = 还没算；表头一行一列就是 t 和 s 这两个串' }),
      seqList([], '每收到一个字符，它就会出现在这里'),
    ],
  }
}

/* ------------------------- 编辑距离 ------------------------- */

const CODE_EDIT = [
  '// 编辑距离：把 s 改成 t 最少要几步（插入 / 删除 / 替换各算一步）',
  'int dp[N + 1][M + 1];                          // dp[i][j]：s 前 i 个字符改成 t 前 j 个字符的最少步数',
  'for (int i = 0; i <= n; i++) dp[i][0] = i;     // 边界：t 是空串，只能把 s 的 i 个字符全删掉',
  'for (int j = 0; j <= m; j++) dp[0][j] = j;     // 边界：s 是空串，只能一个字符一个字符地插入',
  'for (int i = 1; i <= n; i++) {',
  '  for (int j = 1; j <= m; j++) {',
  '    if (s[i] == t[j]) dp[i][j] = dp[i - 1][j - 1];     // 相同：不用动，直接看左上角',
  '    else dp[i][j] = 1 + min(dp[i - 1][j],             // 删除：把 s[i] 删掉',
  '                            dp[i][j - 1],             // 插入：补一个 t[j]',
  '                            dp[i - 1][j - 1]);        // 替换：把 s[i] 改成 t[j]',
  '  }',
  '}',
  '// 答案 dp[n][m]；回推时哪个来源 = 当前值 - 1，这一步就是哪种操作',
]

function* runEditDistance(data: number[]): AlgoRunner {
  const { s, t } = twoStrings(data)
  const n = s.length
  const m = t.length
  /** dp[i][j]；第 0 列是 0..n（只能删），第 0 行是 0..m（只能插） */
  const dp: Array<Array<number | null>> = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (j === 0 ? i : i === 0 ? j : null)),
  )
  /** 回推得到的操作（收集顺序是从后往前） */
  const ops: EditOp[] = []
  const trace: string[] = []
  let curRow = 0
  let curCol = 0

  const flat = (): number[] => dp.map((row) => row.map((v) => v ?? 0)).flat()
  const table = (opts: TableOpts = {}): BoardView =>
    editTable(s, t, dp, {
      row: opts.row ?? curRow,
      col: opts.col ?? curCol,
      ...opts,
      mark: [...trace, ...(opts.mark ?? [])],
    })

  yield {
    line: 3,
    action: 'init',
    array: flat(),
    boards: [
      table({
        hot: Array.from({ length: n + 1 }, (_, i) => `${i},0`),
        note: '边界：t 是空串时，只能把 s 的字符一个个删掉，所以第 0 列是 0,1,2,…',
      }),
      opList(ops, '先把两条边填好，再一格一格地填'),
    ],
    comment: `编辑距离：把 s = ${s.join('')} 改成 t = ${t.join('')}，插入 / 删除 / 替换各算一步。dp[i][j] 就是"s 的前 i 个字符"改成"t 的前 j 个字符"的最少步数。先看边界：t 是空串时只能删，所以 dp[i][0] = i`,
    vars: { n, m },
  }

  yield {
    line: 4,
    action: 'mark',
    array: flat(),
    boards: [
      table({
        hot: Array.from({ length: m + 1 }, (_, j) => `0,${j}`),
        note: '边界：s 是空串时，只能一个字符一个字符地插入，所以第 0 行是 0,1,2,…',
      }),
      opList(ops),
    ],
    comment: 's 是空串时只能插入，所以 dp[0][j] = j。两条边的值不一样：第 0 列是"全删"，第 0 行是"全插"，都不是 0',
    vars: { n, m },
  }

  for (let i = 1; i <= n; i++) {
    curRow = i
    for (let j = 1; j <= m; j++) {
      curCol = j
      const cur = `${i},${j}`
      const a = s[i - 1]!
      const b = t[j - 1]!
      if (a === b) {
        const diag = dp[i - 1]![j - 1]!
        dp[i]![j] = diag
        yield {
          line: 7,
          action: 'set',
          array: flat(),
          boards: [
            table({
              hot: [cur],
              mark: [`${i - 1},${j - 1}`],
              pointers: { 斜: dpCellIndex(m, i - 1, j - 1) },
              note: `s[${i}] == t[${j}] = '${a}'：不用改，直接抄左上角`,
            }),
            opList(ops),
          ],
          comment: `s[${i}] 和 t[${j}] 都是 '${a}'，一样 → 这一个字符不用动：dp[${i}][${j}] = dp[${i - 1}][${j - 1}] = ${diag}，白拿一步`,
          vars: { i, j },
        }
      } else {
        const del = dp[i - 1]![j]!
        const ins = dp[i]![j - 1]!
        const rep = dp[i - 1]![j - 1]!
        const best = 1 + Math.min(del, ins, rep)
        yield {
          line: 8,
          action: 'compare',
          array: flat(),
          boards: [
            table({
              hot: [cur],
              mark: [`${i - 1},${j}`, `${i},${j - 1}`, `${i - 1},${j - 1}`],
              pointers: {
                删: dpCellIndex(m, i - 1, j),
                插: dpCellIndex(m, i, j - 1),
                换: dpCellIndex(m, i - 1, j - 1),
              },
              note: `'${a}' != '${b}'：删 / 插 / 换三种操作各看一个来源格子`,
            }),
            opList(ops),
          ],
          comment: `s[${i}] = '${a}' 和 t[${j}] = '${b}' 不一样，三种操作对应三个来源：删除 s[${i}] → dp[${i - 1}][${j}] = ${del}；插入 t[${j}] → dp[${i}][${j - 1}] = ${ins}；替换 s[${i}] 为 '${b}' → dp[${i - 1}][${j - 1}] = ${rep}`,
          vars: { i, j, 删: del, 插: ins, 换: rep },
        }
        dp[i]![j] = best
        // 最小值来自哪个来源，这一步就是哪种操作（一样小的时候按 删 > 插 > 换 的顺序定）
        const winner = best === del + 1 ? '删' : best === ins + 1 ? '插' : '换'
        const srcRow = winner === '插' ? i : i - 1
        const srcCol = winner === '删' ? j : j - 1
        yield {
          line: 10,
          action: 'set',
          array: flat(),
          boards: [
            table({
              hot: [cur],
              pointers: { [winner]: dpCellIndex(m, srcRow, srcCol) },
              note: `1 + min(${del}, ${ins}, ${rep}) = ${best}`,
            }),
            opList(ops),
          ],
          comment: `dp[${i}][${j}] = 1 + min(${del}, ${ins}, ${rep}) = ${best}：三种操作里最省的是"${
            winner === '删' ? `删除 '${a}'` : winner === '插' ? `插入 '${b}'` : `把 '${a}' 替换成 '${b}'`
          }"`,
          vars: { i, j, 最少步数: best },
        }
      }
    }
  }

  const dist = dp[n]![m]!
  curRow = n
  curCol = m
  trace.push(`${n},${m}`)
  yield {
    line: 13,
    action: 'mark',
    array: flat(),
    boards: [
      table({ hot: [`${n},${m}`], note: `答案格 dp[${n}][${m}] = ${dist}` }),
      opList(ops, '下面从右下角往回推，把这三步到底是哪三步找出来'),
    ],
    comment: `表填完了：dp[${n}][${m}] = ${dist}，也就是把 "${s.join('')}" 改成 "${t.join('')}" 最少要 ${dist} 步。下面从右下角往回推，把每一步操作还原出来`,
    vars: { n, m, 编辑距离: dist },
  }

  let i = n
  let j = m
  while (i > 0 || j > 0) {
    curRow = i
    curCol = j
    const here = dp[i]?.[j] ?? 0
    const a = i > 0 ? s[i - 1]! : ''
    const b = j > 0 ? t[j - 1]! : ''
    const del = i > 0 ? dp[i - 1]![j]! : 0
    const ins = j > 0 ? dp[i]![j - 1]! : 0
    const rep = i > 0 && j > 0 ? dp[i - 1]![j - 1]! : 0

    if (i > 0 && j > 0 && a === b) {
      // 相同字符：斜着走，不算一步操作
      yield {
        line: 13,
        action: 'mark',
        array: flat(),
        boards: [
          table({
            hot: [`${i},${j}`],
            pointers: { 斜: dpCellIndex(m, i - 1, j - 1) },
            note: `s[${i}] == t[${j}] = '${a}'：这一步不用操作`,
          }),
          opList(ops),
        ],
        comment: `回推：s[${i}] = t[${j}] = '${a}' 相同，这里不花步数，斜着往左上走一格`,
        vars: { i, j },
      }
      i -= 1
      j -= 1
    } else if (i > 0 && j > 0 && dp[i]![j] === rep + 1) {
      ops.push({ text: '替换', sub: `${a}→${b}` })
      yield {
        line: 13,
        action: 'mark',
        array: flat(),
        boards: [
          table({
            hot: [`${i},${j}`],
            pointers: { 换: dpCellIndex(m, i - 1, j - 1) },
            note: `当前值 = 左上角 ${rep} + 1 → 这一步是替换`,
          }),
          opList(ops, `把 '${a}' 换成 '${b}'`),
        ],
        comment: `回推：当前 dp[${i}][${j}] = ${here} 正好是"左上角 ${rep} + 1" → 这一步是把 s[${i}] = '${a}' 替换成 t[${j}] = '${b}'，然后往左上走`,
        vars: { i, j },
      }
      i -= 1
      j -= 1
    } else if (j > 0 && dp[i]![j] === ins + 1) {
      ops.push({ text: '插入', sub: `+${b}` })
      yield {
        line: 13,
        action: 'mark',
        array: flat(),
        boards: [
          table({
            hot: [`${i},${j}`],
            pointers: { 插: dpCellIndex(m, i, j - 1) },
            note: `当前值 = 左边 ${ins} + 1 → 这一步是插入`,
          }),
          opList(ops, `插入 '${b}'`),
        ],
        comment: `回推：当前 dp[${i}][${j}] = ${here} 正好是"左边 ${ins} + 1" → 这一步是插入 t[${j}] = '${b}'，往左走一格`,
        vars: { i, j },
      }
      j -= 1
    } else if (i > 0) {
      ops.push({ text: '删除', sub: `-${a}` })
      yield {
        line: 13,
        action: 'mark',
        array: flat(),
        boards: [
          table({
            hot: [`${i},${j}`],
            pointers: { 删: dpCellIndex(m, i - 1, j) },
            note: `当前值 = 上面 ${del} + 1 → 这一步是删除`,
          }),
          opList(ops, `删掉 '${a}'`),
        ],
        comment: `回推：当前 dp[${i}][${j}] = ${here} 正好是"上面 ${del} + 1" → 这一步是把 s[${i}] = '${a}' 删掉，往上走一格`,
        vars: { i, j },
      }
      i -= 1
    } else {
      ops.push({ text: '插入', sub: `+${b}` })
      yield {
        line: 13,
        action: 'mark',
        array: flat(),
        boards: [
          table({ hot: [`${i},${j}`], note: `s 已经用完了，只能插入 '${b}'` }),
          opList(ops, `插入 '${b}'`),
        ],
        comment: `回推：s 的字符已经用完了（i = 0），剩下的 t 只能一个字符一个字符地插入，这一步插入 '${b}'`,
        vars: { i, j },
      }
      j -= 1
    }
    trace.push(`${i},${j}`)
  }

  const order = [...ops].reverse()
  const steps = order.map((op) => `${op.text} ${op.sub}`).join('、')
  yield {
    line: 13,
    action: 'done',
    array: flat(),
    boards: [
      table({
        hot: [`${n},${m}`],
        note: '红色格子是回推路线：斜着走 = 保留或替换，往上 = 删除，往左 = 插入',
      }),
      opList(ops, `共 ${dist} 步：${steps}`),
    ],
    comment: `编辑距离 = ${dist}：把 "${s.join('')}" 改成 "${t.join('')}" 最少 ${dist} 步 —— ${steps}。回推规律：当前值等于哪个来源 + 1，这一步就是那种操作`,
    vars: { n, m, 编辑距离: dist },
  }
}

function editInitScene(data: number[]): { boards: BoardView[] } {
  const { s, t } = twoStrings(data)
  const dp: Array<Array<number | null>> = Array.from({ length: s.length + 1 }, (_, i) =>
    Array.from({ length: t.length + 1 }, (_, j) => (j === 0 ? i : i === 0 ? j : null)),
  )
  return {
    boards: [
      editTable(s, t, dp, {
        note: '灰暗的格子 = 还没算；第 0 列（全删）和第 0 行（全插）已经就位',
      }),
      opList([], '每回推一步，操作就记在这里'),
    ],
  }
}

/* ------------------------- 注册用的算法清单 ------------------------- */

export const dpSpecs: AlgorithmSpec[] = [
  {
    id: 'dp-knapsack',
    name: '0-1 背包',
    category: 'dp',
    group: '背包问题',
    summary: 'dp[i][j] = max(不选第 i 件, 选第 i 件) 两个来源取大，最后回推出选了哪些物品',
    complexity: { time: 'O(n×C)', space: 'O(n×C)' },
    renderer: 'scene',
    codeLines: CODE_KNAPSACK,
    // 每两个数一件物品（重量、价值）：默认 4 件 —— 2/3、3/4、4/5、5/6，容量 7
    defaultData: () => [2, 3, 3, 4, 4, 5, 5, 6],
    // 输入是"每两个数一件物品"，所以规模只给偶数：6 / 8 / 10 个数 = 3 / 4 / 5 件物品。
    // 容量固定 7，物品再多表格就挤得看不清了 —— 不支持的规模不放进下拉框。
    sizes: [6, 8, 10],
    prepareData: normalizeKnapsack,
    initComment: (data) => {
      const items = knapItems(data)
      const list = items.map((it, k) => `物${k + 1}(w${it.w},v${it.v})`).join(' ')
      return `0-1 背包：${items.length} 件物品 ${list}，背包容量 C = ${KNAP_CAP}。dp[i][j] 表示"只看前 i 件、容量为 j"的最大价值；表的最上面一行和最左边一列是边界 0`
    },
    initScene: knapsackInitScene,
    createRunner: runKnapsack,
  },
  {
    id: 'dp-lcs',
    name: '最长公共子序列',
    category: 'dp',
    group: '双串模型',
    summary: '字符相等就斜着接上（左上角 + 1），不相等就取"上"和"左"里大的那个',
    complexity: { time: 'O(n×m)', space: 'O(n×m)' },
    renderer: 'scene',
    codeLines: CODE_LCS,
    // 前半段是 s，后半段是 t：默认 s = ABCBD、t = BDCAB（各 5 个字符，LCS = BCB）
    defaultData: () => [...'ABCBD', ...'BDCAB'].map((c) => c.charCodeAt(0)),
    // 两个串各占一半：8 个数 = 各 4 个字符，10 个数 = 各 5 个字符。再长表格就挤了
    sizes: [8, 10],
    prepareData: normalizeStrings,
    initComment: (data) => {
      const { s, t } = twoStrings(data)
      return `最长公共子序列：s = ${s.join('')}（${s.length} 个字符）、t = ${t.join('')}（${t.length} 个字符）。dp[i][j] 是"s 的前 i 个字符"和"t 的前 j 个字符"的 LCS 长度；表格的第 0 行和第 0 列是空串，值都是 0`
    },
    initScene: lcsInitScene,
    createRunner: runLcs,
  },
  {
    id: 'dp-edit-distance',
    name: '编辑距离',
    category: 'dp',
    group: '双串模型',
    summary: '删除 / 插入 / 替换各对应一个来源格子，取最小的那个再加 1',
    complexity: { time: 'O(n×m)', space: 'O(n×m)' },
    renderer: 'scene',
    codeLines: CODE_EDIT,
    // 前半段是 s，后半段是 t：默认 s = horse、t = roses（各 5 个字符，距离 3）
    defaultData: () => [...'horse', ...'roses'].map((c) => c.charCodeAt(0)),
    // 和 LCS 同一套输入约定：8 个数 = 各 4 个字符，10 个数 = 各 5 个字符
    sizes: [8, 10],
    prepareData: normalizeStrings,
    initComment: (data) => {
      const { s, t } = twoStrings(data)
      return `编辑距离：把 s = ${s.join('')} 改成 t = ${t.join('')}，插入 / 删除 / 替换各算一步。dp[i][j] 是"s 的前 i 个字符"改成"t 的前 j 个字符"的最少步数；第 0 列（把 s 全删掉）是 0,1,2…，第 0 行（往空串里插）也是 0,1,2…`
    },
    initScene: editInitScene,
    createRunner: runEditDistance,
  },
]
