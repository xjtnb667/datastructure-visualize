import type {
  AlgorithmSpec,
  AlgoRunner,
  BoardView,
  CellItem,
  TreeView,
  TreeNodeSnapshot,
} from '@/core/types'

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

/** 堆 / 并查集的默认数组规模 */
const HEAP_N = 9
const UF_N = 8

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

/**
 * 哈夫曼树的树形快照。
 * 二叉树用 left / right（渲染器按中序布局，"只有左孩子"就一定在父结点左边）；
 * 森林（构造过程）用 roots 把每一棵都列出来，根结点不再画向上的虚线。
 */
function hufView(
  tree: HufTree,
  forest: string[],
  opts: { hot?: string[]; done?: string[]; pointers?: Record<string, string | null>; note?: string } = {},
): TreeView {
  const nodes: TreeNodeSnapshot[] = tree.nodes.map((n) => ({
    id: n.id,
    value: n.w,
    left: n.left ?? null,
    right: n.right ?? null,
    sub: n.ch ?? '—',
  }))
  return {
    nodes,
    roots: forest.length ? [...forest] : tree.root ? [tree.root] : [],
    hot: opts.hot ?? [],
    done: opts.done ?? [],
    pointers: opts.pointers ?? {},
    links: forest
      .filter((r) => tree.nodes.find((n) => n.id === r)?.ch !== undefined)
      .map((r) => ({ from: r, to: r, kind: 'parent' as const })),
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
  const weights = data.length ? data : [5, 29, 7, 8, 14, 23, 3, 11]
  const tree = buildHuffman(weights)
  let forest = weights.map((_, i) => `n${i}`)
  let next = weights.length
  const doneLeaves: string[] = []

  yield {
    line: 3,
    action: 'init',
    array: forestWeights(tree, forest),
    tree: hufView(tree, forest, {
      note: `森林里有 ${forest.length} 棵单结点树：${forestText(tree, forest)}（权值 = 字符出现次数）`,
    }),
    comment: `① 先把每个权值变成一棵只有根结点的树，森林里一共 ${forest.length} 棵树：${forestText(tree, forest)}`,
    vars: { n: weights.length, 森林: forest.length },
  }

  for (let k = 1; k < weights.length; k++) {
    const sorted = [...forest].sort((a, b) => {
      const wa = tree.nodes[Number(a.slice(1))]!.w
      const wb = tree.nodes[Number(b.slice(1))]!.w
      return wa !== wb ? wa - wb : a.localeCompare(b)
    })
    const a = sorted[0]!
    const b = sorted[1]!
    const wa = tree.nodes[Number(a.slice(1))]!.w
    const wb = tree.nodes[Number(b.slice(1))]!.w

    yield {
      line: 5,
      action: 'compare',
      array: forestWeights(tree, forest),
      tree: hufView(tree, forest, {
        hot: [a, b],
        pointers: { a: a, b: b },
        note: `本轮挑出权值最小的两棵：${wa} 和 ${wb}`,
      }),
      comment: `③ 从森林的 ${forest.length} 棵树里挑出权值最小的两棵：${wa} 与 ${wb}（最小的 ${Math.min(wa, wb)} 一定能选上）`,
      vars: { a: wa, b: wb, 森林: forest.length },
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
      comment: `④ 造一个新根，权值 = ${wa} + ${wb} = ${wa + wb}`,
      vars: { a: wa, b: wb, 新根: wa + wb },
    }

    const id = `n${next++}`
    forest = forest.filter((x) => x !== a && x !== b)
    forest.push(id)

    yield {
      line: 8,
      action: 'swap',
      array: forestWeights(tree, forest),
      tree: hufView(tree, forest, {
        hot: [id],
        pointers: { 新根: id },
        note: `新根 ${wa + wb} 的左孩子是 ${wa}，右孩子是 ${wb}`,
      }),
      comment: `⑤ 把 ${wa} 挂到左孩子、${wb} 挂到右孩子；合成后森林还剩 ${forest.length} 棵树：${forestText(tree, forest)}`,
      vars: { 森林: forest.length, 新根: wa + wb },
    }
  }

  const total = tree.nodes[Number(tree.root!.slice(1))]!.w
  doneLeaves.push(...weights.map((_, i) => `n${i}`))
  yield {
    line: 11,
    action: 'done',
    array: [total],
    tree: hufView(tree, tree.root ? [tree.root] : [], {
      done: doneLeaves,
      note: `哈夫曼树建成，根结点权值 = ${total} = 所有叶子权值之和`,
    }),
    comment: `⑦ 合并了 ${weights.length - 1} 次后森林里只剩一棵树，这就是哈夫曼树：根权值 ${total}，带权路径长度 WPL = ${total * 1}`,
    vars: { 合并次数: weights.length - 1, 树根权值: total },
  }
}

function* runHuffmanCode(data: number[]): AlgoRunner {
  const weights = data.length ? data : [5, 29, 7, 8, 14, 23, 3, 11]
  const tree = buildHuffman(weights)
  const table = huffmanCodes(tree).sort((x, y) => x.ch.localeCompare(y.ch))
  const byId = new Map(tree.nodes.map((n) => [n.id, n]))
  /** 已经访问完的叶子字符 */
  const doneCh = new Set<string>()
  /** 走过的边：'父id>子id' */
  const used = new Set<string>()

  const rowOf = (ch: string): number => table.findIndex((e) => e.ch === ch)

  const board = (
    step: string,
    hotRow: number,
    opts: { codeText?: string; note: string; activeCell?: number },
  ): BoardView => {
    const items: CellItem[] = []
    // 第一行是表头（tone 用 dim，和哈夫曼树的结论行区分开）
    for (const h of ['字符', '权值', '编码']) items.push({ text: h, tone: 'dim' })
    for (let r = 0; r < table.length; r++) {
      const e = table[r]!
      const isHot = r === hotRow
      const finished = doneCh.has(e.ch)
      const code = isHot && opts.codeText !== undefined ? opts.codeText : finished ? e.code : ''
      items.push({
        text: e.ch,
        sub: String(e.w),
        tone: finished ? 'done' : isHot ? 'hot' : 'base',
      })
      items.push({ text: String(e.w), tone: isHot ? 'hot' : finished ? 'done' : 'dim' })
      items.push({ text: code || '···', tone: isHot ? 'hot' : finished ? 'done' : 'dim' })
    }
    return {
      title: `哈夫曼编码表（${step}）`,
      layout: 'grid',
      cols: 3,
      items,
      pointers: hotRow >= 0 ? { 当前字符: (hotRow + 1) * 3 } : {},
      note: opts.note,
    }
  }

  const treeNow = (hot: string[]): TreeView => ({
    nodes: tree.nodes.map((n) => ({
      id: n.id,
      value: n.w,
      left: n.left ?? null,
      right: n.right ?? null,
      sub: n.ch ?? '—',
    })),
    root: tree.root,
    hot,
    done: tree.nodes.filter((n) => n.ch !== undefined && doneCh.has(n.ch)).map((n) => n.id),
    note: '从根往下走：左孩子 = 0，右孩子 = 1',
  })

  yield {
    line: 1,
    action: 'init',
    array: weights.slice(),
    boards: [board('准备', -1, { note: '还没有字符编好码' })],
    comment: `哈夫曼树已经建好（根权值 ${byId.get(tree.root!)!.w}）。现在从根往下走给每个字符编码：向左记 0、向右记 1`,
    vars: { 字符数: table.length },
  }

  for (const leaf of tree.nodes.filter((n) => n.ch !== undefined)) {
    const ch = leaf.ch!
    const w = leaf.w
    const path: Array<{ id: string; side: 'left' | 'right' }> = []
    let cur: HufNode | undefined = tree.root ? byId.get(tree.root) : undefined
    let code = ''

    yield {
      line: 3,
      action: 'mark',
      array: weights.slice(),
      boards: [board(`开始 ${ch}`, rowOf(ch), { codeText: '', note: `当前要编码的字符 ${ch}，权值 ${w}` })],
      comment: `① 从哈夫曼树的根结点出发，准备给字符 ${ch} 编码`,
      vars: { 权值: w },
      tree: treeNow(cur ? [cur.id] : []),
    }

    while (cur && cur.ch === undefined) {
      const goLeft = cur.left !== undefined
      const childId = (goLeft ? cur.left : cur.right)!
      const child = byId.get(childId)!
      const side = goLeft ? 'left' : 'right'
      path.push({ id: childId, side })
      used.add(`${cur.id}>${childId}`)

      yield {
        line: goLeft ? 8 : 10,
        action: 'compare',
        array: weights.slice(),
        boards: [
          board(`走 ${ch}`, rowOf(ch), {
            codeText: code,
            note: `从 ${cur.w} 走${goLeft ? '左' : '右'}分支到 ${child.w}，这一位记 ${goLeft ? '0' : '1'}`,
          }),
        ],
        comment: `${goLeft ? '③' : '④'} 在结点 ${cur.w} 处走${goLeft ? '左' : '右'}分支（到 ${child.w}），编码多一位 ${goLeft ? '0' : '1'}，当前是 ${code}${goLeft ? '0' : '1'}`,
        vars: { 权值: w },
        tree: treeNow([cur.id, childId]),
      }
      code += goLeft ? '0' : '1'
      cur = child
    }

    doneCh.add(ch)
    const rowIdx = rowOf(ch)
    yield {
      line: 5,
      action: 'done',
      array: weights.slice(),
      boards: [
        board(`完成 ${ch}`, rowIdx, {
          codeText: code,
          note: `字符 ${ch}（权值 ${w}）的编码 = ${code}，共 ${code.length} 位`,
        }),
      ],
      comment: `② 走到叶子结点 ${ch}（权值 ${w}），这一路记下的 01 串就是它的编码：${ch} -> ${code}（${code.length} 位）`,
      vars: { 权值: w, 码长: code.length },
      tree: treeNow(cur ? [cur.id] : []),
    }
  }

  const totalBits = table.reduce((s, e) => s + e.w * e.code.length, 0)
  yield {
    line: 12,
    action: 'done',
    array: weights.slice(),
    boards: [
      board('完成', -1, {
        note: `编码表建好了，带权路径长度 WPL = ${totalBits} 位`,
      }),
    ],
    comment: `两个字符的编码不会互为前缀（前缀码），所以解码时不会认错；整篇正文一共 ${totalBits} 位，WPL = ${totalBits}`,
    vars: { 总位数: totalBits },
    tree: treeNow([]),
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

function heapFrames(data: number[]): number[] {
  const a = data.slice(0, HEAP_N)
  for (let i = 0; i < HEAP_N; i++) if (a[i] === undefined) a[i] = 0
  return a
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

/**
 * 演示用的初始并查集，三个集合：
 *   {0,1,2} 根 = 2，树高 3（0 -> 1 -> 2）
 *   {3,4}   根 = 4，树高 2（3 -> 4）
 *   {5,6,7} 根 = 7，树高 2（5 -> 7，6 -> 7）
 * Find 演示查 0（0 -> 1 -> 2 这条路正好能看出路径压缩的价值），
 * Union 演示把 {3,4} 合并进 {5,6,7}（秩 0 的小树挂到秩 2 的大树下）。
 */
function ufInit(): { parent: number[]; rank: number[] } {
  const parent = [1, 2, 2, 4, 4, 7, 7, 7]
  const rank = [0, 1, 2, 0, 0, 0, 1, 2]
  return { parent, rank }
}

/** 顺着 parent 找到根 */
function ufRoot(parent: number[], x: number): number {
  let r = x
  while (parent[r] !== r) r = parent[r]!
  return r
}

function* runUfFind(data: number[]): AlgoRunner {
  const n = data.length > 1 ? data.length : UF_N
  const init = ufInit()
  const parent = init.parent.slice(0, n)
  const rank = init.rank.slice(0, n)
  // 让前 n 个元素里的根仍然指向自己（截断后可能指向不存在的下标）
  for (let i = 0; i < n; i++) if (parent[i]! >= n) parent[i] = i
  // 查 0 号元素：它向上要经过 0 -> 1 -> 2，路径够长，最能看出路径压缩的价值
  const x = 0
  /** find 走一遍，路上经过的结点记下来（含根） */
  const seen: number[] = []

  yield {
    line: 2,
    action: 'init',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      pointers: { x: `u${x}` },
      note: `parent 数组 = [${parent.join(', ')}]，现在有这些集合：${ufGroups(parent)}`,
    }),
    comment: `① 双亲表示法：parent[i] 就是 i 的双亲，向上的虚线就是这条双亲指针，自己指向自己的结点是根。parent = [${parent.join(', ')}]，当前分组 ${ufGroups(parent)}。现在要查元素 ${x} 属于哪个集合`,
    vars: { x, parent: parent[x] },
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
          ? `走到 parent[${r}] = ${r}：${r} 就是根，元素 ${x} 属于根为 ${r} 的集合`
          : `② parent[${r}] = ${p}，而 ${r} 自己不是根，所以指针往上跳到双亲 ${p}`,
      vars: { x, 当前: r, 双亲: p },
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
      note: `查找路径：${[...seen].reverse().join(' -> ')}，根是 ${r}`,
    }),
    comment: `⑤ 查找结束：元素 ${x} 的根是 ${r}，这条路一共走了 ${seen.length - 1} 步：${seen.map((i) => i).join(' -> ')}`,
    vars: { x, 根: r, 路径长度: seen.length - 1 },
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
      comment: `④ 路径压缩：把路上经过的 ${i} 直接挂到根 ${r} 下面，parent[${i}] 由 ${old} 改成 ${r}（下次再查 ${i} 就一步到根）`,
      vars: { 压缩结点: i, 根: r },
    }
  }

  yield {
    line: 9,
    action: 'mark',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${r}`],
      pointers: { 根: `u${r}` },
      note: `压缩后 parent = [${parent.join(', ')}]`,
    }),
    comment: `⑤ 返回根 r = ${r}。压缩后 parent = [${parent.join(', ')}]，${compressed.length ? `刚被压缩的结点 ${compressed.join('、')} 现在都直接指着根` : '路上结点的双亲本来就是根'}，树变矮了`,
    vars: { x, 根: r, 压缩结点数: compressed.length },
  }

  // 再查一次，走的是压缩后的近路
  const before = seen.length - 1
  let after = 0
  for (let i = x; parent[i] !== i; i = parent[i]!) after++
  yield {
    line: 2,
    action: 'mark',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      hot: [`u${x}`],
      pointers: { x: `u${x}`, 根: `u${r}` },
      note: `再查一次 ${x}：现在只要 ${after} 步就到根`,
    }),
    comment: `① 压缩完再查一次元素 ${x}：这次只要 ${after} 步就到根 ${r}，压缩前要 ${before} 步 —— 这就是路径压缩的价值，以后再查都是近似 O(1)`,
    vars: { x, 压缩后步数: after, 压缩前步数: before },
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
    comment: `查找结束，返回根 ${r}。最终 parent = [${parent.join(', ')}]，分组是 ${ufGroups(parent)}；树变矮以后，以后所有 Find 都快了`,
    vars: { x, 根: r, 集合大小: doneUf.length },
  }
}

function* runUfUnion(data: number[]): AlgoRunner {
  const n = data.length > 1 ? data.length : UF_N
  const init = ufInit()
  const parent = init.parent.slice(0, n)
  const rank = init.rank.slice(0, n)
  for (let i = 0; i < n; i++) if (parent[i]! >= n) parent[i] = i

  const x = n - 1
  // 第二个参数挑 4：它所在的树又小又矮（{3,4}，秩 0），挂到大树下面刚好演示"小树挂大树"
  const y = Math.min(n - 4, 4)
  const rx = ufRoot(parent, x)
  const ry = ufRoot(parent, y)
  const high = rank[rx]! >= rank[ry]! ? rx : ry
  const low = high === rx ? ry : rx
  const same = rx === ry

  yield {
    line: 2,
    action: 'init',
    array: parent.slice(),
    tree: ufView(parent, rank, {
      pointers: { x: `u${x}`, y: `u${y}` },
      note: `parent = [${parent.join(', ')}]；秩写在结点下面的小字里，当前分组 ${ufGroups(parent)}`,
    }),
    comment: `要从元素 ${x}（根 ${rx}）和元素 ${y}（根 ${ry}）开始合并。parent = [${parent.join(', ')}]，结点下方小字是秩（树高的上界）：${ufGroups(parent)}`,
    vars: { x, y, rx, ry },
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
    comment: `① 先 find(${x})：从 ${x} 顺着双亲往上走，得到它所在集合的根 rx = ${rx}（秩 ${rank[rx]}）`,
    vars: { x, rx, 秩: rank[rx]! },
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
    comment: `① 再 find(${y})：从 ${y} 顺着双亲往上走，得到根 ry = ${ry}（秩 ${rank[ry]}）`,
    vars: { y, ry, 秩: rank[ry]! },
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
      vars: { rx, ry },
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
    vars: { rx, ry, 秩x: rank[rx]!, 秩y: rank[ry]! },
  }

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
      ? `④ 两个根的秩都是 ${rank[high]! - 1}（一样高），随便挑一个当新根：parent[${low}] = ${high}，并完新根秩加 1 变成 ${rank[high]}`
      : `④ 秩 ${rank[low]!} < 秩 ${rank[high]!}，所以把小的那棵的根 ${low} 挂到 ${high} 下面：parent[${low}] = ${high}，${high} 的秩不变（还是 ${rank[high]}），原来 ${low} 那棵树的结点现在都在 ${high} 底下`,
    vars: { 被合并的根: low, 新根: high },
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
    comment: `合并完成：parent = [${parent.join(', ')}]，分组变成 ${ufGroups(parent)}。按秩合并保证树高不超过 O(log n)，再配上路径压缩，Find / Union 的均摊时间接近 O(1)`,
    vars: { 新根: high, 新根秩: rank[high]! },
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
    defaultData: () => [5, 29, 7, 8, 14, 23, 3, 11],
    initComment: (data) =>
      `初始权值（对应字符 A~H）：[${data.join(', ')}]。每个权值先各成一棵单结点树，下面开始反复合并`,
    initTree: (data) => {
      const w = data.length ? data : [5, 29, 7, 8, 14, 23, 3, 11]
      const tree = buildHuffman(w)
      const forest = w.map((_, i) => `n${i}`)
      return hufView(tree, forest, {
        note: `森林里有 ${w.length} 棵单结点树，每棵的权值就是对应字符的出现次数`,
      })
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
    renderer: 'scene',
    codeLines: CODE_HUF_CODE,
    defaultData: () => [5, 29, 7, 8, 14, 23, 3, 11],
    initComment: (data) =>
      `权值 [${data.join(', ')}] 已建成哈夫曼树，现在从根往下给每个字符编码：向左记 0、向右记 1`,
    initScene: (data) => {
      const w = data.length ? data : [5, 29, 7, 8, 14, 23, 3, 11]
      const table = huffmanCodes(buildHuffman(w)).sort((x, y) => x.ch.localeCompare(y.ch))
      const items: CellItem[] = []
      for (const h of ['字符', '权值', '编码']) items.push({ text: h, tone: 'dim' })
      for (const e of table) {
        items.push({ text: e.ch, sub: String(e.w), tone: 'base' })
        items.push({ text: String(e.w), tone: 'dim' })
        items.push({ text: '···', tone: 'dim' })
      }
      return {
        boards: [
          {
            title: '哈夫曼编码表（还没开始）',
            layout: 'grid',
            cols: 3,
            items,
            note: '左子树 = 0，右子树 = 1；每个字符的编码都是走到它的叶子的那一条路',
          },
        ],
      }
    },
    createRunner: runHuffmanCode,
  },
  {
    id: 'heap-build',
    name: '建堆（自下而上）',
    category: 'tree',
    group: '堆',
    summary: '从最后一个非叶结点 n/2-1 往前，逐个向下调整，O(n) 建堆',
    complexity: { time: 'O(n)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: CODE_HEAP_BUILD,
    defaultData: () => [4, 10, 3, 5, 1, 2, 9, 7, 8],
    initComment: (data) =>
      `初始数组 [${data.slice(0, HEAP_N).join(', ')}]（下标 0 开始）。要把它整理成**大根堆**：每个结点都不小于它的两个孩子`,
    initScene: (data) => {
      const a = heapFrames(data)
      return {
        boards: [
          {
            title: '初始数组（还不是堆）',
            layout: 'row',
            items: a.map((v, i) => ({ text: String(v), sub: String(i), tone: 'base' as const })),
            note: `${HEAP_FORMULA}　n = ${HEAP_N}，最后一个非叶结点下标是 n/2-1 = ${Math.floor(HEAP_N / 2) - 1}`,
          },
        ],
      }
    },
    createRunner: runHeapBuild,
  },
  {
    id: 'heap-sift',
    name: '堆调整（向下调整 / 筛选）',
    category: 'tree',
    group: '堆',
    summary: '和**较大的**那个孩子比较，不满足大根堆就交换，然后继续往下',
    complexity: { time: 'O(log n)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: CODE_HEAP_SIFT,
    defaultData: () => [1, 9, 8, 6, 5, 7, 4, 3, 2],
    initComment: (data) =>
      `数组 [${data.slice(0, HEAP_N).join(', ')}] 里除了根结点 a[0] = ${data[0]}，其余子树都已经是大根堆。现在单独对 a[0] 做一次向下调整`,
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
  {
    id: 'uf-find',
    name: '并查集·Find（查找根 + 路径压缩）',
    category: 'tree',
    group: '并查集',
    summary: '顺着双亲一路走到根，走完把路上所有结点直接挂到根上',
    complexity: { time: 'O(α(n))，均摊接近 O(1)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: CODE_UF_FIND,
    defaultData: () => [0, 1, 2, 3, 4, 5, 6, 7],
    initComment: () =>
      '双亲表示法：parent[i] = i 的是根，其余结点用向上的虚线指着自己的双亲。初始分组是 {0,1,2}、{3,4}、{5,6,7}',
    initTree: (data) => {
      const n = data.length > 1 ? data.length : UF_N
      const init = ufInit()
      const parent = init.parent.slice(0, n)
      const rank = init.rank.slice(0, n)
      for (let i = 0; i < n; i++) if (parent[i]! >= n) parent[i] = i
      return ufView(parent, rank, {
        note: `parent = [${parent.join(', ')}]，向上虚线就是双亲指针，指向自己的结点是根`,
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
    defaultData: () => [0, 1, 2, 3, 4, 5, 6, 7],
    initComment: () =>
      '双亲表示法 + 秩（结点下方小字）。合并前先各自 Find 到根，再按秩合并：秩小的根挂到秩大的根下面',
    initTree: (data) => {
      const n = data.length > 1 ? data.length : UF_N
      const init = ufInit()
      const parent = init.parent.slice(0, n)
      const rank = init.rank.slice(0, n)
      for (let i = 0; i < n; i++) if (parent[i]! >= n) parent[i] = i
      return ufView(parent, rank, {
        note: `parent = [${parent.join(', ')}]，结点下方小字是秩`,
      })
    },
    createRunner: runUfUnion,
  },
]
