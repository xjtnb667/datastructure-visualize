import type {
  AlgorithmSpec,
  AlgoRunner,
  BoardView,
  CellItem,
  CellTone,
  GraphEdgeSnapshot,
  GraphNodeSnapshot,
  GraphView,
} from '@/core/types'

/**
 * 图的存储结构：邻接矩阵 / 邻接表 / 十字链表 / 邻接多重表。
 *
 * **数据规模 = 图的顶点数 n**，n 取 5..9（下拉框里选的那一档就是顶点数）。
 * 顶点坐标、边、表格的行列数全部按 n 现算（见 graphOf），
 * 而且**不用 Math.random** —— 同一档规模每次跑出来都是同一张图，
 * 解说词才敢把顶点、边、权值写死。
 * （老写法把 6 个顶点、10 条边、表格列数全写成模块级常量，
 *   于是"数据规模"下拉框里只剩 6 一个选项 —— 这就是这次要改掉的东西。）
 *
 * 图是本项目里较新的渲染器，用法和其他渲染器不太一样，先把约定写清楚：
 *
 *   1. 顶点坐标由算法自己给，是**相对坐标 0..1**（渲染器按面板尺寸换算成像素）。
 *      顶点摆在圆周上（ring），半径随 n 略收一点 —— 位置全程固定不动，
 *      画面里变的只有颜色和边上的权值，这样"这一步动了什么"才读得出来。
 *   2. **每帧都要给 graph**；首帧是 engine 造的，所以还要给 initGraph（不给第一帧就是空画面）。
 *      首帧的表格靠 initScene 给 —— 首帧的 boards 只能从那里进。
 *   3. **板子（boards）是这四个算法的主角**：矩阵 / 邻接表 / 弧结点表 / 边结点表
 *      一律用 layout: 'grid' 画，第一行（矩阵还有第一列）当表头，数据格从 (1,1) 开始；
 *      pointers 指向当前那一行 / 那个格子，渲染成格子上的黄色小标签。
 *   4. 一个 yield = 一步，line 必须落在 codeLines 的**非空**行上；
 *      array 每帧必填 —— 图类算法没有"数据序列"，这里统一放顶点编号 1..n。
 *
 * 两张图都按 n 现算（n = 5..9）：
 *   无向带权图（邻接矩阵 / 邻接表 / 邻接多重表）：
 *     先连成一个环 V1-V2-…-Vn-V1（n 条边，保证**连通**、没有孤立点），
 *     再加两条弦 V1—V3、V(n-2)—Vn ——
 *     n 个顶点、n+2 条边（n=5 时 7 条，n=9 时 11 条），权值取 1..9 的确定值。
 *   有向图（十字链表用它，另外建的一张）：
 *     先连成一个有向环 V1→V2→…→Vn→V1（n 条弧，每个顶点都有出边也有入边），
 *     再补上 V1⇄V2、V3⇄V4 两对**互为反向**的弧（用来讲清"方向相反的两条弧各占一个结点"）
 *     和一条 V3→V5（让 V3 有两条出边，"顺 firstout 找出边"才走得下去）——
 *     n 个顶点、n+3 条弧（n=5 时 8 条，n=9 时 12 条）。
 */

/* ================================================================== *
 * 一、公共：数据规模、确定性造图、圆环布局、快照构造函数
 * ================================================================== */

/**
 * 四个算法支持的「数据规模」= 图的顶点数，一律 5..9。
 * 顶点数、边数、表格的行列数全都按 n 现算，所以每一档都画得出对得上的画面。
 */
export const GS_SIZES: number[] = [5, 6, 7, 8, 9]
const MIN_N = 5
const MAX_N = 9
/** 默认规模：7 个顶点（和最早的固定 6 个顶点观感接近，画面不会突然变大变小） */
const DEFAULT_N = 7

function clampN(len: number): number {
  if (!Number.isFinite(len)) return DEFAULT_N
  return Math.min(MAX_N, Math.max(MIN_N, Math.round(len)))
}

/** 顶点编号序列 1..n —— 图类算法没有"数据序列"，array 统一拿它占位 */
const vertexIds = (n: number): number[] => Array.from({ length: n }, (_, k) => k + 1)

/**
 * 把任意输入规整成 5..9 个元素（顶点编号 1..n）。
 * 界面上的「数据规模」就是图里的顶点数：选 5 就是 5 个顶点，选 9 就是 9 个顶点。
 * 规整成 1..n 是为了让首帧的 array（engine 用 defaultData 造）和后面每一帧都对得上。
 */
export function prepareData(raw: number[]): number[] {
  const len = Array.isArray(raw) ? raw.length : 0
  return vertexIds(clampN(len || DEFAULT_N))
}

/** 每个 spec 的默认数据：7 个顶点 */
const defaultData = (): number[] => vertexIds(DEFAULT_N)

/** 坐标保留 4 位小数：0.5 + 0.42cos(-90°) 算出来是 0.5000000000000001，看着别扭 */
function r4(v: number): number {
  return Math.round(v * 1e4) / 1e4
}

/**
 * 圆环半径：顶点越多圆环上越挤，半径略收一点，
 * 顶点圆和它旁边的小标签就不会贴到面板边上（n=9 时收到 0.40，坐标落在 0.106..0.894）。
 */
const ringR = (n: number): number => (n >= 9 ? 0.4 : n >= 8 ? 0.41 : 0.42)

/**
 * 圆环布局：第 k 个顶点从 12 点方向起顺时针摆。
 * 坐标严格落在 0.08..0.92（校验器要求 0..1）；相邻顶点坐标差至少 0.27，
 * 换算到面板上（宽 640px 时）约 170px，远大于顶点圆半径 21px —— 绝不会挤在一起。
 */
function ring(k: number, n: number): { x: number; y: number } {
  const t = (2 * Math.PI * k) / n - Math.PI / 2
  const R = ringR(n)
  return { x: r4(0.5 + R * Math.cos(t)), y: r4(0.5 + R * Math.sin(t)) }
}

/** 一条边 / 一条弧：i、j 是 0-based 顶点下标，w 是权值 */
interface WEdge {
  i: number
  j: number
  w: number
}

/**
 * 权值：1..9 的**确定值**（绝对不能用 Math.random —— 同一档规模必须每次都长一样，
 * 解说词里的"权值 6"才敢写死）。
 */
const weightOf = (i: number, j: number, n: number): number => 1 + ((i * 3 + j * 5 + n) % 9)

/**
 * 无向带权图：n 个顶点、n+2 条边，一定是**连通图**。
 *   ① 先连成一个环 V1-V2-…-Vn-V1 —— n 条边，每个顶点至少落在这条环上，绝不会有孤立点；
 *   ② 再加两条"弦"：V1—V3 和 V(n-2)—Vn —— n=5 时 7 条边、n=9 时 11 条边（≈ n+2）。
 * 最后按 (i, j) 字典序排好：矩阵逐条填、邻接表逐行建链的顺序就是它，顺序固定，解说词才敢把话写死。
 * （按 (i, j) 排好还有一个好处：每个顶点的邻接边天然按"另一端编号"升序，
 *   邻接表的 next 链、邻接多重表的边链看起来都是整齐的。）
 */
function buildUndirected(n: number): WEdge[] {
  const raw: WEdge[] = []
  for (let i = 0; i < n; i++) raw.push({ i, j: (i + 1) % n, w: 0 })
  raw.push({ i: 0, j: 2, w: 0 })
  raw.push({ i: n - 3, j: n - 1, w: 0 })
  return raw
    .map((e) => {
      const a = Math.min(e.i, e.j)
      const b = Math.max(e.i, e.j)
      return { i: a, j: b, w: weightOf(a, b, n) }
    })
    .sort((x, y) => x.i - y.i || x.j - y.j)
}

/**
 * 有向图（十字链表用）：n 个顶点、n+3 条弧。
 *   ① 先连成一个**有向环** V1→V2→…→Vn→V1 —— n 条弧，每个顶点都有出边也有入边；
 *   ② 补上两对**互为反向**的弧 V1⇄V2、V3⇄V4 —— 正好演示"方向相反的两条弧各占一个结点"；
 *   ③ 再补一条 V3→V5 —— V3 于是有两条出边，"顺 firstout 找出边"才走得下去。
 * n=5 时 8 条弧、n=9 时 12 条弧（= n+3）。
 * 最后按 (弧尾, 弧头) 排序：每个顶点的出链按弧头升序、入链按弧尾升序 —— 表里的指针看起来最整齐。
 */
function buildDirected(n: number): WEdge[] {
  const raw: WEdge[] = []
  for (let i = 0; i < n; i++) raw.push({ i, j: (i + 1) % n, w: 0 })
  raw.push({ i: 1, j: 0, w: 0 }) // V2→V1，和 V1→V2 互为反向
  raw.push({ i: 3, j: 2, w: 0 }) // V4→V3，和 V3→V4 互为反向
  raw.push({ i: 2, j: 4, w: 0 }) // V3→V5：V3 的第二条出边
  return raw
    .map((e) => ({ i: e.i, j: e.j, w: weightOf(e.i, e.j, n) }))
    .sort((x, y) => x.i - y.i || x.j - y.j)
}

/** 一张图的全部"现算"结果（同一档 n 只造一次） */
interface GraphData {
  n: number
  /** 顶点名 V1..Vn。id 也用同一个串，边 / badge / 板子里的文字全靠它对齐 */
  allV: string[]
  /** 无向带权图（邻接矩阵 / 邻接表 / 邻接多重表共用），按 (i, j) 排好 */
  und: WEdge[]
  /** 有向图（十字链表用），按 (弧尾, 弧头) 排好 */
  dir: WEdge[]
  /** 每个顶点的邻接边序号，按另一端编号升序 */
  adj: number[][]
  /** 建完之后的邻接矩阵终态：对角线 0、无边 -1（画成 ∞）、有边就是权值 */
  M: number[][]
  /** 最大度数 = 邻接表一行最多挂几个边结点 */
  maxDeg: number
  /** 矩阵列数：第一列是顶点表头，所以是 n + 1 */
  mcols: number
  /** 邻接表列数：第一列是表头，后面 maxDeg 列放边结点 */
  lcols: number
}

const cache = new Map<number, GraphData>()

/**
 * 按顶点数造一张图。**同样的 n 永远得到同一张图**（没有随机数，纯确定性的），
 * 所以"某一步的解说词里说权值是 6"这件事永远成立。
 */
function graphOf(nRaw: number): GraphData {
  const n = clampN(nRaw)
  const hit = cache.get(n)
  if (hit) return hit

  const allV = Array.from({ length: n }, (_, k) => `V${k + 1}`)
  const und = buildUndirected(n)
  const dir = buildDirected(n)

  const adj = Array.from({ length: n }, (_, v) => {
    const list: number[] = []
    und.forEach((e, k) => {
      if (e.i === v || e.j === v) list.push(k)
    })
    return list.sort((x, y) => other(und[x]!, v) - other(und[y]!, v))
  })

  const M = (() => {
    const a = Array.from({ length: n }, () => Array.from({ length: n }, () => -1))
    for (let i = 0; i < n; i++) a[i]![i] = 0
    for (const e of und) {
      a[e.i]![e.j] = e.w
      a[e.j]![e.i] = e.w
    }
    return a
  })()

  const maxDeg = Math.max(...adj.map((l) => l.length))
  const g: GraphData = { n, allV, und, dir, adj, M, maxDeg, mcols: n + 1, lcols: maxDeg + 1 }
  cache.set(n, g)
  return g
}

/** 边的另一端（无向图两个方向都可能引用，靠它换算） */
const other = (e: WEdge, v: number): number => (e.i === v ? e.j : e.i)

/** 顶点的 0-based 下标，写在顶点下方的小字里 —— 正好就是它在矩阵 / 表里的行号 */
const vSub = (k: number): string => `v${k}`

/** 圆周上的 n 个顶点（不含当前状态，状态由每个算法自己给） */
function ringNodes(g: GraphData): GraphNodeSnapshot[] {
  return g.allV.map((id, k) => {
    const p = ring(k, g.n)
    return { id, label: id, x: p.x, y: p.y, sub: vSub(k) }
  })
}

/** 顶点旁边的小标签：矩阵用行号，邻接表用表头号 */
const headBadges = (g: GraphData): Record<string, string> =>
  Object.fromEntries(g.allV.map((id, k) => [id, `第${k}行`]))
const listBadges = (g: GraphData): Record<string, string> =>
  Object.fromEntries(g.allV.map((id, k) => [id, `表头${k}`]))
const emptyBadges = (g: GraphData): Record<string, string> =>
  Object.fromEntries(g.allV.map((id) => [id, '首边—']))

/** 造一张图快照：顶点坐标固定，变的是边的配色和顶点旁边的小标签 */
function view(
  g: GraphData,
  opts: {
    edges: GraphEdgeSnapshot[]
    hot?: string[]
    done?: string[]
    badges?: Record<string, string>
    note?: string
  },
): GraphView {
  return {
    nodes: ringNodes(g),
    edges: opts.edges,
    hot: opts.hot ?? [],
    done: opts.done ?? [],
    badges: opts.badges ?? {},
    note: opts.note,
  }
}

/** 无向图的边快照：w 一律画出来（带权图），配色由调用方按边序号决定 */
function unEdges(
  g: GraphData,
  toneOf?: (k: number, e: WEdge) => CellTone | undefined,
): GraphEdgeSnapshot[] {
  return g.und.map((e, k) => ({
    from: g.allV[e.i]!,
    to: g.allV[e.j]!,
    w: e.w,
    tone: toneOf?.(k, e),
  }))
}

/** 有向图的弧快照：一律画箭头（十字链表必须看得出方向） */
function dirEdges(
  g: GraphData,
  toneOf?: (k: number, e: WEdge) => CellTone | undefined,
): GraphEdgeSnapshot[] {
  return g.dir.map((e, k) => ({
    from: g.allV[e.i]!,
    to: g.allV[e.j]!,
    w: e.w,
    directed: true,
    tone: toneOf?.(k, e),
  }))
}

/** 某个顶点的邻接边全都处理完了 -> 这个顶点画绿色（渲染器的 done） */
function finishedV(g: GraphData, written: Set<number>): string[] {
  return g.allV.filter((_, v) => g.adj[v]!.every((k) => written.has(k)))
}

/** 顺链走：从 start 开始，用 nextOf 取下一条，返回经过的结点序号 */
function walk(start: number | null, nextOf: (k: number) => number | null): number[] {
  const out: number[] = []
  let cur = start
  while (cur !== null) {
    out.push(cur)
    cur = nextOf(cur)
  }
  return out
}

/** 空箭头：还没建的结点格子 */
function blankCells(n: number, sub = '—'): CellItem[] {
  return Array.from({ length: n }, () => ({ text: '', sub, tone: 'dim' as CellTone }))
}

/* ================================================================== *
 * 二、邻接矩阵
 * ================================================================== */

/** 矩阵格子序号：r / c **含表头**（第 0 行、第 0 列是顶点表头） */
const mid = (g: GraphData, r: number, c: number): number => r * g.mcols + c
/** 数据格 (i, j) 的格子序号（i、j 是 0-based 顶点下标） */
const mdata = (g: GraphData, i: number, j: number): number => mid(g, i + 1, j + 1)

const mtext = (v: number): string => (v === -1 ? '∞' : String(v))

const MATRIX_NOTE =
  '第 0 行 / 第 0 列是顶点表头 vex，其余格子才是 arc[i][j]：对角线写 0，其余先全部写 ∞（灰 = 还没读到这条边）；紫色 = 正在写的格子，绿色 = 已经存好的边'

/**
 * 邻接矩阵板。
 *
 * **画的是"当前已经建成的样子"，不是最终结果**：只有落在 filled 里的格子才显示权值，
 * 别的格子一律还是 ∞。这一点是这个算法的立身之本 ——
 * 读一条边只填两个对称格，没读到的边就不该有权值（否则首帧整张矩阵的权值全在，
 * 既和「已填格」计数矛盾，也把答案提前剧透了）：
 * **第 0 帧除了对角线的 n 个 0，其余 n²-n 格全是 ∞。**
 *
 * @param filled 已经写进矩阵的格子序号（= 已读过的边对应的那些对称格）
 * @param hot 正在写的两个格子序号，画紫色；此刻它们的值还是 ∞
 * @param pointers 当前行 / 列 / 格子的黄色小标签
 */
function matrixBoard(
  g: GraphData,
  opts: {
    hot?: number[]
    filled?: number[]
    pointers?: Record<string, number>
    note?: string
  } = {},
): BoardView {
  const hot = new Set(opts.hot ?? [])
  const filled = new Set(opts.filled ?? [])
  const items: CellItem[] = [{ text: '顶点', sub: 'vex', tone: 'base' }]
  for (let j = 0; j < g.n; j++) items.push({ text: g.allV[j]!, sub: `列${j}`, tone: 'base' })
  for (let i = 0; i < g.n; i++) {
    items.push({ text: g.allV[i]!, sub: `行${i}`, tone: 'base' })
    for (let j = 0; j < g.n; j++) {
      const idx = mdata(g, i, j)
      // 初始化时对角线就写 0，其余先写 ∞；只有真读过的边才把权值写上去
      const written = filled.has(idx)
      const text = written ? mtext(g.M[i]![j]!) : i === j ? '0' : '∞'
      const tone: CellTone = hot.has(idx) ? 'hot' : written ? 'done' : i === j ? 'base' : 'dim'
      items.push({ text, sub: `${i},${j}`, tone })
    }
  }
  return {
    title: `邻接矩阵 arc[0..${g.n - 1}][0..${g.n - 1}]　共 ${g.n}×${g.n} = ${g.n * g.n} 格`,
    layout: 'grid',
    cols: g.mcols,
    items,
    pointers: opts.pointers,
    note: opts.note ?? MATRIX_NOTE,
  }
}

const CODE_MATRIX = [
  '// 邻接矩阵：n×n 的二维数组 arc 就是一张图，arc[i][j] 表示顶点 i 到 j 的关系',
  'typedef struct { int vex[N]; int arc[N][N]; } MGraph;   // 顶点表 + 邻接矩阵',
  '#define N 顶点数   // 顶点数 = 数据规模（5..9 任选）：矩阵永远是 N×N 格',
  'int w = weightOf(vi, vj);                    // 读出一条边：两个端点和权值',
  'if (w != INF) {                              // 无向图的边两个方向都通，要写两个格子',
  '  arc[i][j] = w;                             // 顺着写一份',
  '  arc[j][i] = w;                             // 对称位置再写一份 —— 矩阵沿主对角线对称',
  '}',
  'bool adjacent(int i, int j) { return arc[i][j] != INF; }   // 查边 O(1)，不用遍历',
  '// 空间固定 n*n：稠密图划算；边少的时候大半格子都是 ∞，这才有了邻接表',
]

function* runAdjMatrix(data: number[]): AlgoRunner {
  const g = graphOf(data.length)
  const arr = vertexIds(g.n)
  const written = new Set<number>()
  /** 已经填好的矩阵格子序号（= 画面里有权值的那些格子；底部「已填格」就是它的长度） */
  const filled: number[] = []
  const badges = (): Record<string, string> => headBadges(g)

  yield {
    line: 1,
    action: 'init',
    array: arr,
    graph: view(g, {
      // 一条边都还没读：图上的边先画成灰色虚线，权值也压暗 —— 表示"还没进矩阵"
      edges: unEdges(g, () => 'dim'),
      badges: badges(),
      note: `无向带权图：${g.n} 个顶点、${g.und.length} 条带权的边；下面这张矩阵就是它在内存里的样子`,
    }),
    boards: [matrixBoard(g)],
    comment: `要存的是这张无向带权图：${g.n} 个顶点 V1..V${g.n}、${g.und.length} 条边，每条边都有权值（顶点下方的小字 v0..v${g.n - 1} 就是它在表格里的下标）。邻接矩阵把图存成一个 ${g.n}×${g.n} 的二维数组：第 0 行和第 0 列是**顶点表**，剩下的 arc[i][j] 写"顶点 i 和 j 之间那条边的权值"，没有边就写 ∞，对角线写 0。矩阵现在的状态是：**对角线 ${g.n} 个 0，其余 ${g.n * g.n - g.n} 格全是 ∞** —— 一条边都还没读进来，所以图上的边也是灰的。`,
    vars: { n: g.n, 边数: g.und.length, 已填格: 0 },
  }

  for (let k = 0; k < g.und.length; k++) {
    const e = g.und[k]!
    const a = e.i
    const b = e.j
    const c1 = mdata(g, a, b)
    const c2 = mdata(g, b, a)
    const pointers = { 行: mid(g, a + 1, 0), 列: mid(g, 0, b + 1), 'i,j': c1, 'j,i': c2 }

    yield {
      line: 5,
      action: 'mark',
      array: arr,
      indices: [a, b],
      graph: view(g, {
        edges: unEdges(g, (x) => (x === k ? 'hot' : written.has(x) ? 'done' : 'dim')),
        hot: [g.allV[a]!, g.allV[b]!],
        done: finishedV(g, written),
        badges: badges(),
        note: `正在读第 ${k + 1} 条边：${g.allV[a]} — ${g.allV[b]}，权值 ${e.w}`,
      }),
      boards: [matrixBoard(g, { hot: [c1, c2], filled, pointers })],
      comment: `读第 ${k + 1}/${g.und.length} 条边：${g.allV[a]} — ${g.allV[b]}，权值 ${e.w}。它在矩阵里对应 arc[${a}][${b}] 和 arc[${b}][${a}] **两个**格子 —— 无向图的边两个方向都通，所以两个格子要一起点亮（紫色）。这两格现在还是 ∞，权值要下一步才写进去。`,
      vars: { i: a, j: b, w: e.w, 已填格: filled.length },
    }

    written.add(k)
    filled.push(c1, c2)

    yield {
      line: 7,
      action: 'set',
      array: arr,
      indices: [a, b],
      graph: view(g, {
        edges: unEdges(g, (x) => (written.has(x) ? 'done' : 'dim')),
        hot: [g.allV[a]!, g.allV[b]!],
        done: finishedV(g, written),
        badges: badges(),
        note: `${g.allV[a]} — ${g.allV[b]} 已经进矩阵：arc[${a}][${b}] = arc[${b}][${a}] = ${e.w}`,
      }),
      // 这一帧两格已经写成权值，所以是绿色（done），不再点紫
      boards: [matrixBoard(g, { filled, pointers })],
      comment: `把权值填进去：arc[${a}][${b}] = arc[${b}][${a}] = ${e.w}，两个对称的格子写同一个值 —— 它们一起从 ∞ 变成 ${e.w}、一起变绿。到这里一共填好 ${filled.length} 个格子（就是画面里有权值的格子数）；没读到的边一直是 ∞，对角线是 0。`,
      vars: { i: a, j: b, w: e.w, 已填格: filled.length },
    }
  }

  // 查边演示：直接读一个格子。挑 V1 和它在链上排第 2 个的邻接点 —— 这条边一定存在（V1—V3 那条弦）
  const qi = 0
  const qAdj = g.adj[qi]!
  const qk = qAdj[Math.min(1, qAdj.length - 1)]!
  const qj = other(g.und[qk]!, qi)
  const qc = mdata(g, qi, qj)
  yield {
    line: 9,
    action: 'compare',
    array: arr,
    indices: [qi, qj],
    graph: view(g, {
      edges: unEdges(g, (x) => (x === qk ? 'hot' : 'done')),
      hot: [g.allV[qi]!, g.allV[qj]!],
      done: finishedV(g, written),
      badges: badges(),
      note: `查 ${g.allV[qi]} 和 ${g.allV[qj]} 是否相邻：直接看 arc[${qi}][${qj}] = ${g.M[qi]![qj]!}`,
    }),
    boards: [
      matrixBoard(g, {
        hot: [qc],
        filled,
        pointers: { 行: mid(g, qi + 1, 0), 列: mid(g, 0, qj + 1), 查询格: qc },
      }),
    ],
    comment: `查边：${g.allV[qi]} 和 ${g.allV[qj]} 之间有没有边、权值多少？不用翻别的格子，直接读 arc[${qi}][${qj}] = ${g.M[qi]![qj]!} ≠ ∞ —— 一步就有答案，查边是 O(1)。这是邻接矩阵最大的好处。`,
    vars: { i: qi, j: qj, w: g.M[qi]![qj]!, 已填格: filled.length },
  }

  yield {
    line: 10,
    action: 'done',
    array: arr,
    graph: view(g, {
      edges: unEdges(g, () => 'done'),
      done: g.allV,
      badges: badges(),
      note: `${g.und.length} 条边全都进了矩阵：${g.n * g.n} 个格子里有 ${filled.length} 个写着权值`,
    }),
    boards: [matrixBoard(g, { filled })],
    comment: `存完了：${g.und.length} 条边占了 ${filled.length} 个格子（每条边两个对称格），对角线的 ${g.n} 个格子是 0，剩下 ${g.n * g.n - filled.length - g.n} 个格子是 ∞。空间永远是 n² = ${g.n * g.n}，和图里有多少条边无关 —— 稠密图划算，边少的图很浪费，所以还要学邻接表。`,
    vars: { n: g.n, 边数: g.und.length, 权值格: filled.length },
  }
}

/* ================================================================== *
 * 三、邻接表
 * ================================================================== */

const LIST_NOTE =
  '每行一个顶点：第一格是表头（顶点名 + firstedge），后面是它的边结点（邻接点 + 权值）；橙色箭头就是 next 指针，空的格子画成暗色'

/**
 * 邻接表板。`seen[v]` = 顶点 v 的链上已经建好几个边结点了 ——
 * 建到第几个就画几个，后面的格子留空（暗色），这样"链在长"是看得见的。
 * 列数 = 1 + 最大度数（现算），行数 = 1 + 顶点数 —— 都跟着数据规模走。
 */
function listBoard(
  g: GraphData,
  opts: {
    seen: number[]
    hot?: number[]
    done?: number[]
    dim?: Set<number>
    pointers?: Record<string, number>
    note?: string
  },
): BoardView {
  const hot = new Set(opts.hot ?? [])
  const done = new Set(opts.done ?? [])
  const dim = opts.dim ?? new Set<number>()
  const cols = g.lcols
  const lid = (r: number, c: number): number => r * cols + c
  const items: CellItem[] = [{ text: '表头', sub: 'vex', tone: 'base' }]
  for (let c = 1; c < cols; c++) items.push({ text: `边结点${c}`, sub: 'edge', tone: 'base' })
  const links: Array<{ from: number; to: number; dir: 'right' }> = []

  for (let v = 0; v < g.n; v++) {
    const head = lid(v + 1, 0)
    items.push({
      text: g.allV[v]!,
      sub: 'first',
      tone: hot.has(head) ? 'hot' : done.has(head) ? 'done' : 'base',
    })
    const cnt = opts.seen[v] ?? 0
    for (let c = 0; c < g.maxDeg; c++) {
      const idx = lid(v + 1, c + 1)
      if (c < cnt) {
        const e = g.und[g.adj[v]![c]!]!
        const to = other(e, v)
        const tone: CellTone = hot.has(idx)
          ? 'hot'
          : dim.has(idx)
            ? 'dim'
            : done.has(idx)
              ? 'done'
              : 'base'
        items.push({ text: g.allV[to]!, sub: `权${e.w}`, tone })
      } else {
        items.push(...blankCells(1))
      }
    }
    // 链：表头 -> 第 1 个边结点 -> 第 2 个 ...（画成橙色箭头）
    for (let c = 0; c < cnt; c++) links.push({ from: lid(v + 1, c), to: lid(v + 1, c + 1), dir: 'right' })
  }

  return {
    title: `邻接表　${g.n} 个表头 + ${g.und.length * 2} 个边结点（无向图每条边存两遍）`,
    layout: 'grid',
    cols,
    items,
    pointers: opts.pointers,
    links: links.length ? links : undefined,
    note: opts.note ?? LIST_NOTE,
  }
}

const CODE_LIST = [
  '// 邻接表：n 个表头（顶点表）+ 每条边一个边结点，边结点挂在表头后面串成单链表',
  '#define N 顶点数   // 顶点数 = 数据规模（5..9 任选）：n 个表头 + 每条边一个边结点',
  'typedef struct ArcNode { int adjvex; int weight; struct ArcNode *next; } ArcNode;  // 边结点',
  'typedef struct VNode { int data; ArcNode *firstedge; } VNode;                      // 表头',
  'VNode G[N];                                   // 顶点表：一个顶点一个表头，firstedge 指向链上第一个边结点',
  'for (int v = 0; v < N; v++) {                 // 一行一行地建链',
  '  for (v 的每个邻接点 u) {                     // 无向图里这条边在两个顶点的链里各出现一次',
  '    ArcNode *p = new ArcNode;                 // 申请一个边结点',
  '    p->adjvex = u; p->weight = weight(u, v);  // 记下邻接点下标和权值',
  '    p->next = NULL; 接到 v 的链尾;            // 挂到链尾，链尾的 next 就是 NULL',
  '  }',
  '}',
  '// n 个表头 + 2e 个边结点；查边要顺着链走，O(顶点度数)',
]

function* runAdjList(data: number[]): AlgoRunner {
  const g = graphOf(data.length)
  const arr = vertexIds(g.n)
  const seen: number[] = Array.from({ length: g.n }, () => 0)
  /** 已经进过链的边序号（图上画成绿色） */
  const shown = new Set<number>()
  const doneRows: boolean[] = Array.from({ length: g.n }, () => false)
  const badges = (): Record<string, string> => listBadges(g)
  const doneV = (): string[] => g.allV.filter((_, v) => doneRows[v])
  /** 邻接表格子序号：第 0 行是列名，第 r + 1 行才是顶点 r（和 listBoard 里同一套算法） */
  const lid = (r: number, c: number): number => r * g.lcols + c
  /** 已经建好的格子（表头 + 边结点），用来画绿色 */
  const doneCells = (): number[] => {
    const out: number[] = []
    for (let v = 0; v < g.n; v++) {
      if (doneRows[v]) out.push(lid(v + 1, 0))
      for (let c = 0; c < seen[v]!; c++) out.push(lid(v + 1, c + 1))
    }
    return out
  }

  yield {
    line: 1,
    action: 'init',
    array: arr,
    graph: view(g, {
      edges: unEdges(g),
      badges: badges(),
      note: `无向带权图：${g.n} 个顶点、${g.und.length} 条边；下面这张表就是它的邻接表`,
    }),
    boards: [listBoard(g, { seen })],
    comment: `还是这张无向带权图（${g.n} 个顶点、${g.und.length} 条边）。邻接表换一种存法：**每个顶点一个表头**，它的每个邻接点占一个**边结点**（存邻接点下标 adjvex、权值 weight、next 指针），边结点串成一条链挂在表头后面。下面这张表，每行就是一个顶点的链。`,
    vars: { n: g.n, 边数: g.und.length },
  }

  for (let v = 0; v < g.n; v++) {
    const deg = g.adj[v]!.length
    yield {
      line: 5,
      action: 'mark',
      array: arr,
      indices: [v],
      graph: view(g, {
        edges: unEdges(g, (k, e) => {
          if (e.i === v || e.j === v) return 'hot'
          return shown.has(k) ? 'done' : undefined
        }),
        hot: [g.allV[v]!],
        done: doneV(),
        badges: badges(),
        note: `第 ${v + 1} 行：${g.allV[v]} 的链上要挂 ${deg} 个边结点（它的度是 ${deg}）`,
      }),
      boards: [listBoard(g, { seen, hot: [lid(v + 1, 0)], pointers: { 表头: lid(v + 1, 0) } })],
      comment: `看第 ${v + 1} 个表头 ${g.allV[v]}：它存顶点信息和一个 firstedge 指针（指向链上第一个边结点）。${g.allV[v]} 的度是 ${deg}，所以这一行的链上有 ${deg} 个边结点 —— 图上紫色的就是它的这些邻边。`,
      vars: { 顶点: v, 度: deg },
    }

    for (let t = 0; t < deg; t++) {
      const k = g.adj[v]![t]!
      const e = g.und[k]!
      const to = other(e, v)
      seen[v] = t + 1
      shown.add(k)
      const cell = lid(v + 1, t + 1)
      const ptrs: Record<string, number> = { 表头: lid(v + 1, 0), 新结点: cell }
      if (t > 0) ptrs.上一个结点 = lid(v + 1, t)

      yield {
        line: 9,
        action: 'set',
        array: arr,
        indices: [v, to],
        graph: view(g, {
          edges: unEdges(g, (x, ex) => {
            if (x === k) return 'hot'
            if (ex.i === v || ex.j === v) return 'done'
            return shown.has(x) ? 'done' : undefined
          }),
          hot: [g.allV[v]!, g.allV[to]!],
          done: doneV(),
          badges: badges(),
          note: `${g.allV[v]} 链上的第 ${t + 1} 个边结点：邻接点 ${g.allV[to]}，权值 ${e.w}`,
        }),
        boards: [
          listBoard(g, {
            seen,
            hot: [cell],
            done: doneCells().filter((c) => c !== cell),
            pointers: ptrs,
          }),
        ],
        comment: `沿 ${g.allV[v]} 的链走到第 ${t + 1} 个边结点：邻接点是 ${g.allV[to]}，权值 ${e.w}。于是写 adjvex = ${to}（也就是 ${g.allV[to]}）、weight = ${e.w}；next 指针${
          t + 1 < deg ? '指向下一个边结点' : '写 NULL —— 它是这条链的最后一个结点'
        }。`,
        vars: { 顶点: v, adjvex: to, 权: e.w },
      }
    }

    doneRows[v] = true
    yield {
      line: 10,
      action: 'mark',
      array: arr,
      indices: [v],
      graph: view(g, {
        edges: unEdges(g, (k, e) => (e.i === v || e.j === v || shown.has(k) ? 'done' : undefined)),
        hot: [],
        done: doneV(),
        badges: badges(),
        note: `${g.allV[v]} 这一行建完了：${deg} 个边结点，最后一个的 next = NULL`,
      }),
      boards: [listBoard(g, { seen, done: doneCells(), pointers: { 表头: lid(v + 1, 0) } })],
      comment: `${g.allV[v]} 的链建完了：${deg} 个边结点，最后一个的 next = NULL，链到此结束。图上和 ${g.allV[v]} 相连的边都已经记进这一行了。`,
      vars: { 顶点: v, 度: deg },
    }
  }

  // 查边演示：顺着 V1 的链一个一个比。挑链上第 2 个邻接点 —— 这条边一定存在（V1—V3 那条弦），
  // 而且必须走两下才找得到，正好看出"查边要 O(顶点度数)"
  const qi = 0
  const qAdj = g.adj[qi]!
  const qk = qAdj[Math.min(1, qAdj.length - 1)]!
  const qj = other(g.und[qk]!, qi)
  const scanned: number[] = []
  for (let t = 0; t < qAdj.length; t++) {
    const k = qAdj[t]!
    const e = g.und[k]!
    const to = other(e, qi)
    const cell = lid(qi + 1, t + 1)
    const found = to === qj
    if (!found) scanned.push(cell)
    yield {
      line: 13,
      action: found ? 'compare' : 'mark',
      array: arr,
      indices: [qi, to],
      graph: view(g, {
        edges: unEdges(g, (x) => (x === k || x === qk ? 'hot' : undefined)),
        hot: found ? [g.allV[qi]!, g.allV[qj]!] : [g.allV[qi]!],
        done: doneV(),
        badges: badges(),
        note: found
          ? `在 ${g.allV[qi]} 的链上找到了 ${g.allV[qj]}`
          : `第 ${t + 1} 个结点是 ${g.allV[to]}，不是 ${g.allV[qj]}，沿 next 继续走`,
      }),
      boards: [
        listBoard(g, {
          seen,
          hot: [cell],
          done: doneCells(),
          dim: new Set(scanned),
          pointers: { 表头: lid(qi + 1, 0), p: cell },
        }),
      ],
      comment: found
        ? `找到啦：第 ${t + 1} 个边结点的 adjvex 就是 ${qj}（${g.allV[qj]}），权值 ${e.w}。注意一共比了 ${t + 1} 次 —— 邻接表查一条边最坏要把整条链走完，也就是 O(顶点度数)，不像矩阵那样 O(1)。`
        : `查 ${g.allV[qi]} 和 ${g.allV[qj]} 之间有没有边：从 ${g.allV[qi]} 的 firstedge 出发，第 ${t + 1} 个结点的 adjvex = ${to}（${g.allV[to]}），不是 ${qj}，沿 next 继续走。`,
      vars: { 比较次数: t + 1 },
    }
    if (found) break
  }

  yield {
    line: 13,
    action: 'done',
    array: arr,
    graph: view(g, {
      edges: unEdges(g, () => 'done'),
      done: g.allV,
      badges: badges(),
      note: `${g.n} 个表头 + ${g.und.length * 2} 个边结点 = ${g.n + g.und.length * 2} 个结点`,
    }),
    boards: [listBoard(g, { seen, done: doneCells() })],
    comment: `存完了：${g.n} 个表头 + ${g.und.length * 2} 个边结点（无向图里每条边在两个顶点的链里各存一次，所以 ${g.und.length} 条边变成 ${g.und.length * 2} 个结点）= ${g.n + g.und.length * 2} 个结点。和矩阵固定的 ${g.n * g.n} 个格子比，顶点多、边少时邻接表省得多；代价是查一条边要从链头走，而且无向图一条边存了两遍 —— 这就是后面邻接多重表要解决的问题。`,
    vars: { 表头: g.n, 边结点: g.und.length * 2 },
  }
}

/* ================================================================== *
 * 四、十字链表（有向图）
 * ================================================================== */

const OCOLS = 5
/** 弧结点表格子序号：第 0 行是列名，第 k + 1 行才是弧 e(k+1) */
const oid = (r: number, c: number): number => r * OCOLS + c

/** 十字链表里的一个弧结点（每个域正好对应 board 上的一列） */
interface Arc {
  /** 弧尾（从哪出发） */
  a: number
  /** 弧头（指向谁） */
  b: number
  w: number
  /** 同弧头链：弧头相同的下一条弧 —— 找**入边**顺着它走 */
  hlink: number | null
  /** 同弧尾链：弧尾相同的下一条弧 —— 找**出边**顺着它走 */
  tlink: number | null
}

const ORTH_NOTE =
  '一个弧结点 5 个域：弧尾 tailvex、弧头 headvex、权 info、hlink（同弧头链 = 入边链）、tlink（同弧尾链 = 出边链）；还没建的弧画成暗色'

/**
 * 弧结点表：一行一条弧，行号就是弧的编号（e1、e2…… 在弧尾那一格的 sub 里）。
 * 行数 = 弧数 = n+3，跟着数据规模走；5 个域是结构本身决定的，列数固定 5。
 */
function orthBoard(
  g: GraphData,
  opts: {
    arcs: Arc[]
    created: number
    hot?: number[]
    done?: number[]
    pointers?: Record<string, number>
    note?: string
  },
): BoardView {
  const hot = new Set(opts.hot ?? [])
  const done = new Set(opts.done ?? [])
  const items: CellItem[] = [
    { text: '弧尾', sub: 'tailvex', tone: 'base' },
    { text: '弧头', sub: 'headvex', tone: 'base' },
    { text: '权', sub: 'info', tone: 'base' },
    { text: '同弧头链', sub: 'hlink', tone: 'base' },
    { text: '同弧尾链', sub: 'tlink', tone: 'base' },
  ]
  for (let k = 0; k < opts.arcs.length; k++) {
    if (k >= opts.created) {
      items.push(...blankCells(OCOLS))
      continue
    }
    const nd = opts.arcs[k]!
    const row = oid(k + 1, 0)
    const tone: CellTone = hot.has(row) ? 'hot' : done.has(row) ? 'done' : 'base'
    items.push({ text: g.allV[nd.a]!, sub: `e${k + 1}`, tone })
    items.push({ text: g.allV[nd.b]!, tone })
    items.push({ text: String(nd.w), tone })
    items.push({ text: nd.hlink === null ? 'NULL' : `e${nd.hlink + 1}`, sub: '入链', tone })
    items.push({ text: nd.tlink === null ? 'NULL' : `e${nd.tlink + 1}`, sub: '出链', tone })
  }
  return {
    title: `十字链表 · 弧结点表　${g.dir.length} 条弧 = ${g.dir.length} 个弧结点（每条弧只存一遍）`,
    layout: 'grid',
    cols: OCOLS,
    items,
    pointers: opts.pointers,
    note: opts.note ?? ORTH_NOTE,
  }
}

const CODE_ORTH = [
  '// 十字链表：有向图的弧结点同时挂在"同弧尾链"和"同弧头链"上',
  'typedef struct ArcBox {',
  '  int tailvex, headvex;          // 弧尾、弧头：这条弧从谁指向谁',
  '  struct ArcBox *hlink, *tlink;  // hlink = 同弧头链，tlink = 同弧尾链',
  '  int info;                      // 权值等信息',
  '} ArcBox;',
  'typedef struct VexNode { int data; ArcBox *firstin, *firstout; } VexNode;   // 顶点结点',
  'ArcBox *p = new ArcBox; p->tailvex = i; p->headvex = j; p->info = w;   // 建弧结点，两条链先置空',
  '把 p 接到 i 的"同弧尾链"末尾;   // i 的 firstout 现在能找到这条出边',
  '把 p 接到 j 的"同弧头链"末尾;   // j 的 firstin 现在能找到这条入边',
  '// 入边：顺 j 的 firstin 走 hlink；出边：顺 i 的 firstout 走 tlink —— 两个方向都方便',
  '// 有向图的邻接表只有出边好找，想找入边得扫全部顶点，这就是十字链表的用处',
]

function* runOrth(data: number[]): AlgoRunner {
  const g = graphOf(data.length)
  const arr = vertexIds(g.n)
  const arcs: Arc[] = g.dir.map((e) => ({ a: e.i, b: e.j, w: e.w, hlink: null, tlink: null }))
  /** 已经建好几个弧结点 */
  let created = 0
  const firstOut: Array<number | null> = Array.from({ length: g.n }, () => null)
  const firstIn: Array<number | null> = Array.from({ length: g.n }, () => null)
  const lastOut: Array<number | null> = Array.from({ length: g.n }, () => null)
  const lastIn: Array<number | null> = Array.from({ length: g.n }, () => null)

  const badges = (): Record<string, string> =>
    Object.fromEntries(
      g.allV.map((id, v) => {
        const o = firstOut[v]
        const i = firstIn[v]
        return [id, `出${o === null ? '—' : `e${o + 1}`}/入${i === null ? '—' : `e${i + 1}`}`]
      }),
    )
  const board = (
    hot: number[] = [],
    done: number[] = [],
    pointers?: Record<string, number>,
    note?: string,
  ): BoardView => orthBoard(g, { arcs, created, hot, done, pointers, note })

  /**
   * 这条弧的**反向弧**（存在、而且排在它前面的话）——
   * 解说里的"这两条是方向相反的两条弧"靠它，不能拿 a > b 硬判：
   * 有向环里 Vn→V1 这种弧也是 a > b，但它没有反向弧。
   */
  const revOf = (k: number): number =>
    arcs.findIndex((e, x) => x < k && e.a === arcs[k]!.b && e.b === arcs[k]!.a)

  yield {
    line: 1,
    action: 'init',
    array: arr,
    graph: view(g, {
      edges: dirEdges(g),
      badges: badges(),
      note: `有向图：${g.n} 个顶点、${g.dir.length} 条弧，箭头方向就是弧的方向；V1⇄V2、V3⇄V4 是两对互为反向的弧`,
    }),
    boards: [board([], [], undefined, '还没开始建：弧结点表是空的')],
    comment: `十字链表存的是**有向图**：这张图有 ${g.n} 个顶点、${g.dir.length} 条弧（其中有 V1⇄V2、V3⇄V4 两对**互为反向**的弧，箭头方向就是弧的方向）。每个弧结点有 5 个域：tailvex 记弧尾、headvex 记弧头、info 记权值、tlink 指向"弧尾相同的下一条弧"（出边链）、hlink 指向"弧头相同的下一条弧"（入边链）。下面这张表就是弧结点表。`,
    vars: { n: g.n, 弧数: g.dir.length },
  }

  for (let k = 0; k < arcs.length; k++) {
    const nd = arcs[k]!
    created = k + 1
    const row = oid(k + 1, 0)
    const rev = revOf(k)

    yield {
      line: 8,
      action: 'set',
      array: arr,
      indices: [nd.a, nd.b],
      graph: view(g, {
        edges: dirEdges(g, (x) => (x === k ? 'hot' : x < k ? 'done' : undefined)),
        hot: [g.allV[nd.a]!, g.allV[nd.b]!],
        done: [],
        badges: badges(),
        note: `新建弧结点 e${k + 1}：${g.allV[nd.a]} → ${g.allV[nd.b]}，权值 ${nd.w}`,
      }),
      boards: [board([row], [], { 新弧: row, tlink: oid(k + 1, 4), hlink: oid(k + 1, 3) })],
      comment: `建第 ${k + 1}/${g.dir.length} 个弧结点：这是一条从 ${g.allV[nd.a]} 指向 ${g.allV[nd.b]} 的弧，权值 ${nd.w}。写 tailvex = ${g.allV[nd.a]}、headvex = ${g.allV[nd.b]}、info = ${nd.w}；hlink 和 tlink 先置空（NULL）。${
        rev >= 0
          ? `注意它和前面那条 e${rev + 1}（${g.allV[arcs[rev]!.a]} → ${g.allV[arcs[rev]!.b]}）是方向相反的两条弧 —— 有向图里它们各占一个弧结点，谁也不是谁的"对称格"。`
          : ''
      }`,
      vars: { 弧: k + 1, 权: nd.w },
    }

    const prevOut = lastOut[nd.a]
    const prevIn = lastIn[nd.b]
    if (prevOut === null) firstOut[nd.a] = k
    else arcs[prevOut]!.tlink = k
    lastOut[nd.a] = k
    if (prevIn === null) firstIn[nd.b] = k
    else arcs[prevIn]!.hlink = k
    lastIn[nd.b] = k

    const ptrs: Record<string, number> = { 新弧: row, 出链: oid(k + 1, 4) }
    if (prevOut !== null) ptrs.出链前驱 = oid(prevOut + 1, 4)
    yield {
      line: 9,
      action: 'set',
      array: arr,
      indices: [nd.a, nd.b],
      graph: view(g, {
        edges: dirEdges(g, (x) => (x === k ? 'hot' : x < k ? 'done' : undefined)),
        hot: [g.allV[nd.a]!],
        done: [],
        badges: badges(),
        note: `把 e${k + 1} 接到 ${g.allV[nd.a]} 的同弧尾链（出边链）上：现在顺 firstout 就能找到 ${g.allV[nd.a]} 的所有出边`,
      }),
      boards: [board([row], [], ptrs)],
      comment: `先挂"同弧尾链"（出边链）：弧尾相同的弧串成一条链，${g.allV[nd.a]} 的 firstout 指向链头，顺着 tlink 就能列完它的所有出边。${
        prevOut === null
          ? `${g.allV[nd.a]} 原来还没有出边，所以顶点表里 firstout[${nd.a}] 直接指向 e${k + 1}。`
          : `${g.allV[nd.a]} 的出链原来末尾是 e${prevOut + 1}，把它那一格的 tlink 由 NULL 改成 e${k + 1}。`
      }`,
      vars: { 弧: k + 1, 弧尾: nd.a },
    }

    const ptrsIn: Record<string, number> = { 新弧: row, 入链: oid(k + 1, 3) }
    if (prevIn !== null) ptrsIn.入链前驱 = oid(prevIn + 1, 3)
    yield {
      line: 10,
      action: 'set',
      array: arr,
      indices: [nd.a, nd.b],
      graph: view(g, {
        edges: dirEdges(g, (x) => (x === k ? 'hot' : x <= k ? 'done' : undefined)),
        hot: [g.allV[nd.b]!],
        done: [],
        badges: badges(),
        note: `把 e${k + 1} 接到 ${g.allV[nd.b]} 的同弧头链（入边链）上：现在顺 firstin 就能找到 ${g.allV[nd.b]} 的所有入边`,
      }),
      boards: [board([row], [], ptrsIn)],
      comment: `再挂"同弧头链"（入边链）：弧头相同的弧串成另一条链，${g.allV[nd.b]} 的 firstin 指向链头，顺着 hlink 就能列完它的所有入边。${
        prevIn === null
          ? `${g.allV[nd.b]} 原来还没有入边，所以顶点表里 firstin[${nd.b}] 直接指向 e${k + 1}。`
          : `${g.allV[nd.b]} 的入链原来末尾是 e${prevIn + 1}，把它那一格的 hlink 由 NULL 改成 e${k + 1}。`
      }`,
      vars: { 弧: k + 1, 弧头: nd.b },
    }
  }

  // 遍历演示：V3 的出边、入边。V3 在这张图里既有出边也有入边（V3→V4、V3→V5 / V2→V3、V4→V3），
  // 顺着 firstout 和 firstin 各走一遍，正好对照"两个方向都方便"
  const qv = 2
  const outChain = walk(firstOut[qv], (k) => arcs[k]!.tlink)
  const inChain = walk(firstIn[qv], (k) => arcs[k]!.hlink)
  const outNames = outChain.map((k) => `${g.allV[arcs[k]!.a]}→${g.allV[arcs[k]!.b]}`)
  const inNames = inChain.map((k) => `${g.allV[arcs[k]!.a]}→${g.allV[arcs[k]!.b]}`)

  for (let t = 0; t < outChain.length; t++) {
    const k = outChain[t]!
    const nd = arcs[k]!
    yield {
      line: 11,
      action: 'mark',
      array: arr,
      indices: [qv, nd.b],
      graph: view(g, {
        edges: dirEdges(g, (x) => (x === k ? 'hot' : outChain.includes(x) ? 'done' : undefined)),
        hot: [g.allV[qv]!, g.allV[nd.b]!],
        done: [g.allV[qv]!],
        badges: badges(),
        note: `顺 ${g.allV[qv]} 的 firstout 找出边：第 ${t + 1} 条是 e${k + 1}（${g.allV[qv]} → ${g.allV[nd.b]}，权 ${nd.w}）`,
      }),
      boards: [
        board(
          [oid(k + 1, 0)],
          outChain.filter((x) => x !== k).map((x) => oid(x + 1, 0)),
          { 当前弧: oid(k + 1, 0), tlink: oid(k + 1, 4) },
        ),
      ],
      comment: `找出边：从 ${g.allV[qv]} 的 firstout 出发，第 ${t + 1} 条弧是 e${k + 1}：${g.allV[qv]} → ${g.allV[nd.b]}，权 ${nd.w}。${
        nd.tlink === null
          ? '它的 tlink 是 NULL，说明这是最后一条出边。'
          : `它的 tlink 指向 e${nd.tlink + 1}，接着往下走。`
      }`,
      vars: { 第几条出边: t + 1 },
    }
  }
  yield {
    line: 11,
    action: 'mark',
    array: arr,
    indices: [qv],
    graph: view(g, {
      edges: dirEdges(g, (x) => (outChain.includes(x) ? 'done' : undefined)),
      hot: [g.allV[qv]!],
      done: [g.allV[qv]!],
      badges: badges(),
      note: `${g.allV[qv]} 的出边一共 ${outChain.length} 条：${outNames.join('、')}`,
    }),
    boards: [board([], outChain.map((x) => oid(x + 1, 0)))],
    comment: `${g.allV[qv]} 的出边一共 ${outChain.length} 条：${outNames.join('、')}，一条不多一条不少 —— 有向图里顺着 firstout 走出链，出边就找全了。`,
    vars: { 出边数: outChain.length },
  }

  for (let t = 0; t < inChain.length; t++) {
    const k = inChain[t]!
    const nd = arcs[k]!
    yield {
      line: 11,
      action: 'mark',
      array: arr,
      indices: [nd.a, qv],
      graph: view(g, {
        edges: dirEdges(g, (x) => (x === k ? 'hot' : inChain.includes(x) ? 'done' : undefined)),
        hot: [g.allV[nd.a]!, g.allV[qv]!],
        done: [g.allV[qv]!],
        badges: badges(),
        note: `顺 ${g.allV[qv]} 的 firstin 找入边：第 ${t + 1} 条是 e${k + 1}（${g.allV[nd.a]} → ${g.allV[qv]}，权 ${nd.w}）`,
      }),
      boards: [
        board(
          [oid(k + 1, 0)],
          inChain.filter((x) => x !== k).map((x) => oid(x + 1, 0)),
          { 当前弧: oid(k + 1, 0), hlink: oid(k + 1, 3) },
        ),
      ],
      comment: `找入边：从 ${g.allV[qv]} 的 firstin 出发，第 ${t + 1} 条弧是 e${k + 1}：${g.allV[nd.a]} → ${g.allV[qv]}，权 ${nd.w}。${
        nd.hlink === null
          ? '它的 hlink 是 NULL，入边就找完了。'
          : `它的 hlink 指向 e${nd.hlink + 1}，继续走。`
      }`,
      vars: { 第几条入边: t + 1 },
    }
  }

  yield {
    line: 12,
    action: 'done',
    array: arr,
    graph: view(g, {
      edges: dirEdges(g, () => 'done'),
      done: g.allV,
      badges: badges(),
      note: `${g.dir.length} 条弧 = ${g.dir.length} 个弧结点；${g.allV[qv]} 的出边：${outNames.join('、')}；入边：${inNames.join('、')}`,
    }),
    boards: [board([], arcs.map((_, k) => oid(k + 1, 0)))],
    comment: `建完了：${g.dir.length} 条弧只占 ${g.dir.length} 个弧结点，每个结点同时挂在"同弧尾链"和"同弧头链"上。于是 ${g.allV[qv]} 的**出边**（${outNames.join('、')}）顺 firstout 走 tlink 就能列完，**入边**（${inNames.join('、')}）顺 firstin 走 hlink 也能列完 —— 找入边、找出边都方便。有向图的邻接表只有出边表，想找入边就得加一个逆邻接表（或者扫全部顶点），这就是十字链表的用处。`,
    vars: { 弧数: g.dir.length, 出边数: outChain.length, 入边数: inChain.length },
  }
}

/* ================================================================== *
 * 五、邻接多重表（无向图）
 * ================================================================== */

const ECOLS = 6
/** 边结点表格子序号：第 0 行是列名，第 k + 1 行才是边 e(k+1) */
const eid = (r: number, c: number): number => r * ECOLS + c

/** 邻接多重表里的一个边结点：一条无向边只有这么一个结点 */
interface MEdge {
  /** ivex：小编号那一端 */
  a: number
  /** jvex：另一端的编号 */
  b: number
  w: number
  /** 依附于 a 的下一条边结点（a 这一头走 ilink） */
  ilink: number | null
  /** 依附于 b 的下一条边结点（b 这一头走 jlink） */
  jlink: number | null
  /** 边还在不在（删边演示用：结点留着，只是从两条链上绕过去） */
  live: boolean
}

const MULTI_NOTE =
  '一条无向边只有 1 个结点：ivex / jvex 是两端（小编号在前），ilink 指向"下一条依附于 ivex 的边"，jlink 指向"下一条依附于 jvex 的边"；顶点旁边的小标签是它的 firstedge'

/**
 * 边结点表：一行一条边，ivex/jvex 两头各挂一条链。
 * 行数 = 边数 = n+2，跟着数据规模走。
 */
function multiBoard(
  g: GraphData,
  opts: {
    edges: MEdge[]
    created: number
    hot?: number[]
    done?: number[]
    pointers?: Record<string, number>
    note?: string
  },
): BoardView {
  const hot = new Set(opts.hot ?? [])
  const done = new Set(opts.done ?? [])
  const items: CellItem[] = [
    { text: '边结点', sub: 'EBox', tone: 'base' },
    { text: 'ivex', sub: '端点i', tone: 'base' },
    { text: 'ilink', sub: '同i链', tone: 'base' },
    { text: 'jvex', sub: '端点j', tone: 'base' },
    { text: 'jlink', sub: '同j链', tone: 'base' },
    { text: '权', sub: 'w', tone: 'base' },
  ]
  for (let k = 0; k < opts.edges.length; k++) {
    if (k >= opts.created) {
      items.push(...blankCells(ECOLS))
      continue
    }
    const nd = opts.edges[k]!
    const row = eid(k + 1, 0)
    const tone: CellTone = hot.has(row) ? 'hot' : done.has(row) ? 'done' : 'base'
    if (!nd.live) {
      // 删掉的边：行留在原位（格子序号不能动），只是画暗、指针画成横线
      items.push({ text: `e${k + 1}`, sub: '已删', tone: 'dim' })
      items.push({ text: g.allV[nd.a]!, sub: vSub(nd.a), tone: 'dim' })
      items.push({ text: '—', sub: '已摘', tone: 'dim' })
      items.push({ text: g.allV[nd.b]!, sub: vSub(nd.b), tone: 'dim' })
      items.push({ text: '—', sub: '已摘', tone: 'dim' })
      items.push({ text: String(nd.w), tone: 'dim' })
      continue
    }
    items.push({ text: `e${k + 1}`, sub: '边结点', tone })
    items.push({ text: g.allV[nd.a]!, sub: vSub(nd.a), tone })
    items.push({ text: nd.ilink === null ? 'NULL' : `e${nd.ilink + 1}`, sub: 'i链', tone })
    items.push({ text: g.allV[nd.b]!, sub: vSub(nd.b), tone })
    items.push({ text: nd.jlink === null ? 'NULL' : `e${nd.jlink + 1}`, sub: 'j链', tone })
    items.push({ text: String(nd.w), tone })
  }
  return {
    title: `邻接多重表 · 边结点表　${g.und.length} 条边 = ${g.und.length} 个结点（邻接表要 ${g.und.length * 2} 个）`,
    layout: 'grid',
    cols: ECOLS,
    items,
    pointers: opts.pointers,
    note: opts.note ?? MULTI_NOTE,
  }
}

const CODE_MULTI = [
  '// 邻接多重表：无向图的每条边只建 1 个结点（邻接表一条边要建 2 个）',
  '#define N 顶点数   // 顶点数 = 数据规模（5..9 任选）：每条边只建 1 个结点',
  'typedef struct EBox {',
  '  int ivex, jvex;              // 这条边的两个端点（编号小的当 ivex）',
  '  struct EBox *ilink, *jlink;  // 指向"下一条依附于 ivex / jvex 的边结点"',
  '  int weight;                  // 边的权值',
  '} EBox;',
  'EBox *firstedge[N];            // 顶点表：每个顶点指向它依附的第一条边',
  'EBox *p = new EBox; p->ivex = i; p->jvex = j; p->weight = w;   // 建结点，两条链先置空',
  '把 p 接到 i 的边链末尾;   // 看上一个结点里 i 是 ivex 还是 jvex，改对应的那个 link',
  '把 p 接到 j 的边链末尾;   // 同一个结点同时挂在两条链上',
  '// 删一条边：把它从两条链上绕过去（改 2 处指针）；邻接表要摘掉两个结点',
]

function* runAdjMulti(data: number[]): AlgoRunner {
  const g = graphOf(data.length)
  const arr = vertexIds(g.n)
  const edges: MEdge[] = g.und.map((e) => ({
    a: e.i,
    b: e.j,
    w: e.w,
    ilink: null,
    jlink: null,
    live: true,
  }))
  let created = 0
  const firstEdge: Array<number | null> = Array.from({ length: g.n }, () => null)
  const lastOf: Array<number | null> = Array.from({ length: g.n }, () => null)

  /** 在顶点 v 这一头，结点 k 的下一条走哪个域 */
  const nextIn = (k: number, v: number): number | null =>
    edges[k]!.a === v ? edges[k]!.ilink : edges[k]!.jlink
  /** 顶点 v 这一头在结点 k 里对应哪个 link 域 */
  const linkField = (k: number, v: number): 'ilink' | 'jlink' =>
    edges[k]!.a === v ? 'ilink' : 'jlink'
  const chainOf = (v: number): number[] => walk(firstEdge[v] ?? null, (k) => nextIn(k, v))

  const badges = (): Record<string, string> =>
    Object.fromEntries(
      g.allV.map((id, v) => {
        const fe = firstEdge[v]
        return [id, `首边${fe === null || fe === undefined ? '—' : `e${fe + 1}`}`]
      }),
    )
  const board = (
    hot: number[] = [],
    done: number[] = [],
    pointers?: Record<string, number>,
    note?: string,
  ): BoardView => multiBoard(g, { edges, created, hot, done, pointers, note })

  /**
   * 演示"一次走完所有邻边"的顶点：度数最大的那个（并列时取编号最小的）——
   * 它的边链最长，"每条边只出现一次"看得最清楚。
   */
  const qv = g.adj.reduce((best, l, v) => (l.length > g.adj[best]!.length ? v : best), 0)

  yield {
    line: 1,
    action: 'init',
    array: arr,
    graph: view(g, {
      edges: unEdges(g),
      badges: badges(),
      note: `无向带权图：${g.n} 个顶点、${g.und.length} 条边；顶点旁边的小标签是它的 firstedge（还没建，所以都是 —）`,
    }),
    boards: [board([], [], undefined, '还没开始建：边结点表是空的')],
    comment: `邻接多重表存的还是这张**无向**带权图（${g.n} 个顶点、${g.und.length} 条边）。它和邻接表最大的区别是：**每条无向边只建一个结点**（邻接表要给一条边建两个，两个方向各一个）。每个结点里 ivex / jvex 是这条边的两个端点（小编号在前），ilink 指向"下一条依附于 ivex 的边结点"，jlink 指向"下一条依附于 jvex 的边结点"。所以 ${g.und.length} 条边只要 ${g.und.length} 个结点。`,
    vars: { n: g.n, 边数: g.und.length },
  }

  for (let k = 0; k < edges.length; k++) {
    const nd = edges[k]!
    created = k + 1
    const row = eid(k + 1, 0)

    yield {
      line: 9,
      action: 'set',
      array: arr,
      indices: [nd.a, nd.b],
      graph: view(g, {
        edges: unEdges(g, (x) => (x === k ? 'hot' : x < k ? 'done' : undefined)),
        hot: [g.allV[nd.a]!, g.allV[nd.b]!],
        done: [],
        badges: badges(),
        note: `新建边结点 e${k + 1}：${g.allV[nd.a]} — ${g.allV[nd.b]}，权值 ${nd.w}（一条边只有一个结点）`,
      }),
      boards: [board([row], [], { 新结点: row })],
      comment: `建第 ${k + 1}/${g.und.length} 个边结点：边 ${g.allV[nd.a]} — ${g.allV[nd.b]}，权值 ${nd.w}。写 ivex = ${g.allV[nd.a]}（小编号那一端，下标 v${nd.a}）、jvex = ${g.allV[nd.b]}（下标 v${nd.b}）、weight = ${nd.w}，ilink 和 jlink 先置空。**一条无向边在这里只有这一个结点** —— 邻接表要把这条边存两遍，这里一遍就够。`,
      vars: { 边: k + 1, 权: nd.w },
    }

    // 接到 a 那一头的链尾
    const preA = lastOf[nd.a] ?? null
    if (preA === null) firstEdge[nd.a] = k
    else edges[preA]![linkField(preA, nd.a)] = k
    lastOf[nd.a] = k
    const fA = preA === null ? null : linkField(preA, nd.a)

    yield {
      line: 10,
      action: 'set',
      array: arr,
      indices: [nd.a, nd.b],
      graph: view(g, {
        edges: unEdges(g, (x) => (x === k ? 'hot' : x < k ? 'done' : undefined)),
        hot: [g.allV[nd.a]!],
        done: [],
        badges: badges(),
        note: `把 e${k + 1} 接到 ${g.allV[nd.a]} 的边链末尾（${g.allV[nd.a]} 那一头走 ${fA ?? 'ilink'}）`,
      }),
      boards: [
        board(
          [row],
          [],
          preA === null
            ? { 新结点: row }
            : { 新结点: row, 上一个结点: eid(preA + 1, 0), 改这里: eid(preA + 1, fA === 'ilink' ? 2 : 4) },
        ),
      ],
      comment: `先挂 ${g.allV[nd.a]} 那一头：${
        preA === null
          ? `${g.allV[nd.a]} 原来还没有边，顶点表里 firstedge 直接指向 e${k + 1}。`
          : `${g.allV[nd.a]} 的边链原来末尾是 e${preA + 1}；在这条边里 ${g.allV[nd.a]} 是 ${edges[preA]!.a === nd.a ? 'ivex' : 'jvex'}，所以要改它的 ${fA} 域，由 NULL 改成 e${k + 1}。`
      }一个结点要同时挂在两条链上，还有另一头。`,
      vars: { 边: k + 1, 端点: nd.a },
    }

    // 接到 b 那一头的链尾
    const preB = lastOf[nd.b] ?? null
    if (preB === null) firstEdge[nd.b] = k
    else edges[preB]![linkField(preB, nd.b)] = k
    lastOf[nd.b] = k
    const fB = preB === null ? null : linkField(preB, nd.b)

    yield {
      line: 11,
      action: 'set',
      array: arr,
      indices: [nd.a, nd.b],
      graph: view(g, {
        edges: unEdges(g, (x) => (x === k ? 'hot' : x <= k ? 'done' : undefined)),
        hot: [g.allV[nd.b]!],
        done: [],
        badges: badges(),
        note: `再把 e${k + 1} 接到 ${g.allV[nd.b]} 的边链末尾（${g.allV[nd.b]} 那一头走 ${fB ?? 'jlink'}）`,
      }),
      boards: [
        board(
          [row],
          [],
          preB === null
            ? { 新结点: row }
            : { 新结点: row, 上一个结点: eid(preB + 1, 0), 改这里: eid(preB + 1, fB === 'ilink' ? 2 : 4) },
        ),
      ],
      comment: `再挂 ${g.allV[nd.b]} 那一头：${
        preB === null
          ? `${g.allV[nd.b]} 原来还没有边，firstedge 直接指向 e${k + 1}。`
          : `${g.allV[nd.b]} 的边链原来末尾是 e${preB + 1}；在这条边里 ${g.allV[nd.b]} 是 ${edges[preB]!.a === nd.b ? 'ivex' : 'jvex'}，所以改它的 ${fB} 域，由 NULL 改成 e${k + 1}。`
      }现在这条边同时挂在 ${g.allV[nd.a]} 和 ${g.allV[nd.b]} 的链上，但整个表里只有这一个结点。`,
      vars: { 边: k + 1, 端点: nd.b },
    }
  }

  // 遍历演示：一次走完"度数最大那个顶点"的所有邻边（每条边在这条链里只出现一次）
  const chainOfQv = chainOf(qv)
  const neighbours = chainOfQv.map((k) => other(g.und[k]!, qv))
  for (let t = 0; t < chainOfQv.length; t++) {
    const k = chainOfQv[t]!
    const to = other(g.und[k]!, qv)
    const fld = linkField(k, qv)
    const nxt = nextIn(k, qv)
    yield {
      line: 12,
      action: 'mark',
      array: arr,
      indices: [qv, to],
      graph: view(g, {
        edges: unEdges(g, (x) => (x === k ? 'hot' : chainOfQv.includes(x) ? 'done' : undefined)),
        hot: [g.allV[qv]!, g.allV[to]!],
        done: [g.allV[qv]!],
        badges: badges(),
        note: `从 ${g.allV[qv]} 的 firstedge 出发，第 ${t + 1} 条边是 e${k + 1}（${g.allV[qv]} — ${g.allV[to]}）`,
      }),
      boards: [
        board(
          [eid(k + 1, 0)],
          chainOfQv.filter((x) => x !== k).map((x) => eid(x + 1, 0)),
          { 当前结点: eid(k + 1, 0), 走这个域: eid(k + 1, fld === 'ilink' ? 2 : 4) },
        ),
      ],
      comment: `遍历 ${g.allV[qv]} 的所有邻边：从 firstedge 出发，第 ${t + 1} 个结点是 e${k + 1} —— ${g.allV[qv]} 在这条边里是 ${fld === 'ilink' ? 'ivex' : 'jvex'}，所以下一条要顺着它的 ${fld} 走${nxt === null ? '，而它是 NULL，说明走完了' : `，也就是 e${nxt + 1}`}；这条边的另一端是 ${g.allV[to]}。`,
      vars: { 第几条邻边: t + 1, 邻接点: to },
    }
  }
  yield {
    line: 12,
    action: 'mark',
    array: arr,
    indices: [qv],
    graph: view(g, {
      edges: unEdges(g, (x) => (chainOfQv.includes(x) ? 'done' : undefined)),
      hot: [g.allV[qv]!],
      done: [g.allV[qv]!],
      badges: badges(),
      note: `${g.allV[qv]} 一共 ${chainOfQv.length} 条邻边：${neighbours.map((v) => g.allV[v]).join('、')}`,
    }),
    boards: [board([], chainOfQv.map((x) => eid(x + 1, 0)))],
    comment: `一次走完：${g.allV[qv]} 的 ${chainOfQv.length} 条邻边全都遍历到了，邻接点依次是 ${neighbours.map((v) => g.allV[v]).join('、')} —— 每条边在这条链里只出现一次。邻接表里这条边在 ${g.allV[qv]} 那边有一个结点、在对面顶点那边还有一个结点，所以"遍历某点的所有边"在多重表里更省事。`,
    vars: { 邻边数: chainOfQv.length },
  }

  /*
   * 删边演示：删 V2—V3 这条边。
   * 挑它不是随意的：它在 V2 的链上排第 2（链头是 V1—V2）、在 V3 的链上也排第 2（链头是 V1—V3），
   * **两头都不是链头** —— 所以删它改的是"前一个结点的 ilink / jlink"，
   * 正好演示邻接多重表删边"改 2 处指针"（要是链头就得改顶点表的 firstedge，就不是同一回事了）。
   * n=5..9 里 V1—V2、V1—V3 都在（一条环边 + 那条弦），所以这个位置永远成立。
   */
  const del = g.und.findIndex((e) => e.i === 1 && e.j === 2)
  const delEdge = edges[del]!
  const delA = delEdge.a
  const delB = delEdge.b
  const chainA = chainOf(delA)
  const chainB = chainOf(delB)
  const preA = chainA[chainA.indexOf(del) - 1]!
  const preB = chainB[chainB.indexOf(del) - 1]!
  const f3 = linkField(preA, delA)
  const f4 = linkField(preB, delB)
  const after3 = nextIn(del, delA)
  const after4 = nextIn(del, delB)
  edges[preA]![f3] = after3
  edges[preB]![f4] = after4
  delEdge.live = false
  const chainAfter = chainOf(delA)
  const nbAfter = chainAfter.map((k) => other(g.und[k]!, delA))

  yield {
    line: 12,
    action: 'set',
    array: arr,
    indices: [delA, delB],
    graph: view(g, {
      edges: unEdges(g, (x) => (x === del ? 'dim' : chainAfter.includes(x) ? 'done' : undefined)),
      hot: [g.allV[delA]!, g.allV[delB]!],
      done: [],
      badges: badges(),
      note: `删掉 ${g.allV[delA]} — ${g.allV[delB]}：把 e${del + 1} 从两条链上绕过去，只改了 2 处指针`,
    }),
    boards: [
      board(
        [eid(del + 1, 0)],
        [eid(preA + 1, 0), eid(preB + 1, 0)],
        {
          删这个结点: eid(del + 1, 0),
          [`改${g.allV[delA]}链`]: eid(preA + 1, f3 === 'ilink' ? 2 : 4),
          [`改${g.allV[delB]}链`]: eid(preB + 1, f4 === 'ilink' ? 2 : 4),
        },
        `删边只改指针：e${preA + 1}.${f3} 和 e${preB + 1}.${f4} 各改一次，e${del + 1} 这个结点被跳过`,
      ),
    ],
    comment: `删边 ${g.allV[delA]} — ${g.allV[delB]}：这条边在多重表里只有 e${del + 1} 一个结点，删它就是**把这个结点从两条链上绕过去**。${g.allV[delA]} 的链上，e${del + 1} 的前一个是 e${preA + 1}，改它的 ${f3}（原来指向 e${del + 1}）指向 e${after3 === null ? 'NULL' : `e${after3 + 1}`}；${g.allV[delB]} 的链上，前一个是 e${preB + 1}，改它的 ${f4} 指向 e${after4 === null ? 'NULL' : `e${after4 + 1}`}。一共改 2 处指针，结点本身留着或回收都行 —— 邻接表删同一条边要摘掉**两个**结点。`,
    vars: { 改指针处数: 2 },
  }

  yield {
    line: 12,
    action: 'mark',
    array: arr,
    indices: [delA],
    graph: view(g, {
      edges: unEdges(g, (x) => (x === del ? 'dim' : chainAfter.includes(x) ? 'done' : undefined)),
      hot: [g.allV[delA]!],
      done: [],
      badges: badges(),
      note: `再看 ${g.allV[delA]} 的链：${chainAfter.map((x) => `e${x + 1}`).join(' → ')}，e${del + 1} 已经被绕过去了`,
    }),
    boards: [board([], chainAfter.map((x) => eid(x + 1, 0)))],
    comment: `再走一遍 ${g.allV[delA]} 的链：${chainAfter.map((x) => `e${x + 1}`).join(' → ')}，e${del + 1} 被跳过了。${g.allV[delA]} 的邻接点现在是 ${nbAfter.map((v) => g.allV[v]).join('、')}（少了 ${g.allV[delB]}）—— 链是完好的，删边没有留下断头。`,
    vars: { 删后邻边数: chainAfter.length },
  }

  yield {
    line: 12,
    action: 'done',
    array: arr,
    graph: view(g, {
      edges: unEdges(g, (x) => (x === del ? 'dim' : 'done')),
      done: g.allV,
      badges: badges(),
      note: `${g.und.length} 条边只用 ${g.und.length} 个结点（链上现在剩 ${g.und.length - 1} 条，e${del + 1} 已删）`,
    }),
    boards: [board()],
    comment: `小结：${g.und.length} 条无向边在邻接多重表里只有 ${g.und.length} 个结点（邻接表要 ${g.und.length * 2} 个），每个结点同时挂在它两个端点的链上，所以从任一顶点出发都能一次走完它的所有邻边、每条边只经过一次；删边也只要把这一个结点从两条链上绕过去（改 2 处指针），不像邻接表要摘两个结点。代价是每个结点的指针含义要看清 ivex / jvex —— 走到谁的链上，就走对应的那个 link 域。`,
    vars: { 边数: g.und.length, 结点数: g.und.length },
  }
}

/* ================================================================== *
 * 六、注册清单
 * ================================================================== */

/**
 * 四个算法都跟着「数据规模」走：规模就是**图的顶点数** n（5..9），
 * 顶点坐标、边、表格的行列数全部按 n 现算，所以每一档都画得出对得上的画面；
 * prepareData 把任何随机输入都规整成 5..9 个顶点编号 1..n，
 * 这样首帧的 array（engine 用 defaultData 造，默认 7 个顶点）和后面每一帧都对得上。
 */
export const graphStorageSpecs: AlgorithmSpec[] = [
  {
    id: 'graph-adj-matrix',
    name: '图的存储·邻接矩阵',
    category: 'graph',
    group: '存储结构',
    summary: '一张 n×n 的矩阵：arc[i][j] 写权值、无边写 ∞，无向图沿主对角线对称，查边 O(1)',
    complexity: { time: '查边 O(1)；建矩阵 O(n²)', space: 'O(n²)' },
    renderer: 'graph',
    codeLines: CODE_MATRIX,
    defaultData,
    prepareData,
    sizes: [...GS_SIZES],
    initComment: (data) => {
      const g = graphOf(data.length)
      return `无向带权图：${g.n} 个顶点 V1~V${g.n}、${g.und.length} 条带权的边。邻接矩阵把它存成 ${g.n}×${g.n} 的二维数组 —— 第一行第一列是顶点表，边写权值、无边写 ∞、对角线写 0；读一条边要把对称的两个格子一起写上。眼下一条边都还没读，所以矩阵里**只有对角线那 ${g.n} 个 0，其余 ${g.n * g.n - g.n} 格全是 ∞**`
    },
    initGraph: (data) => {
      const g = graphOf(data.length)
      return view(g, {
        // 首帧用的就是这张图：边先画成灰色虚线（"还没读进矩阵"），和矩阵里的 ∞ 灰色是一个意思
        edges: unEdges(g, () => 'dim'),
        badges: headBadges(g),
        note: '顶点旁边的小标签是它在矩阵里的行号（它同时也是那一列）；灰色的边 = 还没读进矩阵',
      })
    },
    initScene: (data) => ({ boards: [matrixBoard(graphOf(data.length))] }),
    createRunner: runAdjMatrix,
  },
  {
    id: 'graph-adj-list',
    name: '图的存储·邻接表',
    category: 'graph',
    group: '存储结构',
    summary: 'n 个表头 + 每条边一个边结点：边结点串成链，顶点多、边少时比矩阵省',
    complexity: { time: '建表 O(n+e)；查边 O(顶点度数)', space: 'O(n + 2e)（无向图每条边存两遍）' },
    renderer: 'graph',
    codeLines: CODE_LIST,
    defaultData,
    prepareData,
    sizes: [...GS_SIZES],
    initComment: (data) => {
      const g = graphOf(data.length)
      return `还是这张 ${g.n} 顶点、${g.und.length} 条边的无向带权图。邻接表换一种存法：每个顶点一个表头，它的每个邻接点占一个边结点（邻接点下标 + 权值 + next 指针），边结点串成一条链挂在表头后面`
    },
    initGraph: (data) => {
      const g = graphOf(data.length)
      return view(g, {
        edges: unEdges(g),
        badges: listBadges(g),
        note: '顶点旁边的小标签是它的表头在表里的行号',
      })
    },
    initScene: (data) => {
      const g = graphOf(data.length)
      return { boards: [listBoard(g, { seen: Array.from({ length: g.n }, () => 0) })] }
    },
    createRunner: runAdjList,
  },
  {
    id: 'graph-orthogonal',
    name: '图的存储·十字链表',
    category: 'graph',
    group: '存储结构',
    summary: '有向图的每个弧结点同时挂进同弧尾链和同弧头链，找入边、找出边都方便',
    complexity: { time: '找出边 O(出度)；找入边 O(入度)', space: 'O(n + e)' },
    renderer: 'graph',
    codeLines: CODE_ORTH,
    defaultData,
    prepareData,
    sizes: [...GS_SIZES],
    initComment: (data) => {
      const g = graphOf(data.length)
      return `十字链表存的是有向图：${g.n} 个顶点、${g.dir.length} 条弧（V1⇄V2、V3⇄V4 是两对互为反向的弧）。每个弧结点 5 个域：弧尾、弧头、权、hlink（同弧头链 = 入边链）、tlink（同弧尾链 = 出边链）`
    },
    initGraph: (data) => {
      const g = graphOf(data.length)
      return view(g, {
        edges: dirEdges(g),
        badges: emptyBadges(g),
        note: '顶点旁边的小标签是它的 firstout / firstin（还没建，所以都是 —）',
      })
    },
    initScene: (data) => {
      const g = graphOf(data.length)
      // 首帧就把 n+3 行空弧结点摆好（全是暗色格，不剧透），后面一帧帧往里填
      const arcs: Arc[] = g.dir.map((e) => ({ a: e.i, b: e.j, w: e.w, hlink: null, tlink: null }))
      return { boards: [orthBoard(g, { arcs, created: 0 })] }
    },
    createRunner: runOrth,
  },
  {
    id: 'graph-adj-multi',
    name: '图的存储·邻接多重表',
    category: 'graph',
    group: '存储结构',
    summary: '无向图每条边只有一个结点：邻接表一条边存两遍，它只存一遍，删边、遍历都省',
    complexity: { time: '建表 O(n+e)；删边 O(1) 改 2 处指针', space: 'O(n + e)（每条边 1 个结点）' },
    renderer: 'graph',
    codeLines: CODE_MULTI,
    defaultData,
    prepareData,
    sizes: [...GS_SIZES],
    initComment: (data) => {
      const g = graphOf(data.length)
      return `邻接多重表存的是这张 ${g.n} 顶点、${g.und.length} 条边的无向带权图。它和邻接表最大的区别：**每条无向边只建一个结点**（邻接表要建两个），结点里的 ivex / jvex 是两端，ilink / jlink 分别把它们串进两个端点的边链`
    },
    initGraph: (data) => {
      const g = graphOf(data.length)
      return view(g, {
        edges: unEdges(g),
        badges: emptyBadges(g),
        note: '顶点旁边的小标签是它的 firstedge（还没建，所以都是 —）',
      })
    },
    initScene: (data) => {
      const g = graphOf(data.length)
      return {
        boards: [
          multiBoard(g, {
            edges: g.und.map((e) => ({ a: e.i, b: e.j, w: e.w, ilink: null, jlink: null, live: true })),
            created: 0,
          }),
        ],
      }
    },
    createRunner: runAdjMulti,
  },
]
