import type {
  AlgorithmSpec,
  AlgoRunner,
  BoardView,
  CellItem,
  TreeView,
  TreeNodeSnapshot,
} from '@/core/types'
import { TREE_SIZES } from './treeTraverse'

/**
 * 树的应用 —— 哈夫曼树 / 堆 / 并查集。
 *
 * 两种渲染器的分工：
 *   tree  ：哈夫曼树（森林 -> 一棵树）、并查集（双亲表示法 + 向上虚线）
 *   scene ：堆（数组就是堆，row 布局画数组最直观）、哈夫曼编码表（grid 两列/三列）
 *
 * 快照约定：
 *   - 每帧都给 array（逻辑顺序的值序列）+ 中文 comment；
 *   - tree 渲染器每帧给 tree，scene 渲染器每帧给 boards，并且要写 initTree / initScene
 *     （首帧由 engine 造，生成器管不到）；
 *   - 一个 yield = 一步，line 必须指向 codeLines 里**非空**的那一行。
 */

/** 一帧给多长至少 1 个结点，字符表按 A 往后排 */
function charOf(i: number): string {
  return String.fromCharCode(65 + i)
}

/**
 * 兜底规模。
 *   HEAP_N   —— 堆的数组长度现在**跟着数据规模走**，只有数据为空时才用这 9 个 0 撑一块板子；
 *   UF_SIZES —— 并查集支持的结点个数（5..9），元素个数 = 数据规模，
 *               初始分组由 ufInit 按 n 确定性地摆出来（不再只有写死的 8 个结点一种规模）。
 */
const HEAP_N = 9
const UF_SIZES = [5, 6, 7, 8, 9]
const UF_MIN_N = UF_SIZES[0]!
const UF_MAX_N = UF_SIZES[UF_SIZES.length - 1]!
/** 并查集的默认数据：7 个元素，刚好摆成 {0,1,2} {3,4} {5,6} 三组 */
const UF_DEFAULT = [0, 1, 2, 3, 4, 5, 6]

/* ------------------------------------------------------------------ *
 * 一、哈夫曼树
 * ------------------------------------------------------------------ */

interface HufNode {
  id: string
  /** 权值 */
  w: number
  /** 叶子结点的字符；内部结点没有 */
  ch?: string
  left?: string
  right?: string
}

interface HufTree {
  nodes: HufNode[]
  root: string | null
}

/**
 * 建哈夫曼树：权值序列 -> 叶子结点，反复"取最小的两棵合成一棵"。
 * 这里只算结构，不 yield，构造和编码两个算法共用。
 */
function buildHuffman(weights: number[]): HufTree {
  const nodes: HufNode[] = weights.map((w, i) => ({
    id: `n${i}`,
    w,
    ch: charOf(i),
  }))
  let next = weights.length
  let forest = nodes.map((n) => n.id)
  while (forest.length > 1) {
    // 权值最小的两棵：先按权值升序，权值相同时按 id 字典序，保证结果确定
    const sorted = [...forest].sort((a, b) => {
      const wa = nodes[Number(a.slice(1))]!.w
      const wb = nodes[Number(b.slice(1))]!.w
      return wa !== wb ? wa - wb : a.localeCompare(b)
    })
    const a = sorted[0]!
    const b = sorted[1]!
    const id = `n${next++}`
    nodes.push({
      id,
      w: nodes[Number(a.slice(1))]!.w + nodes[Number(b.slice(1))]!.w,
      left: a,
      right: b,
    })
    forest = forest.filter((x) => x !== a && x !== b)
    forest.push(id)
  }
  return { nodes, root: forest[0] ?? null }
}

/** 从根往下走：左记 0、右记 1，收集每个叶子（字符）的编码 */
function huffmanCodes(tree: HufTree): Array<{ ch: string; w: number; code: string }> {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]))
  const out: Array<{ ch: string; w: number; code: string }> = []
  const walk = (id: string | undefined, code: string): void => {
    if (!id) return
    const n = byId.get(id)
    if (!n) return
    if (n.ch !== undefined) {
      out.push({ ch: n.ch, w: n.w, code: code === '' ? '0' : code })
      return
    }
    walk(n.left, code + '0')
    walk(n.right, code + '1')
  }
  walk(tree.root ?? undefined, '')
  return out
}

/** 哈夫曼构造的默认权值（8 个叶子，对应字符 A~H） */
const HUF_SAMPLE = [5, 29, 7, 8, 14, 23, 3, 11]

/**
 * 当前森林里**真的已经存在**的结点（按创建顺序）。
 *
 * 这一步是「初始状态不能有连线」的关键：哈夫曼树的内部结点是**边合并边 new** 出来的，
 * 如果每帧都把整棵树的全部结点（包括还没造出来的内部结点）都画出来，
 * 初始状态就会凭空多出一排内部结点和它们的连线 —— 那正是之前的 bug。
 */
function liveNodes(tree: HufTree, forest: string[]): HufNode[] {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]))
  const alive = new Set<string>()
  const walk = (id: string): void => {
    if (alive.has(id)) return
    const n = byId.get(id)
    if (!n) return
    alive.add(id)
    if (n.left) walk(n.left)
    if (n.right) walk(n.right)
  }
  for (const r of forest) walk(r)
  return tree.nodes.filter((n) => alive.has(n.id))
}

/** 一棵树里最左边那个叶子。森林按它排序，画面上的结点移动幅度才最小 */
function leftLeafId(byId: Map<string, HufNode>, id: string): string {
  let cur = byId.get(id)
  while (cur?.left) cur = byId.get(cur.left)
  return cur?.id ?? id
}

/** 结点下方的小字：叶子给字符，内部结点给"两个孩子权值相加"的算式 */
function subOf(tree: HufTree, n: HufNode): string {
  if (n.ch !== undefined) return n.ch
  const byId = new Map(tree.nodes.map((x) => [x.id, x]))
  const lw = byId.get(n.left!)?.w
  const rw = byId.get(n.right!)?.w
  return lw !== undefined && rw !== undefined ? `${lw}+${rw}` : '—'
}

/**
 * 哈夫曼**构造**过程中的树形快照 = 当前的森林。
 * 二叉树用 left / right（渲染器按中序布局，"只有左孩子"就一定在父结点左边）；
 * 森林用 roots 把每一棵都列出来。父子实线由 left / right 自动画，
 * 所以这里**一条额外连线都不给**。
 */
function hufView(
  tree: HufTree,
  forest: string[],
  opts: { hot?: string[]; done?: string[]; pointers?: Record<string, string | null>; note?: string } = {},
): TreeView {
  /*
   * 树区域只画**已经合并出来的**树。
   * 还没参与过合并的游离叶子属于上方那个池子，在下面再画一遍就重复了 ——
   * 用户的说法是"先将每个结点单独摆在上方成一行，而后在其下方不断构建树"，
   * 所以下面从空开始，随合并一棵一棵长出来。
   */
  const merged = forest.filter((id) => {
    const n = tree.nodes.find((x) => x.id === id)
    return !!n && (!!n.left || !!n.right)
  })
  const nodes = liveNodes(tree, merged).map((n) => ({
    id: n.id,
    value: n.w,
    left: n.left ?? null,
    right: n.right ?? null,
    sub: subOf(tree, n),
  }))
  /*
   * 指针只保留"树区域里真有这个结点"的那些。
   * a / b 指的是本轮选中的两棵最小树，如果它们还是游离叶子，树区域里就没有它们
   * （它们在上方池子里高亮着）—— 这时候指向不存在的结点会被校验器直接报错。
   */
  const ids = new Set(nodes.map((n) => n.id))
  const pointers = Object.fromEntries(
    Object.entries(opts.pointers ?? {}).filter(([, v]) => !v || ids.has(v)),
  )
  return {
    nodes,
    roots: merged.length ? [...merged] : tree.root ? [tree.root] : [],
    hot: opts.hot ?? [],
    done: opts.done ?? [],
    pointers,
    links: [],
    note: opts.note,
  }
}

/** 每个结点"从双亲过来的那一位"：左孩子记 0、右孩子记 1（根没有） */
function hufBits(tree: HufTree): Map<string, '0' | '1'> {
  const m = new Map<string, '0' | '1'>()
  for (const n of tree.nodes) {
    if (n.left) m.set(n.left, '0')
    if (n.right) m.set(n.right, '1')
  }
  return m
}

/**
 * 哈夫曼**编码**用的树形快照。
 *
 * 边上没法单独写字（TreeNodeSnapshot 没有边的标签字段），所以 0 / 1 直接写在
 * **子结点自己的小字**里：叶子是「A·0」（字符 + 进来的那一位），内部结点就是「0」/「1」。
 * 结点主体的大数字仍然是对应的权值。
 */
function hufCodeView(
  tree: HufTree,
  opts: { hot?: string[]; done?: string[]; note?: string } = {},
): TreeView {
  const bits = hufBits(tree)
  return {
    nodes: tree.nodes.map((n) => {
      const bit = bits.get(n.id)
      return {
        id: n.id,
        value: n.w,
        left: n.left ?? null,
        right: n.right ?? null,
        sub: n.ch !== undefined ? (bit ? `${n.ch}·${bit}` : n.ch) : (bit ?? '根'),
      }
    }),
    root: tree.root,
    hot: opts.hot ?? [],
    done: opts.done ?? [],
    note: opts.note ?? '结点小字就是"从双亲进来的那一位"：左 0、右 1；叶子写成 A·0（字符 A 走的是 0 这一支）',
  }
}

/**
 * 游离结点池一行摆几格：一行最多 9 格（再多就横向溢出了），超过 9 个折成两行。
 * 8 个权值一行摆得下；12 个用 6 列，折成两行。
 */
function poolCols(n: number): number {
  return n <= 9 ? n : Math.ceil(n / 2)
}

/**
 * 游离结点池：还没被合并过的那些叶子，一个权值一格，摆在树**上方**（position: 'top'）。
 * 每合并一次就从 items 里去掉被选中的那两个 —— 后面的格子自然依次往前补上空位。
 */
function poolBoard(
  tree: HufTree,
  pool: string[],
  cols: number,
  opts: { hot?: string[]; note: string },
): BoardView {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]))
  const hot = new Set(opts.hot ?? [])
  return {
    title: `游离结点池（还剩 ${pool.length} 个单结点树）`,
    position: 'top',
    layout: 'grid',
    cols,
    items: pool.map((id) => {
      const n = byId.get(id)
      return {
        text: String(n?.w ?? ''),
        sub: n?.ch ?? '',
        tone: hot.has(id) ? ('hot' as const) : ('base' as const),
      }
    }),
    note: opts.note,
  }
}

/**
 * 哈夫曼编码表（挂在树**下面**，不加 position）。
 *
 * 摆成**三行**（字符 / 权值 / 编码，一个字符一列），而不是一行一个字符。
 * 这里是树在当主角：一行一个字符的话 8 个字符就要 400 多像素高，
 * 树被挤到只剩一条缝、非缩到最小的 2/3 不可；横过来摆只占 150 像素，
 * 整棵哈夫曼树就能完整留在一个画面里。
 */
function hufCodeTable(
  table: Array<{ ch: string; w: number; code: string }>,
  done: Set<string>,
  step: string,
  hotCol: number,
  opts: { codeText?: string; note: string },
): BoardView {
  const state = (r: number): 'base' | 'hot' | 'done' => {
    if (r === hotCol) return 'hot'
    return done.has(table[r]!.ch) ? 'done' : 'base'
  }
  const rows: Array<{ label: string; cell: (r: number) => CellItem }> = [
    { label: '字符', cell: (r) => ({ text: table[r]!.ch, tone: state(r) }) },
    {
      label: '权值',
      cell: (r) => ({ text: String(table[r]!.w), tone: state(r) === 'base' ? 'dim' : state(r) }),
    },
    {
      label: '编码',
      cell: (r) => {
        const e = table[r]!
        const isHot = r === hotCol
        const finished = done.has(e.ch)
        // 正在编码的那个字符，这一格显示"当前已经走了几位"（边走边长）
        const code = isHot && opts.codeText !== undefined ? opts.codeText : finished ? e.code : ''
        return { text: code || '···', tone: isHot ? 'hot' : finished ? 'done' : 'dim' }
      },
    },
  ]
  const items: CellItem[] = []
  for (const row of rows) {
    items.push({ text: row.label, tone: 'dim' })
    for (let r = 0; r < table.length; r++) items.push(row.cell(r))
  }
  return {
    title: `哈夫曼编码表（${step}）`,
    layout: 'grid',
    cols: table.length + 1,
    items,
    // 第一列是行标题，所以第 r 个字符落在第 r+1 格
    pointers: hotCol >= 0 ? { 当前字符: hotCol + 1 } : {},
    note: opts.note,
  }
}

/** 森林的权值（按 id 序号排），当作这一帧的 array */
function forestWeights(tree: HufTree, forest: string[]): number[] {
  return [...forest]
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .map((id) => tree.nodes[Number(id.slice(1))]!.w)
}

/** 森林的可读描述：权值从小到大 */
function forestText(tree: HufTree, forest: string[]): string {
  const ws = forest.map((id) => tree.nodes[Number(id.slice(1))]!.w).sort((a, b) => a - b)
  return `[${ws.join(', ')}]`
}

const CODE_HUF_BUILD = [
  '// 每个权值先各自成为一棵只有根结点的树',
  'HuffmanTree build(int w[], int n) {',
  '  for (int i = 0; i < n; i++) forest[i] = 叶子(w[i]);   // ① 森林里有 n 棵单结点树',
  '  for (int k = 1; k < n; k++) {                          // ② 一共合并 n-1 次',
  '    a = 取最小(forest);                                  // ③ 取权值最小的两棵',
  '    b = 取最小(forest);',
  '    t = 新结点(a.w + b.w);                               // ④ 新根权值 = 两棵权值之和',
  '    t->left = a; t->right = b;                            // ⑤ 左小右大挂上去',
  '    forest 加入 t;                                        // ⑥ 放回森林',
  '  }',
  '  return forest[0];                                      // ⑦ 只剩一棵，就是哈夫曼树',
  '}',
]

const CODE_HUF_CODE = [
  '// 从根往下走：向左记 0、向右记 1，到叶子就得到该字符的编码',
  'void encode(HuffmanTree T, char path[], int len) {',
  '  if (T == NULL) return;',
  '  if (T->left == NULL && T->right == NULL) {   // ① 走到叶子结点',
  '    输出(T->ch, path);                          // ② 这一路记下的 01 串就是编码',
  '    return;',
  '  }',
  '  path[len] = \'0\';                            // ③ 走左分支，记一个 0',
  '  encode(T->left, path, len + 1);',
  '  path[len] = \'1\';                            // ④ 走右分支，记一个 1',
  '  encode(T->right, path, len + 1);',
  '}',
]

function* runHuffmanBuild(data: number[]): AlgoRunner {
  const weights = data.length ? data : HUF_SAMPLE
  const n = weights.length
  /**
   * 树是**边合并边长**的：一开始只有 n 个叶子结点，合并一次才 new 一个内部结点。
   * 绝不能一次把整棵树算出来再画 —— 那样初始状态就会连着线和内部结点一起冒出来。
   */
  const nodes: HufNode[] = weights.map((w, i) => ({ id: `n${i}`, w, ch: charOf(i) }))
  const tree: HufTree = { nodes, root: null }
  const byId = new Map(nodes.map((nd) => [nd.id, nd]))
  const nodeOf = (id: string): HufNode => byId.get(id)!
  const wOf = (id: string): number => nodeOf(id).w

  /** 当前森林（每棵树的根）。按"最左边那个叶子"排序，画面上结点移动的幅度最小 */
  let forest = nodes.map((nd) => nd.id)
  /** 游离结点池 = 还没被合并过的叶子，摆在树上方等着被选 */
  let pool = [...forest]
  let next = n
  const cols = poolCols(n)

  const inOrder = (ids: string[]): string[] =>
    [...ids].sort(
      (a, b) => Number(leftLeafId(byId, a).slice(1)) - Number(leftLeafId(byId, b).slice(1)),
    )
  const poolView = (hot: string[], note: string): BoardView =>
    poolBoard(tree, pool, cols, { hot, note })
  /** 森林里权值最小的两棵树（权值相同时按编号，保证结果确定） */
  const smallest = (): [string, string] => {
    const sorted = [...forest].sort((a, b) =>
      wOf(a) !== wOf(b) ? wOf(a) - wOf(b) : a.localeCompare(b),
    )
    return [sorted[0]!, sorted[1]!]
  }
  /** 池子里被选走的那些（选中的可能已经是树里的内部结点了，那就一个也不删） */
  const pickedFromPool = (a: string, b: string): string[] =>
    pool.filter((id) => id === a || id === b)
  const pickText = (picked: string[]): string =>
    picked.length
      ? `这一轮从池子里选走了 ${picked.map((id) => `${nodeOf(id).ch}(${wOf(id)})`).join(' 和 ')}`
      : '这一轮选中的两棵已经在树里长出来了，池子里没有它们'

  yield {
    line: 3,
    action: 'init',
    array: forestWeights(tree, forest),
    tree: hufView(tree, forest, {
      note: `森林里有 ${n} 棵单结点树，彼此之间还没有任何连线：${forestText(tree, forest)}`,
    }),
    boards: [
      poolView(
        [],
        `${n} 个权值就是 ${n} 个游离结点，各自独立地摆在上面；下面每合并一次，这里就少两个`,
      ),
    ],
    comment: `① 先把每个权值变成一棵只有根结点的树：${forestText(tree, forest)}，一共 ${n} 棵、彼此之间一条连线都没有。它们都摆在上面等着被选中`,
    vars: { n, 森林: n, 池子: n },
  }

  for (let k = 1; k < n; k++) {
    const [a, b] = smallest()
    const wa = wOf(a)
    const wb = wOf(b)
    const picked = pickedFromPool(a, b)

    yield {
      line: 5,
      action: 'compare',
      array: forestWeights(tree, forest),
      tree: hufView(tree, forest, {
        hot: [a, b],
        pointers: { a: a, b: b },
        note: `本轮挑出权值最小的两棵：${wa} 和 ${wb}`,
      }),
      boards: [poolView(picked, pickText(picked))],
      comment: `③ 从森林的 ${forest.length} 棵树里挑出权值最小的两棵：${wa} 和 ${wb}（${Math.min(wa, wb)} 是最小的，一定选得上）`,
      vars: { a: wa, b: wb, 森林: forest.length, 池子: pool.length },
    }

    yield {
      line: 7,
      action: 'mark',
      array: forestWeights(tree, forest),
      tree: hufView(tree, forest, {
        hot: [a, b],
        pointers: { a: a, b: b },
        note: `新根权值 = ${wa} + ${wb} = ${wa + wb}`,
      }),
      boards: [poolView(picked, `新结点的权值 = ${wa} + ${wb} = ${wa + wb}`)],
      comment: `④ 造一个新根结点，权值 = ${wa} + ${wb} = ${wa + wb}`,
      vars: { a: wa, b: wb, 新根: wa + wb },
    }

    const id = `n${next++}`
    const created: HufNode = { id, w: wa + wb, left: a, right: b }
    nodes.push(created)
    byId.set(id, created)
    forest = inOrder([...forest.filter((x) => x !== a && x !== b), id])
    pool = pool.filter((x) => x !== a && x !== b)

    yield {
      line: 8,
      action: 'swap',
      array: forestWeights(tree, forest),
      tree: hufView(tree, forest, {
        hot: [id],
        pointers: { 新根: id },
        note: `${wa} 挂在左孩子、${wb} 挂在右孩子；森林还剩 ${forest.length} 棵树`,
      }),
      boards: [
        poolView(
          [],
          `${picked.length ? `池子里少了 ${picked.map((x) => nodeOf(x).ch).join(' 和 ')}，后面的结点依次往前补上空位；` : ''}池子还剩 ${pool.length} 个`,
        ),
      ],
      comment: `⑤ 把 ${wa} 挂到左孩子、${wb} 挂到右孩子，合成一棵权值 ${wa + wb} 的新树；森林还剩 ${forest.length} 棵树：${forestText(tree, forest)}`,
      vars: { 森林: forest.length, 新根: wa + wb, 池子: pool.length },
    }
  }

  const root = forest[0]!
  tree.root = root
  const total = wOf(root)
  const wpl = huffmanCodes(tree).reduce((s, e) => s + e.w * e.code.length, 0)
  yield {
    line: 11,
    action: 'done',
    array: [total],
    tree: hufView(tree, [root], {
      done: nodes.filter((nd) => nd.ch !== undefined).map((nd) => nd.id),
      note: `哈夫曼树建成，根结点权值 = ${total} = 所有叶子权值之和`,
    }),
    boards: [poolView([], '池子已经空了：所有游离结点都合并进树里了')],
    comment: `⑦ 合并了 ${n - 1} 次后森林里只剩一棵树，这就是哈夫曼树：根结点权值 ${total}，带权路径长度 WPL = ${wpl}（= 每个叶子的权值 × 码长，加起来）`,
    vars: { 合并次数: n - 1, 树根权值: total },
  }
}

function* runHuffmanCode(data: number[]): AlgoRunner {
  const weights = data.length ? data : HUF_SAMPLE
  const tree = buildHuffman(weights)
  const table = huffmanCodes(tree).sort((x, y) => x.ch.localeCompare(y.ch))
  const byId = new Map(tree.nodes.map((n) => [n.id, n]))
  /** 双亲表：从叶子往上回溯，才能走出"这个字符自己的那一条路" */
  const parentOf = new Map<string, string>()
  for (const n of tree.nodes) {
    if (n.left) parentOf.set(n.left, n.id)
    if (n.right) parentOf.set(n.right, n.id)
  }
  /** 已经编码完成的叶子字符 */
  const doneCh = new Set<string>()

  /** 这个字符在编码表里是第几列 */
  const colOf = (ch: string): number => table.findIndex((e) => e.ch === ch)

  /** 树：走到哪哪个结点亮；编码表挂在树下面（不加 position，默认就在下方） */
  const treeNow = (hot: string[], note?: string): TreeView =>
    hufCodeView(tree, {
      hot,
      done: tree.nodes.filter((n) => n.ch !== undefined && doneCh.has(n.ch)).map((n) => n.id),
      note,
    })
  const tableView = (
    step: string,
    hotCol: number,
    opts: { codeText?: string; note: string },
  ): BoardView => hufCodeTable(table, doneCh, step, hotCol, opts)

  yield {
    line: 1,
    action: 'init',
    array: weights.slice(),
    tree: treeNow([], `哈夫曼树已经建好（根结点权值 ${byId.get(tree.root!)!.w}）。下面就沿着这棵树，一个字符一个字符地往下走`),
    boards: [tableView('准备', -1, { note: '还没有字符编好码' })],
    comment: `哈夫曼树已经建好了（根结点权值 ${byId.get(tree.root!)!.w}）。现在从根往下走给每个字符编码：向左记 0、向右记 1，走到叶子就是这个字符的编码`,
    vars: { 字符数: table.length },
  }

  for (const leaf of tree.nodes.filter((n) => n.ch !== undefined)) {
    const ch = leaf.ch!
    const w = leaf.w
    /**
     * 从根走到**这个叶子**的那条路（每个叶子只有一条）。
     * 不能一路往左走到底 —— 那样每个字符都会得到最左边那个叶子的编码。
     * 借双亲表从叶子往上回溯，才能保证走的是这个字符自己的那一条路。
     */
    const chain: string[] = [leaf.id]
    for (let up = parentOf.get(leaf.id); up !== undefined; up = parentOf.get(up)) chain.push(up)
    chain.reverse()
    let code = ''

    yield {
      line: 3,
      action: 'mark',
      array: weights.slice(),
      tree: treeNow(tree.root ? [tree.root] : [], `准备给字符 ${ch} 编码，先站到根结点上`),
      boards: [
        tableView(`开始 ${ch}`, colOf(ch), {
          codeText: '',
          note: `当前要编码的字符是 ${ch}（权值 ${w}），现在站在根结点 ${byId.get(tree.root!)!.w} 上，编码串还是空的`,
        }),
      ],
      comment: `① 从哈夫曼树的根结点出发，准备给字符 ${ch}（权值 ${w}）编码`,
      vars: { 权值: w },
    }

    for (let k = 1; k < chain.length; k++) {
      const from = byId.get(chain[k - 1]!)!
      const to = byId.get(chain[k]!)!
      const goLeft = from.left === to.id
      const bit = goLeft ? '0' : '1'

      yield {
        line: goLeft ? 8 : 10,
        action: 'compare',
        array: weights.slice(),
        tree: treeNow(
          [from.id, to.id],
          `在结点 ${from.w} 处走${goLeft ? '左' : '右'}分支到 ${to.w}，这一位记 ${bit}`,
        ),
        boards: [
          tableView(`走 ${ch}`, colOf(ch), {
            codeText: code,
            note: `从 ${from.w} 走${goLeft ? '左' : '右'}分支到 ${to.w}，编码多一位 ${bit}`,
          }),
        ],
        comment: `${goLeft ? '③' : '④'} 在结点 ${from.w} 处走${goLeft ? '左' : '右'}分支（到结点 ${to.w}），这一位记 ${bit}，当前编码是 ${code}${bit}`,
        vars: { 权值: w },
      }

      code += bit
    }

    doneCh.add(ch)
    yield {
      line: 5,
      action: 'done',
      array: weights.slice(),
      tree: treeNow(
        [leaf.id],
        `走到叶子结点 ${ch}（权值 ${w}），编码 ${code} 就写在它的小字里`,
      ),
      boards: [
        tableView(`完成 ${ch}`, colOf(ch), {
          codeText: code,
          note: `字符 ${ch}（权值 ${w}）的编码 = ${code}，共 ${code.length} 位`,
        }),
      ],
      comment: `② 走到了叶子结点 ${ch}（权值 ${w}），这一路记下的 01 串就是它的编码：${ch} → ${code}（${code.length} 位），已经写进下面的编码表`,
      vars: { 权值: w, 码长: code.length },
    }
  }

  const totalBits = table.reduce((s, e) => s + e.w * e.code.length, 0)
  yield {
    line: 12,
    action: 'done',
    array: weights.slice(),
    tree: treeNow([], `编码表建好了：带权路径长度 WPL = ${totalBits} 位`),
    boards: [
      tableView('完成', -1, {
        note: `编码表建好了，带权路径长度 WPL = ${totalBits} 位`,
      }),
    ],
    comment: `任何两个字符的编码都不会互为前缀（这叫前缀码），所以解码时不会认错；整篇正文一共 ${totalBits} 位，WPL = ${totalBits}`,
    vars: { 总位数: totalBits },
  }
}

/* ------------------------------------------------------------------ *
 * 二、堆（大根堆，数组 row 布局）
 * ------------------------------------------------------------------ */

/** 数组板：格子下标写在 sub 里，note 里给出孩子的下标公式 */
function heapBoard(
  a: number[],
  opts: {
    title: string
    cur?: number
    childA?: number
    childB?: number
    bigger?: number
    doneFrom?: number
    note: string
  },
): BoardView {
  const items: CellItem[] = a.map((v, i) => {
    let tone: CellItem['tone'] = 'base'
    if (i === opts.cur) tone = 'hot'
    else if (i === opts.bigger) tone = 'mark'
    else if (i === opts.childA || i === opts.childB) tone = 'mark'
    else if (opts.doneFrom !== undefined && i >= opts.doneFrom) tone = 'dim'
    return { text: String(v), sub: `${i}`, tone }
  })
  const pointers: Record<string, number> = {}
  if (opts.cur !== undefined) pointers.i = opts.cur
  if (opts.childA !== undefined) pointers['2i+1'] = opts.childA
  if (opts.childB !== undefined) pointers['2i+2'] = opts.childB
  if (opts.bigger !== undefined && opts.bigger !== opts.cur) pointers.较大孩子 = opts.bigger
  return {
    title: opts.title,
    layout: 'row',
    items,
    pointers,
    note: opts.note,
  }
}

/**
 * 堆的数组：**长度就是数据规模** —— 选 5 个数据就画 5 格、选 12 个就画 12 格
 * （以前一律截成 / 补成固定的 HEAP_N 格，于是"选了 5 却画出 9 个格子"）。
 * 只有数据为空时才兜底成 HEAP_N 个 0，免得板子上一格都没有（校验不允许空板子）。
 */
function heapFrames(data: number[]): number[] {
  return data.length ? data.slice() : new Array<number>(HEAP_N).fill(0)
}

/**
 * 把数据摆成"**只有根结点**可能违反大根堆、其余子树都已经是大根堆"的样子 ——
 * 这是"对 a[0] 做一次向下调整"这一课的前提。
 *
 * 数组里的值一个不少，只是换个位置：把 a[1..] 原地堆化，再把它放回根的位置。
 * 默认数据本来就长这样，所以摆完一个字都不动；换成随机数据也照样成立。
 */
function heapSiftReady(raw: number[]): number[] {
  const a = heapFrames(raw)
  if (a.length <= 1) return a
  const rest = a.slice(1)
  for (let i = Math.floor(rest.length / 2) - 1; i >= 0; i--) {
    let k = i
    for (;;) {
      const l = 2 * k + 1
      if (l >= rest.length) break
      const r = l + 1
      const big = r < rest.length && rest[r]! > rest[l]! ? r : l
      if (rest[k]! >= rest[big]!) break
      const t = rest[k]!
      rest[k] = rest[big]!
      rest[big] = t
      k = big
    }
  }
  return [a[0]!, ...rest]
}

/** 一行说明孩子下标公式，堆的每一帧 note 都带上，用户不会混 */
const HEAP_FORMULA = '下标从 0 开始：结点 i 的左孩子 2i+1、右孩子 2i+2，双亲 (i-1)/2'

const CODE_HEAP_BUILD = [
  '// 大根堆：每个结点都 >= 它的两个孩子',
  'void buildHeap(int a[], int n) {',
  '  for (int i = n / 2 - 1; i >= 0; i--)   // ① 从最后一个非叶结点往前',
  '    siftDown(a, n, i);                   // ② 每个结点做一次"向下调整"',
  '}',
  '',
  'void siftDown(int a[], int n, int i) {',
  '  while (2 * i + 1 < n) {                // ③ 还有孩子就继续',
  '    int c = 2 * i + 1;                   // 左孩子',
  '    if (c + 1 < n && a[c + 1] > a[c]) c++;   // ④ 挑较大的那个孩子',
  '    if (a[i] >= a[c]) break;              // ⑤ 已经满足大根堆，停',
  '    swap(a[i], a[c]);                     // ⑥ 和较大的孩子交换',
  '    i = c;                                // ⑦ 继续往下调整',
  '  }',
  '}',
]

const CODE_HEAP_SIFT = [
  '// 大根堆的向下调整（筛选）：只调整以 i 为根的这棵子树',
  'void siftDown(int a[], int n, int i) {',
  '  while (2 * i + 1 < n) {                       // ① 只要还有孩子就继续',
  '    int c = 2 * i + 1;                          // ② 先假设较大的孩子是左孩子',
  '    if (c + 1 < n && a[c + 1] > a[c]) c++;      // ③ 右孩子更大就换成右孩子',
  '    if (a[i] >= a[c]) break;                     // ④ 父 >= 较大的孩子：满足大根堆，停',
  '    swap(a[i], a[c]);                            // ⑤ 不满足就交换',
  '    i = c;                                       // ⑥ 换完继续往下看',
  '  }',
  '}',
]

function* runHeapBuild(data: number[]): AlgoRunner {
  const a = heapFrames(data)
  const n = a.length
  const swaps = { count: 0 }

  yield {
    line: 3,
    action: 'init',
    array: a.slice(),
    boards: [
      heapBoard(a, {
        title: '初始数组（还不是堆）',
        note: `${HEAP_FORMULA}　n = ${n}，最后一个非叶结点是 a[${Math.floor(n / 2) - 1}]`,
      }),
    ],
    comment: `初始数组 [${a.join(', ')}] 里任何一个结点都可能比孩子小，还不是大根堆。叶子结点本来就没有孩子，不用调整，所以从最后一个非叶结点 a[${Math.floor(n / 2) - 1}]（下标 n/2-1 = ${n}/2-1）开始往前逐个向下调整`,
    vars: { n, i: Math.floor(n / 2) - 1 },
  }

  for (let i0 = Math.floor(n / 2) - 1; i0 >= 0; i0--) {
    yield {
      line: 3,
      action: 'mark',
      array: a.slice(),
      boards: [
        heapBoard(a, {
          title: `开始调整 a[${i0}]`,
          cur: i0,
          note: `${HEAP_FORMULA}　当前结点 i = ${i0}，先看它的孩子`,
        }),
      ],
      comment: `① 轮到结点 a[${i0}] = ${a[i0]}：以它为根的子树做一次向下调整；它右边的结点下标都大于 ${i0}，已经满足大根堆`,
      vars: { i: i0 },
    }

    let i = i0
    while (2 * i + 1 < n) {
      const left = 2 * i + 1
      const right = 2 * i + 2
      let big = left
      yield {
        line: 9,
        action: 'compare',
        array: a.slice(),
        boards: [
          heapBoard(a, {
            title: `a[${i}] 找较大的孩子`,
            cur: i,
            childA: left,
            childB: right < n ? right : undefined,
            bigger: left,
            note: `${HEAP_FORMULA}　左孩子 a[${left}] = ${a[left]}${right < n ? `，右孩子 a[${right}] = ${a[right]}` : '，没有右孩子'}`,
          }),
        ],
        comment: `③ 结点 ${a[i]} 的左孩子是 a[${left}] = ${a[left]}${right < n ? `，右孩子是 a[${right}] = ${a[right]}` : '，它没有右孩子'}`,
        vars: { i, 左孩子: left },
      }

      if (right < n) {
        const takeRight = a[right]! > a[left]!
        if (takeRight) big = right
        yield {
          line: 10,
          action: 'compare',
          array: a.slice(),
          boards: [
            heapBoard(a, {
              title: `a[${i}] 比较两个孩子`,
              cur: i,
              childA: left,
              childB: right,
              bigger: big,
              note: `${HEAP_FORMULA}　较大的孩子是 a[${big}] = ${a[big]}`,
            }),
          ],
          comment: `④ 两个孩里挑大的：${a[right]} ${takeRight ? '>' : '<='} ${a[left]}，所以较大的孩子是 a[${big}] = ${a[big]}（大根堆只和较大的那个孩子比，和小的孩子无关）`,
          vars: { i, 较大的孩子: big },
        }
      }

      if (a[i]! >= a[big]!) {
        yield {
          line: 11,
          action: 'mark',
          array: a.slice(),
          boards: [
            heapBoard(a, {
              title: `a[${i}] 已经满足大根堆`,
              cur: i,
              bigger: big,
              note: `${HEAP_FORMULA}　${a[i]} >= ${a[big]}，不用换`,
            }),
          ],
          comment: `⑤ 父结点 ${a[i]} >= 较大的孩子 ${a[big]}，以 a[${i}] 为根的子树已经是大根堆，调整结束`,
          vars: { i },
        }
        break
      }

      const pv = a[i]!
      const cv = a[big]!
      a[i] = cv
      a[big] = pv
      swaps.count++

      yield {
        line: 12,
        action: 'swap',
        array: a.slice(),
        boards: [
          heapBoard(a, {
            title: `交换 a[${i}] 和 a[${big}]`,
            cur: big,
            bigger: i,
            note: `${HEAP_FORMULA}　父 ${pv} < 孩子 ${cv}，换完 a[${i}] = ${cv}、a[${big}] = ${pv}`,
          }),
        ],
        comment: `⑥ 父结点 ${pv} 比孩子 ${cv} 小，违反大根堆，交换 a[${i}] 和 a[${big}]：换完 a[${i}] = ${cv}、a[${big}] = ${pv}`,
        vars: { i, 较大的孩子: big },
      }

      yield {
        line: 13,
        action: 'set',
        array: a.slice(),
        boards: [
          heapBoard(a, {
            title: `换完，a[${big}] = ${pv}`,
            cur: big,
            note: `${HEAP_FORMULA}　换完还要继续往下看 a[${big}]`,
          }),
        ],
        comment: `⑦ 交换后 a[${i}] = ${cv}、a[${big}] = ${pv}；被换下来的 ${pv} 还可能比它自己的孩子小，所以继续从 i = ${big} 往下调整`,
        vars: { i: big },
      }
      i = big
    }

    if (2 * i + 1 >= n) {
      yield {
        line: 8,
        action: 'mark',
        array: a.slice(),
        boards: [
          heapBoard(a, {
            title: `a[${i}] 是叶子，停`,
            cur: i,
            note: `${HEAP_FORMULA}　2i+1 = ${2 * i + 1} >= n = ${n}，没有孩子`,
          }),
        ],
        comment: `a[${i}] 已经没有孩子（2i+1 = ${2 * i + 1} 超出数组），这一支调整到底了`,
        vars: { i },
      }
    }

    yield {
      line: 4,
      action: 'mark',
      array: a.slice(),
      boards: [
        heapBoard(a, {
          title: `a[${i0}] 调整完成`,
          doneFrom: undefined,
          note: `${HEAP_FORMULA}　现在 a[${i0}..${n - 1}] 已经满足大根堆`,
        }),
      ],
      comment: `结点 a[${i0}] 这棵子树调整完了：现在 a[${i0}..${n - 1}] 这一段都满足大根堆`,
      vars: { i: i0 },
    }
  }

  yield {
    line: 5,
    action: 'done',
    array: a.slice(),
    boards: [
      heapBoard(a, {
        title: '大根堆建好了',
        doneFrom: 0,
        note: `${HEAP_FORMULA}　a[0] = ${a[0]} 就是最大值`,
      }),
    ],
    comment: `② 所有结点都调整过一遍，建堆完成：数组是 [${a.join(', ')}]，a[0] = ${a[0]} 是整个堆的最大值（共交换 ${swaps.count} 次）`,
    vars: { n, 交换次数: swaps.count },
  }
}

function* runHeapSift(data: number[]): AlgoRunner {
  const a = heapFrames(data)
  const n = a.length
  const i0 = 0
  const swaps = { count: 0 }

  yield {
    line: 2,
    action: 'init',
    array: a.slice(),
    boards: [
      heapBoard(a, {
        title: `准备向下调整 a[${i0}]`,
        cur: i0,
        note: `${HEAP_FORMULA}　待调整的子树根是 a[${i0}]`,
      }),
    ],
    comment: `向下调整（筛选）只动以 i = ${i0} 为根的这棵子树：结点的下标关系不变，所以左右孩子的下标还是 2i+1 / 2i+2。数组是 [${a.join(', ')}]，当前 a[${i0}] = ${a[i0]}`,
    vars: { n, i: i0 },
  }

  let i = i0
  while (2 * i + 1 < n) {
    const left = 2 * i + 1
    const right = 2 * i + 2
    let big = left

    yield {
      line: 3,
      action: 'mark',
      array: a.slice(),
      boards: [
        heapBoard(a, {
          title: `a[${i}] 还有孩子吗`,
          cur: i,
          note: `${HEAP_FORMULA}　2i+1 = ${left} < n = ${n}，还有孩子`,
        }),
      ],
      comment: `① 判断 a[${i}] 有没有孩子：2i+1 = ${left} < n = ${n}，有，继续往下调整`,
      vars: { i },
    }

    yield {
      line: 4,
      action: 'compare',
      array: a.slice(),
      boards: [
        heapBoard(a, {
          title: `先假设左孩子较大`,
          cur: i,
          childA: left,
          childB: right < n ? right : undefined,
          bigger: left,
          note: `${HEAP_FORMULA}　候选：左孩子 a[${left}] = ${a[left]}`,
        }),
      ],
      comment: `② 先假设较大的孩子是左孩子 a[${left}] = ${a[left]}${right < n ? `，右边还有个 a[${right}] = ${a[right]}` : '，它没有右孩子'}`,
      vars: { i, c: left },
    }

    if (right < n) {
      const takeRight = a[right]! > a[left]!
      if (takeRight) big = right
      yield {
        line: 5,
        action: 'compare',
        array: a.slice(),
        boards: [
          heapBoard(a, {
            title: `比较左右两个孩子`,
            cur: i,
            childA: left,
            childB: right,
            bigger: big,
            note: `${HEAP_FORMULA}　较大的孩子 = a[${big}] = ${a[big]}`,
          }),
        ],
        comment: `③ 比较两个孩子：右孩子 ${a[right]} ${takeRight ? '>' : '<='} 左孩子 ${a[left]}，所以较大的是 a[${big}] = ${a[big]}。向下调整一定要挑**较大的**孩子换，若挑小的孩子换完，大的孩子就压在父结点上面了，大根堆照样被破坏`,
        vars: { i, c: big },
      }
    } else {
      yield {
        line: 5,
        action: 'mark',
        array: a.slice(),
        boards: [
          heapBoard(a, {
            title: `没有右孩子`,
            cur: i,
            childA: left,
            bigger: left,
            note: `${HEAP_FORMULA}　唯一的孩子就是 a[${left}] = ${a[left]}`,
          }),
        ],
        comment: `③ 没有右孩子，唯一的孩子就是左孩子 a[${left}] = ${a[left]}，它自然就是"较大的孩子"`,
        vars: { i, c: left },
      }
    }

    if (a[i]! >= a[big]!) {
      yield {
        line: 6,
        action: 'done',
        array: a.slice(),
        boards: [
          heapBoard(a, {
            title: `已经是大根堆，停`,
            cur: i,
            bigger: big,
            doneFrom: 0,
            note: `${HEAP_FORMULA}　${a[i]} >= ${a[big]}`,
          }),
        ],
        comment: `④ 父结点 ${a[i]} >= 较大的孩子 ${a[big]}，已经满足大根堆性质，不用交换，向下调整到此结束`,
        vars: { i },
      }
      return
    }

    const pv = a[i]!
    const cv = a[big]!
    a[i] = cv
    a[big] = pv
    swaps.count++

    yield {
      line: 7,
      action: 'swap',
      array: a.slice(),
      boards: [
        heapBoard(a, {
          title: `交换 a[${i}] <-> a[${big}]`,
          cur: big,
          bigger: i,
          note: `${HEAP_FORMULA}　${pv} < ${cv}，换完 a[${i}] = ${cv}、a[${big}] = ${pv}`,
        }),
      ],
      comment: `⑤ 父结点 ${pv} 比较大的孩子 ${cv} 小，交换它们：a[${i}] = ${cv}、a[${big}] = ${pv}`,
      vars: { i, c: big },
    }

    i = big
    yield {
      line: 8,
      action: 'set',
      array: a.slice(),
      boards: [
        heapBoard(a, {
          title: `继续往下调整 a[${i}]`,
          cur: i,
          note: `${HEAP_FORMULA}　新一轮：i = ${i}`,
        }),
      ],
      comment: `⑥ 交换后父结点位置上的 ${cv} 已经比原来的两个孩子都大，但从 a[${i}] 换下来的 ${pv} 还可能要往下沉，所以令 i = ${i} 继续循环`,
      vars: { i },
    }
  }

  yield {
    line: 9,
    action: 'done',
    array: a.slice(),
    boards: [
      heapBoard(a, {
        title: '向下调整结束',
        doneFrom: 0,
        note: `${HEAP_FORMULA}　a[0] = ${a[0]}`,
      }),
    ],
    comment: `a[${i}] 已经没有孩子，向下调整结束。现在数组是 [${a.join(', ')}]，以 a[${i0}] 为根的子树重新满足大根堆（共交换 ${swaps.count} 次）`,
    vars: { 交换次数: swaps.count },
  }
}

/* ------------------------------------------------------------------ *
 * 三、并查集（双亲表示法）
 * ------------------------------------------------------------------ */

/**
 * 并查集树快照。
 *
 * 双亲表示法只给 parent（渲染器把它理解成二叉树的中序布局），多个根用 roots 列出来。
 * 同时填 children —— 它是 parent 的**反向关系**，渲染器用它做"叶子占位、父居中"的多叉布局，
 * 不填的话所有结点会挤在同一列上互相盖住（父子**向下**的实线不画，向上指针统一用 parent 虚线）。
 */
function ufView(
  parent: number[],
  rank: number[],
  opts: { hot?: string[]; done?: string[]; pointers?: Record<string, string | null>; note?: string } = {},
): TreeView {
  const id = (i: number): string => `u${i}`
  const childrenOf = new Map<number, string[]>()
  const roots: string[] = []
  for (let i = 0; i < parent.length; i++) {
    const p = parent[i]!
    if (p === i) {
      roots.push(id(i))
    } else {
      const arr = childrenOf.get(p) ?? []
      arr.push(id(i))
      childrenOf.set(p, arr)
    }
  }
  const nodes: TreeNodeSnapshot[] = parent.map((p, i) => ({
    id: id(i),
    value: i,
    parent: id(p),
    children: childrenOf.get(i) ?? [],
    sub: `秩 ${rank[i] ?? 0}`,
  }))
  return {
    nodes,
    roots,
    hot: opts.hot ?? [],
    done: opts.done ?? [],
    pointers: opts.pointers ?? {},
    links: parent
      .map((p, i) => ({ from: id(i), to: id(p), kind: 'parent' as const }))
      .filter((l) => l.from !== l.to),
    note: opts.note,
  }
}

/** 并查集当前的分组文字描述：{0,4,7} 这样 */
function ufGroups(parent: number[]): string {
  const g = new Map<number, number[]>()
  for (let i = 0; i < parent.length; i++) {
    let r = i
    while (parent[r] !== r) r = parent[r]!
    const arr = g.get(r) ?? []
    arr.push(i)
    g.set(r, arr)
  }
  return [...g.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, mem]) => `{${mem.join(',')}} 根=${r}`)
    .join('　')
}

const CODE_UF_FIND = [
  'int find(int x) {',
  '  int r = x;',
  '  while (parent[r] != r) r = parent[r];   // ① 顺着双亲一路走到根',
  '  while (x != r) {                         // ② 路径压缩',
  '    int t = parent[x];',
  '    parent[x] = r;                         // ③ 路上每个结点直接挂到根上',
  '    x = t;',
  '  }',
  '  return r;                                // ④ 返回根',
  '}',
]

const CODE_UF_UNION = [
  'void union(int x, int y) {',
  '  int rx = find(x), ry = find(y);   // ① 先各自找到根',
  '  if (rx == ry) return;            // ② 本来就在一个集合里，什么也不用做',
  '  if (rank[rx] < rank[ry]) {       // ③ 按秩合并：矮的树挂到高的树下',
  '    parent[rx] = ry;',
  '  } else if (rank[rx] > rank[ry]) {',
  '    parent[ry] = rx;',
  '  } else {',
  '    parent[ry] = rx;               // ④ 秩相等，任选一个当根',
  '    rank[rx]++;                    // ⑤ 合并后新根的秩加 1',
  '  }',
  '}',
]

/** 并查集的元素个数 = 数据规模；超出 5..9 就夹到最近的合法值 */
function ufSize(data: number[]): number {
  if (data.length < UF_MIN_N) return UF_MIN_N
  if (data.length > UF_MAX_N) return UF_MAX_N
  return data.length
}

/**
 * 把随机 / 原始数据规整成并查集要的 5..9 个元素。
 *
 * 元素的值本身不参与运算（并查集的"指针"全在 parent 数组里），
 * 所以这里直接铺成 0..n-1：结点显示的值和它的下标永远一致，讲起来不会串。
 */
export function prepareData(raw: number[]): number[] {
  const n = ufSize(raw)
  return Array.from({ length: n }, (_, i) => i)
}

/**
 * 演示用的初始并查集，**按数据规模 n 确定性地摆**（不用随机数，同一个 n 每次画出来都一样）：
 *
 *   {0,1,2}      —— 一条 3 层的链 0 -> 1 -> 2（根 2、秩 2），
 *                   所有规模下都固定不变；Find 就查 0，这条路最能看出路径压缩的价值；
 *   其余 3..n-1  —— **均分成两拨**，每拨摆成"星形"（其余结点都直接挂在根上，根的秩 1）；
 *                   n = 5 时只剩 2 个结点，不再分拨，直接算作一拨。
 *
 * 于是五个规模长这样（元素个数刚好就是 n）：
 *   n=5 -> {0,1,2} {3,4}
 *   n=6 -> {0,1,2} {3,4} {5}
 *   n=7 -> {0,1,2} {3,4} {5,6}
 *   n=8 -> {0,1,2} {3,4,5} {6,7}
 *   n=9 -> {0,1,2} {3,4,5} {6,7,8}
 *
 * 约定：parent[i] === i 表示 i 是根（自己指自己）；rank 是"根到最深叶子的边数"，
 * 所以链 {0,1,2} 的根秩 2、星形的根秩 1、单结点集合的根秩 0 —— 根结点的秩就反映树高。
 */
function ufInit(n: number): { parent: number[]; rank: number[] } {
  const parent = Array.from({ length: n }, (_, i) => i)
  const rank = Array.from({ length: n }, () => 0)

  // 第一拨：0 -> 1 -> 2 一条链（固定不随 n 变），根是 2
  parent[0] = 1
  parent[1] = 2
  rank[1] = 1
  rank[2] = 2

  const rest = n - 3
  if (rest > 0) {
    // 剩下的均分成两拨；只剩 2 个（n = 5）时不再分，合成一拨
    const mid = rest >= 3 ? 3 + Math.ceil(rest / 2) : n
    ufStar(parent, rank, 3, mid)
    ufStar(parent, rank, mid, n)
  }
  return { parent, rank }
}

/** 把 [from, to) 这一拨摆成星形：根是 to-1，其余结点都直接挂在根上（树高 2，根的秩 1） */
function ufStar(parent: number[], rank: number[], from: number, to: number): void {
  if (to <= from) return
  const root = to - 1
  rank[root] = to - from >= 2 ? 1 : 0
  for (let i = from; i < root; i++) parent[i] = root
}

/** 顺着 parent 找到根 */
function ufRoot(parent: number[], x: number): number {
  let r = x
  while (parent[r] !== r) r = parent[r]!
  return r
}

/** 从 x 走到根要几步（边的条数） */
function ufDepth(parent: number[], x: number): number {
  let d = 0
  for (let i = x; parent[i] !== i; i = parent[i]!) d++
  return d
}

/** 当前有几个集合 */
function ufGroupCount(parent: number[]): number {
  let c = 0
  for (let i = 0; i < parent.length; i++) if (parent[i] === i) c++
  return c
}

/** 根 r 这个集合里有哪些结点（升序） */
function ufMembers(parent: number[], r: number): number[] {
  const out: number[] = []
  for (let i = 0; i < parent.length; i++) if (ufRoot(parent, i) === r) out.push(i)
  return out
}

function* runUfFind(data: number[]): AlgoRunner {
  const n = ufSize(data)
  const { parent, rank } = ufInit(n)
  const groups0 = ufGroupCount(parent)
  // 查 0 号元素：0 -> 1 -> 2 这条链在所有规模下都固定，是画面里最深、最能看出路径压缩价值的一条路
  const x = 0
  /** find 走一遍，路上经过的结点记下来（含根） */
  const seen: number[] = []
  const parentBefore = parent.slice()
  const stepsBefore = ufDepth(parent, x)

  yield {
    line: 2,
    action: 'init',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      pointers: { x: `u${x}` },
      note: `parent 数组 = [${parent.join(', ')}]，一共 ${n} 个元素、${groups0} 个集合：${ufGroups(parent)}`,
    }),
    comment: `① r = x = ${x}，先假定它就是根。双亲表示法里 parent[i] 就是 i 的双亲，向上的虚线是这条双亲指针，自己指向自己的结点是根。数据规模 n = ${n}，parent = [${parent.join(', ')}]，分成 ${groups0} 个集合：${ufGroups(parent)}。${x} 在一条 3 层的链上，压缩前要走 ${stepsBefore} 步才能到根`,
    vars: { n, x, 组数: groups0, 压缩前步数: stepsBefore },
  }

  // 第一遍：找出根，顺便把路上经过的结点记进 seen
  let r = x
  while (true) {
    const p = parent[r]!
    seen.push(r)
    yield {
      line: 3,
      action: 'compare',
      array: parent.slice(),
      tree: ufView(parent, rank, {
        hot: [`u${r}`],
        pointers: { x: `u${r}`, 下一步: `u${p}` },
        note:
          p === r
            ? `parent[${r}] = ${r}，找到根了`
            : `parent[${r}] = ${p} != ${r}，${r} 不是根，继续往上`,
      }),
      comment:
        p === r
          ? `① 走到 parent[${r}] = ${r}：${r} 就是根，元素 ${x} 属于根为 ${r} 的集合`
          : `① parent[${r}] = ${p}，而 ${r} 自己不是根，所以指针往上跳到双亲 ${p}`,
      vars: { n, x, 当前: r, 双亲: p },
    }
    if (p === r) break
    r = p
  }

  yield {
    line: 3,
    action: 'mark',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${r}`],
      pointers: { 根: `u${r}` },
      note: `查找路径：${seen.join(' -> ')}，根是 ${r}`,
    }),
    comment: `① 一路走到底：元素 ${x} 的根是 ${r}，这条路走了 ${stepsBefore} 步：${seen.join(' -> ')}。接下来做路径压缩，把路上的结点直接挂到根上`,
    vars: { n, x, 根: r, 路径长度: stepsBefore },
  }

  // 路径压缩：把路上每个结点直接挂到根上（本来就已经是根的孩子的不动）
  const compressed: number[] = []
  for (const i of seen) {
    if (i === r || parent[i] === r) continue
    const old = parent[i]!
    parent[i] = r
    compressed.push(i)
    yield {
      line: 6,
      action: 'set',
      array: parent.slice(),
      tree: ufView(parent, rank, {
        hot: [`u${i}`],
        pointers: { 压缩: `u${i}`, 根: `u${r}` },
        note: `把 ${i} 直接挂到根 ${r} 下：parent[${i}] 由 ${old} 改成 ${r}`,
      }),
      comment: `②③ 路径压缩：把路上经过的 ${i} 直接挂到根 ${r} 下面，parent[${i}] 由 ${old} 改成 ${r}（下次再查 ${i} 就一步到根）`,
      vars: { n, 压缩结点: i, 根: r },
    }
  }

  const stepsAfter = ufDepth(parent, x)
  yield {
    line: 9,
    action: 'mark',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${r}`],
      pointers: { 根: `u${r}` },
      note: `压缩前 parent = [${parentBefore.join(', ')}] → 压缩后 parent = [${parent.join(', ')}]`,
    }),
    comment: `④ 返回根 r = ${r}。压缩前 parent = [${parentBefore.join(', ')}]，压缩后 parent = [${parent.join(', ')}]，${compressed.length ? `刚被压缩的结点 ${compressed.join('、')} 现在都直接指着根` : '路上结点的双亲本来就是根'}，树变矮了`,
    vars: { n, x, 根: r, 压缩结点数: compressed.length, 组数: ufGroupCount(parent) },
  }

  // 再查一次，走的是压缩后的近路
  yield {
    line: 2,
    action: 'mark',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${x}`],
      pointers: { x: `u${x}`, 根: `u${r}` },
      note: `再查一次 ${x}：压缩前 ${stepsBefore} 步，压缩后 ${stepsAfter} 步就到根`,
    }),
    comment: `④ 压缩完再查一次元素 ${x}：压缩前要走 ${stepsBefore} 步才到根 ${r}，压缩后只要走 ${stepsAfter} 步 —— 这就是路径压缩的价值，以后再查都是近似 O(1)`,
    vars: { n, x, 压缩前步数: stepsBefore, 压缩后步数: stepsAfter },
  }

  const doneUf = parent.map((_, i) => `u${i}`).filter((_, i) => parent[i] === r || i === r)
  yield {
    line: 9,
    action: 'done',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${r}`],
      pointers: { 根: `u${r}` },
      done: doneUf,
      note: `最终 parent = [${parent.join(', ')}]，分组：${ufGroups(parent)}`,
    }),
    comment: `④ 查找结束，返回根 ${r}。最终 parent = [${parent.join(', ')}]，一共 ${n} 个元素、${ufGroupCount(parent)} 个集合：${ufGroups(parent)}；树变矮以后，以后所有 Find 都快了`,
    vars: { n, x, 根: r, 集合大小: doneUf.length },
  }
}

function* runUfUnion(data: number[]): AlgoRunner {
  const n = ufSize(data)
  const { parent, rank } = ufInit(n)
  const groups0 = ufGroupCount(parent)

  /*
   * 演示"按秩合并"的两个元素（所有规模下都这么挑，画面才稳定）：
   *   x = 3 —— 它在第二拨里，自己不是根，往上一步到那一拨的根（星形，秩 1）；
   *   y = 0 —— 它在 {0,1,2} 这条链的链尾，往上两步才到根 2（秩 2）。
   * 两个根的秩一定是 1 < 2，所以永远走"秩小的树挂到秩大的树下"这条分支。
   */
  const x = 3
  const y = 0
  const rx = ufRoot(parent, x)
  const ry = ufRoot(parent, y)
  const high = rank[rx]! >= rank[ry]! ? rx : ry
  const low = high === rx ? ry : rx
  const same = rx === ry
  const membersX = ufMembers(parent, rx)
  const membersY = ufMembers(parent, ry)

  yield {
    line: 2,
    action: 'init',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      pointers: { x: `u${x}`, y: `u${y}` },
      note: `parent = [${parent.join(', ')}]；秩写在结点下面的小字里，一共 ${n} 个元素、${groups0} 个集合 ${ufGroups(parent)}`,
    }),
    comment: `数据规模 n = ${n}，合并前要各自 Find 到根。要从元素 ${x}（根 ${rx}）和元素 ${y}（根 ${ry}）开始。parent = [${parent.join(', ')}]，结点下方的小字就是秩：${ufGroups(parent)}`,
    vars: { n, x, y, rx, ry, 组数: groups0 },
  }

  yield {
    line: 2,
    action: 'compare',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${x}`, `u${rx}`],
      pointers: { x: `u${x}`, rx: `u${rx}` },
      note: `find(${x}) 一路上到根 rx = ${rx}`,
    }),
    comment: `① 先 find(${x})：从 ${x} 顺着双亲往上走一步就到根 rx = ${rx}（秩 ${rank[rx]}），它所在集合是 {${membersX.join(',')}}，一共 ${membersX.length} 个结点`,
    vars: { n, x, rx, 秩: rank[rx]!, 集合大小: membersX.length },
  }

  yield {
    line: 2,
    action: 'compare',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${y}`, `u${ry}`],
      pointers: { y: `u${y}`, ry: `u${ry}` },
      note: `find(${y}) 一路上到根 ry = ${ry}`,
    }),
    comment: `① 再 find(${y})：从 ${y} 顺着双亲往上走（${y} → 1 → ${ry}）才到根 ry = ${ry}（秩 ${rank[ry]}），它所在集合是 {${membersY.join(',')}}，一共 ${membersY.length} 个结点`,
    vars: { n, y, ry, 秩: rank[ry]!, 集合大小: membersY.length },
  }

  if (same) {
    yield {
      line: 3,
      action: 'done',
      array: parent.slice(),
      tree: ufView(parent, rank, {
        hot: [`u${rx}`],
        done: [rx, ry].map((i) => `u${i}`),
        pointers: { 根: `u${rx}` },
        note: `rx = ry = ${rx}，本来就在一个集合里`,
      }),
      comment: `② rx = ry = ${rx}，两个元素本来就在同一个集合里，什么都不用做（这正是并查集"顺手判环"的原理）`,
      vars: { n, rx, ry },
    }
    return
  }

  yield {
    line: rank[rx]! < rank[ry]! ? 4 : rank[rx]! > rank[ry]! ? 6 : 9,
    action: 'compare',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${rx}`, `u${ry}`],
      pointers: { rx: `u${rx}`, ry: `u${ry}` },
      note: `比较两棵树的秩：${rank[rx]} 与 ${rank[ry]}`,
    }),
    comment: `③ 按秩合并：比较两个根的秩 ${rank[rx]} 与 ${rank[ry]}。规则是**秩小的树挂到秩大的树下**，这样合并后新树的高不会超过原来高的那棵，不会越并越深`,
    vars: { n, rx, ry, 秩x: rank[rx]!, 秩y: rank[ry]! },
  }

  const parentBefore = parent.slice()
  parent[low] = high
  const sameRank = rank[rx] === rank[ry]
  if (sameRank) rank[high] = rank[high]! + 1

  yield {
    line: sameRank ? 9 : rank[rx]! > rank[ry]! ? 7 : 5,
    action: 'swap',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${low}`],
      pointers: { 挂上去: `u${low}`, 新根: `u${high}` },
      note: `parent[${low}] = ${high}：把根 ${low} 挂到根 ${high} 下面${sameRank ? `，秩相同所以 rank[${high}] 加 1 变成 ${rank[high]}` : '，秩不变'}`,
    }),
    comment: sameRank
      ? `③④ 两个根的秩都是 ${rank[high]! - 1}（一样高），随便挑一个当新根：parent[${low}] = ${high}，并完新根秩加 1 变成 ${rank[high]}。parent 由 [${parentBefore.join(', ')}] 变成 [${parent.join(', ')}]`
      : `③ 秩 ${rank[low]!} < 秩 ${rank[high]!}，所以把小的那棵的根 ${low} 挂到 ${high} 下面：parent[${low}] = ${high}，${high} 的秩不变（还是 ${rank[high]}）—— 原来 {${membersX.join(',')}} 这些结点现在都挂到 ${high} 底下了。parent 由 [${parentBefore.join(', ')}] 变成 [${parent.join(', ')}]`,
    vars: { n, 被合并的根: low, 新根: high, 被合并的根的秩: rank[low]!, 新根秩: rank[high]! },
  }

  yield {
    line: 12,
    action: 'done',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${high}`],
      done: parent.map((_, i) => `u${i}`),
      pointers: { 新根: `u${high}` },
      note: `合并后 parent = [${parent.join(', ')}]，${ufGroups(parent)}`,
    }),
    comment: `合并完成：parent = [${parent.join(', ')}]，一共 ${n} 个元素、现在 ${ufGroupCount(parent)} 个集合：${ufGroups(parent)}。按秩合并保证树高不超过 O(log n)，再配上路径压缩，Find / Union 的均摊时间接近 O(1)`,
    vars: { n, 新根: high, 新根秩: rank[high]!, 组数: ufGroupCount(parent) },
  }
}

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

export const treeApplySpecs: AlgorithmSpec[] = [
  {
    id: 'huffman-build',
    name: '哈夫曼树·构造',
    category: 'tree',
    group: '哈夫曼树',
    summary: '反复取权值最小的两棵树合成一棵，直到只剩一棵',
    complexity: { time: 'O(n log n)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: CODE_HUF_BUILD,
    defaultData: () => HUF_SAMPLE.slice(),
    // 数据规模 = **叶子个数**：选 7 就是 7 个权值、画面上 7 个结点（不是 2n-1 个）
    // 数据规模 = 叶子个数。N 个权值必然长成 2N-1 个结点的满二叉树，
    // 10 个以上就会密到 2/3 缩放也放不下一个画面，所以上限收到 9。
    sizes: [5, 6, 7, 8, 9],
    initComment: (data) =>
      `初始权值（对应字符 A~${charOf(data.length - 1)}）：[${data.join(', ')}]。每个权值先各成一棵只有根结点的树，摆在上面的是"游离结点池"，彼此之间还没有任何连线`,
    initTree: (data) => {
      const w = data.length ? data : HUF_SAMPLE
      // 首帧：n 个叶子各自成为一棵只有根结点的树，**一条边都没有**
      const nodes: HufNode[] = w.map((wt, i) => ({ id: `n${i}`, w: wt, ch: charOf(i) }))
      return hufView(
        { nodes, root: null },
        nodes.map((nd) => nd.id),
        { note: `森林里有 ${w.length} 棵单结点树，每棵的权值就是对应字符的出现次数；现在还没有任何连线` },
      )
    },
    // 首帧是 engine 造的，游离结点池也要在第一帧就出现在树上方，只能从 initScene 给
    initScene: (data) => {
      const w = data.length ? data : HUF_SAMPLE
      const nodes: HufNode[] = w.map((wt, i) => ({ id: `n${i}`, w: wt, ch: charOf(i) }))
      return {
        boards: [
          poolBoard({ nodes, root: null }, nodes.map((nd) => nd.id), poolCols(w.length), {
            note: `${w.length} 个权值就是 ${w.length} 个游离结点；每合并一次，这里就少两个（后面的往前补空位）`,
          }),
        ],
      }
    },
    createRunner: runHuffmanBuild,
  },
  {
    id: 'huffman-code',
    name: '哈夫曼编码',
    category: 'tree',
    group: '哈夫曼树',
    summary: '从根往下走，向左记 0、向右记 1，走到叶子就是该字符的编码',
    complexity: { time: 'O(n)', space: 'O(n)' },
    // 编码要"看得出走在树上"，所以也换成树渲染器；编码表挂在树下面
    renderer: 'tree',
    codeLines: CODE_HUF_CODE,
    defaultData: () => HUF_SAMPLE.slice(),
    // 数据规模 = 叶子个数。N 个权值必然长成 2N-1 个结点的满二叉树，
    // 10 个以上就会密到 2/3 缩放也放不下一个画面，所以上限收到 9。
    sizes: [5, 6, 7, 8, 9],
    initComment: (data) =>
      `权值 [${data.join(', ')}] 已经建成一棵哈夫曼树（就画在右边），现在从根往下给每个字符编码：向左记 0、向右记 1`,
    initTree: (data) => hufCodeView(buildHuffman(data.length ? data : HUF_SAMPLE), { hot: [] }),
    initScene: (data) => {
      const w = data.length ? data : HUF_SAMPLE
      const table = huffmanCodes(buildHuffman(w)).sort((x, y) => x.ch.localeCompare(y.ch))
      return {
        boards: [
          hufCodeTable(table, new Set<string>(), '还没开始', -1, {
            note: '左子树 = 0，右子树 = 1；每个字符的编码都是走到它的叶子的那一条路',
          }),
        ],
      }
    },
    createRunner: runHuffmanCode,
  },
  {
    id: 'uf-find',
    name: '并查集·Find（查找根 + 路径压缩）',
    category: 'tree',
    group: '并查集',
    summary: '顺着双亲一路走到根，走完把路上所有结点直接挂到根上',
    complexity: { time: 'O(α(n))，均摊接近 O(1)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: CODE_UF_FIND,
    defaultData: () => UF_DEFAULT.slice(),
    // 元素个数 = 数据规模 n：5..9 都能摆（初始分组由 ufInit 按 n 生成）
    sizes: [...UF_SIZES],
    prepareData,
    initComment: (data) => {
      const n = ufSize(data)
      const { parent } = ufInit(n)
      return `双亲表示法：parent[i] = i 的是根，其余结点用向上的虚线指着自己的双亲。数据规模 n = ${n}，初始分成 ${ufGroupCount(parent)} 个集合：${ufGroups(parent)}，结点下方小字是秩`
    },
    initTree: (data) => {
      const n = ufSize(data)
      const { parent, rank } = ufInit(n)
      return ufView(parent, rank, {
        note: `parent = [${parent.join(', ')}]，一共 ${n} 个元素、${ufGroupCount(parent)} 个集合；向上虚线就是双亲指针，指向自己的结点是根`,
      })
    },
    createRunner: runUfFind,
  },
  {
    id: 'uf-union',
    name: '并查集·Union（合并集合）',
    category: 'tree',
    group: '并查集',
    summary: '先各自 Find 到根，再按秩合并：把矮的树挂到高的树下',
    complexity: { time: 'O(α(n))，均摊接近 O(1)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: CODE_UF_UNION,
    defaultData: () => UF_DEFAULT.slice(),
    // 同 uf-find：元素个数 = 数据规模，初始分组按 n 生成
    sizes: [...UF_SIZES],
    prepareData,
    initComment: (data) => {
      const n = ufSize(data)
      const { parent } = ufInit(n)
      return `双亲表示法 + 秩（结点下方小字）。数据规模 n = ${n}，初始分成 ${ufGroupCount(parent)} 个集合：${ufGroups(parent)}。合并前先各自 Find 到根，再按秩合并：秩小的根挂到秩大的根下面`
    },
    initTree: (data) => {
      const n = ufSize(data)
      const { parent, rank } = ufInit(n)
      return ufView(parent, rank, {
        note: `parent = [${parent.join(', ')}]，一共 ${n} 个元素、${ufGroupCount(parent)} 个集合，结点下方小字是秩`,
      })
    },
    createRunner: runUfUnion,
  },
]

/**
 * 建堆 / 堆调整（`renderer: 'scene'`）。
 *
 * 它们的**大类是「排序」**：这两个演示就是堆排序的前两步（先自下而上建大根堆、
 * 再单独看一次向下调整），所以和「堆排序」同属排序大类的「选择类排序」组。
 * 注册由 `algorithms/index.ts` 负责，且必须紧挨着堆排序 —— 选择器只合并
 * **相邻**的同名子类，插到别处就会在界面上多出一个同名标题。
 */
export const heapSpecs: AlgorithmSpec[] = [
  {
    id: 'heap-build',
    name: '建堆（自下而上）',
    category: 'sort',
    group: '选择类排序',
    summary: '从最后一个非叶结点 n/2-1 往前，逐个向下调整，O(n) 建堆',
    complexity: { time: 'O(n)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: CODE_HEAP_BUILD,
    defaultData: () => [4, 10, 3, 5, 1, 2, 9, 7, 8],
    // 数组长度 = 数据规模：选几个数据就画几个"结点"（数组格子就是堆的结点）
    sizes: TREE_SIZES,
    initComment: (data) => {
      const a = heapFrames(data)
      return `初始数组 [${a.join(', ')}]（下标 0 开始，一共 ${a.length} 个结点）。要把它整理成**大根堆**：每个结点都不小于它的两个孩子`
    },
    initScene: (data) => {
      const a = heapFrames(data)
      return {
        boards: [
          {
            title: '初始数组（还不是堆）',
            layout: 'row',
            items: a.map((v, i) => ({ text: String(v), sub: String(i), tone: 'base' as const })),
            note: `${HEAP_FORMULA}　n = ${a.length}，最后一个非叶结点下标是 n/2-1 = ${Math.floor(a.length / 2) - 1}`,
          },
        ],
      }
    },
    createRunner: runHeapBuild,
  },
  {
    id: 'heap-sift',
    name: '堆调整（向下调整 / 筛选）',
    category: 'sort',
    group: '选择类排序',
    summary: '和**较大的**那个孩子比较，不满足大根堆就交换，然后继续往下',
    complexity: { time: 'O(log n)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: CODE_HEAP_SIFT,
    defaultData: () => [1, 9, 8, 6, 5, 7, 4, 3, 2],
    // 数组长度 = 数据规模
    sizes: TREE_SIZES,
    // 不管选多大规模、随机出什么数据，都先摆成"只有根不满足大根堆"的样子，
    // 否则"向下调整 a[0]"的前提不成立，解说词就成了假话
    prepareData: heapSiftReady,
    initComment: (data) => {
      const a = heapFrames(data)
      return `数组 [${a.join(', ')}]（一共 ${a.length} 个结点）里除了根结点 a[0] = ${a[0]}，其余子树都已经是大根堆。现在单独对 a[0] 做一次向下调整`
    },
    initScene: (data) => {
      const a = heapFrames(data)
      return {
        boards: [
          {
            title: '准备向下调整 a[0]',
            layout: 'row',
            items: a.map((v, i) => ({
              text: String(v),
              sub: String(i),
              tone: i === 0 ? ('hot' as const) : ('base' as const),
            })),
            pointers: { i: 0 },
            note: `${HEAP_FORMULA}　大根堆：父结点 >= 两个孩子`,
          },
        ],
      }
    },
    createRunner: runHeapSift,
  },
]
