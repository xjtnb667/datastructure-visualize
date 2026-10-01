import type { AlgorithmSpec, AlgoRunner, BoardView, CellTone } from '@/core/types'

/**
 * 数组与矩阵：特殊矩阵的压缩存储 + 稀疏矩阵。
 *
 * 约定：
 *   - defaultData 给的是一维数字串，toMatrix 确定性地还原成 n×n 矩阵
 *     （n = max(2, round(sqrt(len)))，缺的格子补 0），所以"随机数据"按钮也能用；
 *   - 每个算法的 prepareData 把矩阵整成它要求的结构（对称 / 下三角 / 三对角 / 稀疏），
 *     生成器内部用同一个函数再规整一次（这些规整都是幂等的），两边看到的矩阵一定一致；
 *   - 每帧的 array 都是"当前矩阵按行优先展平"的数字序列；
 *   - 画面全靠 boards：左边原矩阵（grid），右边压缩后的一维表 / 三元组表 / 十字链表。
 */

/** 稀疏矩阵最多保留几个非零元（再多演示就太长了） */
const MAX_NNZ = 5

/* ---------------- 一维数据 <-> 矩阵 ---------------- */

/** 矩阵阶数：n = max(2, round(sqrt(len))) */
function order(len: number): number {
  return Math.max(2, Math.round(Math.sqrt(len)))
}

/** 一维数据 -> n×n 矩阵：a[i][j] = data[i*n+j] ?? 0 */
function toMatrix(data: number[]): number[][] {
  const n = order(data.length)
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => data[i * n + j] ?? 0),
  )
}

/**
 * 把长度拆成"最接近矩形"的两个整数边长：5 → 1×5，6 → 2×3，12 → 3×4。
 * 取 ≤ √len 的最大因数当行数，剩下的当列数。
 *
 * 稀疏矩阵用它 —— 数据有几个非零元就摆出**正好装得下**的矩阵，
 * 而不是硬取平方根：那样长度不是平方数时，多出来的数据会被丢掉、缺的格子要补 0。
 */
function rectShape(len: number): { rows: number; cols: number } {
  let rows = 1
  for (let r = 2; r * r <= len; r++) if (len % r === 0) rows = r
  return { rows, cols: Math.max(1, Math.floor(len / rows)) }
}

/** 一维数据 -> r×c 矩阵，r*c 正好等于数据长度 */
function toRect(data: number[]): number[][] {
  const { rows, cols } = rectShape(data.length)
  return Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => data[i * cols + j] ?? 0),
  )
}

function getCell(a: number[][], i: number, j: number): number {
  return a[i]?.[j] ?? 0
}

function setCell(a: number[][], i: number, j: number, v: number): void {
  const row = a[i]
  if (row) row[j] = v
}

/** 矩阵 -> 行优先的一维序列（每帧的 array 都用它） */
function flatMatrix(a: number[][]): number[] {
  return a.flat()
}

/** 一串空槽位（还没存元素的存储表） */
function nulls(len: number): Array<number | null> {
  return Array.from({ length: len }, () => null)
}

/** 行优先扫到的第一个零元（用来演示"零元跳过"） */
function firstZeroCell(a: number[][]): [number, number] | null {
  const cols = a[0]?.length ?? 0
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < cols; j++) {
      if (getCell(a, i, j) === 0) return [i, j]
    }
  }
  return null
}

/** 零元 / 非零元个数统计 */
function countZero(a: number[][]): { nnz: number; zeros: number } {
  let nnz = 0
  for (const row of a) {
    for (const v of row) if (v !== 0) nnz += 1
  }
  const total = a.length * (a[0]?.length ?? 0)
  return { nnz, zeros: total - nnz }
}

/* ---------------- 三种板子 ---------------- */

/** 原矩阵板：sub 标出 (i, j)；hot = 正在看的格子，stored = 已经存进压缩表的格子 */
function matrixBoard(
  a: number[][],
  opts: {
    hot?: number[]
    stored?: number[]
    zeroDim?: boolean
    pointers?: Record<string, number>
    note?: string
  } = {},
): BoardView {
  // 行列分开取：特殊矩阵是 n×n，稀疏矩阵是 r×c（比如 6 个数 → 2×3）
  const rows = a.length
  const cols = a[0]?.length ?? 0
  const hot = new Set(opts.hot ?? [])
  const stored = new Set(opts.stored ?? [])
  return {
    title: `原矩阵 a[0..${rows - 1}][0..${cols - 1}]`,
    layout: 'grid',
    cols,
    items: a.flatMap((row, i) =>
      row.map((v, j) => {
        const idx = i * cols + j
        const tone: CellTone = hot.has(idx)
          ? 'hot'
          : stored.has(idx)
            ? 'done'
            : opts.zeroDim && v === 0
              ? 'dim'
              : 'base'
        return { text: String(v), sub: `${i},${j}`, tone }
      }),
    ),
    pointers: opts.pointers,
    note: opts.note,
  }
}

/** 压缩后的一维存储表：row 布局，sub 是一维下标 k，还没存到的格子画成暗色 */
function storeBoard(
  title: string,
  values: Array<number | null>,
  hot: number[],
  opts: { subOf?: (k: number) => string; note?: string } = {},
): BoardView {
  return {
    title,
    layout: 'row',
    items: values.map((v, k) => ({
      text: v === null ? '' : String(v),
      sub: opts.subOf ? opts.subOf(k) : String(k),
      tone: hot.includes(k) ? 'hot' : v === null ? 'dim' : 'done',
    })),
    note: opts.note,
  }
}

/** 三元组表：每个非零元占一行三格（行号、列号、值），靠 grid + cols:3 摆出来 */
function tripleBoard(triples: Array<[number, number, number]>, hot = -1): BoardView {
  const items = triples.flatMap(([i, j, v], r) => {
    const tone: CellTone = r === hot ? 'hot' : 'done'
    return [
      { text: String(i), sub: '行', tone },
      { text: String(j), sub: '列', tone },
      { text: String(v), sub: '值', tone },
    ]
  })
  return {
    title: `三元组表 tb　${triples.length} 个非零元 × 3 格`,
    layout: 'grid',
    cols: 3,
    items: items.length
      ? items
      : [
          { text: '', sub: '行', tone: 'dim' },
          { text: '', sub: '列', tone: 'dim' },
          { text: '', sub: '值', tone: 'dim' },
        ],
    note: '每行一个非零元：行号、列号、值；零元一个都不进来',
  }
}

/** 十字链表里的一个结点：格子序号就是它在矩阵里的位置 i*n+j */
interface CrossNode {
  i: number
  j: number
  v: number
  /** 同行下一个非零元的格子序号；null = 本行最后一个 */
  right: number | null
  /** 同列下一个非零元的格子序号；null = 本列最后一个 */
  down: number | null
}

/** 十字链表板：结点摆在自己的 (i, j) 位置，right / down 用 links 画出来 */
function crossBoard(
  a: number[][],
  nodes: Map<number, CrossNode>,
  opts: { hot?: number[]; pointers?: Record<string, number>; note?: string } = {},
): BoardView {
  const rows = a.length
  const cols = a[0]?.length ?? 0
  const hot = new Set(opts.hot ?? [])
  const links: Array<{ from: number; to: number; dir: 'right' | 'down' }> = []
  for (const [idx, nd] of nodes) {
    if (nd.right !== null) links.push({ from: idx, to: nd.right, dir: 'right' })
    if (nd.down !== null) links.push({ from: idx, to: nd.down, dir: 'down' })
  }
  return {
    title: `十字链表：一个非零元一个结点，摆在自己的 (i, j) 位置　${rows}×${cols}`,
    layout: 'grid',
    cols,
    items: a.flatMap((row, i) =>
      row.map((v, j) => {
        const idx = i * cols + j
        const tone: CellTone = hot.has(idx)
          ? 'hot'
          : nodes.has(idx)
            ? 'done'
            : v === 0
              ? 'dim'
              : 'base'
        return { text: String(v), sub: `${i},${j}`, tone }
      }),
    ),
    pointers: opts.pointers,
    links,
    note: opts.note ?? '暗色格是零元，不建结点',
  }
}

/** 对称矩阵压缩表（n(n+1)/2 格） */
function symTable(n: number, store: Array<number | null>, hot: number[] = []): BoardView {
  const m = (n * (n + 1)) / 2
  return storeBoard(`压缩存储 sa[0..${m - 1}]　共 ${m} = n(n+1)/2 格`, store, hot, {
    note: '行优先：先存第 0 行，再存第 1 行……',
  })
}

/** 下三角矩阵压缩表（n(n+1)/2 + 1 格，最后一格放常量 c） */
function triTable(n: number, store: Array<number | null>, hot: number[] = []): BoardView {
  const m = (n * (n + 1)) / 2
  return storeBoard(`压缩存储 sa[0..${m}]　下三角 ${m} 格 + 常量 1 格`, store, hot, {
    subOf: (k) => (k === m ? 'c' : String(k)),
    note: `最后一格 sa[${m}] 专门放上三角的公共常量 c`,
  })
}

/** 三对角矩阵压缩表（3n-2 格） */
function diagTable(n: number, store: Array<number | null>, hot: number[] = []): BoardView {
  const m = 3 * n - 2
  return storeBoard(`压缩存储 sa[0..${m - 1}]　共 ${m} = 3n-2 格`, store, hot, {
    note: '行优先：第 i 行的带上元素从第 2i 格开始放',
  })
}

/* ---------------- 把随机数字整成"合格的"特殊矩阵 ---------------- */

/** 对称矩阵：把上三角镜像到下三角，保证 a[i][j] == a[j][i] */
function symmetricMatrix(data: number[]): number[][] {
  const a = toMatrix(data)
  const n = a.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) setCell(a, j, i, getCell(a, i, j))
  }
  return a
}

/** 下三角矩阵：i < j 的区域全置成公共常量（这里就是 0） */
function triangularMatrix(data: number[]): number[][] {
  const a = toMatrix(data)
  const n = a.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) setCell(a, i, j, 0)
  }
  return a
}

/** 三对角（带状）矩阵：|i - j| > 1 的位置全置 0 */
function diagonalMatrix(data: number[]): number[][] {
  const a = toMatrix(data)
  const n = a.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (Math.abs(i - j) > 1) setCell(a, i, j, 0)
    }
  }
  return a
}

/**
 * 稀疏矩阵的骨架：3 阶及以上取所有 (i+j) 为偶数的位置 ——
 * 这样同一行、同一列都至少有 2 个结点，right / down 链才演示得出来；
 * 2 阶只有 4 格，手工给一个 L 形，同样保证有行链和列链。
 */
function sparseMask(rows: number, cols: number, i: number, j: number): boolean {
  if (rows <= 2 && cols <= 2) return !(i === 1 && j === 1)
  return (i + j) % 2 === 0
}

/**
 * 稀疏矩阵：只留骨架上的非零元（最多 MAX_NNZ 个），其余全清零。
 * 形状按 rectShape 取"最接近矩形"的整数边长 —— 数据有几个就摆几个，
 * 不丢数据也不补空格（9 个数是 3×3，6 个数是 2×3，5 个数是 1×5）。
 */
function sparseMatrix(data: number[]): number[][] {
  const a = toRect(data)
  const rows = a.length
  const cols = a[0]?.length ?? 0
  let keep = 0
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (sparseMask(rows, cols, i, j) && getCell(a, i, j) !== 0 && keep < MAX_NNZ) keep += 1
      else setCell(a, i, j, 0)
    }
  }
  // 兜底：输入全是 0 时也留一个非零元，否则三元组表 / 十字链表会是空的
  if (keep === 0) setCell(a, 0, 0, 1)
  return a
}

/* ---------------- 对称矩阵 ---------------- */

const CODE_SYM = [
  '// 对称矩阵：a[i][j] == a[j][i]，只存下三角（含对角线），共 n(n+1)/2 个',
  '#define N 3',
  'int sa[N * (N + 1) / 2];                     // 3 阶只要 6 格',
  '// 行优先压缩：第 i 行前面已经连续放好 1 + 2 + ... + i 个元素',
  'int k = i * (i + 1) / 2 + j;                 // 只对 i >= j（下三角）成立',
  'sa[k] = a[i][j];                             // 存一个元素，对称位置共用这一格',
  'int get(int i, int j) {',
  '  if (i < j) { int t = i; i = j; j = t; }     // 上三角没单独存，先交换成下三角',
  '  return sa[i * (i + 1) / 2 + j];             // 再套同一个公式取回来',
  '}',
  '// n*n 个元素只用 n(n+1)/2 格，省下 n(n-1)/2 格',
]

function* runSymmetric(data: number[]): AlgoRunner {
  const a = symmetricMatrix(data)
  const n = a.length
  const m = (n * (n + 1)) / 2
  const store = nulls(m)
  const stored: number[] = []
  const table = (hot: number[] = []) => symTable(n, store, hot)

  yield {
    line: 1,
    action: 'init',
    array: flatMatrix(a),
    boards: [matrixBoard(a), table()],
    comment: `${n}×${n} 的对称矩阵：a[i][j] 和 a[j][i] 恒等，所以只存下三角（含对角线）${m} = n(n+1)/2 个，压成一维表 sa`,
    vars: { n, m },
  }

  // 逐行逐列存下三角：k = i(i+1)/2 + j
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const k = (i * (i + 1)) / 2 + j
      const v = getCell(a, i, j)
      yield {
        line: 5,
        action: 'mark',
        array: flatMatrix(a),
        boards: [matrixBoard(a, { hot: [i * n + j], stored }), table([k])],
        comment: `算下标：第 ${i} 行前面已经放好 1+2+...+${i} = ${(i * (i + 1)) / 2} 个元素，所以 k = i(i+1)/2 + j = ${i}*${i + 1}/2 + ${j} = ${k}`,
        vars: { i, j, k },
      }
      store[k] = v
      stored.push(i * n + j)
      yield {
        line: 6,
        action: 'set',
        array: flatMatrix(a),
        boards: [matrixBoard(a, { hot: [i * n + j], stored }), table([k])],
        comment: `sa[${k}] = a[${i}][${j}] = ${v}；对称位置 a[${j}][${i}] 和它相等，共用这一格，不再另存`,
        vars: { i, j, k },
      }
    }
  }

  // 访问演示：上三角先交换成下三角，再套同一个公式
  const probes: Array<[number, number]> = [
    [0, n - 1],
    [n - 1, 0],
  ]
  for (const [qi, qj] of probes) {
    const upper = qi < qj
    yield {
      line: 8,
      action: 'mark',
      array: flatMatrix(a),
      boards: [matrixBoard(a, { hot: [qi * n + qj], stored }), table()],
      comment: upper
        ? `访问 a[${qi}][${qj}]：i < j，落在上三角 —— 它没被单独存过，靠 a[${qi}][${qj}] = a[${qj}][${qi}] 先交换成 (${qj}, ${qi})`
        : `访问 a[${qi}][${qj}]：i >= j，本来就在下三角，不用交换，直接算 k`,
      vars: { i: qi, j: qj },
    }
    const i2 = Math.max(qi, qj)
    const j2 = Math.min(qi, qj)
    const k = (i2 * (i2 + 1)) / 2 + j2
    yield {
      line: 9,
      action: 'mark',
      array: flatMatrix(a),
      boards: [matrixBoard(a, { hot: [qi * n + qj], stored }), table([k])],
      comment: `套同一个公式：k = i(i+1)/2 + j = ${i2}*${i2 + 1}/2 + ${j2} = ${k}，读到 sa[${k}] = ${store[k]}。上三角、下三角走的是同一条公式`,
      vars: { i: i2, j: j2, k },
    }
  }

  yield {
    line: 11,
    action: 'done',
    array: flatMatrix(a),
    boards: [matrixBoard(a, { stored }), table()],
    comment: `存完了：${n * n} 个元素只占 ${m} 格，省下 n(n-1)/2 = ${(n * (n - 1)) / 2} 格。读 a[i][j] 之前先保证 i >= j，再套 k = i(i+1)/2 + j`,
    vars: { n, m },
  }
}

function symInitScene(data: number[]): { boards: BoardView[] } {
  const a = symmetricMatrix(data)
  const n = a.length
  return { boards: [matrixBoard(a), symTable(n, nulls((n * (n + 1)) / 2))] }
}

/* ---------------- 三角矩阵 ---------------- */

const CODE_TRI = [
  '// 下三角矩阵：i < j 的区域全是同一个常量（通常就是 0）',
  '#define N 3',
  'int sa[N * (N + 1) / 2 + 1];         // 下三角 n(n+1)/2 格，另外多开 1 格放常量',
  'int k = i * (i + 1) / 2 + j;         // 下三角（含对角线）的行优先公式',
  'if (i >= j) sa[k] = a[i][j];         // 下三角逐个存',
  'else sa[N * (N + 1) / 2] = a[i][j];  // 上三角不逐个存，只留一个公共常量',
  'int get(int i, int j) {',
  '  if (i >= j) return sa[i * (i + 1) / 2 + j];   // 下三角按公式取',
  '  return sa[N * (N + 1) / 2];                   // 上三角一律返回那个常量',
  '}',
  '// 为什么多一格：上三角有 n(n-1)/2 个"相同"的值，存一份就够了',
]

function* runTriangular(data: number[]): AlgoRunner {
  const a = triangularMatrix(data)
  const n = a.length
  const m = (n * (n + 1)) / 2
  /** 上三角的公共常量 */
  const c = 0
  const store = nulls(m + 1)
  const stored: number[] = []
  const table = (hot: number[] = []) => triTable(n, store, hot)

  yield {
    line: 1,
    action: 'init',
    array: flatMatrix(a),
    boards: [matrixBoard(a, { zeroDim: true }), table()],
    comment: `${n}×${n} 的下三角矩阵：i >= j 的下三角有 n(n+1)/2 = ${m} 个元素；i < j 的上三角全是同一个常量 c = ${c}，所以数组开 ${m} + 1 = ${m + 1} 格`,
    vars: { n, m, c },
  }

  // 下三角：按 k = i(i+1)/2 + j 逐个存
  let first = true
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const k = (i * (i + 1)) / 2 + j
      const v = getCell(a, i, j)
      if (first) {
        first = false
        yield {
          line: 4,
          action: 'mark',
          array: flatMatrix(a),
          boards: [matrixBoard(a, { hot: [i * n + j], stored, zeroDim: true }), table([k])],
          comment: `算下标：第 ${i} 行前面放好 ${(i * (i + 1)) / 2} 个元素，k = i(i+1)/2 + j = ${i}*${i + 1}/2 + ${j} = ${k}`,
          vars: { i, j, k },
        }
      }
      store[k] = v
      stored.push(i * n + j)
      yield {
        line: 5,
        action: 'set',
        array: flatMatrix(a),
        boards: [matrixBoard(a, { hot: [i * n + j], stored, zeroDim: true }), table([k])],
        comment: `sa[${k}] = a[${i}][${j}] = ${v}　（i >= j，在下三角，按 k = i(i+1)/2 + j 直接存）`,
        vars: { i, j, k },
      }
    }
  }

  // 上三角：不逐个存，只在最后一格写一份常量
  const upper: Array<[number, number]> = []
  for (let i = 0; i < n && upper.length < 2; i++) {
    for (let j = i + 1; j < n && upper.length < 2; j++) upper.push([i, j])
  }
  let t = 0
  for (const [i, j] of upper) {
    store[m] = c
    yield {
      line: 6,
      action: 'set',
      array: flatMatrix(a),
      boards: [matrixBoard(a, { hot: [i * n + j], stored, zeroDim: true }), table([m])],
      comment:
        t === 0
          ? `a[${i}][${j}] 在上三角：上三角一共 n(n-1)/2 = ${(n * (n - 1)) / 2} 个元素，值全是同一个常量，所以不逐个存，只在最后那格写一份 sa[${m}] = ${c}`
          : `再看上三角的 a[${i}][${j}]：还是那个常量 ${c}，读的时候直接返回 sa[${m}]，压缩表不用多占一格`,
      vars: { i, j, k: m },
    }
    t += 1
  }

  // 取元素演示：下三角套公式，上三角直接返回常量格
  const li = n - 1
  const lj = 0
  const lk = (li * (li + 1)) / 2 + lj
  yield {
    line: 8,
    action: 'mark',
    array: flatMatrix(a),
    boards: [matrixBoard(a, { hot: [li * n + lj], stored, zeroDim: true }), table([lk])],
    comment: `取 a[${li}][${lj}]：i >= j 在下三角，k = ${li}*${li + 1}/2 + ${lj} = ${lk}，读到 sa[${lk}] = ${store[lk]}`,
    vars: { i: li, j: lj, k: lk },
  }
  const ui = 0
  const uj = n - 1
  yield {
    line: 9,
    action: 'mark',
    array: flatMatrix(a),
    boards: [matrixBoard(a, { hot: [ui * n + uj], stored, zeroDim: true }), table([m])],
    comment: `取 a[${ui}][${uj}]：i < j 是上三角，不用算 k，直接返回常量格的 sa[${m}] = ${c}`,
    vars: { i: ui, j: uj, k: m },
  }

  yield {
    line: 11,
    action: 'done',
    array: flatMatrix(a),
    boards: [matrixBoard(a, { stored, zeroDim: true }), table()],
    comment: `存完了：下三角 ${m} 格 + 常量 1 格 = ${m + 1} 格，比存满 ${n * n} 格省了 ${n * n - m - 1} 格 —— 上三角那 ${(n * (n - 1)) / 2} 个相同的值只花了一格`,
    vars: { n, m },
  }
}

function triInitScene(data: number[]): { boards: BoardView[] } {
  const a = triangularMatrix(data)
  const n = a.length
  return {
    boards: [matrixBoard(a, { zeroDim: true }), triTable(n, nulls((n * (n + 1)) / 2 + 1))],
  }
}

/* ---------------- 对角矩阵 ---------------- */

const CODE_DIA = [
  '// 对角矩阵（带状矩阵）：非零元只在主对角线以及上下各一条带上',
  '#define N 3',
  'int sa[3 * N - 2];                   // 三对角一共 3n-2 个：3 阶只要 7 格',
  '// 行优先压缩：第 i 行的带上元素从第 2i 格开始连续放',
  'int k = 2 * i + j;                   // 只对 |i - j| <= 1 的元素成立',
  'if (i - j <= 1 && j - i <= 1) sa[k] = a[i][j];   // 带内：真的存',
  'int get(int i, int j) {',
  '  if (i - j > 1 || j - i > 1) return 0;          // 带外直接判 0，数组里根本没它',
  '  return sa[2 * i + j];                          // 带内按同一个公式取',
  '}',
  '// 带外一共 n*n - (3n-2) 个元素，一个都不存',
]

function* runDiagonal(data: number[]): AlgoRunner {
  const a = diagonalMatrix(data)
  const n = a.length
  const m = 3 * n - 2
  const store = nulls(m)
  const stored: number[] = []
  const table = (hot: number[] = []) => diagTable(n, store, hot)

  const band: Array<[number, number]> = []
  const outside: Array<[number, number]> = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (Math.abs(i - j) <= 1) band.push([i, j])
      else outside.push([i, j])
    }
  }

  yield {
    line: 1,
    action: 'init',
    array: flatMatrix(a),
    boards: [matrixBoard(a, { zeroDim: true }), table()],
    comment: `${n}×${n} 的对角（带状）矩阵：非零元只在主对角线和它上下各一条带上，|i - j| <= 1，一共 3n-2 = ${m} 个；其余 ${outside.length} 个位置一律是 0，一个都不存`,
    vars: { n, m },
  }

  // 带内元素：按 k = 2i + j 逐个存
  let first = true
  for (const [i, j] of band) {
    const k = 2 * i + j
    const v = getCell(a, i, j)
    if (first) {
      first = false
      yield {
        line: 5,
        action: 'mark',
        array: flatMatrix(a),
        boards: [matrixBoard(a, { hot: [i * n + j], stored, zeroDim: true }), table([k])],
        comment: `算下标：第 ${i} 行的带上元素从第 2*${i} = ${2 * i} 格开始放，所以 k = 2i + j = 2*${i} + ${j} = ${k}`,
        vars: { i, j, k },
      }
    }
    store[k] = v
    stored.push(i * n + j)
    yield {
      line: 6,
      action: 'set',
      array: flatMatrix(a),
      boards: [matrixBoard(a, { hot: [i * n + j], stored, zeroDim: true }), table([k])],
      comment: `sa[${k}] = a[${i}][${j}] = ${v}　（|${i} - ${j}| = ${Math.abs(i - j)} <= 1，在带内，按 k = 2i + j 存）`,
      vars: { i, j, k },
    }
  }

  // 带外元素：数组里根本没有它，访问时直接判 0
  const probes = outside.slice(0, 2)
  if (probes.length === 0) {
    yield {
      line: 11,
      action: 'mark',
      array: flatMatrix(a),
      boards: [matrixBoard(a, { stored, zeroDim: true }), table()],
      comment: `${n} 阶时 3n-2 = ${m} 正好等于 n*n = ${n * n}，每个位置都在带内，没有"带外不存"的例子；阶数再大一点才会出现`,
      vars: { n, m },
    }
  }
  for (const [i, j] of probes) {
    yield {
      line: 8,
      action: 'mark',
      array: flatMatrix(a),
      boards: [matrixBoard(a, { hot: [i * n + j], stored, zeroDim: true }), table()],
      comment: `访问带外的 a[${i}][${j}]：|i - j| = ${Math.abs(i - j)} > 1，数组里根本没给它留格子，直接返回 0`,
      vars: { i, j },
    }
  }

  yield {
    line: 11,
    action: 'done',
    array: flatMatrix(a),
    boards: [matrixBoard(a, { stored, zeroDim: true }), table()],
    comment: `存完了：${n * n} 个元素只用了 ${m} = 3n-2 格，带外 ${n * n - m} 个 0 全都不存。读的时候先看 |i - j| 是否 <= 1，带外直接判 0`,
    vars: { n, m },
  }
}

function diagInitScene(data: number[]): { boards: BoardView[] } {
  const a = diagonalMatrix(data)
  const n = a.length
  return { boards: [matrixBoard(a, { zeroDim: true }), diagTable(n, nulls(3 * n - 2))] }
}

/* ---------------- 稀疏矩阵 · 三元组表 ---------------- */

const CODE_TRIPLE = [
  '// 稀疏矩阵：非零元很少，只存非零元，零元一个都不存',
  'typedef struct { int i, j, v; } Triple;   // 三元组：行号、列号、值',
  'Triple tb[MAXSIZE]; int len = 0;          // 三元组表 + 表长',
  'for (int i = 0; i < rows; i++)',
  '  for (int j = 0; j < cols; j++)',
  '    if (a[i][j] != 0) {                    // 零元直接跳过，不占格子',
  '      tb[len].i = i; tb[len].j = j; tb[len].v = a[i][j];   // 记下位置和值',
  '      len++;                               // 表长加一，指向下一行空位',
  '    }',
  '// rows*cols 个元素只用了 len 行 —— 零元越多越省',
]

function* runTriple(data: number[]): AlgoRunner {
  const a = sparseMatrix(data)
  const rows = a.length
  const cols = a[0]?.length ?? 0
  const { nnz, zeros } = countZero(a)
  const triples: Array<[number, number, number]> = []
  const stored: number[] = []
  const matrix = (hot: number[], p?: number) =>
    matrixBoard(a, {
      hot,
      stored,
      zeroDim: true,
      pointers: p === undefined ? undefined : { p },
    })

  yield {
    line: 1,
    action: 'init',
    array: flatMatrix(a),
    boards: [matrixBoard(a, { zeroDim: true }), tripleBoard(triples)],
    comment: `${rows}×${cols} 一共 ${rows * cols} 个元素，里面只有 ${nnz} 个非零元、${zeros} 个零元。零元一个都不存，只把非零元按行优先记成 (行, 列, 值) 三元组`,
    vars: { rows, cols, nnz, zeros },
  }

  // 先演示一个"零元被跳过"
  const zero = firstZeroCell(a)
  if (zero) {
    const [zi, zj] = zero
    yield {
      line: 6,
      action: 'mark',
      array: flatMatrix(a),
      boards: [matrix([zi * cols + zj], zi * cols + zj), tripleBoard(triples)],
      comment: `按行优先扫到 a[${zi}][${zj}]：值是 0，是零元，直接跳过 —— 三元组表里不会出现它，省下一整行三格`,
      vars: { i: zi, j: zj },
    }
  }

  // 逐个非零元建三元组
  const cells: Array<[number, number, number]> = []
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const v = getCell(a, i, j)
      if (v !== 0) cells.push([i, j, v])
    }
  }
  let first = true
  for (const [i, j, v] of cells) {
    if (first) {
      first = false
      yield {
        line: 6,
        action: 'mark',
        array: flatMatrix(a),
        boards: [matrix([i * cols + j], i * cols + j), tripleBoard(triples)],
        comment: `扫到第一个非零元 a[${i}][${j}] = ${v}：非零元要留下 —— 位置 (${i}, ${j}) 和值 ${v} 都得记住，所以一行要三格`,
        vars: { i, j, v },
      }
    }
    const at = triples.length
    triples.push([i, j, v])
    stored.push(i * cols + j)
    yield {
      line: 7,
      action: 'set',
      array: flatMatrix(a),
      boards: [matrix([i * cols + j]), tripleBoard(triples, at)],
      comment: `写三元组：tb[${at}] = (行 ${i}, 列 ${j}, 值 ${v})，占表里第 ${at} 行的三格`,
      vars: { i, j, v, len: triples.length },
    }
    yield {
      line: 8,
      action: 'mark',
      array: flatMatrix(a),
      boards: [matrix([i * cols + j]), tripleBoard(triples, at)],
      comment: `表长加一：len 由 ${at} 变成 ${triples.length}，下一个非零元会写在第 ${triples.length} 行`,
      vars: { len: triples.length },
    }
  }

  yield {
    line: 10,
    action: 'done',
    array: flatMatrix(a),
    boards: [matrixBoard(a, { zeroDim: true, stored }), tripleBoard(triples)],
    comment: `建表完成：${rows * cols} 个元素只用了 ${triples.length} 行 × 3 格 = ${triples.length * 3} 个整数，${zeros} 个零元一个都没进来`,
    vars: { rows, cols, nnz, len: triples.length },
  }
}

function tripleInitScene(data: number[]): { boards: BoardView[] } {
  const a = sparseMatrix(data)
  return { boards: [matrixBoard(a, { zeroDim: true }), tripleBoard([])] }
}

/* ---------------- 稀疏矩阵 · 十字链表 ---------------- */

const CODE_CROSS = [
  '// 十字链表：每个非零元一个结点，同时挂进"行链"和"列链"',
  'typedef struct OLNode { int i, j, v; struct OLNode *right, *down; } OLNode;',
  'OLNode *p = new OLNode; p->i = i; p->j = j; p->v = v;   // 申请结点，两根指针先置空',
  '// 沿 right 从行头走到列号 < j 的最后一个结点，它就是行前驱 pre',
  '// 沿 down 从列头走到行号 < i 的最后一个结点，它就是列前驱 preDown',
  'p->right = pre->right; pre->right = p;        // 接行链：串进本行的 right 链',
  'p->down = preDown->down; preDown->down = p;   // 接列链：串进本列的 down 链',
  '// 插完后每个非零元被两条链共享，零元不建结点、不进链',
]

function* runCross(data: number[]): AlgoRunner {
  const a = sparseMatrix(data)
  const rows = a.length
  const cols = a[0]?.length ?? 0
  const { nnz, zeros } = countZero(a)
  const nodes = new Map<number, CrossNode>()
  const board = (
    hot: number[] = [],
    pointers: Record<string, number> = {},
    note?: string,
  ): BoardView =>
    crossBoard(a, nodes, {
      hot,
      pointers,
      note: note ?? `已建结点 ${nodes.size} / ${nnz}　暗色格是零元，不建结点`,
    })
  /** 把结点序号翻译成人话，方便写解说词 */
  const label = (k: number | null): string => {
    if (k === null) return 'NULL'
    const nd = nodes.get(k)
    return nd ? `结点(${nd.i}, ${nd.j})` : 'NULL'
  }

  const cells: Array<[number, number, number]> = []
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const v = getCell(a, i, j)
      if (v !== 0) cells.push([i, j, v])
    }
  }

  yield {
    line: 1,
    action: 'init',
    array: flatMatrix(a),
    boards: [board()],
    comment: `${rows}×${cols} 里只有 ${nnz} 个非零元、${zeros} 个零元。每个非零元建一个结点（存 i、j、v），零元一个结点都不建；每个结点还有 right（同行下一个非零元）和 down（同列下一个非零元）两根指针`,
    vars: { rows, cols, nnz, zeros },
  }

  // 按行优先逐个插入：申请结点 -> 找行前驱 -> 找列前驱 -> 接行链 -> 接列链
  let cnt = 0
  for (const [i, j, v] of cells) {
    cnt += 1
    const idx = i * cols + j

    let rowPre: CrossNode | null = null
    let rowPreIdx = -1
    let colPre: CrossNode | null = null
    let colPreIdx = -1
    for (const [k, nd] of nodes) {
      if (nd.i === i && nd.j < j && (rowPre === null || nd.j > rowPre.j)) {
        rowPre = nd
        rowPreIdx = k
      }
      if (nd.j === j && nd.i < i && (colPre === null || nd.i > colPre.i)) {
        colPre = nd
        colPreIdx = k
      }
    }

    yield {
      line: 3,
      action: 'set',
      array: flatMatrix(a),
      boards: [board([idx], { p: idx })],
      comment: `为第 ${cnt} 个非零元 a[${i}][${j}] = ${v} 申请一个结点 p：结点就摆在自己的 (${i}, ${j}) 位置，right / down 先置空`,
      vars: { i, j, v, p: idx },
    }

    yield {
      line: 4,
      action: 'mark',
      array: flatMatrix(a),
      boards: [board([idx], rowPre ? { p: idx, pre: rowPreIdx } : { p: idx })],
      comment: rowPre
        ? `接链前的准备（1/2）：沿第 ${i} 行的 right 链走，找列号小于 ${j} 的最后一个结点 —— 行前驱是 a[${rowPre.i}][${rowPre.j}]，p 要插在它后面`
        : `接链前的准备（1/2）：第 ${i} 行的行链还是空的，没有列号小于 ${j} 的结点，p 直接成为这一行的第一个结点`,
      vars: { i, j, pre: rowPre ? rowPreIdx : -1 },
    }

    yield {
      line: 5,
      action: 'mark',
      array: flatMatrix(a),
      boards: [board([idx], colPre ? { p: idx, preDown: colPreIdx } : { p: idx })],
      comment: colPre
        ? `接链前的准备（2/2）：沿第 ${j} 列的 down 链走，找行号小于 ${i} 的最后一个结点 —— 列前驱是 a[${colPre.i}][${colPre.j}]`
        : `接链前的准备（2/2）：第 ${j} 列的列链还是空的，p 直接成为这一列的第一个结点`,
      vars: { i, j, preDown: colPre ? colPreIdx : -1 },
    }

    // 接行链：p->right = pre->right; pre->right = p
    const node: CrossNode = { i, j, v, right: rowPre ? rowPre.right : null, down: null }
    if (rowPre) rowPre.right = idx
    nodes.set(idx, node)
    yield {
      line: 6,
      action: 'set',
      array: flatMatrix(a),
      boards: [board([idx], rowPre ? { p: idx, pre: rowPreIdx } : { p: idx })],
      comment: rowPre
        ? `接行链：先让 p->right = pre->right = ${label(node.right)}，再让 pre->right = p —— 第 ${i} 行的链按列号从小到大串起来了`
        : `接行链：本行没有前驱，直接让行头结点指向 p（p->right = NULL），p 是第 ${i} 行的第一个结点`,
      vars: { i, j, right: node.right ?? -1 },
    }

    // 接列链：p->down = preDown->down; preDown->down = p
    node.down = colPre ? colPre.down : null
    if (colPre) colPre.down = idx
    yield {
      line: 7,
      action: 'set',
      array: flatMatrix(a),
      boards: [board([idx], colPre ? { p: idx, preDown: colPreIdx } : { p: idx })],
      comment: colPre
        ? `接列链：先让 p->down = preDown->down = ${label(node.down)}，再让 preDown->down = p —— 第 ${j} 列的链也串好了`
        : `接列链：本列没有前驱，直接让列头结点指向 p（p->down = NULL），p 是第 ${j} 列的第一个结点`,
      vars: { i, j, down: node.down ?? -1 },
    }
  }

  yield {
    line: 8,
    action: 'done',
    array: flatMatrix(a),
    boards: [board()],
    comment: `插入完成：${nnz} 个非零元 = ${nnz} 个结点，每个结点同时挂在行链和列链上；${zeros} 个零元一个结点都没占`,
    vars: { rows, cols, nnz },
  }
}

function crossInitScene(data: number[]): { boards: BoardView[] } {
  const a = sparseMatrix(data)
  const { nnz, zeros } = countZero(a)
  return {
    boards: [
      crossBoard(a, new Map(), { note: `${nnz} 个非零元待插入 / ${zeros} 个零元不建结点` }),
    ],
  }
}

/* ---------------- 注册用的算法清单 ---------------- */

export const matrixSpecs: AlgorithmSpec[] = [
  {
    id: 'matrix-symmetric',
    name: '对称矩阵压缩存储',
    category: 'matrix',
    group: '特殊矩阵',
    squareInput: true,
    summary: '只存下三角，a[i][j] 与 a[j][i] 共用一格，按 k = i(i+1)/2 + j 定位',
    complexity: { time: 'O(1) 定位（直接算下标）', space: 'O(n²) → O(n(n+1)/2)' },
    renderer: 'scene',
    codeLines: CODE_SYM,
    defaultData: () => [4, 6, 9, 2, 5, 8, 3, 7, 6],
    prepareData: (raw) => flatMatrix(symmetricMatrix(raw)),
    initComment: (data) => {
      const n = order(data.length)
      const m = (n * (n + 1)) / 2
      return `准备 ${n}×${n} 的对称矩阵：a[i][j] 和 a[j][i] 是同一个值，所以只存下三角（含对角线）${m} 个，压成一维表 sa`
    },
    initScene: symInitScene,
    createRunner: runSymmetric,
  },
  {
    id: 'matrix-triangular',
    name: '三角矩阵压缩存储',
    category: 'matrix',
    group: '特殊矩阵',
    squareInput: true,
    summary: '下三角逐个存，上三角那一堆相同的值只多留一格放常量',
    complexity: { time: 'O(1) 定位（直接算下标）', space: 'O(n²) → O(n(n+1)/2 + 1)' },
    renderer: 'scene',
    codeLines: CODE_TRI,
    defaultData: () => [4, 7, 2, 6, 5, 3, 9, 8, 6],
    prepareData: (raw) => flatMatrix(triangularMatrix(raw)),
    initComment: (data) => {
      const n = order(data.length)
      const m = (n * (n + 1)) / 2
      return `准备 ${n}×${n} 的下三角矩阵：下三角 ${m} 个元素要存，上三角 ${(n * (n - 1)) / 2} 个元素全是同一个常量，所以压缩表开 ${m + 1} 格`
    },
    initScene: triInitScene,
    createRunner: runTriangular,
  },
  {
    id: 'matrix-diagonal',
    name: '对角矩阵压缩存储',
    category: 'matrix',
    group: '特殊矩阵',
    squareInput: true,
    summary: '只存主对角线和上下各一条带，按 k = 2i + j 定位，带外直接判 0',
    complexity: { time: 'O(1) 定位（带外先判范围）', space: 'O(n²) → O(3n-2)' },
    renderer: 'scene',
    codeLines: CODE_DIA,
    defaultData: () => [5, 7, 2, 3, 6, 8, 1, 4, 9],
    prepareData: (raw) => flatMatrix(diagonalMatrix(raw)),
    initComment: (data) => {
      const n = order(data.length)
      return `准备 ${n}×${n} 的对角（带状）矩阵：非零元只在 |i - j| <= 1 的三条带上，一共 3n-2 = ${3 * n - 2} 个，其余位置全是 0，不用存`
    },
    initScene: diagInitScene,
    createRunner: runDiagonal,
  },
  {
    id: 'sparse-triple',
    name: '稀疏矩阵三元组表',
    category: 'matrix',
    group: '稀疏矩阵',
    summary: '只存非零元，每个非零元记一行 (行, 列, 值)，按行优先排列',
    complexity: { time: 'O(n²)（建表要扫一遍矩阵）', space: 'O(n²) → O(3t)，t 是非零元个数' },
    renderer: 'scene',
    codeLines: CODE_TRIPLE,
    defaultData: () => [3, 0, 7, 0, 5, 0, 9, 0, 2],
    prepareData: (raw) => flatMatrix(sparseMatrix(raw)),
    initComment: (data) => {
      const a = sparseMatrix(data)
      const { nnz, zeros } = countZero(a)
      const rows = a.length
      const cols = a[0]?.length ?? 0
      return `准备 ${rows}×${cols} 的稀疏矩阵（${data.length} 个数按"最接近矩形"的边长摆好）：${rows * cols} 个元素里只有 ${nnz} 个非零元、${zeros} 个零元。三元组表只存非零元，零元一个都不进表`
    },
    initScene: tripleInitScene,
    createRunner: runTriple,
  },
  {
    id: 'sparse-cross',
    name: '稀疏矩阵十字链表',
    category: 'matrix',
    group: '稀疏矩阵',
    summary: '每个非零元一个结点，right 串同行、down 串同列，零元不建结点',
    complexity: {
      time: 'O(n²)（每个非零元还要找行 / 列前驱）',
      space: 'O(n²) → O(5t)，每个结点 5 个域',
    },
    renderer: 'scene',
    codeLines: CODE_CROSS,
    defaultData: () => [3, 0, 4, 0, 6, 0, 8, 0, 7],
    prepareData: (raw) => flatMatrix(sparseMatrix(raw)),
    initComment: (data) => {
      const a = sparseMatrix(data)
      const { nnz, zeros } = countZero(a)
      const rows = a.length
      const cols = a[0]?.length ?? 0
      return `准备 ${rows}×${cols} 的稀疏矩阵（${data.length} 个数按"最接近矩形"的边长摆好）：${nnz} 个非零元要建 ${nnz} 个结点，${zeros} 个零元不建结点；每个结点的 right 指向同行下一个非零元，down 指向同列下一个非零元`
    },
    initScene: crossInitScene,
    createRunner: runCross,
  },
]
