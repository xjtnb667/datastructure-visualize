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
 * 图的应用 —— 最小生成树（Prim / Kruskal）、最短路径（Dijkstra / Floyd）、关键路径（AOE 网）。
 *
 * 图是本项目**全新的渲染器**，用法和其他渲染器不太一样，先把约定写清楚：
 *
 *   1. 顶点坐标由算法自己给 —— **相对坐标 0..1**，渲染器按面板尺寸换算像素。
 *      所有算法统一用 ring() 把顶点摆在圆周上（位置固定不动），
 *      这样整个过程中"动的"只有颜色、边上的权值和顶点旁边的小标签，画面才读得懂。
 *   2. **顶点数 = 数据规模 n**：下拉框给 5..9 五档，n 一变，顶点、边、矩阵阶数、
 *      板子的列数全部跟着重算 —— 这个文件里已经没有"写死 6 个顶点"的常量了。
 *      图本身按 n **确定性生成**（不用 Math.random），同一个 n 每次画出来都一模一样，
 *      步骤序列才可重放、测试才写得出来。
 *   3. 每帧都要给 graph（校验器规定），首帧还要额外给 initGraph
 *      —— 首帧是 engine 造的，生成器管不到它，不给的话第一帧就是空画面。
 *   4. **badges（顶点旁边的小标签）是关键**：Dijkstra 的 dist、关键路径的 ve/vl
 *      全靠它挂在顶点旁边；Floyd 的距离矩阵、低代价数组另外用板子（boards）画。
 *   5. 板子的 layout 有两种用法：
 *        row  = 一维数组（lowcost 数组、dist 数组、按权排序的边表）
 *        grid = 二维表 / 矩阵（Floyd 的距离矩阵、关键路径的 e/l 表），第一行第一列当表头。
 *   6. 一个 yield = 一步，line 必须指向 codeLines 里**非空**的那一行；array 每帧必填
 *      （图类算法的 array 就取这一帧最要紧的那张表，当"数据值序列"用）。
 */

/* ================================================================== *
 * 一、公共：数据规模 n、圆环布局、确定性的带权图
 * ================================================================== */

/** 这五个算法支持的数据规模（= 顶点数）：下拉框里的 5..9 就是它 */
const SIZES = [5, 6, 7, 8, 9]
const MIN_N = SIZES[0]!
const MAX_N = SIZES[SIZES.length - 1]!
/** 默认规模：7 个顶点（"还原默认数据"用它） */
const DEFAULT_N = 7

/**
 * 把任意长度夹到 5..9。
 * 图上"一个顶点一格"，规模太小画不出结构、太大一圈塞不下，所以两端都夹住；
 * 这样就算有人直接拿 12 个数的随机数据来跑，画出来也还是合法的图。
 */
const clampN = (len: number): number =>
  Number.isFinite(len) && len > 0 ? Math.min(MAX_N, Math.max(MIN_N, Math.floor(len))) : MIN_N

/**
 * 把随机 / 原始数据规整成"n 个顶点编号"（n 落在 5..9）。
 * 图是**按 n 现算**的，所以数据本身只需要表达"画几个顶点"这一件事 ——
 * 顶点、边、权值全都不用用户提供，也就不会有"数据和图对不上"的问题。
 */
export function prepareData(raw: number[]): number[] {
  return Array.from({ length: clampN(raw.length) }, (_, i) => i + 1)
}

/** 生成器里的 n：数据有几位就画几个顶点（prepareData 之后必然落在 5..9） */
const nOf = (data: number[]): number => clampN(data.length)

/** 默认数据：n 个顶点编号（1..n） */
const vertexData = (n: number = DEFAULT_N): number[] => Array.from({ length: n }, (_, i) => i + 1)

/**
 * 圆环布局：第 k 个顶点从 12 点方向开始顺时针摆。
 * 半径固定 0.42、圆心 (0.5, 0.5)，所以坐标天然落在 0.08..0.92 之间（校验器要求 0..1）。
 */
const ring = (k: number, n: number): { x: number; y: number } => {
  const t = (2 * Math.PI * k) / n - Math.PI / 2
  return { x: 0.5 + 0.42 * Math.cos(t), y: 0.5 + 0.42 * Math.sin(t) }
}

/** 顶点名 V1..Vn（顶点上的大字） */
const V = (i: number): string => `V${i}`

/** 顶点 id：u1..un（1-based，和别人家的 n0/n1 区分开） */
const U = (i: number): string => `u${i}`

/**
 * "不可达 / 还没算出来"的**哨兵值**。
 *
 * 为什么要这么麻烦：Engine 的校验器要求每一帧的 `array` 全是有限数（`Number.isFinite`），
 * 所以表格数据里**不能直接放 Infinity**。
 * 这里用一个比所有权值都大的有限数当 ∞，好处是"∞ + 边权还是 ∞"，算术照样成立
 * （松弛时 `dist[u] + w < dist[v]` 这种判断在不可达时自然不成立）。
 */
const INF = 9999
/** 表格里的写法：哨兵显示成 ∞ */
const inf = (v: number): string => (v === INF ? '∞' : String(v))

/**
 * 32 位整数散列（murmur3 的收尾混合）：把几个小整数搅成一个看起来没规律的值。
 *
 * 为什么不用 Math.random()：步骤序列是要**预计算**的，每次刷新都换一张图的话，
 * "上一步/下一步"就没有意义了，测试也无从断言。散列是确定的 ——
 * 同样的 (a, b, salt) 永远得到同一个数，所以同一个 n 每次画出来都一模一样。
 */
const hash32 = (a: number, b: number, salt: number): number => {
  let h = (a * 374761393 + b * 668265263 + salt * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/** 把"顶点数 n"掺进散列的种子：不同规模的图长得不一样，同一个规模永远一样 */
const saltOf = (salt: number, n: number): number => salt * 97 + n * 1009

/** 无向图的边权：1..9 的确定值（salt 区分"环边"和"弦"） */
const edgeWeight = (i: number, j: number, salt: number, n: number): number =>
  (hash32(i, j, saltOf(salt, n)) % 9) + 1

/**
 * AOE 网主干工序的持续时间：1..4 天。
 * 三条捷径则固定 5..7 天 —— "绕过去"不一定划算，所以关键路径有时走捷径、有时老老实实走主干，
 * 这样关键活动、机动时间、e/l 才都有东西可讲。
 */
const trunkDays = (i: number, n: number): number => (hash32(i, i + 1, saltOf(3, n)) % 4) + 1

/* ---------------------------- 无向带权图 ---------------------------- */

/** 无向带权图的一条边（uv 按编号小的在前存，判环和画图都方便） */
interface WEdge {
  /** 1-based 顶点编号，i < j */
  i: number
  j: number
  w: number
}

/** 一张按 n 生成好的无向连通带权图（Prim / Kruskal / Dijkstra / Floyd 共用） */
interface UGraph {
  n: number
  /** 定义顺序：先环、后弦 */
  edges: WEdge[]
  /** 按权值升序（权相同时按起点、终点编号），Kruskal 直接用它当处理顺序 */
  byW: WEdge[]
  /** 顶点 id：u1..un */
  ids: string[]
  /** id -> 顶点坐标 */
  pos: Record<string, { x: number; y: number }>
}

/**
 * 第 c 条弦跨过几个顶点（2 和 3 交替，免得所有弦都挤在同一侧）。
 * 弦只用来把图铺得"有得挑"，连通性靠下面那个环保证。
 */
const CHORD_STEP = [2, 3, 2, 3, 2]

/**
 * 按 n 生成一张**无向连通带权图**：
 *   ① 先把 V1-V2-…-Vn-V1 串成一个环 —— 环本身就是连通的，
 *      所以 Prim 的 lowcost 里**永远不会出现说不清的 ∞**，Kruskal 也必然能凑够 n-1 条边；
 *   ② 再添 n/2 条弦，让图不那么"稀"，最小生成树才有得挑；
 *   ③ 权值全部取 1..9 的确定值（edgeWeight 散列，不是随机数）。
 * 边数 = n + n/2：n=5 是 7 条，n=9 是 13 条。
 */
const buildUG = (n: number): UGraph => {
  const edges: WEdge[] = []
  const seen = new Set<string>()
  const add = (a: number, b: number, salt: number): void => {
    const i = Math.min(a, b)
    const j = Math.max(a, b)
    if (i === j || seen.has(`${i}-${j}`)) return
    seen.add(`${i}-${j}`)
    edges.push({ i, j, w: edgeWeight(i, j, salt, n) })
  }

  // ① 环：V1-V2-…-Vn-V1（连通性由它保证）
  for (let i = 1; i <= n; i++) add(i, (i % n) + 1, 1)
  // ② 弦：从 V1 开始每隔一个顶点连一条
  for (let c = 0; c < Math.floor(n / 2); c++) {
    const i = c + 1
    const j = i + CHORD_STEP[c % CHORD_STEP.length]!
    add(i, j > n ? j - n : j, 7)
  }

  const ids = Array.from({ length: n }, (_, k) => U(k + 1))
  return {
    n,
    edges,
    byW: [...edges].sort((a, b) => a.w - b.w || a.i - b.i || a.j - b.j),
    ids,
    pos: Object.fromEntries(ids.map((id, k) => [id, ring(k, n)])),
  }
}

/** 同一个 n 只建一次图：Prim / Kruskal / Dijkstra / Floyd 跑的是**同一张图** */
const UG_CACHE = new Map<number, UGraph>()
const ug = (n: number): UGraph => {
  let g = UG_CACHE.get(n)
  if (!g) {
    g = buildUG(n)
    UG_CACHE.set(n, g)
  }
  return g
}

/** 无向图的顶点快照（不含当前状态）；hot / done / badges 由每个算法自己给 */
const ugNodes = (g: UGraph, sub?: Record<string, string>): GraphNodeSnapshot[] =>
  g.ids.map((id, k) => {
    const p = g.pos[id]!
    const label = V(k + 1)
    const s = sub?.[id]
    return s ? { id, label, x: p.x, y: p.y, sub: s } : { id, label, x: p.x, y: p.y }
  })

/** 无向图的边快照：w 一律画出来（带权图），tone / label 由调用方决定 */
const ugEdges = (g: UGraph, toneOf: (e: WEdge) => GraphEdgeSnapshot): GraphEdgeSnapshot[] =>
  g.edges.map(toneOf)

/** 某个顶点在无向图里的邻接边（按权值升序，候选边次序稳定） */
const edgesAt = (g: UGraph, v: number): WEdge[] =>
  g.edges.filter((e) => e.i === v || e.j === v).sort((a, b) => a.w - b.w || a.i - b.i || a.j - b.j)

/** 边的另一端 */
const other = (e: WEdge, v: number): number => (e.i === v ? e.j : e.i)

/** 升序边表里的 "V1-V3(1)" 这种串，板子上直接照抄 */
const sortedEdgeText = (e: WEdge): string => `${V(e.i)}-${V(e.j)}(${e.w})`

/* ================================================================== *
 * 二、公共：板子（一维 row 表 / 二维 grid 表）
 * ================================================================== */

/** 一维表：每格显示 text + sub，指针指向当前关心的那一格 */
function rowBoard(
  title: string,
  items: CellItem[],
  pointers: Record<string, number>,
  note: string,
): BoardView {
  return { title, layout: 'row', items, pointers, note }
}

/**
 * 二维表（grid）。
 * 第 0 行、第 0 列都是**表头**（顶点名），数据格从 (1,1) 开始 —— Floyd 的距离矩阵、
 * 关键路径的活动表都按这个约定摆。
 *
 * 列数由算法自己算（Floyd 是 n+1，活动表是固定的 7 列），
 * items 长度必须正好是 (行数) * width，否则格子会错位。
 */
function gridBoard(
  title: string,
  width: number,
  rows: CellItem[][],
  pointers: Record<string, number>,
  note: string,
): BoardView {
  const items: CellItem[] = []
  for (const r of rows) items.push(...r)
  return { title, layout: 'grid', cols: width, items, pointers, note }
}

/* ================================================================== *
 * 三、最小生成树 · Prim
 * ================================================================== */

/**
 * Prim 的一句话：从起点出发，每次把"连接已选集合与未选集合的**最小边**"加进来。
 *
 * lowcost[v] = v 到**已选集合**的最小边权（v 已在集合里就是 0，暂时连不上就是 ∞），
 * parent[v]   = 那条最小边在集合里的另一端。
 * lowcost 同时挂在顶点的 badges 上，也画成下半部分的板子 —— 这是本算法的核心状态。
 */

const CODE_PRIM = [
  '// 无向连通带权图 G（顶点 V1..Vn）；lowcost[v] = v 到已选集合的最小边权',
  'void Prim(Graph G, int start) {',
  '  for (int v = 1; v <= n; v++) { lowcost[v] = ∞; parent[v] = 0; }  // ① 初始都连不上',
  '  lowcost[start] = 0;                        // ② 起点先放进已选集合',
  '  for (int k = 1; k < n; k++) {              // ③ 还要选 n-1 次，选 n-1 条边',
  '    int u = 取 lowcost 最小且未选的顶点;       // ④ 离集合最近的顶点',
  '    把 u 加进已选集合;                         // ⑤ u 定下来了',
  '    for (u 的每条邻边 (u, v, w))              // ⑥ 用 u 去刷新候选边',
  '      if (v 未选 && w < lowcost[v]) { lowcost[v] = w; parent[v] = u; }',
  '  }',
  '}',
]

/** lowcost 板：每个顶点一格（共 n 格），格子里就是 lowcost；已选顶点标绿 */
function primBoard(
  g: UGraph,
  lowcost: number[],
  selected: Set<number>,
  cur: number,
  note: string,
): BoardView {
  const items: CellItem[] = g.ids.map((_, k) => {
    const v = k + 1
    return {
      text: inf(lowcost[k]!),
      sub: V(v),
      tone: selected.has(v) ? 'done' : v === cur ? 'hot' : 'base',
    }
  })
  return rowBoard(
    `lowcost[] —— ${g.n} 个顶点各自到已选集合的最小边权`,
    items,
    cur >= 1 ? { u: cur - 1 } : {},
    note,
  )
}

function* runPrim(data: number[]): AlgoRunner {
  const g = ug(nOf(data))
  const n = g.n
  const start = 1

  const lowcost = new Array<number>(n).fill(INF)
  const parent = new Array<number>(n).fill(0)
  const selected = new Set<number>([start])
  const chosen: WEdge[] = []

  /** 顶点 badges：已选顶点写"已选"，未选顶点写它当前的 lowcost */
  const badgesOf = (): Record<string, string> =>
    Object.fromEntries(
      g.ids.map((id, k) => {
        const v = k + 1
        return [id, selected.has(v) ? '已选' : `lowcost=${inf(lowcost[k]!)}`]
      }),
    )

  /** 这一帧的图：已选顶点给 done，本轮关注的顶点给 hot，候选边（连着已选集合的）给 label */
  const snap = (
    hot: string[],
    note: string,
    labelOf: (e: WEdge) => string | undefined = (e) =>
      selected.has(e.i) !== selected.has(e.j) ? `候选${e.w}` : undefined,
    done = [...selected].map(U),
  ): GraphView => ({
    nodes: ugNodes(g),
    edges: ugEdges(g, (e) => ({
      from: U(e.i),
      to: U(e.j),
      w: e.w,
      tone: chosen.includes(e) ? 'done' : selected.has(e.i) !== selected.has(e.j) ? 'hot' : 'base',
      label: labelOf(e),
    })),
    hot,
    done,
    badges: badgesOf(),
    note,
  })

  // 起点自己进集合，再把它的邻边填成初始候选
  const startEdges = edgesAt(g, start)
  lowcost[start - 1] = 0
  for (const e of startEdges) {
    const v = other(e, start)
    lowcost[v - 1] = e.w
    parent[v - 1] = start
  }

  yield {
    line: 4,
    action: 'init',
    array: lowcost.slice(),
    graph: snap(
      [U(start)],
      `① 先把起点 ${V(start)} 放进已选集合（绿色）；它的邻边都成了候选边（紫色，label 就是边权）`,
    ),
    boards: [
      primBoard(
        g,
        lowcost,
        selected,
        start,
        `起点 ${V(start)} 已选；候选边只有从它出发的 ${startEdges.length} 条：${startEdges
          .map((e) => `${V(start)}-${V(other(e, start))}=${e.w}`)
          .join('、')}，其余顶点还连不上，lowcost = ∞`,
      ),
    ],
    comment: `① 随便挑一个起点 ${V(start)} 放进已选集合（绿色顶点）。子问题很小：现在只选了一个顶点，一共有 ${n} 个顶点，所以还要选 ${n - 1} 次。它的 ${startEdges.length} 条邻边的权值就成了对应顶点的 lowcost：${startEdges
      .map((e) => `${V(other(e, start))}=${e.w}`)
      .join('，')}；其余的顶点还连不上，lowcost = ∞`,
    vars: { n, 已选顶点数: 1, 已选边数: 0 },
  }

  let total = 0
  for (let k = 2; k <= n; k++) {
    // ④ 找 lowcost 最小且未选的顶点
    let u = 0
    for (let v = 1; v <= n; v++) {
      if (selected.has(v)) continue
      if (u === 0 || lowcost[v - 1]! < lowcost[u - 1]!) u = v
    }
    const eIn = g.edges.find(
      (e) => (e.i === u && e.j === parent[u - 1]) || (e.j === u && e.i === parent[u - 1]),
    )!
    const wIn = lowcost[u - 1]!

    yield {
      line: 6,
      action: 'compare',
      array: lowcost.slice(),
      graph: snap(
        [U(u)],
        `④ 未选顶点里 lowcost 最小的是 ${V(u)}（lowcost = ${wIn}），它就是离已选集合最近的那个`,
      ),
      boards: [
        primBoard(
          g,
          lowcost,
          selected,
          u,
          `扫描 lowcost 数组：未选顶点里 ${V(u)} 的 ${wIn} 最小，所以这一轮就选它`,
        ),
      ],
      comment: `④ 在还没进集合的顶点里挑 lowcost 最小的：${V(u)} 的 lowcost = ${wIn}${
        u === 1 ? '' : `（那条边是 ${V(parent[u - 1])}-${V(u)}，权值 ${wIn}）`
      }，比其它未选顶点的候选边都小 —— 这就是"离已选集合最近"的顶点`,
      vars: { 这一轮: k - 1, u, lowcost: wIn },
    }

    // ⑥ 用 u 刷新候选边
    const refresh: Array<{ v: number; e: WEdge; old: number }> = []
    for (const e of edgesAt(g, u)) {
      const v = other(e, u)
      if (selected.has(v)) continue
      if (e.w < lowcost[v - 1]!) {
        refresh.push({ v, e, old: lowcost[v - 1]! })
        lowcost[v - 1] = e.w
        parent[v - 1] = u
      }
    }

    yield {
      line: 9,
      action: 'set',
      array: lowcost.slice(),
      graph: snap(
        [U(u)],
        refresh.length
          ? `⑥ 用 ${V(u)} 去刷新候选边：${refresh
              .map(
                (r) =>
                  `${V(u)}-${V(r.v)}=${r.e.w} 比原来的 ${inf(r.old)} 更小，lowcost[${V(r.v)}] 改成 ${r.e.w}`,
              )
              .join('；')}`
          : `⑥ 扫过 ${V(u)} 的每条邻边，没有一条比对方的 lowcost 更小，数组不用改`,
      ),
      boards: [
        primBoard(
          g,
          lowcost,
          selected,
          u,
          refresh.length
            ? `lowcost 变小了：${refresh.map((r) => `${V(r.v)}: ${inf(r.old)} -> ${r.e.w}`).join('，')}`
            : `${V(u)} 的邻边都没让 lowcost 变小，候选边保持原样`,
        ),
      ],
      comment: `⑥ 把新顶点 ${V(u)} 的每条邻边都看一遍，谁连不上或者原来的 lowcost 更大就更新它：${
        refresh.length
          ? refresh.map((r) => `${V(r.v)} 的 lowcost 由 ${inf(r.old)} 改成 ${r.e.w}`).join('，')
          : `一条都没更新（${V(u)} 的邻居要么已经在集合里，要么原来的候选边更短）`
      }`,
      vars: { u, lowcost: lowcost[u - 1]!, 更新个数: refresh.length },
    }

    // ⑤ 正式把 u 和那条最小边加进来
    selected.add(u)
    chosen.push(eIn)
    total += wIn

    yield {
      line: 5,
      action: 'mark',
      array: lowcost.slice(),
      graph: snap(
        [U(u)],
        `⑤ 把 ${V(u)} 连进来：边 ${V(eIn.i)}-${V(eIn.j)}（权值 ${wIn}）变成绿色，已选集合有 ${selected.size} 个顶点了`,
        undefined,
        [...selected].map(U),
      ),
      boards: [
        primBoard(
          g,
          lowcost,
          selected,
          u,
          `已选 ${V(u)}：lowcost[${V(u)}] 归 0；到目前一共选了 ${chosen.length} 条边，总权值 ${total}`,
        ),
      ],
      comment:
        u === 1
          ? `⑤ ${V(u)} 就是起点本身，不用连线`
          : `⑤ 选中的边 ${V(eIn.i)}-${V(eIn.j)}（权值 ${wIn}）正式加入生成树（画成绿色加粗）：${V(parent[u - 1])} 和 ${V(u)} 从此连通。已选集合 = {${[...selected]
              .sort((a, b) => a - b)
              .map(V)
              .join(', ')}}，累计权值 ${total}`,
      vars: { 已选顶点数: selected.size, 已选边数: chosen.length, 累计权值: total },
    }
  }

  yield {
    line: 11,
    action: 'done',
    array: lowcost.slice(),
    graph: snap(
      [],
      `完成：${n - 1} 条绿色边就是最小生成树，总权值 = ${total}`,
      () => undefined,
      g.ids.slice(),
    ),
    boards: [
      primBoard(g, lowcost, selected, 0, `所有顶点的 lowcost 都是 0（全部已选），最小生成树总权值 ${total}`),
    ],
    comment: `③ 一共选了 ${n - 1} 次（顶点数 - 1），所有顶点都进了集合，最小生成树建好了：${chosen
      .map((e) => `${V(e.i)}-${V(e.j)}(${e.w})`)
      .join(' + ')} = ${total}。它一定是权值和最小的那棵 —— 每一步都选了当下能选的最短边，而且永远是"连接内外"的边，绝不会成环`,
    vars: { 边数: chosen.length, 总权值: total },
  }
}

/* ================================================================== *
 * 四、最小生成树 · Kruskal
 * ================================================================== */

/** 并查集（Kruskal 判环用）：本文件内部自写一份，不去 import treeApply 的 */
class DSU {
  private p: number[]
  private rk: number[]
  private n: number

  constructor(n: number) {
    this.n = n
    this.p = Array.from({ length: n + 1 }, (_, i) => i)
    this.rk = new Array<number>(n + 1).fill(0)
  }

  /** 顺着一路找根，找到后把路上的结点直接挂到根下（路径压缩） */
  find(x: number): number {
    let r = x
    while (this.p[r] !== r) r = this.p[r]!
    let cur = x
    while (this.p[cur] !== cur) {
      const nx = this.p[cur]!
      this.p[cur] = r
      cur = nx
    }
    return r
  }

  /** 本来就在一个集合里返回 false（说明这条边会让生成树成环，必须扔掉） */
  union(a: number, b: number): boolean {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return false
    if (this.rk[ra]! < this.rk[rb]!) this.p[ra] = rb
    else if (this.rk[ra]! > this.rk[rb]!) this.p[rb] = ra
    else {
      this.p[rb] = ra
      this.rk[ra] = this.rk[ra]! + 1
    }
    return true
  }

  /** 当前分成哪几组：{1,3,6} {2,5} 这样（只列还没被合并掉的根） */
  groups(): number[][] {
    const g = new Map<number, number[]>()
    for (let v = 1; v <= this.n; v++) {
      const r = this.find(v)
      g.set(r, [...(g.get(r) ?? []), v])
    }
    return [...g.values()].sort((a, b) => a[0]! - b[0]!)
  }
}

const CODE_KRUSKAL = [
  '// 并查集：parent[] 里每个集合选一个代表（根），两端根相同就是已经连通',
  'void Kruskal(Edge E[], int m) {                 // E 已经按权值从小到大排好',
  '  for (int i = 1; i <= n; i++) parent[i] = i;    // ① 每个顶点先各自成一个集合',
  '  for (int k = 1; k <= m; k++) {                 // ② 从小到大逐条考察',
  '    if (find(E[k].u) == find(E[k].v)) continue;  // ③ 两端已经在同一集合 -> 会成环，扔掉',
  '    union(E[k].u, E[k].v);                       // ④ 不成环：这条边进生成树',
  '    count++; total += E[k].w;',
  '    if (count == n - 1) break;                   // ⑤ 凑够 n-1 条边就收工',
  '  }',
  '}',
]

/** 边表状态：待考察 / 正在看 / 已加入生成树 / 被扔掉 */
type EdgeState = 'pending' | 'cur' | 'accepted' | 'rejected'

/** 按权排序后的边表板子（n + n/2 格）：每格写 V1-V3(1) 这样的边名 */
function kruskalEdgeBoard(g: UGraph, states: EdgeState[], k: number, note: string): BoardView {
  const items: CellItem[] = g.byW.map((e, idx) => ({
    text: sortedEdgeText(e),
    sub: `#${idx + 1}`,
    tone: states[idx] as CellTone,
  }))
  return rowBoard(
    `按权值排序后的边表（共 ${g.byW.length} 条：已考察的变灰，选中的变绿，会成环的变红）`,
    items,
    k >= 0 && k < items.length ? { 当前: k } : {},
    note,
  )
}

/** 并查集分组板：一个集合一格，格子里列出成员，当前正在考察的那两格高亮 */
function dsuBoard(dsu: DSU, hot: number[], note: string): BoardView {
  const groups = dsu.groups()
  const items: CellItem[] = groups.map((grp) => ({
    text: `{${grp.map(V).join(',')}}`,
    sub: `根${V(grp[0]!)}`,
    tone: grp.some((v) => hot.includes(v)) ? 'hot' : 'base',
  }))
  const pointers: Record<string, number> = {}
  const idx = groups.findIndex((grp) => grp.some((v) => hot.includes(v)))
  if (idx >= 0) pointers.当前 = idx
  return rowBoard(`并查集分组（共 ${groups.length} 个集合）`, items, pointers, note)
}

function* runKruskal(data: number[]): AlgoRunner {
  const g = ug(nOf(data))
  const n = g.n
  const dsu = new DSU(n)
  /** 每条边（在 byW 顺序里）当前的考察状态 */
  const states: EdgeState[] = g.byW.map(() => 'pending')
  /** 边 -> 它在 byW 里的下标（画图时要按 id 找状态） */
  const order = new Map<WEdge, number>(g.byW.map((e, idx) => [e, idx]))
  const chosen: WEdge[] = []
  let total = 0

  const snap = (hot: string[], note: string): GraphView => ({
    nodes: ugNodes(g),
    edges: g.edges.map((e) => {
      const st = states[order.get(e)!]!
      const tone: CellTone =
        st === 'accepted' ? 'done' : st === 'rejected' ? 'mark' : st === 'cur' ? 'hot' : 'base'
      return {
        from: U(e.i),
        to: U(e.j),
        w: e.w,
        tone,
        label: st === 'accepted' && chosen.includes(e) ? '已选' : st === 'rejected' ? '成环' : undefined,
      }
    }),
    hot,
    done: [...new Set(chosen.flatMap((e) => [U(e.i), U(e.j)]))],
    badges: Object.fromEntries(g.ids.map((id, k) => [id, `集合${V(dsu.find(k + 1))}`])),
    note,
  })

  yield {
    line: 3,
    action: 'init',
    array: g.byW.map((e) => e.w),
    graph: snap(
      [],
      `① 每个顶点先各自成一个集合（badge 里写的就是它现在的集合代表）；${g.byW.length} 条边按权值从小到大排好了，下面这块板子就是处理顺序`,
    ),
    boards: [
      kruskalEdgeBoard(g, states, 0, `还没考察任何一条边，${g.byW.length} 条边都是待考察（蓝色）`),
      dsuBoard(dsu, [], `一开始每个顶点自成一个集合，一共 ${n} 个集合`),
    ],
    comment: `① Kruskal 换个思路：先不管顶点怎么连，把**所有边按权值从小到大排队**，然后一条一条考察。开始时每个顶点各自成一个集合（一共 ${n} 个），下面第一块板子是排好队的边表：${g.byW
      .map(sortedEdgeText)
      .join(' < ')}`,
    vars: { n, 边数: g.edges.length },
  }

  for (let k = 0; k < g.byW.length && chosen.length < n - 1; k++) {
    const e = g.byW[k]!
    states[k] = 'cur'
    const ru = dsu.find(e.i)
    const rv = dsu.find(e.j)

    yield {
      line: 5,
      action: 'compare',
      array: g.byW.map((x) => x.w),
      graph: snap(
        [U(e.i), U(e.j)],
        `③ 考察第 ${k + 1} 条边 ${V(e.i)}-${V(e.j)}（权值 ${e.w}）：find(${V(e.i)}) = ${V(ru)}，find(${V(
          e.j,
        )}) = ${V(rv)}`,
      ),
      boards: [
        kruskalEdgeBoard(g, states, k, `当前这条就是第 ${k + 1} 条：${sortedEdgeText(e)}`),
        dsuBoard(dsu, [e.i, e.j], `两端的集合代表：${V(ru)} 和 ${V(rv)}`),
      ],
      comment: `③ 轮到第 ${k + 1} 条边 ${V(e.i)}-${V(e.j)}（权值 ${e.w}），先用并查集查两端各属于哪个集合：find(${V(
        e.i,
      )}) = ${V(ru)}，find(${V(e.j)}) = ${V(rv)}，${
        ru === rv ? '两个根一样 —— 两端早就连通了' : '两个根不一样 —— 两端还没连通'
      }`,
      vars: { 边的序号: k + 1, 权值: e.w, 集合u: ru, 集合v: rv },
    }

    if (ru === rv) {
      states[k] = 'rejected'
      yield {
        line: 5,
        action: 'mark',
        array: g.byW.map((x) => x.w),
        graph: snap(
          [U(e.i), U(e.j)],
          `两端已经在同一个集合 {${dsu
            .groups()
            .find((grp) => grp.includes(e.i))!
            .map(V)
            .join(',')}} 里：这条边加进去就成环，直接扔掉（红色）`,
        ),
        boards: [
          kruskalEdgeBoard(g, states, k, `${sortedEdgeText(e)} 被扔掉：两端已在同一集合`),
          dsuBoard(dsu, [e.i, e.j], `两端同属集合 ${V(ru)}，什么也不做`),
        ],
        comment: `③ 两端 ${V(e.i)}、${V(e.j)} 已经在同一个集合里（代表都是 ${V(ru)}），说明它们之间**已经有一条通路**了；这条边再加进来就会形成一个环，而生成树不允许有环，所以把它扔掉（画成红色"成环"）。注意：它不一定真的在环上被删，只是"这条边没用了"`,
        vars: { 权值: e.w, 已选边数: chosen.length },
      }
      continue
    }

    // ④ 不成环：加进生成树
    dsu.union(e.i, e.j)
    states[k] = 'accepted'
    chosen.push(e)
    total += e.w

    yield {
      line: 6,
      action: 'swap',
      array: g.byW.map((x) => x.w),
      graph: snap(
        [U(e.i), U(e.j)],
        `④ 两端不在同一个集合，这条边加进生成树（绿色）：两个集合 {…${V(e.i)}…} 和 {…${V(e.j)}…} 合并成一个`,
      ),
      boards: [
        kruskalEdgeBoard(g, states, k, `${sortedEdgeText(e)} 选中，已选 ${chosen.length} 条，累计权值 ${total}`),
        dsuBoard(dsu, [e.i, e.j], `合并后只剩 ${dsu.groups().length} 个集合`),
      ],
      comment: `④ ${V(e.i)} 和 ${V(e.j)} 的集合代表不同（${V(ru)} ≠ ${V(rv)}），说明加上这条边不会成环，于是把它加入生成树（画成绿色）：两个集合合并成一个大集合。到目前选了 ${chosen.length} 条边，累计权值 ${total}${
        chosen.length === n - 1 ? '，已经够 n-1 条，后面不用再看了' : ''
      }`,
      vars: { 已选边数: chosen.length, 累计权值: total, 集合个数: dsu.groups().length },
    }
  }

  yield {
    line: 9,
    action: 'done',
    array: g.byW.map((e) => e.w),
    graph: snap([], `完成：${chosen.length} 条绿色边构成最小生成树，总权值 = ${total}`),
    boards: [
      kruskalEdgeBoard(g, states, -1, `绿色的 ${chosen.length} 条边就是答案；灰色的看过没用、红色的会成环`),
      dsuBoard(dsu, [], `所有顶点并成了一个集合，说明整张图连通`),
    ],
    comment: `⑤ 选够 n-1 = ${n - 1} 条边就收工。最小生成树 = ${chosen
      .map((e) => `${V(e.i)}-${V(e.j)}(${e.w})`)
      .join(' + ')} = ${total}。和 Prim 得到的两棵树权值一定相等（可能选的边不完全一样，但总权值一样）：Kruskal 是"按边从小到大捡，不成环就要"，Prim 是"从一个点开始长，每次接最近的"，目标都是 n-1 条边、总权值最小`,
    vars: { 边数: chosen.length, 总权值: total },
  }
}

/* ================================================================== *
 * 五、最短路径 · Dijkstra
 * ================================================================== */

/**
 * 单源最短路：dist[v] = 起点到 v 目前已知的最短距离。
 * 每轮从**未确定**的顶点里挑 dist 最小的，它这时候的 dist 就是最终答案
 * （因为所有边权非负，绕远路只会更长），然后松弛它的每条出边。
 */

const CODE_DIJKSTRA = [
  '// 单源最短路：dist[v] = 起点到 v 目前已知的最短距离，S = 已确定的顶点集合',
  'void Dijkstra(Graph G, int start) {',
  '  for (int v = 1; v <= n; v++) { dist[v] = ∞; S[v] = 0; }   // ① 全都不确定',
  '  dist[start] = 0;                                          // ② 起点到自己当然是 0',
  '  for (int k = 1; k <= n; k++) {                            // ③ 一共确定 n 个顶点',
  '    int u = 取 dist 最小且未确定的顶点;                       // ④ 它的 dist 已经是最终答案',
  '    S[u] = 1;                                               // ⑤ 确定 u',
  '    for (u 的每条邻边 (u, v, w))                             // ⑥ 松弛',
  '      if (dist[u] + w < dist[v]) dist[v] = dist[u] + w;      //    绕道 u 更近就改小',
  '  }',
  '}',
]

/** dist + S 板：每格是 dist（共 n 格），已确定的标绿，正在松弛的边另一端标紫 */
function distBoard(
  g: UGraph,
  dist: number[],
  done: Set<number>,
  hot: number[],
  note: string,
): BoardView {
  const items: CellItem[] = g.ids.map((_, k) => {
    const v = k + 1
    return {
      text: inf(dist[k]!),
      sub: `S=${done.has(v) ? 1 : 0}`,
      tone: done.has(v) ? 'done' : hot.includes(v) ? 'hot' : 'base',
    }
  })
  const pointers: Record<string, number> = {}
  const cur = hot.find((v) => v >= 1 && v <= items.length)
  if (cur !== undefined) pointers.当前 = cur - 1
  return rowBoard(
    'dist[] —— 起点到每个顶点的当前最短距离（sub 是"是否已确定"）',
    items,
    pointers,
    note,
  )
}

function* runDijkstra(data: number[], ctx?: { target?: number }): AlgoRunner {
  const g = ug(nOf(data))
  const n = g.n
  // 起点可以在界面上通过"目标值"选，是空就用 V1
  const start =
    ctx?.target !== undefined && ctx.target >= 1 && ctx.target <= n ? Math.floor(ctx.target) : 1

  const dist = new Array<number>(n).fill(INF)
  const prev = new Array<number>(n).fill(0)
  const done = new Set<number>()
  dist[start - 1] = 0

  const snap = (
    hot: string[],
    note: string,
    labelOf: (e: WEdge) => string | undefined = () => undefined,
  ): GraphView => ({
    nodes: ugNodes(g),
    edges: ugEdges(g, (e) => ({
      from: U(e.i),
      to: U(e.j),
      w: e.w,
      // 松弛时把那条边标成 hot（紫色），一眼能看出"现在在用哪条边绕"
      tone: labelOf(e) !== undefined ? 'hot' : 'base',
      label: labelOf(e),
    })),
    hot,
    done: [...done].map(U),
    badges: Object.fromEntries(g.ids.map((id, k) => [id, `dist=${inf(dist[k]!)}`])),
    note,
  })

  yield {
    line: 4,
    action: 'init',
    array: dist.slice(),
    graph: snap(
      [U(start)],
      `② 先把 dist[${V(start)}] 设成 0（起点到自己不用走路），其余顶点的 dist 都还是 ∞`,
    ),
    boards: [
      distBoard(
        g,
        dist,
        done,
        [start],
        `起点是 ${V(start)}：它自己的 dist = 0，别的顶点都还没走过，一律 ∞`,
      ),
    ],
    comment: `① 从 ${V(start)} 出发求到其余每个顶点的最短路。一开始谁都没确定：dist[${V(start)}] = 0（自己到自己），其余全是 ∞；S 集合是空的。Dijkstra 只能用在**边权非负**的图上 —— 因为它的依据是"绕远路只会更长"`,
    vars: { n, 起点: start, 已确定: 0 },
  }

  for (let k = 1; k <= n; k++) {
    // ④ 未确定顶点里 dist 最小的那个
    let u = 0
    for (let v = 1; v <= n; v++) {
      if (done.has(v)) continue
      if (u === 0 || dist[v - 1]! < dist[u - 1]!) u = v
    }
    const du = dist[u - 1]!
    done.add(u)

    yield {
      line: 6,
      action: 'mark',
      array: dist.slice(),
      graph: snap(
        [U(u)],
        `④ 未确定顶点里 dist 最小的就是 ${V(u)}：dist = ${inf(du)}。因为边权都非负，绕别的路只会更长，所以这个值已经是最终答案`,
      ),
      boards: [
        distBoard(g, dist, done, [u], `第 ${k} 轮确定 ${V(u)}：dist = ${inf(du)}，加进 S 集合`),
      ],
      comment: `${
        k === 1 ? '④ 第一轮' : `④ 第 ${k} 轮`
      }：还没确定的顶点是 {${g.ids
        .map((_, i) => i + 1)
        .filter((v) => !done.has(v) || v === u)
        .map(V)
        .join(', ')}}，其中 ${V(u)} 的 dist = ${inf(du)} 最小，所以现在就确定它 —— 以后不管怎么绕都不可能比 ${inf(
        du,
      )} 更短（这就是贪心的依据）`,
      vars: { 第几轮: k, u, dist: du },
    }

    // ⑥ 松弛 u 的每条邻边
    const relaxEdges = edgesAt(g, u)
    // 这一帧"松弛用的那条边"：环里逐条 yield，所以要把边放到 labels 里
    let relaxIndex = 0
    for (const e of relaxEdges) {
      relaxIndex += 1
      const v = other(e, u)
      if (done.has(v)) continue
      const nd = du + e.w
      const old = dist[v - 1]!
      if (nd < old) {
        dist[v - 1] = nd
        prev[v - 1] = u
        yield {
          line: 9,
          action: 'set',
          array: dist.slice(),
          graph: snap(
            [U(v)],
            `⑥ 松弛边 ${V(u)}-${V(v)}（权值 ${e.w}）：dist[${V(u)}] + ${e.w} = ${nd} < ${inf(
              old,
            )}，所以 dist[${V(v)}] 由 ${inf(old)} 改成 ${nd}（这条边标成紫色）`,
            (x) => (x === e ? `${inf(du)}+${x.w}=${nd}` : undefined),
          ),
          boards: [
            distBoard(g, dist, done, [v], `dist[${V(v)}] 变小了：${inf(old)} -> ${nd}（绕道 ${V(u)} 更近）`),
          ],
          comment: `⑥ 松弛：从刚确定的 ${V(u)} 走到 ${V(v)} 只要 ${e.w}，那么 dist[${V(u)}] + ${e.w} = ${inf(du)} + ${e.w} = ${nd}；原来的 dist[${V(v)}] = ${inf(
            old,
          )} 比它大，说明"绕道 ${V(u)}"更近，于是把 dist[${V(v)}] 改成 ${nd}`,
          vars: { u, v, 新距离: nd, 旧距离: old === INF ? -1 : old, 松弛序: relaxIndex },
        }
      } else {
        yield {
          line: 9,
          action: 'compare',
          array: dist.slice(),
          graph: snap(
            [U(v)],
            `⑥ 松弛边 ${V(u)}-${V(v)}（权值 ${e.w}）：${inf(du)} + ${e.w} = ${nd}，不小于已有的 ${inf(
              old,
            )}，不用改`,
            (x) => (x === e ? `${inf(du)}+${x.w}=${nd}` : undefined),
          ),
          boards: [
            distBoard(g, dist, done, [v], `dist[${V(v)}] 保持 ${inf(old)}：绕道 ${V(u)} 并不更近`),
          ],
          comment: `⑥ 松弛：${inf(du)} + ${e.w} = ${nd}，而 dist[${V(v)}] 已经是 ${inf(
            old,
          )}，${
            nd === old ? '一样短，不用改（保留原来的路径就行）' : '比它大，绕道反而远了，不改'
          }`,
          vars: { u, v, 候选距离: nd, 旧距离: old === INF ? -1 : old, 松弛序: relaxIndex },
        }
      }
    }
  }

  const targets = g.ids.map((_, i) => i + 1).filter((v) => v !== start)
  yield {
    line: 11,
    action: 'done',
    array: dist.slice(),
    graph: snap(
      [],
      `完成：从 ${V(start)} 到各顶点的最短距离 —— ${targets
        .map((v) => `V${v}=${inf(dist[v - 1]!)}`)
        .join('，')}`,
    ),
    boards: [
      distBoard(
        g,
        dist,
        done,
        [],
        `所有顶点的 dist 都定下来了：${targets.map((v) => `V${v}=${inf(dist[v - 1]!)}`).join('，')}`,
      ),
    ],
    comment: `③ 一共做了 ${n} 轮，所有顶点的 dist 都定下来了。从 ${V(start)} 出发的最短距离是：${targets
      .map((v) => `${V(v)} = ${inf(dist[v - 1]!)}`)
      .join('，')}。最后一个确定的顶点其实已经不需要松弛了，但为了"每个顶点都进 S"，循环还是走满 ${n} 轮`,
    vars: { 已确定: done.size, 迭代轮数: n },
  }
}

/* ================================================================== *
 * 六、最短路径 · Floyd
 * ================================================================== */

/**
 * 各顶点间最短路径：三层循环 for k / for i / for j。
 * 每一轮 k 表示"允许用 V(k+1) 当中转站"，把所有 D[i][j] 和 D[i][k]+D[k][j] 比一遍。
 * 矩阵是主角，所以每帧都把整张矩阵画出来（不可达写 ∞），
 * 并高亮第 k 行、第 k 列和正在被更新的那一格。
 */

const CODE_FLOYD = [
  '// D[i][j] = 只允许经过前若干个顶点时，i 到 j 的最短距离',
  'void Floyd(int D[][], int n) {',
  '  for (int k = 1; k <= n; k++)                  // ② 一轮加一个中转站',
  '    for (int i = 1; i <= n; i++)                // ③ 每一行',
  '      for (int j = 1; j <= n; j++)              // ④ 每一列',
  '        if (D[i][k] + D[k][j] < D[i][j])        // ⑤ 绕道 k 是不是更近',
  '          D[i][j] = D[i][k] + D[k][j];          // ⑥ 更近就改小',
  '}',
]

/** 距离矩阵的初始状态：自己到自己是 0，有边就填边权，没边就 ∞ */
function floydInit(g: UGraph): number[][] {
  const n = g.n
  const D: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(INF))
  for (let i = 0; i < n; i++) D[i]![i] = 0
  for (const e of g.edges) {
    D[e.i - 1]![e.j - 1] = e.w
    D[e.j - 1]![e.i - 1] = e.w
  }
  return D
}

/** 矩阵拍平成 array（行优先），每帧的 array 就是它 */
const flat = (D: number[][]): number[] => D.flatMap((r) => r)

/**
 * 把整张矩阵画成一块 grid 板子（列数 = n + 1）。
 * 第 0 行 / 第 0 列是表头（顶点名），(i+1, j+1) 那格就是 D[i][j]。
 * 高亮规则：第 k 行第 k 列（这一轮的中转站，紫）、被读取的 D[i][k] / D[k][j]（紫）、
 * 被更新的 D[i][j]（红 / 绿）。
 */
function matrixBoard(
  g: UGraph,
  D: number[][],
  k: number,
  cur: { i: number; j: number },
  tone: 'hot' | 'done',
  note: string,
): BoardView {
  const n = g.n
  const width = n + 1
  const head = (t: string): CellItem => ({ text: t, tone: 'dim' })
  const rows: CellItem[][] = []
  rows.push([head('D'), ...g.ids.map((_, j) => head(V(j + 1)))])
  for (let i = 0; i < n; i++) {
    const row: CellItem[] = [head(V(i + 1))]
    for (let j = 0; j < n; j++) {
      let t: CellTone = 'base'
      if (i === k || j === k) t = 'hot'
      if (i === cur.i && j === cur.j) t = tone
      row.push({ text: inf(D[i]![j]!), sub: `D${i + 1}${j + 1}`, tone: t })
    }
    rows.push(row)
  }
  const pointers: Record<string, number> = {}
  if (k >= 0 && k < n) pointers[`k=${V(k + 1)}`] = (k + 1) * width // 第 k 行行首那格
  if (cur.i >= 0 && cur.i < n && cur.j >= 0 && cur.j < n) {
    pointers[`D[${V(cur.i + 1)}][${V(cur.j + 1)}]`] = (cur.i + 1) * width + cur.j + 1
  }
  return gridBoard(
    `距离矩阵 D[i][j]（${n} 阶，不可达写 ∞；行 = 起点，列 = 终点）`,
    width,
    rows,
    pointers,
    note,
  )
}

function* runFloyd(data: number[]): AlgoRunner {
  const g = ug(nOf(data))
  const n = g.n
  const D = floydInit(g)

  /** 图上的边：矩阵里"直接连通"的那些（∞ 的不画） */
  const snap = (hot: string[], note: string): GraphView => ({
    nodes: ugNodes(g),
    edges: ugEdges(g, (e) => ({ from: U(e.i), to: U(e.j), w: e.w, tone: 'base' as const })),
    hot,
    done: [],
    badges: Object.fromEntries(g.ids.map((id, k) => [id, `行${D[k]!.map(inf).join('/')}`])),
    note,
  })

  let updates = 0
  for (let k = 0; k < n; k++) {
    yield {
      line: 3,
      action: 'mark',
      array: flat(D),
      graph: snap(
        [U(k + 1)],
        `② 这一轮允许经过的中转站是 ${V(k + 1)}：把矩阵里第 ${k + 1} 行、第 ${k + 1} 列当作"经过 ${
          V(k + 1)
        } 的路"，去和别的格子比`,
      ),
      boards: [
        matrixBoard(
          g,
          D,
          k,
          { i: -1, j: -1 },
          'hot',
          `第 ${k + 1} 轮：中转站 k = ${V(k + 1)}（高亮的行和列就是它）`,
        ),
      ],
      comment: `② 第 ${k + 1} 轮，中转站 k = ${V(k + 1)}。含义是：现在允许路径**经过 ${V(k + 1)}**，把所有格子 D[i][j] 和"先到 ${V(
        k + 1,
      )} 再去 j"的距离 D[i][${V(k + 1)}] + D[${V(k + 1)}][j] 比一比。第 ${k + 1} 行第 ${k + 1} 列是这一轮要反复用到的数据，先高亮出来`,
      vars: { k: k + 1, 轮次: k + 1 },
    }

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === k || j === k) continue // D[k][…] / D[…][k] 这一轮不会变，跳过不看
        const via = D[i]![k]! + D[k]![j]!
        if (!(via < D[i]![j]!)) continue

        const old = D[i]![j]!
        D[i]![j] = via
        updates++

        yield {
          line: 6,
          action: 'set',
          array: flat(D),
          graph: snap(
            [U(k + 1)],
            `⑥ 发现更近的路：${V(i + 1)} -> ${V(k + 1)} -> ${V(j + 1)} 一共 ${via}，比原来的 ${inf(
              old,
            )} 短，所以 D[${V(i + 1)}][${V(j + 1)}] 改成 ${via}`,
          ),
          boards: [
            matrixBoard(
              g,
              D,
              k,
              { i, j },
              'done',
              `D[${V(i + 1)}][${V(j + 1)}]：读 D[${V(i + 1)}][${V(k + 1)}] = ${inf(D[i]![k]!)} 和 D[${V(
                k + 1,
              )}][${V(j + 1)}] = ${inf(D[k]![j]!)}，相加 ${via} < 原来的 ${inf(old)}，改小`,
            ),
          ],
          comment: `⑤⑥ 看 D[${V(i + 1)}][${V(j + 1)}]：原来是 ${inf(old)}。绕道 ${V(k + 1)} 呢？D[${V(i + 1)}][${V(
            k + 1,
          )}] + D[${V(k + 1)}][${V(j + 1)}] = ${inf(D[i]![k]!)} + ${inf(D[k]![j]!)} = ${via}，比 ${inf(
            old,
          )} 小，所以更新：D[${V(i + 1)}][${V(j + 1)}] = min(${inf(old)}, ${via}) = ${via}`,
          vars: { k: k + 1, i: i + 1, j: j + 1, 新值: via, 旧值: old === INF ? -1 : old },
        }
      }
    }
  }

  yield {
    line: 7,
    action: 'done',
    array: flat(D),
    graph: snap([], `完成：矩阵里每个格子就是两两之间的最短距离（一共更新了 ${updates} 次）`),
    boards: [
      matrixBoard(
        g,
        D,
        -1,
        { i: -1, j: -1 },
        'hot',
        '最终距离矩阵：第 i 行第 j 列就是 Vi 到 Vj 的最短距离',
      ),
    ],
    comment: `三层循环跑完，矩阵里每个格子都是最终答案了。任意两个顶点之间都能走通（没有 ∞），最远的一对是 ${(() => {
      let best: { i: number; j: number; d: number } | null = null
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          if (i !== j && D[i]![j]! < INF && (!best || D[i]![j]! > best.d)) best = { i, j, d: D[i]![j]! }
      return best ? `${V(best.i + 1)} 到 ${V(best.j + 1)}，距离 ${best.d}` : '—'
    })()}。整个过程一共更新了 ${updates} 次。Floyd 的好处是不怕负权边，而且一次就把**所有顶点对**的最短距离都算出来了`,
    vars: { 更新次数: updates, 顶点数: n },
  }
}

/* ================================================================== *
 * 七、关键路径（AOE 网）
 * ================================================================== */

/**
 * AOE 网：顶点 = 事件，有向边 = 活动，边权 = 活动持续时间。
 *
 * 顶点还是按 n 摆在圆周上，但边**只允许小号指向大号**（天然无环），
 * 所以箭头一律顺着圆环往前走：V1 是源点（开工），Vn 是汇点（完工），
 * 中间的每个事件都既有入边也有出边。
 * 边由两段拼成：
 *   ① 主干 V1→V2→…→Vn（n-1 条），保证每个中间事件都有入边和出边；
 *   ② 三条捷径 V1→V3、V2→V4、V3→Vn，让关键路径未必就是主干。
 * 一共 n + 2 条活动，持续时间都是确定值（主干 1..4 天，捷径 5..7 天）。
 */
interface Act {
  /** 起点顶点编号 1..n */
  u: number
  /** 终点顶点编号 1..n */
  v: number
  /** 活动持续时间（边权） */
  d: number
  /** 活动名 a1..a(n+2)，讲解时好指代 */
  name: string
}

/** 活动名（a1、a2…）在图上标在箭头下面，靠它把"活动"和"边"对上 */
const actKey = (u: number, v: number): string => `${u}>${v}`

/** 一张按 n 生成好的 AOE 网 */
interface AoeNet {
  n: number
  acts: Act[]
  ids: string[]
  pos: Record<string, { x: number; y: number }>
  /** 每个顶点的入边 / 出边（按另一端的编号排，顺序稳定） */
  preds: Map<number, Act[]>
  succs: Map<number, Act[]>
}

/** 按 n 生成 AOE 网：小号指向大号（无环）、V1 入度 0、Vn 出度 0、n+2 条活动 */
const buildAoe = (n: number): AoeNet => {
  const acts: Act[] = []
  const seen = new Set<string>()
  const add = (u: number, v: number, d: number): void => {
    if (u >= v || v > n || seen.has(actKey(u, v))) return
    seen.add(actKey(u, v))
    acts.push({ u, v, d, name: '' })
  }

  // ① 主干：V1→V2→…→Vn，每道工序 1..4 天
  for (let i = 1; i < n; i++) add(i, i + 1, trunkDays(i, n))
  // ② 三条捷径（还是小号指向大号）：7 / 6 / 5 天，比主干单步贵，但能"一步跨过去"
  add(1, 3, 7)
  add(2, 4, 6)
  add(3, n, 5)

  acts.sort((a, b) => a.u - b.u || a.v - b.v)
  acts.forEach((a, idx) => {
    a.name = `a${idx + 1}`
  })

  const ids = Array.from({ length: n }, (_, k) => U(k + 1))
  const preds = new Map<number, Act[]>()
  const succs = new Map<number, Act[]>()
  for (let v = 1; v <= n; v++) {
    preds.set(v, [])
    succs.set(v, [])
  }
  for (const a of acts) {
    preds.get(a.v)!.push(a)
    succs.get(a.u)!.push(a)
  }
  for (const list of preds.values()) list.sort((a, b) => a.u - b.u)
  for (const list of succs.values()) list.sort((a, b) => a.v - b.v)

  return {
    n,
    acts,
    ids,
    pos: Object.fromEntries(ids.map((id, k) => [id, ring(k, n)])),
    preds,
    succs,
  }
}

/** 同一个 n 只建一次 AOE 网 */
const AOE_CACHE = new Map<number, AoeNet>()
const aoe = (n: number): AoeNet => {
  let net = AOE_CACHE.get(n)
  if (!net) {
    net = buildAoe(n)
    AOE_CACHE.set(n, net)
  }
  return net
}

const CODE_CP = [
  '// AOE 网：顶点是事件，有向边 (i, j, w) 是活动，w 是活动持续时间',
  'Status CriticalPath(ALGraph G) {                       // 求关键路径',
  '  按拓扑序求 ve（事件最早发生时间）;                     // ① ve[j] = max(ve[i] + w)',
  '  按逆拓扑序求 vl（事件最晚发生时间）;                   // ② vl[i] = min(vl[j] - w)',
  '  for (每条活动 a = (i, j)) {                          // ③ 活动的两个时间',
  '    e[a] = ve[i];                                      //    最早开始 = 起点的最早发生',
  '    l[a] = vl[j] - w;                                  //    最晚开始 = 终点的最晚发生 - 持续时间',
  '    if (e[a] == l[a]) 标记为关键活动;                    // ④ e == l 就是关键活动',
  '  }',
  '}',
]

/** ve/vl 板子（n 格）：每格显示 ve 和 vl，已求出来的标绿 */
function vevlBoard(
  net: AoeNet,
  ve: number[],
  vl: number[],
  done: Set<number>,
  cur: number,
  note: string,
): BoardView {
  const items: CellItem[] = net.ids.map((_, k) => {
    const v = k + 1
    const hasVl = vl[k] !== undefined && vl[k] !== INF
    return {
      text: `ve=${inf(ve[k]!)}`,
      sub: hasVl ? `vl=${inf(vl[k]!)}` : V(v),
      tone: done.has(v) ? 'done' : v === cur ? 'hot' : 'base',
    }
  })
  return rowBoard(
    `事件的最早 / 最晚发生时间（V1..V${net.n}）`,
    items,
    cur >= 1 && cur <= items.length ? { 当前: cur - 1 } : {},
    note,
  )
}

/**
 * 活动表：一行一条活动（共 n+2 行），列 = 活动名 / 起止事件 / 持续时间 / e / l / l-e / 是否关键。
 * 第一列是行标题（和 Floyd 的矩阵一样，第 0 行第 0 列当表头）。
 */
function actBoard(
  net: AoeNet,
  ve: number[],
  vl: number[],
  flag: Array<'pending' | 'cur' | 'critical' | 'normal'>,
  curAct: number,
  note: string,
): BoardView {
  const rows: CellItem[][] = []
  const head = (t: string): CellItem => ({ text: t, tone: 'dim' })
  rows.push(['活动', '起止事件', '持续时间', 'e', 'l', 'l - e', '关键？'].map(head))
  const vlReady = vl.every((x) => x !== INF)
  net.acts.forEach((a, idx) => {
    const e = ve[a.u - 1]!
    const l = vlReady ? vl[a.v - 1]! - a.d : INF
    const critical = vlReady && e === l
    const tone: CellTone =
      idx === curAct ? 'hot' : flag[idx] === 'critical' ? 'done' : flag[idx] === 'normal' ? 'dim' : 'base'
    const cell = (t: string): CellItem => ({ text: t, tone })
    rows.push([
      cell(a.name),
      cell(V(a.u) + '→' + V(a.v)),
      cell(String(a.d)),
      cell(inf(e)),
      cell(vlReady ? inf(l) : '—'),
      cell(vlReady ? String(l - e) : '—'),
      cell(vlReady ? (critical ? '是关键活动' : '') : '—'),
    ])
  })
  const width = 7
  return gridBoard(
    '各活动的 e（最早开始）/ l（最晚开始）',
    width,
    rows,
    curAct >= 0 && curAct < net.acts.length ? { 当前活动: (curAct + 1) * width + 1 } : {},
    note,
  )
}

/** AOE 图的边快照：关键活动标红加粗（tone:'mark'），label 写活动名，w 是持续时间 */
function aoeEdges(
  net: AoeNet,
  critical: Set<string>,
  highlight: Set<string>,
): GraphEdgeSnapshot[] {
  return net.acts.map((a) => ({
    from: U(a.u),
    to: U(a.v),
    w: a.d,
    directed: true,
    tone: critical.has(actKey(a.u, a.v)) ? 'mark' : highlight.has(actKey(a.u, a.v)) ? 'hot' : 'base',
    label: a.name,
  }))
}

const aoeNodes = (net: AoeNet): GraphNodeSnapshot[] =>
  net.ids.map((id, k) => ({ id, label: V(k + 1), x: net.pos[id]!.x, y: net.pos[id]!.y }))

function* runCriticalPath(data: number[]): AlgoRunner {
  const net = aoe(nOf(data))
  const n = net.n
  const m = net.acts.length
  const ve = new Array<number>(n).fill(0)
  const vl = new Array<number>(n).fill(INF)
  const veDone = new Set<number>([1])
  const critical = new Set<string>()
  const flag: Array<'pending' | 'cur' | 'critical' | 'normal'> = net.acts.map(() => 'pending')

  /** 拓扑序：按"所有前驱都排完了"一遍扫出来（AOE 网必定无环） */
  const topo: number[] = []
  {
    const indeg = new Array<number>(n + 1).fill(0)
    for (const a of net.acts) indeg[a.v]!++
    const q = [1]
    while (q.length) {
      const u = q.shift()!
      topo.push(u)
      for (const a of net.succs.get(u)!) {
        indeg[a.v]!--
        if (indeg[a.v] === 0) q.push(a.v)
      }
    }
  }

  const vBadge = (k: number): string =>
    vl[k] === INF ? `ve=${inf(ve[k]!)}` : `ve=${inf(ve[k]!)} vl=${inf(vl[k]!)}`

  const snap = (hot: string[], note: string, highlight: Set<string> = new Set()): GraphView => ({
    nodes: aoeNodes(net),
    edges: aoeEdges(net, critical, highlight),
    hot,
    done: [...veDone].map(U),
    badges: Object.fromEntries(net.ids.map((id, k) => [id, vBadge(k)])),
    note,
  })

  yield {
    line: 3,
    action: 'init',
    array: ve.slice(),
    graph: snap(
      [U(1)],
      `① 源点 V1 的最早发生时间 ve[V1] = 0（工程从第 0 天开工）；每条箭头上的数字是活动持续时间，箭头下面的 a1..a${m} 是活动名`,
    ),
    boards: [
      vevlBoard(net, ve, vl, veDone, 1, `起点 V1 的 ve = 0，其余顶点还没算（vl 还没到算的时候）`),
      actBoard(net, ve, vl, flag, -1, `e 和 l 还都没算出来：先要把 ve / vl 求出来`),
    ],
    comment: `AOE 网（Activity On Edge）：**顶点表示事件**（比如"${V(
      Math.min(4, n),
    )} 事件发生"就是它前面几项活都干完了），**有向边表示活动**，边权就是这项活动要干多少天。V1 是源点（整个工程的开工时刻），${V(
      n,
    )} 是汇点（完工时刻）。先按拓扑序求每个事件的**最早发生时间 ve**：ve[V1] = 0，其余事件要等它前面所有活动都干完才能发生`,
    vars: { 顶点数: n, 活动数: m },
  }

  // ① 拓扑序求 ve
  for (const v of topo) {
    if (v === 1) continue
    const ps = net.preds.get(v)!
    let best = { from: 0, val: -1 }
    for (const a of ps) {
      const cand = ve[a.u - 1]! + a.d
      if (cand > best.val) best = { from: a.u, val: cand }
    }
    ve[v - 1] = best.val
    veDone.add(v)

    yield {
      line: 3,
      action: 'set',
      array: ve.slice(),
      graph: snap(
        [U(v)],
        `① 事件 ${V(v)} 的 ve = max(前驱的 ve + 活动时间) = ${best.val}：卡在最长的那条路上，也就是 ${V(
          best.from,
        )} 这条路`,
        new Set(net.preds.get(v)!.map((a) => actKey(a.u, a.v))),
      ),
      boards: [
        vevlBoard(net, ve, vl, veDone, v, `${V(v)} 的 ve 由所有入边里"最晚结束"的那条决定，= ${best.val}`),
        actBoard(net, ve, vl, flag, -1, `ve 求到 ${V(v)} 了；e / l 要等 vl 也算完`),
      ],
      comment: `① 求事件 ${V(v)} 的最早发生时间：它前面有 ${ps.length} 项活动，全干完它才能发生，所以 ve[${V(
        v,
      )}] = max(前驱的 ve + 那项活动的时间)。逐条算：${ps
        .map((a) => `${V(a.u)}->${V(v)} 是 ${ve[a.u - 1]} + ${a.d} = ${ve[a.u - 1]! + a.d}`)
        .join('，')}，取最大的 ${best.val}（由 ${V(best.from)} 那条路决定）。压着最长的那条走，其它更短的路都等得起`,
      vars: { v, ve: best.val },
    }
  }

  const veEnd = ve[n - 1]!
  yield {
    line: 3,
    action: 'mark',
    array: ve.slice(),
    graph: snap(
      [U(n)],
      `汇点 ${V(n)} 的 ve = ${veEnd}，这就是整个工程的**最短工期**：所有活动都干完至少需要 ${veEnd}`,
    ),
    boards: [
      vevlBoard(net, ve, vl, veDone, n, `ve 全部求好了，汇点 ${V(n)} 的 ve = ${veEnd} 就是最短工期`),
      actBoard(net, ve, vl, flag, -1, `下面开始逆着推 vl`),
    ],
    comment: `① 拓扑序走完，ve 全都求出来了：${net.ids
      .map((_, k) => `ve[${V(k + 1)}]=${ve[k]}`)
      .join('，')}。汇点 ${V(n)} 的 ve = ${veEnd}，意思是整个工程最快 ${veEnd} 天完工；这也是所有活动还没开始时的"总工期"`,
    vars: { 最短工期: veEnd },
  }

  // ② 逆拓扑序求 vl
  vl[n - 1] = veEnd
  yield {
    line: 4,
    action: 'init',
    array: ve.slice(),
    graph: snap(
      [U(n)],
      `② 反着推最晚发生时间：汇点 ${V(n)} 的 vl 必须等于 ve（不能拖工期），vl[${V(n)}] = ${veEnd}`,
    ),
    boards: [
      vevlBoard(net, ve, vl, new Set([n]), n, `逆拓扑序的起点：vl[${V(n)}] = ve[${V(n)}] = ${veEnd}`),
      actBoard(net, ve, vl, flag, -1, `开始推 vl`),
    ],
    comment: `② 现在倒过来推**最晚发生时间 vl**：在不拖整个工程后腿的前提下，事件最晚能拖到第几天发生。汇点最特殊：它必须正好在第 ${veEnd} 天完工，所以 vl[${V(
      n,
    )}] = ve[${V(n)}] = ${veEnd}`,
    vars: { 最短工期: veEnd },
  }

  for (let idx = topo.length - 2; idx >= 0; idx--) {
    const v = topo[idx]!
    const ss = net.succs.get(v)!
    let best = { to: 0, val: 0 }
    let first = true
    for (const a of ss) {
      const cand = vl[a.v - 1]! - a.d
      if (first || cand < best.val) {
        best = { to: a.v, val: cand }
        first = false
      }
    }
    vl[v - 1] = best.val

    yield {
      line: 4,
      action: 'set',
      array: ve.slice(),
      graph: snap(
        [U(v)],
        `② 事件 ${V(v)} 的 vl = min(后继的 vl - 活动时间) = ${best.val}，卡在 ${V(best.to)} 这条路上`,
        new Set(ss.map((a) => actKey(a.u, a.v))),
      ),
      boards: [
        vevlBoard(net, ve, vl, new Set([...veDone]), v, `${V(v)} 的 vl = ${best.val}`),
        actBoard(net, ve, vl, flag, -1, `vl 推到 ${V(v)}`),
      ],
      comment: `② 逆着推 ${V(v)} 的最晚发生时间：它后面有 ${ss.length} 项活动，任何一项都不能因为 ${V(
        v,
      )} 晚了而拖延，所以 vl[${V(v)}] = min(后继的 vl - 那项活动的时间)。逐条算：${ss
        .map((a) => `${V(v)}->${V(a.v)} 是 ${vl[a.v - 1]} - ${a.d} = ${vl[a.v - 1]! - a.d}`)
        .join('，')}，取最小的 ${best.val}。${
        vl[v - 1] === ve[v - 1]
          ? `它和 ve[${V(v)}] = ${ve[v - 1]} 一样 —— 一点富余都没有，这个事件在关键路径上`
          : `它比 ve[${V(v)}] = ${ve[v - 1]} 大 ${vl[v - 1]! - ve[v - 1]!} 天，说明这个事件有点富余`
      }`,
      vars: { v, vl: best.val, 富余: vl[v - 1]! - ve[v - 1]! },
    }
  }

  // ③④ 每条活动的 e / l，并挑出关键活动
  for (let idx = 0; idx < net.acts.length; idx++) {
    const a = net.acts[idx]!
    const e = ve[a.u - 1]!
    const l = vl[a.v - 1]! - a.d
    const isCritical = e === l
    flag[idx] = isCritical ? 'critical' : 'normal'
    if (isCritical) critical.add(actKey(a.u, a.v))

    yield {
      line: isCritical ? 8 : 7,
      action: isCritical ? 'mark' : 'compare',
      array: ve.slice(),
      graph: snap(
        [U(a.u), U(a.v)],
        `③④ 活动 ${a.name}（${V(a.u)}→${V(a.v)}，${a.d} 天）：e = ve[${V(a.u)}] = ${e}，l = vl[${V(a.v)}] - ${a.d} = ${l}，e ${
          isCritical ? '=' : '<'
        } l ${isCritical ? '→ 这是关键活动（标红加粗）' : `→ 有 ${l - e} 天机动时间，不是关键活动`}`,
        new Set([actKey(a.u, a.v)]),
      ),
      boards: [
        vevlBoard(net, ve, vl, new Set([...veDone]), 0, `关键活动越攒越多：现在有 ${critical.size} 条`),
        actBoard(
          net,
          ve,
          vl,
          flag,
          idx,
          `${a.name}：e = ${e}，l = ${l}，${isCritical ? 'e = l，关键' : `l - e = ${l - e}，有富余`}`,
        ),
      ],
      comment: isCritical
        ? `④ 活动 ${a.name}（${V(a.u)}→${V(a.v)}，要干 ${a.d} 天）：最早开始 e = ve[${V(a.u)}] = ${e}，最晚开始 l = vl[${V(
            a.v,
          )}] - ${a.d} = ${l}。e = l，意味着它**一天都不能拖**，一拖整个工程就延期 —— 这就是一条关键活动（图上标成红色加粗）`
        : `③ 活动 ${a.name}（${V(a.u)}→${V(a.v)}，要干 ${a.d} 天）：最早开始 e = ve[${V(a.u)}] = ${e}，最晚开始 l = vl[${V(
            a.v,
          )}] - ${a.d} = ${l}。l - e = ${l - e} > 0，说明它可以晚 ${l - e} 天开工也不影响工期，不是关键活动`,
      vars: { e, l: l, 机动时间: l - e },
    }
  }

  /*
   * 关键路径：从源点出发，每一步只走关键活动。
   *
   * 注意这里**不能随便挑第一条关键活动**就往下走：关键活动只是"一天都不能拖"的活动，
   * 它们合起来是一张子图，里面可能有好几条从源点到汇点的路（比如 V1 出去就可能不止一条关键活动）。
   * 随便走会走出一条短的路（长度对不上工期），所以每一步都挑"到汇点最远"的那条继续走，
   * 这样走出来的才是**最长的那条关键路径**，长度正好等于最短工期 ve[汇点]。
   */
  const path: number[] = [1]
  for (let cur = 1; cur !== n; ) {
    const outs = net.succs.get(cur)!.filter((a) => critical.has(actKey(a.u, a.v)))
    let best: Act | null = null
    for (const a of outs) if (best === null || vl[a.v - 1]! > vl[best.v - 1]!) best = a
    if (best === null) break
    path.push(best.v)
    cur = best.v
  }
  const pathActs = net.acts.filter((a) => critical.has(actKey(a.u, a.v)))

  yield {
    line: 8,
    action: 'done',
    array: ve.slice(),
    graph: snap(
      [U(1), U(n)],
      `完成：关键活动 = ${pathActs.map((a) => a.name).join('、')}，串起来就是关键路径 ${path
        .map(V)
        .join(' → ')}，长度 ${veEnd}`,
    ),
    boards: [
      vevlBoard(
        net,
        ve,
        vl,
        new Set([...veDone]),
        0,
        `ve 和 vl 全都求好了；表里"关键？"列写着"是关键活动"的都是 e = l`,
      ),
      actBoard(net, ve, vl, flag, -1, `一共 ${critical.size} 条关键活动，它们的 e 和 l 完全相等`),
    ],
    comment: `④ 所有活动的 e 和 l 都算完了，凡是 **e = l** 的就是关键活动，一共 ${critical.size} 条：${pathActs
      .map((a) => `${a.name}(${V(a.u)}→${V(a.v)})`)
      .join('、')}。把它们从源点串到汇点就得到**关键路径**：${path
      .map(V)
      .join(' → ')}，长度 ${pathActs
      .filter((a) => path.includes(a.u) && path.includes(a.v))
      .reduce((s, a) => s + a.d, 0)} = 最短工期 ${veEnd}（这条路上每一项活动都是 e = l，一次都拖不得；想缩短工期只能从这里想办法，比如给 ${
      pathActs.find((a) => a.u === path[1])?.name ?? '关键活动'
    } 加人手）`,
    vars: { 关键活动数: critical.size, 最短工期: veEnd },
  }
}

/* ================================================================== *
 * 八、注册表
 * ================================================================== */

/**
 * 五个图算法的**顶点数 = 数据规模 n**，下拉框统一给 5..9 五档：
 * 顶点、边、矩阵阶数、板子的格数全都按 n 现算（图本身也是按 n 确定性生成的），
 * 所以每一档画出来都是完整、对得上的画面。
 * prepareData 把任意输入规整成"n 个顶点编号"（n 夹在 5..9），
 * 这样"随机数据 / 换数据规模"在图上也有意义 —— 换个规模就是换一张图。
 */
export const graphPathSpecs: AlgorithmSpec[] = [
  {
    id: 'graph-prim',
    name: '最小生成树·Prim',
    category: 'graph',
    group: '最小生成树',
    summary: '从一个起点开始，每次把"连接已选集合与未选集合的最小边"加进来',
    complexity: { time: 'O(n²)', space: 'O(n)' },
    renderer: 'graph',
    codeLines: CODE_PRIM,
    defaultData: () => vertexData(),
    sizes: [...SIZES],
    prepareData,
    initComment: (data) => {
      const g = ug(nOf(data))
      return `无向连通带权图：${g.n} 个顶点 V1~V${g.n} 摆成一圈，${g.edges.length} 条边上的数字就是权值。Prim 从 V1 出发：每次把"连接已选集合和未选集合的最小边"加进来，挑 n-1 = ${g.n - 1} 条边就够把 ${g.n} 个顶点连通了`
    },
    initGraph: (data) => {
      const g = ug(nOf(data))
      const lowcost = new Array<number>(g.n).fill(INF)
      lowcost[0] = 0
      const startEdges = edgesAt(g, 1)
      for (const e of startEdges) lowcost[other(e, 1) - 1] = e.w
      return {
        nodes: ugNodes(g),
        edges: ugEdges(g, (e) => ({
          from: U(e.i),
          to: U(e.j),
          w: e.w,
          tone: e.i === 1 || e.j === 1 ? 'hot' : 'base',
          label: e.i === 1 || e.j === 1 ? `候选${e.w}` : undefined,
        })),
        hot: [U(1)],
        done: [U(1)],
        badges: Object.fromEntries(
          g.ids.map((id, k) => [id, k === 0 ? '已选' : `lowcost=${inf(lowcost[k]!)}`]),
        ),
        note: `起点 V1 已经在已选集合里（绿色），从它出发的 ${startEdges.length} 条边成了候选边（紫色）`,
      }
    },
    createRunner: runPrim,
  },
  {
    id: 'graph-kruskal',
    name: '最小生成树·Kruskal',
    category: 'graph',
    group: '最小生成树',
    summary: '把所有边按权值排序，从小到大依次考察，不成环就加入生成树',
    complexity: { time: 'O(e log e)', space: 'O(n)' },
    renderer: 'graph',
    codeLines: CODE_KRUSKAL,
    defaultData: () => vertexData(),
    sizes: [...SIZES],
    prepareData,
    initComment: (data) => {
      const g = ug(nOf(data))
      return `同样这张 ${g.n} 顶点、${g.edges.length} 条边的无向连通带权图。Kruskal 不从一个点出发，而是把 ${g.byW.length} 条边**按权值从小到大排队**：${g.byW
        .map(sortedEdgeText)
        .join(' < ')}，然后一条条考察，不成环就加入，选够 ${g.n - 1} 条为止`
    },
    initGraph: (data) => {
      const g = ug(nOf(data))
      return {
        nodes: ugNodes(g),
        edges: ugEdges(g, (e) => ({ from: U(e.i), to: U(e.j), w: e.w, tone: 'base' as const })),
        hot: [],
        done: [],
        badges: Object.fromEntries(g.ids.map((id, k) => [id, `集合${V(k + 1)}`])),
        note: '每个顶点先各自成一个集合（badge 里的"集合V几"就是它所在集合的代表）',
      }
    },
    createRunner: runKruskal,
  },
  {
    id: 'graph-dijkstra',
    name: '最短路径·Dijkstra',
    category: 'graph',
    group: '最短路径',
    summary: '每次确定 dist 最小的顶点，再用它去松弛别的顶点',
    complexity: { time: 'O(n²)', space: 'O(n)' },
    renderer: 'graph',
    codeLines: CODE_DIJKSTRA,
    defaultData: () => vertexData(),
    sizes: [...SIZES],
    prepareData,
    initComment: (data, ctx) => {
      const n = nOf(data)
      const start =
        ctx?.target !== undefined && ctx.target >= 1 && ctx.target <= n ? Math.floor(ctx.target) : 1
      return `从 ${V(start)} 出发求到其余每个顶点的最短距离。一开始只有 dist[${V(
        start,
      )}] = 0，别的全是 ∞；每个顶点旁边的黄色小标签就是它当前的 dist`
    },
    initGraph: (data, ctx) => {
      const g = ug(nOf(data))
      const n = g.n
      const start =
        ctx?.target !== undefined && ctx.target >= 1 && ctx.target <= n ? Math.floor(ctx.target) : 1
      return {
        nodes: ugNodes(g),
        edges: ugEdges(g, (e) => ({ from: U(e.i), to: U(e.j), w: e.w, tone: 'base' as const })),
        hot: [U(start)],
        done: [],
        badges: Object.fromEntries(
          g.ids.map((id, k) => [id, k === start - 1 ? 'dist=0' : 'dist=∞']),
        ),
        note: `起点 ${V(start)} 的 dist = 0，其余顶点还没有路走过去，dist 都是 ∞`,
      }
    },
    createRunner: runDijkstra,
  },
  {
    id: 'graph-floyd',
    name: '最短路径·Floyd',
    category: 'graph',
    group: '最短路径',
    summary: '三层循环 for k / for i / for j，一轮加一个中转站，一次算出所有顶点对的最短路',
    complexity: { time: 'O(n³)', space: 'O(n²)' },
    renderer: 'graph',
    codeLines: CODE_FLOYD,
    // 数据规模就是矩阵的阶数：n 个顶点 → n×n 的距离矩阵
    defaultData: () => vertexData(),
    sizes: [...SIZES],
    prepareData,
    initComment: () =>
      'Floyd 看的是**距离矩阵**：D[i][j] 一开始就是"只走一条边"的距离（自己到自己是 0，没有直接边的写 ∞）。后面三层循环一轮加一个中转站，最后每个格子都变成两两之间的最短路',
    initGraph: (data) => {
      const g = ug(nOf(data))
      const D = floydInit(g)
      return {
        nodes: ugNodes(g),
        edges: ugEdges(g, (e) => ({ from: U(e.i), to: U(e.j), w: e.w, tone: 'base' as const })),
        hot: [],
        done: [],
        badges: Object.fromEntries(g.ids.map((id, k) => [id, `行${D[k]!.map(inf).join('/')}`])),
        note: '顶点旁边的小字是它在矩阵里那一行：起点到各顶点的**直达**距离（∞ 表示没有直接边）',
      }
    },
    createRunner: runFloyd,
  },
  {
    id: 'graph-critical-path',
    name: '关键路径（AOE 网）',
    category: 'graph',
    group: '关键路径',
    summary: '按拓扑序求 ve、逆拓扑序求 vl，e == l 的活动就是关键活动',
    complexity: { time: 'O(n + e)', space: 'O(n + e)' },
    renderer: 'graph',
    codeLines: CODE_CP,
    defaultData: () => vertexData(),
    sizes: [...SIZES],
    prepareData,
    initComment: (data) => {
      const net = aoe(nOf(data))
      return `有向带权无环图：${net.n} 个顶点摆成一圈，V1 是**源点**（开工）、${V(
        net.n,
      )} 是**汇点**（完工），箭头一律从小号指向大号（所以不会有环）；箭头是**活动**，箭头上的数字是这项活动要干几天。求关键路径分四步：先按拓扑序求事件最早发生时间 ve，再逆拓扑序求最晚发生时间 vl，然后算每条活动的 e 和 l，最后 e = l 的活动就是关键活动，串起来就是关键路径`
    },
    initGraph: (data) => {
      const net = aoe(nOf(data))
      return {
        nodes: aoeNodes(net),
        edges: net.acts.map((a) => ({
          from: U(a.u),
          to: U(a.v),
          w: a.d,
          directed: true,
          tone: 'base' as const,
          label: a.name,
        })),
        hot: [U(1)],
        done: [],
        badges: Object.fromEntries(net.ids.map((id, k) => [id, k === 0 ? 've=0' : 've=∞'])),
        note: `V1 源点的 ve = 0（第 0 天开工）；箭头上的数字是活动持续时间，箭头下面是活动名 a1~a${net.acts.length}`,
      }
    },
    createRunner: runCriticalPath,
  },
]
