import type {
  AlgorithmSpec,
  AlgoRunner,
  BoardView,
  CellTone,
  GraphEdgeSnapshot,
  GraphNodeSnapshot,
  GraphView,
  RunnerContext,
} from '@/core/types'

/**
 * 图 —— 图的遍历与拓扑排序。
 *
 * 顶点坐标用**圆环布局**（ring）：位置在整个算法过程中固定不动，
 * 变动的只有颜色、边上的权值和顶点旁边的小标签 —— 这样"哪一步动了什么"才好读。
 * 圆环第 k 个顶点在 (0.5 + 0.42cos, 0.5 + 0.42sin)，半径 0.42 保证坐标严格落在 0..1 内。
 *
 * 图的规模
 * --------
 *   顶点数 n **就是数据规模**（5..9 个），坐标、边表、邻接表全部由 n 确定性生成：
 *   - 无向图（DFS / BFS）：环 V1-V2-…-Vn-V1 打底（一定连通、没有孤立点）+ ⌊n/2⌋ 条弦；
 *   - 有向图（拓扑排序）：主链 V1->…->Vn 打底 + 4 条跨层边，只从小号指向大号，天然无环。
 *   全程不用 Math.random()，所以同一个 n 每次跑出来的图一模一样。
 *   4 个算法都从 V1 出发；DFS 的邻居一律按顶点编号升序扫，解说词里的顺序才是确定的。
 *
 * 快照约定
 * --------
 *   - hot  = 本步正在看的顶点（紫色）；
 *   - done = 已经访问完的顶点（绿色）；
 *   - badges = 顶点旁边的小标签：DFS/BFS 写访问次序，拓扑排序写入度；
 *   - edges 的 tone：hot = 本步正在走的那条边（紫色加粗）、done = 已经走过的边（绿色）、
 *     mark = 环上的边（红色，只有拓扑排序失败时才会出现）；
 *   - 边上的 label 写的是**走过的步数**（DFS 深度、BFS 层次、拓扑的删除次序），
 *     w 写的是边的编号 —— 两个小字画在边的两侧，不会叠在一起。
 *
 * 拓扑排序的特殊之处（4 个算法里只有它这样）
 * ------------------------------------------
 *   输出的顶点**真的会从图上消失**：每输出一个顶点，那一帧起它的 id 就不在 `nodes` 里了，
 *   `edges` 里所有 `from` 等于它的边也一起没了（不是变灰、也不是留灰色虚线）。
 *   于是 `hot` / `done` / `badges` 里**绝不能再出现已经被删掉的顶点** ——
 *   校验器（`validateSteps`）会因为"引用了不存在的顶点"当场抛错。
 *   所以这张图的每一帧都由 `runTopo` 里的 `topoView()` **统一收口**：按"还在图上的顶点"
 *   过滤顶点、边和 hot / done / badges / sub，任何一帧都不可能漏写。
 *   顶点坐标按它在圆环上的**原始**序号算，所以删掉几个顶点之后，剩下的人位置全程不动。
 *
 * 板子约定
 * --------
 *   图下面挂数组板，把递归栈 / 栈 / 队列 / 已输出的顶点**整个摊开**：
 *   - 竖排（column）第 0 格在**最下面**：`items` 从栈底往栈顶排，最后一格是栈顶，
 *     指针「栈顶」指向最后一格（下标 = 栈长 - 1）；空栈不给指针；
 *   - 横排（row）第 0 格在最左边：`items` 从队首往队尾排，指针「队首」指向第 0 格；
 *     空队列同样不给指针；拓扑排序的「已输出」板子也从第 0 格开始往右一格一格攒；
 *   - 拓扑排序还额外挂一块横排的「入度表」：**每个顶点固定一格**（正文是它当前的入度、
 *     右下角小字是顶点名）。它是**全顶点**的，所以图上的顶点被删掉之后，
 *     "它当时的入度是多少、清干净没有"仍然在这张表上看得见。
 *
 * 起点：4 个算法都从 V1 出发（V1 是唯一的"入口"顶点）。
 */

/* ------------------------------------------------------------------ */
/* 一、图的规模与模型：顶点数 n = 数据规模（5..9）                        */
/* ------------------------------------------------------------------ */

/** 支持的顶点数范围：数据规模 = 图有几个顶点，下拉框只给这几个值 */
const MIN_N = 5
const MAX_N = 9
/** 下拉框里的"数据规模"（也就是顶点数）候选值 */
const GRAPH_SIZES = [5, 6, 7, 8, 9]
/** 不看数据、直接开局时用的顶点数 */
const DEFAULT_N = 7

/**
 * 把随机 / 原始数据规整成"n 个顶点编号"：长度 = 顶点数，值 = 顶点编号 V1..Vn。
 * 幂等 —— 已经规整过的数据再过一遍结果不变，所以首帧和后面每一帧都对得上。
 */
export function prepareData(raw: number[]): number[] {
  const n = Math.min(MAX_N, Math.max(MIN_N, raw.length))
  return Array.from({ length: n }, (_, i) => i + 1)
}

/** 生成器内部也只认长度：不管外面递进来多长，一律按 5..9 个顶点画 */
const clampN = (len: number): number => Math.min(MAX_N, Math.max(MIN_N, len))

/** 顶点显示名一律 V1..Vn，id 也用同一个串 —— 边、badge、板子里的文字都靠它对齐 */
const vName = (i: number): string => `V${i + 1}`

/** 圆环上的一组顶点名，顺序就是编号顺序 */
const allV = (n: number): string[] => Array.from({ length: n }, (_, i) => vName(i))

/**
 * 顶点坐标：圆环布局。
 * 第 k 个顶点从 12 点方向开始顺时针排，半径 0.42 —— 坐标严格落在 0..1 之间。
 * 最挤的一档 n = 9 时，相邻两个顶点的间距仍有 0.287 的相对距离（面板宽 640px 时约 180px，
 * 顶点圆半径 21px），相邻顶点绝不会挤在一起。
 */
const ring = (k: number, n: number): { x: number; y: number } => {
  const t = (2 * Math.PI * k) / n - Math.PI / 2
  return { x: 0.5 + 0.42 * Math.cos(t), y: 0.5 + 0.42 * Math.sin(t) }
}

/** 邻接表：顶点 -> 它的邻居，一律按编号升序 */
type Adj = Map<string, string[]>

/** 从边列表建邻接表：无向边两个方向都加，最后按编号升序排好 */
function makeAdj(vertices: string[], edgeStrs: string[], directed: boolean): Adj {
  const adj: Adj = new Map(vertices.map((v) => [v, []]))
  for (const e of edgeStrs) {
    const [a, b] = e.split(directed ? '->' : '-') as [string, string]
    adj.get(a)!.push(b)
    if (!directed) adj.get(b)!.push(a)
  }
  const byNum = (s: string, t: string) => Number(s.slice(1)) - Number(t.slice(1))
  for (const list of adj.values()) list.sort(byNum)
  return adj
}

/**
 * 无向连通图的边表：n 个顶点、n + ⌊n/2⌋ 条边。
 *   ① 先连成一个环 V1-V2-…-Vn-V1：每个顶点的度至少是 2，一定连通、不会出现孤立点；
 *   ② 再补 ⌊n/2⌋ 条弦（Vi - V(i+2)，隔一个顶点连一条），图里有回路可绕，遍历演示才有的可看。
 * n = 6 时正好 9 条边 —— 和原来那张固定图规模一致。
 */
function undirectedEdges(n: number): string[] {
  const out: string[] = []
  for (let i = 1; i <= n; i++) out.push(`${vName(i - 1)}-${vName(i % n)}`)
  for (let i = 1; i <= Math.floor(n / 2); i++) out.push(`${vName(i - 1)}-${vName(i + 1)}`)
  return out
}

/**
 * 有向无环图（AOV 网）的边表：n 个顶点、n + 3 条有向边。
 *   ① 主链 V1->V2->…->Vn：V1 是唯一入度为 0 的源点，Vn 的入度一定大于 0；
 *   ② 再补 4 条"跨层"边，只从小号指向大号，所以**天然无环**：
 *      V1->V3、V2->V4、V1->V4 让 V3 / V4 的前驱明显比别人多，
 *      V(n-2)->Vn 让汇点有两个前驱 —— 中间顶点的入度有大有小，演示才有看头。
 *
 * 出度正好够拓扑排序的动画用：主链保证 Vi 一定指向 V(i+1)，所以**除了最后的汇点 Vn，
 * 每个被输出的顶点都至少有一条出边**（n = 5..9 逐个数过）——
 * "输出一个顶点，它和以它为起点的出边一起消失"这一步，每一步都删得到边，
 * 不会出现"删了个没边的顶点、看不出删边效果"的空帧。
 */
function directedEdges(n: number): string[] {
  const out: string[] = []
  for (let i = 1; i < n; i++) out.push(`${vName(i - 1)}->${vName(i)}`)
  out.push(`${vName(0)}->${vName(2)}`)
  out.push(`${vName(1)}->${vName(3)}`)
  out.push(`${vName(0)}->${vName(3)}`)
  out.push(`${vName(n - 3)}->${vName(n - 1)}`)
  return out
}

/** 边表的长度就是边数：解说词里要报"几个顶点几条边" */
const edgeCount = (n: number, directed: boolean): number =>
  (directed ? directedEdges(n) : undirectedEdges(n)).length

/**
 * 一张图的完整模型：顶点数一定，顶点坐标、边表、邻接表、初始入度就跟着一定。
 * 两种图的生成规则里**没有随机数**，所以同一个 n 每次跑出来的画面完全一样。
 */
interface GraphModel {
  /** 顶点数（= 数据规模） */
  n: number
  directed: boolean
  /** 顶点名 V1..Vn */
  allV: string[]
  /** 边字符串（顺序就是渲染顺序，也决定边上 w 的编号） */
  edges: string[]
  /** 邻接表：邻居**一律按编号升序** —— "从 V1 出发按 V2、V3… 的顺序看邻居"才是确定的 */
  adj: Adj
  /** 初始入度（有向图用；无向图里全是 0，没人看） */
  initIndeg: Map<string, number>
  /** 顶点快照：坐标全程固定，只有下方小字 sub 随步骤变 */
  nodes: (sub?: (i: number) => string | undefined) => GraphNodeSnapshot[]
}

/** 按顶点数造一张图（无向 or 有向），生成过程完全确定性 */
function graphModel(n: number, directed: boolean): GraphModel {
  const vertices = allV(n)
  const edges = directed ? directedEdges(n) : undirectedEdges(n)
  const adj = makeAdj(vertices, edges, directed)
  const initIndeg = new Map<string, number>(vertices.map((v) => [v, 0]))
  if (directed) {
    for (const e of edges) {
      const to = e.split('->')[1]!
      initIndeg.set(to, (initIndeg.get(to) ?? 0) + 1)
    }
  }
  return {
    n,
    directed,
    allV: vertices,
    edges,
    adj,
    initIndeg,
    nodes: (sub) => vertices.map((v, i) => ({ id: v, label: v, ...ring(i, n), sub: sub?.(i) })),
  }
}

/* ------------------------------------------------------------------ */
/* 二、快照构造函数                                                     */
/* ------------------------------------------------------------------ */

/** 一条边的绘制参数：本步的状态、以及边上那两个小字 */
interface EdgeMark {
  /** 边 key（`A>B`）-> 配色 */
  tone: Map<string, CellTone>
  /** 边 key -> 边上第二行小字（vis / del） */
  label: Map<string, string>
}

const emptyMark = (): EdgeMark => ({ tone: new Map(), label: new Map() })

/**
 * 只标一条边的便捷构造：`markEdge(a, b, 'hot', '邻居2')`。
 * 一条边可能同时有"配色"和"小字"，只给配色时第二、三两个参数留空即可。
 */
function markEdge(a: string, b: string, tone: CellTone, label?: string): EdgeMark {
  const m = emptyMark()
  m.tone.set(ekey(a, b), tone)
  if (label) m.label.set(ekey(a, b), label)
  return m
}

/** 把"还没被删掉的边"整批标红（拓扑排序失败时用：剩下的就是环上的边） */
function leftEdges(edgeStrs: string[], removed: Set<string>): EdgeMark {
  const m = emptyMark()
  for (const e of edgeStrs) {
    const [a, b] = e.split('->') as [string, string]
    if (!removed.has(ekey(a, b))) m.tone.set(ekey(a, b), 'mark')
  }
  return m
}

/** 把邻接表里的一对邻居拼成边 key（无向边两个方向都可能被引用） */
const ekey = (a: string, b: string): string => `${a}>${b}`

/**
 * 造一张图快照。
 *   - `hot` / `done` 决定顶点颜色（hot 的最终颜色还会被 action 影响）；
 *   - `badges` 只放"有东西可写"的顶点，空字符串会被渲染器跳过；
 *   - 边上的 w 是边的编号（无向图 1..n+⌊n/2⌋、有向图 1..n+3），label 是本步的标注；
 *   - 边的配色优先看 `mark`（本步的动作），其次看 `used`（已经走过的边画绿色）。
 *
 * 顶点坐标来自模型的 `nodes()`：同一个模型造出来的帧，顶点位置一定一样 ——
 * "位置不动、只变颜色"这条就靠它保证。
 */
function buildView(
  g: GraphModel,
  opts: {
    hot?: string[]
    done?: string[]
    badges?: Record<string, string>
    sub?: (i: number) => string | undefined
    mark?: EdgeMark
    /** 已经走过的边（画绿色） */
    used?: Set<string>
    note?: string
  } = {},
): GraphView {
  const m = opts.mark ?? emptyMark()
  const edges: GraphEdgeSnapshot[] = g.edges.map((e, k) => {
    const [a, b] = e.split(g.directed ? '->' : '-') as [string, string]
    const key = ekey(a, b)
    const back = ekey(b, a)
    const markTone = m.tone.get(key) ?? m.tone.get(back)
    return {
      from: a,
      to: b,
      // 边的编号按"边列表的顺序"给：无向图 1..n+⌊n/2⌋、有向图 1..n+3。
      // 有一对顶点之间可能既有正向又有反向（无向图的两个方向不都画），
      // 但这里的边列表本身已经去重，所以直接用下标 + 1
      w: k + 1,
      directed: g.directed,
      tone: markTone ?? (opts.used?.has(key) ? 'done' : undefined),
      label: m.label.get(key) ?? m.label.get(back),
    }
  })
  return {
    nodes: g.nodes(opts.sub),
    edges,
    hot: opts.hot ?? [],
    done: opts.done ?? [],
    badges: opts.badges ?? {},
    note: opts.note,
  }
}

/* ------------------------------------------------------------------ */
/* 三、栈 / 队列板子                                                     */
/* ------------------------------------------------------------------ */

/**
 * 递归调用栈的栈帧：一个顶点 + 它的邻居里"下一个该看谁"的下标。
 * 栈板子每格显示顶点名，sub 写"第几层"，所以画面上一眼能数出"现在在第几层"。
 */
interface Frame {
  v: string
  next: number
}

/**
 * 竖排栈板（递归调用栈 / 非递归栈共用）。
 * `items` 从栈底往栈顶排 —— column 布局是 column-reverse，所以第 0 格画在**最下面**，
 * 最后一格画在最上面，指针「栈顶」指向最后一格（下标 = 长度 - 1）。空栈不给指针。
 * 标题可以按需覆盖（递归版叫"递归调用栈"、非递归版就叫"栈"）。
 */
function stackBoard(
  stack: string[],
  opts: { hot?: string; note: string; title?: string },
): BoardView {
  const n = stack.length
  const title = opts.title ?? (n ? `栈（栈底在下，共 ${n} 个）` : '栈（空）')
  return {
    title,
    layout: 'column',
    // 第 0 格在最下面，所以从栈底往栈顶排
    items: stack.map((v, i) => ({
      text: v,
      sub: String(i),
      tone: v === opts.hot ? 'hot' : 'base',
    })),
    pointers: n ? { 栈顶: n - 1 } : {},
    note: opts.note,
  }
}

/**
 * 横排队列板。`items` 从队首往队尾排 —— row 布局从左往右，所以第 0 格就是**队首**，
 * 指针「队首」指向第 0 格。空队列不给指针。
 */
function queueBoard(queue: string[], opts: { hot?: string; note: string }): BoardView {
  const n = queue.length
  return {
    title: n ? `队列（队首在左，共 ${n} 个）` : '队列（空）',
    layout: 'row',
    items: queue.map((v, i) => ({
      text: v,
      sub: String(i),
      tone: v === opts.hot ? 'hot' : 'base',
    })),
    pointers: n ? { 队首: 0 } : {},
    note: opts.note,
  }
}

/**
 * 「已输出（拓扑序）」板子：每输出一个顶点就往右接一格，按输出先后排。
 *
 * 为什么拓扑排序非要这块板子：它输出的顶点会**真的从图上删掉**（连同出边），
 * 删完之后图里就再也看不到它们了 —— 没有这块板子，用户看完就"忘了前面输出了什么、
 * 拓扑序到底长什么样"。板子上的格子就是答案本身。
 *
 * 一个都没输出时也是一块**空板子**（note 写明"还没输出任何顶点"）：
 * 它每一帧都在，位置不跳，输出第一个顶点时是"第 0 格长出第 1 格"，
 * 不会出现"板子凭空冒出来"的突兀感。最新那一格点紫色，一眼看出刚输出的是谁。
 * 不挂指针 —— 「队首」那类指针是"下一个要处理谁"，结果板子没有这个语义。
 */
function topoOutBoard(out: string[]): BoardView {
  return {
    title: out.length ? `已输出（拓扑序，共 ${out.length} 个）` : '已输出（拓扑序）',
    layout: 'row',
    items: out.map((v, i) => ({
      text: v,
      tone: i === out.length - 1 ? 'hot' : 'done',
    })),
    note: out.length ? `已经输出的顶点，按先后排：${out.join(' → ')}` : '还没输出任何顶点',
  }
}

/**
 * 「入度表」板子：**每个顶点固定一格**，格子里的**正文是顶点名**，下面的小字是它**当前**的入度。
 *
 * 为什么非要这块板子：顶点旁的黄标签写的是同一个数，但图上的顶点会随着输出**一个个真的被删掉**——
 * 删掉之后标签也一起没了，"它入度是多少、清干净没有"就再也看不见了。
 * 这张表是**全顶点**的（已经输出的也在表里），所以一张表就能回答"现在谁还欠着前驱、各欠几个"。
 * 也正因为它每帧都在、格子数永远一样，入度的变化才是"某个格子里的数字掉了 1"这么直观的事。
 *
 * 三种配色正好是顶点在算法里的三种处境：
 *   hot  —— 这一步入度刚减到 0、马上就要入队（最关键的一拍，用紫色点出来）；
 *   done —— 已经输出完了（绿色淡掉，一眼看出它不再是待办）；
 *   base —— 还在等前驱（普通色）。
 *
 * `indeg` 的 key 必须覆盖 `allV` 里的每一个顶点（`runTopo` 的 `indegNow()` 保证了这一点）：
 * 缺谁的 key，那一格就会默默显示 0，看起来像"它的前驱已经都做完了"——是错的。
 */
function indegBoard(
  allV: string[],
  indeg: Record<string, number>,
  opts: { out?: string[]; hot?: string; note: string },
): BoardView {
  const done = new Set(opts.out ?? [])
  return {
    title: `入度表（共 ${allV.length} 个顶点）`,
    layout: 'row',
    items: allV.map((v) => ({
      text: v,
      sub: String(indeg[v] ?? 0),
      tone: v === opts.hot ? 'hot' : done.has(v) ? 'done' : 'base',
    })),
    // 不给指针：入度表没有"下一个要处理谁"的语义（那是队列板「队首」的活）
    note: opts.note,
  }
}

/* ------------------------------------------------------------------ */
/* 四、① 深度优先搜索（递归）                                            */
/* ------------------------------------------------------------------ */

const CODE_DFS_REC = [
  'void DFS(Graph G, int v) {         // v 是本次要访问的顶点',
  '  visit(v);                       // ① 进函数第一件事就是访问 v',
  '  visited[v] = true;              // ② 立刻打上标记，防止绕回来又访问一遍',
  '  for (w = FirstAdjVex(G, v);     // ③ 从 v 的第一个邻接点开始，按编号从小到大挨个看',
  '       w != -1;',
  '       w = NextAdjVex(G, v, w)) {',
  '    if (!visited[w]) {            // ④ 没访问过的邻居才递归下去',
  '      DFS(G, w);                  //    —— 这一层还没走完就进下一层：压栈',
  '    }',
  '  }',
  '  return;                         // ⑤ 邻居都看完了，返回上一层：弹栈',
  '}',
]

function* runDfsRec(data: number[], _ctx: RunnerContext = {}): AlgoRunner {
  /** 顶点数 = 数据规模（5..9 个顶点）；图的结构完全由它决定，跟随机数无关 */
  const N = clampN(data.length)
  const seq = prepareData(data)
  const g = graphModel(N, false)
  const { edges, adj } = g
  const visited = new Set<string>()
  const order: string[] = []
  /** 调用栈：frame[0] 是最外层（栈底），最后一个是最内层（栈顶） */
  const frames: Frame[] = []
  const start = vName(0)

  const badges = (): Record<string, string> => {
    const b: Record<string, string> = {}
    order.forEach((v, i) => (b[v] = `第${i + 1}个`))
    return b
  }

  const v = (note: string, hot?: string[], mark?: EdgeMark, sub?: (i: number) => string | undefined) =>
    buildView(g, {
      hot: hot ?? [],
      done: [...order],
      badges: badges(),
      mark,
      sub,
      note,
    })

  yield {
    line: 1,
    action: 'init',
    array: seq,
    graph: buildView(g, {
      sub: () => '未访问',
      note: `无向图，${N} 个顶点 ${edges.length} 条边；从 V1 出发递归 DFS`,
    }),
    boards: [stackBoard([], { title: '递归调用栈（栈底在下）', note: '还没进任何一层：调用栈是空的' })],
    comment: `这张无向图有 ${N} 个顶点、${edges.length} 条边（环 V1-V2-…-V${N}-V1 打底，再加 ${Math.floor(N / 2)} 条弦）。顶点编号 V1..V${N} 固定画在圆周上，位置全程不动，变化的只有颜色和边上的小字。DFS 从 V1 出发：一条路走到黑，走不动了再退回来换一条。每到一个顶点，邻居一律**按编号从小到大**挨个看 —— 下面每进一层函数就压一格栈`,
    vars: { n: N, 栈深: 0, 已访问: 0 },
  }

  // 递归函数直接翻译成生成器：`yield* dfs(...)` 就是"进一层、在里面走完、再退回来"
  function* dfs(u: string): AlgoRunner {
    /*
     * 调用者已经把自己的栈帧压进 frames 了，所以**在这一层函数体里**：
     *   depth      = frames.length   —— 当前一共几层（含自己这一层）
     *   frames.map(f => f.v)         —— 整个调用栈，从栈底到栈顶，最后一个就是自己
     */
    const depth = frames.length
    const stackVerts = frames.map((f) => f.v)
    visited.add(u)
    order.push(u)
    yield {
      line: 2,
      action: 'mark',
      array: seq,
      graph: v(
        `第 ${depth} 层：访问 ${u}（第 ${order.length} 个）`,
        [u],
        undefined,
        (i) => (vName(i) === u ? `第${depth}层` : undefined),
      ),
      boards: [
        stackBoard(stackVerts, {
          hot: u,
          note: `进入 ${u} 这一层：调用栈里现在有 ${depth} 格，栈顶是 ${u}`,
        }),
      ],
      comment: `① 第 ${depth} 层进函数，第一件事就是访问 ${u}（第 ${order.length} 个被访问的顶点）。调用栈里从下（栈底）到上（栈顶）依次是 ${stackVerts.join(' → ')}：栈顶就是刚进来的 ${u}${
        stackVerts.length > 1
          ? `，它下面压着还没走完的 ${stackVerts.slice(0, -1).join('、')}`
          : `。此刻栈里只有它一个，说明它是最外层（主程序）的调用`
      }`,
      vars: { n: N, 栈深: depth, 已访问: order.length },
    }
    yield {
      line: 3,
      action: 'mark',
      array: seq,
      graph: v(`把 ${u} 标记为已访问（就是画成绿色）`, [u]),
      boards: [
        stackBoard(stackVerts, {
          hot: u,
          note: `visited[${u}] = true：以后别的顶点再碰到 ${u} 就直接跳过`,
        }),
      ],
      comment: `② 把 visited[${u}] 置为真。这个标记必须在递归子顶点**之前**打上，否则两个相邻的顶点会互相递归、无限绕圈`,
      vars: { n: N, 栈深: depth, 已访问: order.length },
    }

    const nb = adj.get(u)!
    for (let k = 0; k < nb.length; k++) {
      const w = nb[k]!
      frames[frames.length - 1]!.next = k + 1

      // ③ 看一眼这个邻居：紫色的边指出"正在走哪一条"，边上的小字写这是第几个邻居
      yield {
        line: 4,
        action: 'compare',
        array: seq,
        graph: v(
          `第 ${depth} 层：看 ${u} 的第 ${k + 1} 个邻居 ${w}`,
          [u, w],
          markEdge(u, w, 'hot', `邻居${k + 1}`),
        ),
        boards: [
          stackBoard(frames.map((f) => f.v), {
            hot: u,
            note: `第 ${depth} 层的 ${u} 正在按编号顺序查邻居：第 ${k + 1} 个是 ${w}`,
          }),
        ],
        comment: `③ 第 ${depth} 层：${u} 的邻居是按编号升序存的，现在看到第 ${k + 1} 个邻居 ${w}（紫色那条边）`,
        vars: { n: N, 栈深: depth, 已访问: order.length },
      }

      if (visited.has(w)) {
        // ④ 已经访问过的邻居直接跳过 —— 靠"边画成绿色"表示这条路已经走过了
        yield {
          line: 5,
          action: 'compare',
          array: seq,
          graph: v(
            `${w} 已经访问过，跳过这条边（画成绿色）`,
            [u],
            markEdge(u, w, 'done', '回边'),
          ),
          boards: [
            stackBoard(frames.map((f) => f.v), {
              hot: u,
              note: `${w} 已经被访问：这条边不递归下去，${u} 继续看下一个邻居`,
            }),
          ],
          comment: `④ 邻居 ${w} 的 visited 已经是真了 —— 它早就被访问过，所以不递归。这条边画成绿色，就是 DFS 里说的"回边"`,
          vars: { n: N, 栈深: depth, 已访问: order.length },
        }
        continue
      }

      // ⑤ 没访问过 -> 压一层，进去递归
      frames.push({ v: w, next: 0 })
      yield {
        line: 8,
        action: 'mark',
        array: seq,
        graph: v(
          `${w} 没访问过，DFS 递归进去：调用栈压到第 ${frames.length} 层`,
          [w],
          markEdge(u, w, 'hot'),
          (i) => (vName(i) === w ? `第${frames.length}层` : undefined),
        ),
        boards: [
          stackBoard(frames.map((f) => f.v), {
            hot: w,
            note: `压栈：第 ${frames.length} 层的 ${w} 是新栈顶；第 ${depth} 层的 ${u} 先挂起`,
          }),
        ],
        comment: `⑤ ${w} 还没访问过，于是 DFS 递归到 ${w}：调用栈从 ${depth} 层压到 ${frames.length} 层，栈顶变成 ${w}。注意 ${u} 这一层**没有结束**，它只是被压在下面等着，等 ${w} 那边全部走完再回来接着看下一个邻居`,
        vars: { n: N, 栈深: frames.length, 已访问: order.length },
      }
      yield* dfs(w)
      yield {
        line: 11,
        action: 'mark',
        array: seq,
        graph: v(`从 ${w} 返回，回到第 ${depth} 层的 ${u}`, [u]),
        boards: [
          stackBoard(frames.map((f) => f.v), {
            hot: u,
            note: `弹栈：从 ${w} 那层返回，栈顶重新变成 ${u}（栈里还有 ${depth} 格）`,
          }),
        ],
        comment: `⑥ ${w} 那一层已经全部走完，函数返回：调用栈弹掉一格，从第 ${frames.length + 1} 层退回到第 ${depth} 层，栈顶重新变成 ${u}。接着看 ${u} 的下一个邻居`,
        vars: { n: N, 栈深: depth, 已访问: order.length },
      }
    }

    frames.pop()
    yield {
      line: 11,
      action: 'mark',
      array: seq,
      graph: v(
        `${u} 的邻居全部看完，${u} 这一层结束返回上层`,
        frames.length ? [frames[frames.length - 1]!.v] : [],
      ),
      boards: [
        stackBoard(frames.map((f) => f.v), {
          hot: frames.length ? frames[frames.length - 1]!.v : undefined,
          note: frames.length
            ? `弹栈：${u} 这一层走完了，栈顶回到 ${frames[frames.length - 1]!.v}`
            : `弹栈：${u} 是最外层（栈底），调用栈清空，整个 DFS 结束`,
        }),
      ],
      comment: frames.length
        ? `⑦ ${u} 的 ${nb.length} 个邻居都看完了，${u} 这一层无事可做，弹栈返回 ${frames[frames.length - 1]!.v} 那一层`
        : `⑦ ${u} 的邻居全部看完，它是最外层的调用，弹栈之后调用栈空了 —— 递归 DFS 结束`,
      vars: { n: N, 栈深: frames.length, 已访问: order.length },
    }
  }

  frames.push({ v: start, next: 0 })
  yield {
    line: 1,
    action: 'mark',
    array: seq,
    graph: v(`DFS(G, V1)：从 V1 开始，先把 V1 压进调用栈`, [start]),
    boards: [
      stackBoard([start], {
        hot: start,
        note: `最外层调用 DFS(G, V1)：调用栈里只有 V1 一格`,
      }),
    ],
    comment: `主程序调用 DFS(G, V1)：调用栈开第一格，里面是起点 V1`,
    vars: { n: N, 栈深: 1, 已访问: 0 },
  }
  yield* dfs(start)

  yield {
    line: 12,
    action: 'done',
    array: seq,
    graph: buildView(g, {
      done: [...order],
      badges: badges(),
      used: new Set(edges.flatMap((e) => {
        const [a, b] = e.split('-') as [string, string]
        return [ekey(a, b), ekey(b, a)]
      })),
      sub: (i) => `第${order.indexOf(vName(i)) + 1}个`,
      note: `DFS 结束，访问序列：${order.join(' → ')}`,
    }),
    boards: [
      stackBoard([], {
        title: '递归调用栈（栈底在下）',
        note: '调用栈空了，所有顶点都访问过了',
      }),
    ],
    comment: `调用栈空了，递归 DFS 结束。从 V1 出发的访问序列是：${order.join(' → ')}（共 ${order.length} 个顶点，每个顶点恰好访问一次）`,
    vars: { n: N, 栈深: 0, 已访问: order.length },
  }
}

/* ------------------------------------------------------------------ */
/* 五、② 深度优先搜索（非递归，显式栈）                                  */
/* ------------------------------------------------------------------ */

const CODE_DFS_ITER = [
  'void DFSIter(Graph G, int v) {         // v 是起点',
  '  Stack S; InitStack(S);',
  '  Push(S, v);                          // ① 起点先进栈',
  '  while (!StackEmpty(S)) {',
  '    u = Pop(S);                        // ② 弹出栈顶 —— 这一步不访问！',
  '    if (visited[u]) continue;          // ③ 同一个顶点可能被压进栈好几次，弹出来发现访问过了就直接丢掉',
  '    visit(u);                          // ④ 弹出且没访问过，这时候才访问',
  '    visited[u] = true;',
  '    for (w = FirstAdjVex(G, u);       // ⑤ 把 u 的所有没访问过的邻居**一次性全压栈**',
  '         w != -1;',
  '         w = NextAdjVex(G, u, w)) {',
  '      if (!visited[w]) Push(S, w);     //    压栈的顺序就是邻接表的顺序',
  '    }',
  '  }',
  '}',
]

function* runDfsIter(data: number[], _ctx: RunnerContext = {}): AlgoRunner {
  /** 顶点数 = 数据规模（5..9 个顶点）；图的结构完全由它决定，跟随机数无关 */
  const N = clampN(data.length)
  const seq = prepareData(data)
  const g = graphModel(N, false)
  const { edges, adj } = g
  const visited = new Set<string>()
  const order: string[] = []
  /** 显式栈：栈底在 [0]，栈顶在最后 —— 跟板子第 0 格在最下面是一致的 */
  const stack: string[] = []
  const start = vName(0)

  const badges = (): Record<string, string> => {
    const b: Record<string, string> = {}
    order.forEach((v, i) => (b[v] = `第${i + 1}个`))
    return b
  }

  const view = (opts: {
    hot?: string[]
    mark?: EdgeMark
    sub?: (i: number) => string | undefined
    note?: string
  }): GraphView =>
    buildView(g, { ...opts, done: [...order], badges: badges() })

  yield {
    line: 1,
    action: 'init',
    array: seq,
    graph: buildView(g, { sub: () => '未访问', note: '无向图，从 V1 出发的非递归 DFS' }),
    boards: [stackBoard([], { title: '栈（栈底在下）', note: '初始化：栈还是空的' })],
    comment: `非递归 DFS 用一个**显式栈**模拟递归。做法是：起点先压栈；然后反复"弹出栈顶 -> 弹出来且没访问过就访问 -> 把它所有没访问过的邻居一次性全部压栈"。注意是**弹出时才访问**，不是压栈时就访问，所以同一个顶点可能被压进栈很多次，弹出来发现访问过了就当场丢掉`,
    vars: { n: N, 栈深: 0, 已访问: 0 },
  }

  stack.push(start)
  yield {
    line: 3,
    action: 'mark',
    array: seq,
    graph: view({ hot: [start], note: `起点 ${start} 压栈` }),
    boards: [stackBoard(stack, { hot: start, note: `起点 ${start} 压栈，它是唯一的栈顶` })],
    comment: `① 起点 ${start} 压栈。此刻它是栈顶，但**还没有被访问** —— 非递归版里"进栈"和"访问"是两件事`,
    vars: { n: N, 栈深: stack.length, 已访问: 0 },
  }

  while (stack.length) {
    const u = stack.pop()!
    const before = stack.length + 1

    if (visited.has(u)) {
      // 同一个顶点被压了好几次，这次弹出来的这一份是多余的
      yield {
        line: 6,
        action: 'compare',
        array: seq,
        graph: view({ hot: [u], note: `弹出 ${u}，但它早就访问过了：丢掉不用` }),
        boards: [
          stackBoard(stack, {
            note: `弹出栈顶 ${u}（栈深 ${before} -> ${stack.length}）：它已经访问过，直接丢掉`,
          }),
        ],
        comment: `③ 弹出栈顶 ${u}，可它已经在 visited 里了 —— 说明它被压进栈不止一次。这一份是多余的，丢掉不用（栈深 ${before} -> ${stack.length}）`,
        vars: { n: N, 栈深: stack.length, 已访问: order.length },
      }
      continue
    }

    // ② 弹出后先访问
    yield {
      line: 5,
      action: 'mark',
      array: seq,
      graph: view({
        hot: [u],
        note: `弹出栈顶 ${u}（栈深 ${before} -> ${stack.length}），它还没访问过`,
        sub: (i) => (vName(i) === u ? '待访问' : undefined),
      }),
      boards: [
        stackBoard(stack, { note: `弹出栈顶 ${u}：栈深 ${before} -> ${stack.length}，接下来才访问它` }),
      ],
      comment: `② 弹出栈顶 ${u}。非递归版是**先弹、弹出时才访问**：这个顶点已经不在栈里了，我们才开始处理它。栈深 ${before} -> ${stack.length}`,
      vars: { n: N, 栈深: stack.length, 已访问: order.length },
    }

    visited.add(u)
    order.push(u)
    yield {
      line: 7,
      action: 'mark',
      array: seq,
      graph: view({
        hot: [u],
        note: `访问 ${u}（第 ${order.length} 个）并打上访问标记`,
        sub: (i) => (vName(i) === u ? `第${order.length}个` : undefined),
      }),
      boards: [stackBoard(stack, { note: `访问 ${u} 并置 visited[${u}] = true；栈没动` })],
      comment: `④ 访问 ${u}，这是第 ${order.length} 个被访问的顶点，并打上 visited 标记。压栈时代它只是"候选"，弹出访问才算数`,
      vars: { n: N, 栈深: stack.length, 已访问: order.length },
    }

    // ⑤ 把 u 所有没访问过的邻居一次性全部压栈（按邻接表的升序压）
    const pushed: string[] = []
    const nb = adj.get(u)!
    for (let k = 0; k < nb.length; k++) {
      const w = nb[k]!
      if (visited.has(w) || stack.includes(w)) {
        yield {
          line: 12,
          action: 'compare',
          array: seq,
          graph: view({
            hot: [u],
            mark: markEdge(u, w, 'done'),
            note: `${w} 不用压栈（已经访问或在栈里），画成绿色`,
          }),
          boards: [stackBoard(stack, { note: `邻居 ${w} 跳过：它已经访问过或者已经在栈里了` })],
          comment: `⑤ 第 ${k + 1} 个邻居 ${w} 已经访问过（或者已经在栈里），不用再压 —— 这条边画成绿色`,
          vars: { n: N, 栈深: stack.length, 已访问: order.length },
        }
        continue
      }
      stack.push(w)
      pushed.push(w)
      yield {
        line: 12,
        action: 'mark',
        array: seq,
        graph: view({
          hot: [w],
          mark: markEdge(u, w, 'hot'),
          note: `邻居 ${w} 压栈（栈深 ${stack.length}）`,
        }),
        boards: [
          stackBoard(stack, { hot: w, note: `邻居 ${w} 压栈：栈顶变成 ${w}` }),
        ],
        comment: `⑤ ${u} 的第 ${k + 1} 个邻居 ${w} 还没访问过，压栈 —— 这里**压栈时并不访问**，只是把它排上号。栈深变成 ${stack.length}`,
        vars: { n: N, 栈深: stack.length, 已访问: order.length },
      }
    }

    if (pushed.length) {
      yield {
        line: 13,
        action: 'mark',
        array: seq,
        graph: view({
          hot: [stack[stack.length - 1]!],
          note: `${u} 的 ${pushed.length} 个邻居一次性全压栈了`,
        }),
        boards: [
          stackBoard(stack, {
            hot: stack[stack.length - 1]!,
            note: `一次性压入 ${pushed.join('、')}：栈顶 ${stack[stack.length - 1]} 是**最后**压进去的那个，它下一个被弹出`,
          }),
        ],
        comment: `⑤ ${u} 的邻居是按编号升序压栈的：${pushed.join(' -> ')}。栈是后进先出，所以下一个弹出的是最后压进去的 ${stack[stack.length - 1]} —— 非递归版的探索顺序和递归版**可能不一样**，就是这个原因`,
        vars: { n: N, 栈深: stack.length, 已访问: order.length },
      }
    }
  }

  yield {
    line: 15,
    action: 'done',
    array: seq,
    graph: buildView(g, {
      done: [...order],
      badges: badges(),
      used: new Set(edges.flatMap((e) => {
        const [a, b] = e.split('-') as [string, string]
        return [ekey(a, b), ekey(b, a)]
      })),
      sub: (i) => `第${order.indexOf(vName(i)) + 1}个`,
      note: `非递归 DFS 结束，访问序列：${order.join(' → ')}`,
    }),
    boards: [stackBoard([], { title: '栈（栈底在下）', note: '栈空了，遍历结束' })],
    comment: `栈空了，非递归 DFS 结束。从 V1 出发的访问序列是：${order.join(' → ')}（共 ${order.length} 个顶点）。和递归版对照着看：递归版是"想一个、马上钻进去"，非递归版是"先把邻居全部排上号，再挑最后一个先处理"`,
    vars: { n: N, 栈深: 0, 已访问: order.length },
  }
}

/* ------------------------------------------------------------------ */
/* 六、③ 广度优先搜索（队列）                                            */
/* ------------------------------------------------------------------ */

const CODE_BFS = [
  'void BFS(Graph G, int v) {          // v 是起点',
  '  Queue Q; InitQueue(Q);',
  '  visit(v); visited[v] = true;      // ① 起点先访问，再入队',
  '  EnQueue(Q, v);',
  '  while (!QueueEmpty(Q)) {',
  '    u = DeQueue(Q);                 // ② 取队首出队',
  '    for (w = FirstAdjVex(G, u);     // ③ 依次检查 u 的所有邻接点',
  '         w != -1;',
  '         w = NextAdjVex(G, u, w)) {',
  '      if (!visited[w]) {            // ④ 没访问过的邻居',
  '        visit(w); visited[w] = true;//    —— 立刻访问并打标记',
  '        EnQueue(Q, w);              // ⑤ 然后排到队尾',
  '      }',
  '    }',
  '  }',
  '}',
]

interface Enq {
  v: string
  /** 入队时的访问次序（第几个被访问的） */
  order: number
  /** 层次：起点算第 0 层 */
  level: number
}

function* runBfs(data: number[], _ctx: RunnerContext = {}): AlgoRunner {
  /** 顶点数 = 数据规模（5..9 个顶点），和上面两个 DFS 用的是同一张无向图 */
  const N = clampN(data.length)
  const seq = prepareData(data)
  const g = graphModel(N, false)
  const { edges, adj } = g
  const visited = new Set<string>()
  const order: string[] = []
  /** 每个顶点**被访问时**所在的层次，和解说词里的 order 一一对应（收尾帧要报出来） */
  const levels: number[] = []
  const queue: Enq[] = []
  const start = vName(0)

  const badges = (): Record<string, string> => {
    const b: Record<string, string> = {}
    order.forEach((v, i) => (b[v] = `第${i + 1}个`))
    return b
  }

  const view = (opts: {
    hot?: string[]
    mark?: EdgeMark
    sub?: (i: number) => string | undefined
    note?: string
  }): GraphView => buildView(g, { ...opts, done: [...order], badges: badges() })

  const board = (opts: { hot?: string; note: string }): BoardView =>
    queueBoard(queue.map((e) => e.v), opts)

  yield {
    line: 1,
    action: 'init',
    array: seq,
    graph: buildView(g, { sub: () => '未访问', note: '无向图，从 V1 出发的 BFS' }),
    boards: [queueBoard([], { note: '初始化：队列是空的' })],
    comment: `BFS 用一个队列：先进先出。所以顶点是"一层一层"被访问的 —— 离起点 V1 近的全部访问完，才轮到更远的。每个顶点旁边的小标签写的就是它是第几个被访问的`,
    vars: { n: N, 队列长: 0, 已访问: 0 },
  }

  // ① 起点：先访问、打标记，再入队
  visited.add(start)
  order.push(start)
  levels.push(0)
  yield {
    line: 3,
    action: 'mark',
    array: seq,
    graph: view({
      hot: [start],
      sub: (i) => (vName(i) === start ? '第0层' : undefined),
      note: `起点 ${start} 先访问（第 1 个），画成绿色`,
    }),
    boards: [queueBoard([], { note: `${start} 已经访问，接着把它入队` })],
    comment: `① 起点 ${start} 先访问（第 1 个），并打上 visited 标记。BFS 的规矩是"访问和入队紧挨着做"，绝不允许把没访问的顶点先塞进队列，否则同一个顶点会被访问两次`,
    vars: { n: N, 队列长: 0, 已访问: order.length },
  }

  queue.push({ v: start, order: 1, level: 0 })
  yield {
    line: 4,
    action: 'mark',
    array: seq,
    graph: view({ hot: [start], note: `${start} 入队，成为队首`, sub: (i) => (vName(i) === start ? '第0层' : undefined) }),
    boards: [board({ hot: start, note: `${start} 入队：队列长 0 -> 1，它同时是队首也是队尾` })],
    comment: `① ${start} 入队，排在队首。队列里放的就是"已经访问过、但它的邻居还没检查"的顶点`,
    vars: { n: N, 队列长: queue.length, 已访问: order.length },
  }

  while (queue.length) {
    const head = queue.shift()!
    const u = head.v

    // ② 取队首出队
    yield {
      line: 6,
      action: 'mark',
      array: seq,
      graph: view({
        hot: [u],
        sub: (i) => (vName(i) === u ? `第${head.level}层` : undefined),
        note: `队首 ${u} 出队（它是第 ${head.level} 层的顶点）`,
      }),
      boards: [
        board({
          note: `队首 ${u} 出队：队列长 ${queue.length + 1} -> ${queue.length}，现在队首是 ${queue[0]?.v ?? '（空）'}`,
        }),
      ],
      comment: `② 队首 ${u} 出队（队列长 ${queue.length + 1} -> ${queue.length}）。${u} 是第 ${head.level} 层的顶点，接下来检查它有哪些邻居还没访问`,
      vars: { n: N, 队列长: queue.length, 已访问: order.length, 层: head.level },
    }

    const nb = adj.get(u)!
    for (let k = 0; k < nb.length; k++) {
      const w = nb[k]!

      if (visited.has(w)) {
        yield {
          line: 10,
          action: 'compare',
          array: seq,
          graph: view({
            hot: [u, w],
            mark: markEdge(u, w, 'done', '已访问'),
            note: `邻居 ${w} 已经访问过，跳过（边画成绿色）`,
          }),
          boards: [board({ note: `邻居 ${w} 已经访问过，跳过：它不会再进队列` })],
          comment: `③ 邻居 ${w} 的 visited 已经是真，跳过不处理 —— 这是 BFS 里唯一的"看过了"判断，防止同一个顶点重复入队`,
          vars: { n: N, 队列长: queue.length, 已访问: order.length, 层: head.level },
        }
        continue
      }

      // ④ 立刻访问并打标记
      visited.add(w)
      order.push(w)
      const lv = head.level + 1
      levels.push(lv)
      yield {
        line: 11,
        action: 'mark',
        array: seq,
        graph: view({
          hot: [w],
          mark: markEdge(u, w, 'hot', `第${order.length}个`),
          sub: (i) => (vName(i) === w ? `第${lv}层` : undefined),
          note: `发现 ${w}：立刻访问（第 ${order.length} 个），它属于第 ${lv} 层`,
        }),
        boards: [board({ hot: w, note: `${w} 是第 ${lv} 层的顶点，先访问，下一步再入队` })],
        comment: `④ 从 ${u}（第 ${head.level} 层）发现邻居 ${w}，它还没访问过：立刻访问，它是第 ${order.length} 个被访问的顶点，层次是第 ${head.level} + 1 = ${lv} 层。紫色那条边就是从 ${u} 发现 ${w} 的边`,
        vars: { n: N, 队列长: queue.length, 已访问: order.length, 层: lv },
      }

      // ⑤ 再排到队尾
      queue.push({ v: w, order: order.length, level: lv })
      yield {
        line: 12,
        action: 'mark',
        array: seq,
        graph: view({
          hot: [w],
          sub: (i) => (vName(i) === w ? `第${lv}层` : undefined),
          note: `${w} 排在队尾，等着被取出来检查自己的邻居`,
        }),
        boards: [
          board({
            hot: w,
            note: `${w} 入队排到队尾：队列长 ${queue.length - 1} -> ${queue.length}，队首仍然是 ${queue[0]!.v}`,
          }),
        ],
        comment: `⑤ ${w} 排到队尾（队列长 ${queue.length - 1} -> ${queue.length}）。它已经访问过了，入队只是为了让程序**以后**还会取到它、去检查它的邻居。队首仍然是 ${queue[0]!.v} —— 先进先出，所以第 ${head.level} 层的顶点不全部出完，第 ${lv} 层的顶点绝不会先出队`,
        vars: { n: N, 队列长: queue.length, 已访问: order.length, 层: lv },
      }
    }
  }

  yield {
    line: 16,
    action: 'done',
    array: seq,
    graph: buildView(g, {
      done: [...order],
      badges: badges(),
      used: new Set(edges.flatMap((e) => {
        const [a, b] = e.split('-') as [string, string]
        return [ekey(a, b), ekey(b, a)]
      })),
      sub: (i) => `第${order.indexOf(vName(i)) + 1}个`,
      note: `BFS 结束，访问序列：${order.join(' → ')}`,
    }),
    boards: [queueBoard([], { note: '队列空了，所有顶点的邻居都检查过了' })],
    comment: `队列空了，BFS 结束。从 V1 出发的访问序列是：${order.join(' → ')}（共 ${order.length} 个顶点）。序列是严格分层的：每个顶点被访问时所在的层次依次是 ${levels.join('、')} —— 同层的全部访问完才轮到下一层，这就是"广度优先"的含义`,
    vars: { n: N, 队列长: 0, 已访问: order.length },
  }
}

/* ------------------------------------------------------------------ */
/* 七、④ 拓扑排序（AOV 网，反复找入度为 0 的顶点）                        */
/* ------------------------------------------------------------------ */

const CODE_TOPO = [
  'Status TopoSort(Graph G) {            // AOV 网：顶点表示活动，有向边表示先后次序',
  '  FindInDegree(G, indegree);          // ① 统计每个顶点的入度',
  '  InitStack(S);',
  '  for (i = 0; i < G.vexnum; i++)',
  '    if (indegree[i] == 0) Push(S, i);  // ② 入度为 0 的顶点（没有前驱）先入栈（用队列也一样）',
  '  count = 0;',
  '  while (!StackEmpty(S)) {',
  '    i = Pop(S); print(i); count++;     // ③ 弹出一个入度 0 的顶点输出：它是拓扑序的下一个',
  '    DeleteVex(G, i);                   // ④ 输出完立刻删掉它：顶点 i 和以它起点的所有出边一起消失',
  '    for (p = i.firstarc; p; p = p->nextarc) {',
  '      k = p->adjvex;',
  '      if (--indegree[k] == 0) Push(S, k); // ⑤ 每少一条出边，后继入度减 1；减到 0 就入栈',
  '    }',
  '  }',
  '  if (count < G.vexnum) return ERROR;  // ⑥ 还有顶点没输出 -> 图里有环',
  '  return OK;',
  '}',
]

function* runTopo(data: number[], _ctx: RunnerContext = {}): AlgoRunner {
  /** 顶点数 = 数据规模（5..9 个顶点），有向边只从小号指向大号 */
  const N = clampN(data.length)
  const seq = prepareData(data)
  const g = graphModel(N, true)
  const { edges, adj } = g
  const ALL_V = g.allV
  /** 每个顶点的**当前**入度：初始值由主链 + 4 条跨层边决定（首帧解说里会报出来），之后每删一条边就减 1 */
  const indeg = new Map(g.initIndeg)

  /**
   * **还留在图上**的顶点。
   *
   * 这个算法和别的算法最大的区别就在这里：输出的顶点会被**真的删掉**（连同它的出边），
   * 所以"现在图上还剩谁"必须单独记一份 —— 边表也跟着它现算：
   * 一条边只在它的**起点**被删时消失，而起点被删时它的终点一定还在（边只从小号指向大号），
   * 所以"两端都还活着"就等于"这条边还没被删"，不用再单独维护一张被删边表。
   */
  const alive = new Set(ALL_V)
  /**
   * 顶点名 -> 它在圆环上的**原始**序号。
   * 删掉几个顶点之后，剩下的顶点位置要纹丝不动，就是靠"坐标只认名字、不认当前第几个"。
   */
  const ringIdx = (v: string): number => Number(v.slice(1)) - 1

  /** 板子上的"入度为 0、等着被输出"的队列：队首是下一步要弹出的那个 */
  const queue: string[] = []
  /** 已经输出的顶点，按输出先后排 —— 「已输出」板子上的格子就是它 */
  const out: string[] = []

  /** 还在图上的边（key 形如 `V1>V2`） */
  const liveEdgeKeys = (): Set<string> => {
    const s = new Set<string>()
    for (const e of edges) {
      const [a, b] = e.split('->') as [string, string]
      if (alive.has(a) && alive.has(b)) s.add(ekey(a, b))
    }
    return s
  }

  /** 已经被删掉的边 —— 图有环时"剩下的那些"就是环上的边（收尾帧标红用） */
  const removedKeys = (): Set<string> => {
    const live = liveEdgeKeys()
    const s = new Set<string>()
    for (const e of edges) {
      const [a, b] = e.split('->') as [string, string]
      if (!live.has(ekey(a, b))) s.add(ekey(a, b))
    }
    return s
  }

  /**
   * 每个顶点的**当前**入度（key 是**所有**顶点，包括已经删掉的）。
   *
   * ⭐ 这是入度的**唯一数据源**：顶点旁的黄标签和「入度表」板子都从这里派生，
   * 所以两边永远是同一个数 —— 不可能出现"标签写 2、表里写 1"这种两套数据对不上的情况。
   * 已经删掉的那些由 `topoView` 统一滤掉，所以这里不用自己判断。
   */
  const indegNow = (): Record<string, number> =>
    Object.fromEntries(ALL_V.map((v) => [v, indeg.get(v) ?? 0] as [string, number]))

  /** 顶点旁的黄标签：值就是 `indegNow()` 里的那个数，只是前面加了"入度"两个字 */
  const indegBadges = (): Record<string, string> => {
    const now = indegNow()
    return Object.fromEntries(ALL_V.map((v) => [v, `入度${now[v]}`] as [string, string]))
  }

  /**
   * 上一帧的入度快照 —— 「入度表」板子的 note 靠它写出"这一步入度发生了什么"。
   *
   * 用**前后两帧的数据自动对比**，而不是在 8 个 yield 里各手写一句：手写的话，
   * 一旦某个 yield 忘了写、或者数字写错（比如漏写一次减 1），note 就会和表上的数字打架，
   * 而且没法用一条通用断言守住。自动 diff 和表是"从同一份数据生成"的，天然不会不一致。
   */
  let prevIndeg: Record<string, number> | null = null

  /**
   * 这一步入度发生了什么。
   * 只在 `boardPair` 里调用，而 `boardPair` 每个 yield **恰好调一次**，
   * 所以 `prevIndeg` 一定指向上一帧、不会漏帧也不会重复推进。
   */
  const indegNote = (now: Record<string, number>): string => {
    const before = prevIndeg
    prevIndeg = now
    // 首帧没有"上一帧"可比：把初始入度原样报出来（这张表开局就是这个样子）
    if (!before) return `初始入度：${ALL_V.map((v) => `${v}=${now[v]}`).join('，')}`
    const changed = ALL_V.filter((v) => before[v] !== now[v])
    if (!changed.length) return '这一步入度没有变化'
    return changed
      .map((v) =>
        now[v] === 0
          ? `${v} 的入度 ${before[v]} -> 0，马上入队`
          : `${v} 的入度 ${before[v]} -> ${now[v]}`,
      )
      .join('；')
  }

  /**
   * 造一帧**拓扑排序专用**的图快照 —— 全算法唯一的收口处。
   *
   * 这张图上的顶点和边会真的少下去，所以每一个引用都必须先过一遍 `alive`：
   *   1. 顶点只画还活着的，边只画**两端都还活着**的；
   *   2. `hot` / `done` / `badges` 里绝不能残留已经删掉的顶点 —— 校验器会因为
   *      "引用了不存在的顶点"当场抛错（这是本算法最容易踩的坑）。这里一律过滤，
   *      所以在每个 yield 里都不需要手写"哪些顶点已经没了"，也不可能漏写；
   *   3. `sub` 只对**还在图上**的顶点求值，给已删顶点留的小字不会画出来；
   *   4. 边的编号 `w` 用它**原始**边表里的位置：删掉几条边之后，剩下的边不会重新编号；
   *   5. 顶点坐标用它在圆环上的**原始**序号算 —— 删掉同伴后，剩下的人位置一点不动。
   */
  const topoView = (opts: {
    hot?: string[]
    done?: string[]
    badges?: Record<string, string>
    /** 顶点下方那行小字（只会为还在图上的顶点调用） */
    sub?: (v: string) => string | undefined
    mark?: EdgeMark
    note?: string
  } = {}): GraphView => {
    const live = ALL_V.filter((v) => alive.has(v))
    const liveSet = new Set(live)
    const m = opts.mark ?? emptyMark()
    const liveEdges: GraphEdgeSnapshot[] = []
    edges.forEach((e, k) => {
      const [a, b] = e.split('->') as [string, string]
      if (!liveSet.has(a) || !liveSet.has(b)) return
      const key = ekey(a, b)
      liveEdges.push({
        from: a,
        to: b,
        w: k + 1,
        directed: true,
        tone: m.tone.get(key),
        label: m.label.get(key),
      })
    })
    return {
      nodes: live.map((v) => ({ id: v, label: v, ...ring(ringIdx(v), N), sub: opts.sub?.(v) })),
      edges: liveEdges,
      hot: (opts.hot ?? []).filter((v) => liveSet.has(v)),
      done: (opts.done ?? []).filter((v) => liveSet.has(v)),
      badges: Object.fromEntries(
        Object.entries(opts.badges ?? {}).filter(([v]) => liveSet.has(v)),
      ),
      note: opts.note,
    }
  }

  /**
   * 顶点下方的小字：默认"入度见表"（表就是下面那块「入度表」板子，
   * 顶点旁边的黄标签是**同一个值的另一种呈现**），个别顶点可以特写。
   */
  const subOf =
    (extra: Record<string, string> = {}) =>
    (v: string): string =>
      extra[v] ?? '入度见表'

  /**
   * 这一帧挂的三块板子，**每帧都给**（`ScenePanel` 是竖着往下排的，所以下面的顺序 = 从上到下）。
   *
   *   1.「入度表」—— 每个顶点固定一格，写它当前的入度（**全顶点**都在，包括已经输出的）；
   *   2.「已输出（拓扑序）」—— 每输出一个顶点就接一格，结果全靠它攒着；
   *   3.「队列」—— 当前入度为 0、等着被输出的顶点，指针「队首」指向第 0 格（空队列不给指针）。
   *
   * 为什么把入度表排最前面：三块连起来读是"**当前状态 → 结果 → 待办**"——
   * 入度表就是当前状态（它自己的 note 写的正是"这一步入度发生了什么"），
   * 读完再往下看已经输出了谁、谁还在排队。而且它离上面的图最近：
   * 顶点下方的小字写着"入度见表"，那张表就在紧下面。
   *
   * 注意入度表的 note 是**自己**算的（这一步入度变化了多少），不受 `opts.note` 影响 ——
   * `opts.note` 讲的始终是"队列 / 输出"这条线，它只给第 3 块队列板用。
   */
  const boardPair = (opts: { hot?: string; note: string }): BoardView[] => {
    const now = indegNow()
    return [
      // `opts.hot` 就是"这一步入度刚减到 0、马上要入队"的那个顶点 -> 表上那格点紫色
      indegBoard(ALL_V, now, { out, hot: opts.hot, note: indegNote(now) }),
      topoOutBoard(out),
      queueBoard(queue, opts),
    ]
  }

  /**
   * 这个顶点的入度是不是**已经归零、并且已经排进队了**（或者已经输出了）。
   *
   * 这是 Kahn 算法里最容易写错的一处：一个顶点可能有多个前驱，
   * 排在前面处理的前驱可能已经把它减到了 0（比如 V4 的前驱有 V1、V2、V3，
   * 前两个处理完时它的入度就已经是 1 了）—— 等最后一个前驱轮到的时候**绝不能再减一次**，
   * 否则入度会从 0 掉到 -1，解说词会写出"入度减到 0"这种自相矛盾的话，
   * 排进队还会被输出两次。
   * 所以入度的语义是"**还欠几个没做完的前驱**"，最少就是 0，不会再往下走。
   */
  const ready = (v: string): boolean => queue.includes(v) || out.includes(v)

  // 首帧：把所有顶点的入度算出来写在旁边
  const zeroInit = ALL_V.filter((v) => indeg.get(v) === 0)
  yield {
    line: 2,
    action: 'init',
    array: seq,
    graph: topoView({
      badges: indegBadges(),
      sub: subOf(),
      note: `AOV 网：顶点是活动，有向边 u->v 表示 u 必须先于 v；顶点旁的黄标签就是当前入度`,
    }),
    boards: boardPair({ note: `还没开始找：入度为 0 的顶点是 ${zeroInit.join('、')}` }),
    comment: `① 统计每个顶点的入度，写在顶点旁边的小标签上，同时也整整齐齐排在下面的「入度表」板子里：${ALL_V.map((v) => `${v} 入度 ${indeg.get(v)}`).join('，')}。只有 ${zeroInit.join('、')} 入度为 0 —— 没有前驱，可以从它开始。这张图一共 ${edges.length} 条边，除了最后的汇点 ${ALL_V[N - 1]}，每个顶点都至少有一条出边，所以每输出一个顶点都能看到"删结点连带删出边"`,
    vars: { n: N, 输出个数: 0, 入度0个数: zeroInit.length, 图上剩余: alive.size },
  }

  for (const v of zeroInit) queue.push(v)
  yield {
    line: 5,
    action: 'mark',
    array: seq,
    graph: topoView({
      hot: zeroInit,
      badges: indegBadges(),
      sub: subOf(Object.fromEntries(zeroInit.map((v) => [v, '入度0']))),
      note: `入度为 0 的顶点 ${zeroInit.join('、')} 入队`,
    }),
    boards: boardPair({ hot: zeroInit[0], note: `入度为 0 的顶点入队：队首是 ${queue[0]}` }),
    comment: `② 入度为 0 的顶点（没有前驱，现在就能做）全部放进队里：${zeroInit.join('、')}。放进**栈或队列都可以**，只影响同层顶点谁先输出，不影响结果的正确性`,
    vars: { n: N, 输出个数: 0, 入度0个数: queue.length, 图上剩余: alive.size },
  }

  while (queue.length) {
    const u = queue.shift()!
    /*
     * u 的出边表先记下来：下一步会把这个顶点从图上删掉，
     * 但"它原来指向谁"还要接着用来算后继的入度。
     */
    const outs = adj.get(u)!

    // ③ 弹出队首 u 输出 —— 注意这一步它**还在图上**（紫色），下一步才真的被删掉
    const previewMark = emptyMark()
    for (const w of outs) previewMark.tone.set(ekey(u, w), 'hot')
    yield {
      line: 8,
      action: 'mark',
      array: seq,
      graph: topoView({
        hot: [u],
        badges: indegBadges(),
        sub: subOf({ [u]: `第${out.length + 1}个` }),
        mark: previewMark,
        note: outs.length
          ? `输出 ${u}：它是拓扑序列的第 ${out.length + 1} 个顶点；紫色那 ${outs.length} 条边是它的出边`
          : `输出 ${u}：它是拓扑序列的第 ${out.length + 1} 个顶点（没有出边）`,
      }),
      boards: boardPair({
        note: `弹出队首 ${u} 输出（队列长 ${queue.length + 1} -> ${queue.length}），它马上要从图上被删掉`,
      }),
      comment: `③ 弹出队首 ${u} 输出：它是拓扑序列的第 ${out.length + 1} 个顶点。入度为 0 的意思是"它的前驱全都已经做完了"，所以现在轮到它。它**还在图上**（画紫色），下一步才真的消失`,
      vars: { n: N, 输出个数: out.length, 入度0个数: queue.length, 图上剩余: alive.size },
    }

    /*
     * ④ 本算法动画最关键的一步：**把 u 这个顶点，和以它为起点的所有出边，一起从图上删掉**。
     *
     * 这一步必须是自己独立的一帧 —— 画面从"该顶点还在、正要输出"直接变成
     * "顶点和它的出边都不见了"，用户才看得清这一步干了什么。
     * 删完之后，剩下的顶点坐标一点不动（`topoView` 用顶点的原始序号算坐标，不重新布局），
     * 只是图上少了一个人；同时 u 被写进「已输出」板子，结果不会丢。
     */
    out.push(u)
    alive.delete(u)
    const outEdgeText = outs.map((w) => `${u}->${w}`).join('、')
    yield {
      line: 9,
      action: 'set',
      array: seq,
      graph: topoView({
        badges: indegBadges(),
        sub: subOf(),
        note: outs.length
          ? `删掉 ${u}：顶点 ${u} 从图上消失，它的 ${outs.length} 条出边（${outEdgeText}）也一起消失`
          : `删掉 ${u}：它是最后的汇点、没有出边，所以只有顶点 ${u} 自己消失`,
      }),
      boards: boardPair({
        note: outs.length
          ? `${u} 已经输出到「已输出（拓扑序）」板子上了；图上从此没有 ${u}，它的 ${outs.length} 条出边也一起删掉了`
          : `${u} 已经输出到「已输出（拓扑序）」板子上了；它是最后的汇点，没有出边，所以只有它自己从图上消失`,
      }),
      comment: outs.length
        ? `④ 输出完立刻把 ${u} 从图里删掉：顶点 ${u} 不见了，以它为起点的 ${outs.length} 条出边（${outEdgeText}）也一起不见了 —— 边是跟着起点走的。剩下顶点的坐标一个都没动，只是图上少了一个人。${u} 是拓扑序列的第 ${out.length} 个，已经记在「已输出」板子的最后一格`
        : `④ 输出完立刻把 ${u} 从图里删掉：它是这张图的汇点，没有出边，所以只有它自己从画面上消失。剩下顶点的坐标一个都没动。${u} 是拓扑序列的第 ${out.length} 个，已经记在「已输出」板子的最后一格`,
      vars: { n: N, 输出个数: out.length, 入度0个数: queue.length, 图上剩余: alive.size },
    }

    // ⑤ 边跟着 u 一起删了，箭头指向的后继就少一个前驱：入度减 1，减到 0 就进队
    const newlyZero: string[] = []
    for (let k = 0; k < outs.length; k++) {
      const w = outs[k]!
      /*
       * 两种边不能再算（这张图只从小号指向大号，正常跑下来不会碰到，
       * 但入度的语义必须是"还欠几个前驱"，所以这两条防线一定要留）：
       *   1. 指向**已经输出**的顶点：它在输出的时候这条边就跟着一起删掉了；
       *   2. 指向**入度已经归零、已经排队**的顶点：它的入度是靠别的边减到 0 的，
       *      这里再减一次就成 -1 了。
       * 注意这里**不能**再往 hot 里放 u —— u 已经在上一帧被删掉了，
       * 引用它会让校验器直接报错。
       */
      if (ready(w) || out.includes(w)) {
        yield {
          line: 12,
          action: 'compare',
          array: seq,
          graph: topoView({
            hot: [w],
            badges: indegBadges(),
            sub: subOf({ [w]: out.includes(w) ? '已输出' : '已经解锁' }),
            note: `边 ${u}->${w} 不用再算：${w} 的入度已经是 0 了`,
          }),
          boards: boardPair({
            note: out.includes(w)
              ? `${w} 已经输出过了，这条边在它输出时就跟着删掉了，这里跳过`
              : `${w} 的入度已经减到 0 并在队里了，这条边跳过，不能再减一次`,
          }),
          comment: out.includes(w)
            ? `⑤ 边 ${u}->${w} 指向的 ${w} 早就输出过了 —— 它输出的时候这条边就跟着删掉了，这里跳过，**不能再把 ${w} 的入度减一次**`
            : `⑤ 边 ${u}->${w} 指向的 ${w}，它的入度早就被别的边减到 0 了，现在排在队里等输出 —— 入度的意思是"还欠几个前驱没做完"，最少就是 0，**绝不能再减成负数**`,
          vars: { n: N, 输出个数: out.length, 入度0个数: queue.length, 图上剩余: alive.size },
        }
        continue
      }

      const from = indeg.get(w)!
      const to = from - 1
      indeg.set(w, to)
      if (to === 0) newlyZero.push(w)

      yield {
        line: 12,
        action: 'set',
        array: seq,
        graph: topoView({
          hot: [w],
          badges: indegBadges(),
          sub: subOf({ [w]: `入度${from}→${to}` }),
          note: `边 ${u}->${w} 刚才已经跟着 ${u} 一起删掉了：${w} 少一个前驱，入度 ${from} -> ${to}`,
        }),
        boards: boardPair({
          // 刚减到 0 的那一格要在入度表上点紫色（这就是"最关键的一拍"）；
          // 还没减到 0 的就不点，免得用户以为它已经解锁了。
          // 注意 w 这一刻**还没进队**（入队是这一轮出边处理完之后的事），
          // 所以这个 hot 只影响入度表，队列板上找不到它、不会有副作用。
          hot: to === 0 ? w : undefined,
          note:
            to === 0
              ? `${w} 的入度减到 0 了：它马上要入队`
              : `${w} 的入度 ${from} -> ${to}，还没到 0，继续等它的其他前驱`,
        }),
        comment: `⑤ ${u} 的第 ${k + 1} 条出边 ${u}->${w}（已经跟着 ${u} 一起从图上删掉了）指向 ${w}：${w} 少了一个前驱，入度 ${from} -> ${to}${
          to === 0 ? `。减到 0 说明 ${w} 的前驱都做完了，它可以进队了` : `。还没到 0，${w} 还得等它剩下的前驱`
        }`,
        vars: { n: N, 输出个数: out.length, 入度0个数: queue.length, 图上剩余: alive.size },
      }
    }

    for (const w of newlyZero) queue.push(w)
    yield {
      line: 12,
      action: 'mark',
      array: seq,
      graph: topoView({
        hot: newlyZero,
        badges: indegBadges(),
        sub: subOf(Object.fromEntries(newlyZero.map((w) => [w, '入度0']))),
        note: newlyZero.length
          ? `入度减到 0 的顶点 ${newlyZero.join('、')} 进队`
          : `${u} 的出边都处理完了，没有新的入度 0 顶点`,
      }),
      boards: boardPair({
        hot: newlyZero[0],
        note: newlyZero.length
          ? `${newlyZero.join('、')} 入队：队列现在就 ${queue.length} 个了`
          : `没有新的入度 0 顶点入队，队列里还有 ${queue.length} 个`,
      }),
      comment: newlyZero.length
        ? `⑤ ${u} 的出边删完，${newlyZero.join('、')} 的入度刚好减到 0，进队等着被输出。这就是拓扑排序的关键动作：**每删一条边，一个顶点的入度就减 1，减到 0 就解锁**`
        : `⑤ ${u} 的出边全部处理完了，但没有任何顶点因此减到入度 0 —— 它们都还有别的前驱没做完`,
      vars: { n: N, 输出个数: out.length, 入度0个数: queue.length, 图上剩余: alive.size },
    }
  }

  const ok = out.length === N
  yield {
    line: ok ? 16 : 15,
    action: 'done',
    array: seq,
    graph: topoView({
      // 还没被删掉的边：图有环时它们就是环上的边（画红）；无环时一条也不剩
      mark: leftEdges(edges, removedKeys()),
      sub: subOf({}),
      note: ok
        ? `所有顶点都输出完了，图上剩 ${alive.size} 个顶点、${liveEdgeKeys().size} 条边；拓扑序列：${out.join(' → ')}`
        : `还有 ${N - out.length} 个顶点没输出：图里有环，拓扑排序失败`,
    }),
    /*
     * 收尾帧也照样走 `boardPair`：入度表这块板子**每一帧都在**，
     * 这里要是手写数组、少写一块，"每帧都有三块板子"这条规矩当场就破了。
     * 此刻循环已经退出、队列必空，所以 `queueBoard` 拿到的就是空队列，和手写 `[]` 等价。
     */
    boards: boardPair({
      note: ok
        ? '队列空了，所有顶点都输出了：图是有向无环图'
        : '队列空了但还有顶点没输出：剩下的顶点互相等，成环了',
    }),
    comment: ok
      ? `⑥ 队列空了，而且 ${out.length} 个顶点全都输出了 —— 这是一张有向无环图（DAG），拓扑序列是：${out.join(' → ')}。图上现在一个顶点、一条边都不剩：每输出一个顶点，它本人和它的出边就被一起删掉，删到最后正好清空，全部 ${N} 个顶点都按先后排在图下面的「已输出（拓扑序）」板子里。验证一下：每条边都是从前面的顶点指向后面的顶点，没有一个违反先后次序`
      : `⑥ 队列空了，但只输出了 ${out.length} 个顶点，还剩 ${N - out.length} 个没输出（图上红色那些边就是环上的边）—— 说明图里有环，这些顶点互相是对方的前驱，谁也不能先做，拓扑排序失败`,
    vars: { n: N, 输出个数: out.length, 入度0个数: 0, 图上剩余: alive.size },
  }
}

/* ------------------------------------------------------------------ */
/* 八、注册表                                                          */
/* ------------------------------------------------------------------ */

/**
 * 4 个算法的输入都只是一串"顶点编号"：数据**长度 = 顶点数**，值只用来填底部的数据栏。
 * 默认给 7 个顶点（落在 5..9 的中间，开局就是一张不大不小的图）。
 */
const DEFAULT_DATA = (): number[] => Array.from({ length: DEFAULT_N }, (_, i) => i + 1)

/** 遍历类（DFS / BFS）的首帧图：顶点下方一律先写"未访问" */
function initTraverseView(data: number[], note: (g: GraphModel) => string): GraphView {
  const g = graphModel(clampN(data.length), false)
  return buildView(g, { sub: () => '未访问', note: note(g) })
}

/** 拓扑排序的首帧图：每个顶点旁边先把初始入度写出来 */
function initTopoView(data: number[], note: (g: GraphModel) => string): GraphView {
  const g = graphModel(clampN(data.length), true)
  return buildView(g, {
    badges: Object.fromEntries(g.allV.map((v) => [v, `入度${g.initIndeg.get(v)}`])),
    sub: () => '入度见表',
    note: note(g),
  })
}

export const graphTraverseSpecs: AlgorithmSpec[] = [
  {
    id: 'graph-dfs-rec',
    name: '深度优先搜索 DFS（递归）',
    category: 'graph',
    group: '遍历',
    summary: '一条路走到黑：递归下去，走不动了才退回来换一条（递归调用栈画在下面）',
    complexity: { time: 'O(n + e)，n 是顶点数、e 是边数', space: 'O(n)，递归调用栈最深 n 层' },
    renderer: 'graph',
    codeLines: CODE_DFS_REC,
    defaultData: DEFAULT_DATA,
    prepareData,
    // 数据规模 = 顶点数：图按 5..9 个顶点确定性生成，所以只给这五档
    sizes: GRAPH_SIZES,
    initGraph: (data) =>
      initTraverseView(data, (g) => `无向图：${g.n} 个顶点、${g.edges.length} 条边；从 V1 出发递归 DFS`),
    // 首帧由 engine 造，生成器管不到 —— 要让"递归调用栈"从第一帧就出现在页面下方，
    // 只能靠 initScene 把这块空栈板递进去（跟 stackSeq / treeThreadForest 的做法一样）
    initScene: () => ({
      boards: [stackBoard([], { title: '递归调用栈（栈底在下）', note: '还没进任何一层：调用栈是空的' })],
    }),
    initComment: (data) => {
      const n = clampN(data.length)
      return `无向图有 ${n} 个顶点、${edgeCount(n, false)} 条边（环 V1-V2-…-V${n}-V1 打底，再加 ${Math.floor(n / 2)} 条弦），顶点编号 V1..V${n} 固定画在圆周上，位置全程不动。递归 DFS 从 V1 出发：访问 V1 之后，按编号从小到大看它的邻居，谁没访问过就递归进去 —— 一路往深处走，走到没路可走才一层层退回来。下面那块竖排板子就是**递归调用栈**`
    },
    createRunner: runDfsRec,
  },
  {
    id: 'graph-dfs-iter',
    name: '深度优先搜索 DFS（非递归）',
    category: 'graph',
    group: '遍历',
    summary: '用显式栈模拟递归：压栈时只是排队，弹出时才访问',
    complexity: { time: 'O(n + e)，n 是顶点数、e 是边数', space: 'O(n)，显式栈最深 n 层' },
    renderer: 'graph',
    codeLines: CODE_DFS_ITER,
    defaultData: DEFAULT_DATA,
    prepareData,
    sizes: GRAPH_SIZES,
    initGraph: (data) =>
      initTraverseView(data, (g) => `无向图：${g.n} 个顶点、${g.edges.length} 条边；从 V1 出发非递归 DFS`),
    // 同上：显式栈板子要第一帧就在
    initScene: () => ({ boards: [stackBoard([], { note: '初始化：栈还是空的' })] }),
    initComment: () =>
      '同一张无向图，这次不用递归，自己开一个**显式栈**。做法明确说一遍：起点先压栈；然后反复"弹出栈顶 -> 如果它还没访问过就访问 -> 把它所有没访问过的邻居一次性全部压栈"。也就是**压栈时不访问，弹出时才访问**，所以同一个顶点可能被压进栈好几次，弹出来发现访问过了就当场丢掉。下面那块竖排板子就是显式栈',
    createRunner: runDfsIter,
  },
  {
    id: 'graph-bfs',
    name: '广度优先搜索 BFS',
    category: 'graph',
    group: '遍历',
    summary: '一层一层往外扩：用队列，离起点近的全部访问完才轮到更远的（顶点旁标访问次序）',
    complexity: { time: 'O(n + e)，n 是顶点数、e 是边数', space: 'O(n)，队列最长 n 个顶点' },
    renderer: 'graph',
    codeLines: CODE_BFS,
    defaultData: DEFAULT_DATA,
    prepareData,
    sizes: GRAPH_SIZES,
    initGraph: (data) =>
      initTraverseView(data, (g) => `无向图：${g.n} 个顶点、${g.edges.length} 条边；从 V1 出发 BFS`),
    // 同上：队列板子要第一帧就在
    initScene: () => ({ boards: [queueBoard([], { note: '初始化：队列是空的' })] }),
    initComment: () =>
      '同一张无向图，换成 BFS：用**队列**（先进先出），所以顶点是一层一层被访问的 —— 离起点 V1 近的全部访问完，才轮到更远的。规矩是"访问和入队紧挨着做"：先访问、打标记，再排到队尾。每个顶点旁边的小标签写它是第几个被访问的，下面那块横排板子是队列本身，指针「队首」指着第 0 格',
    createRunner: runBfs,
  },
  {
    id: 'graph-topo',
    name: '拓扑排序（AOV 网）',
    category: 'graph',
    group: '拓扑排序',
    summary:
      '反复挑出入度为 0 的顶点输出：每输出一个，该顶点和以它为起点的出边一起从图上消失，后继入度减 1',
    complexity: { time: 'O(n + e)，n 是顶点数、e 是边数', space: 'O(n)，入度表和栈 / 队列' },
    renderer: 'graph',
    codeLines: CODE_TOPO,
    defaultData: DEFAULT_DATA,
    prepareData,
    sizes: GRAPH_SIZES,
    initGraph: (data) =>
      initTopoView(
        data,
        (g) =>
          `AOV 网（有向无环图）：${g.n} 个顶点、${g.edges.length} 条有向边；每输出一个顶点，它和它的出边都会从画面上删掉`,
      ),
    /*
     * 首帧由 engine 造，生成器管不到：三块板子（入度表 + 已输出 + 队列）必须**第一帧就在**，
     * 不然第一帧下方是空的，第 2 帧才冒出来，「入度表」也就不是"每帧都有"了。
     * 首帧入度表用的是 `graphModel` 算出来的**初始入度**，和 `initTopoView`
     * 写在黄标签上的那份是同一条规则生成的，所以第一帧就是"表上的数字 == 顶点旁的标签"。
     */
    initScene: (data) => {
      const g = graphModel(clampN(data.length), true)
      return {
        boards: [
          indegBoard(g.allV, Object.fromEntries(g.initIndeg), {
            note: `初始入度：${g.allV.map((v) => `${v}=${g.initIndeg.get(v)}`).join('，')}`,
          }),
          topoOutBoard([]),
          queueBoard([], { note: '初始化：队列是空的，还没找出入度为 0 的顶点' }),
        ],
      }
    },
    initComment: (data) => {
      const g = graphModel(clampN(data.length), true)
      const indegText = g.allV.map((v) => `${v}=${g.initIndeg.get(v)}`).join('、')
      return `换成一张**有向无环图**（AOV 网）：${g.n} 个顶点、${g.edges.length} 条有向边（主链 V1->…->V${g.n} 打底，再补 4 条跨层边），顶点表示活动，边 u->v 表示 u 必须先于 v。初始入度 ${indegText}，写在每个顶点旁边 —— 中间几个顶点的入度明显比别人大，除最后的汇点外每个顶点都至少有一条出边。做法是：把入度为 0 的顶点（没有前驱，现在就能做）放进队里，反复弹出一个输出；**每输出一个顶点，它本人和以它为起点的所有出边都会从图上真的消失** —— 图上剩下的就是"还没做完的活动"，顶点坐标全程不动。每删掉一条出边，箭头指向的那个顶点入度减 1，减到 0 就说明它的前驱全做完了，进队等着输出。已经输出的顶点按先后排在图下面那块「已输出（拓扑序）」板子里：输出了几个就有几格，一个都没输出时是块空板子。**「已输出」上面那块横排的板子就是入度表**：每个顶点固定占一格，格子里的数字是它**当前**的入度，右下角小字是顶点名 —— 已经输出的那格会**淡掉**，这一步入度刚减到 0、马上要入队的那个格子会**点紫色**，所以"哪一步把谁的入度减掉了"在表上一眼就能看见。入度表每帧都在、格子永远是 n 格，它和顶点旁的黄标签读的是同一份数据，两边永远一样`
    },
    createRunner: runTopo,
  },
]
