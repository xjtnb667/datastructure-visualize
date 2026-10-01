import type {
  AlgorithmSpec,
  AlgoEvent,
  AlgoRunner,
  RunnerContext,
  StepAction,
  TreeNodeSnapshot,
  TreeView,
} from '@/core/types'
import { nodeId, TREE_SIZES } from './treeTraverse'

/**
 * 树与二叉树 —— 二叉排序树（BST）与平衡二叉树（AVL）。
 *
 * 数据约定
 * --------
 * 一维数字串在这里代表"树上所有结点的关键字"：
 *   1. 先去重、升序排好 —— 重复的值往后挪一点，保证**一个数据一个结点**，
 *      所以"数据规模 = 树上的结点数"（选 12 个数据就是 12 个结点）；
 *   2. 再按**对半取中**的顺序插入，建成一棵左右均匀的二叉排序树；
 *   3. 于是树的中序序列**恰好就等于这串关键字**（BST 的中序天然升序），
 *      所以每一步的 array 都取"当前树的中序序列"，底部数据栏始终有意义。
 * 演示用的插入值 / 查找目标都不是写死的常量，而是**从数据里推出来的**
 * （插入取"插进去路径最绕"的那个关键字，查找失败取两个相邻关键字中间的空位），
 * 所以点「随机数据」也能演出同样的效果。
 *
 * 快照约定
 * --------
 *   - 二叉树只填 left / right，另外补上 parent；
 *   - BST 的结点不显示小字；AVL 的结点把**平衡因子**显示在 sub 里（bf=+2 / bf=0 / bf=-1）；
 *   - hot 的配色由 action 决定：compare = 橙（正在比较）、
 *     set = 红（正在搬动 / 将被删除 / 失衡点）、mark = 紫（正在访问，旋转时标参与旋转的结点）、
 *     done = 绿（已就位）；
 *   - 命名指针沿用课堂上的老名字：p = 当前结点，pre = 它的父结点，s = 中序后继。
 */

// ===========================================================================
// 一、二叉树的内部表示
// ===========================================================================

interface TNode {
  id: string
  /** 关键字 */
  v: number
  left: number | null
  right: number | null
}

/**
 * 一棵二叉排序树。结点放在 Map 里，**key 就是"分配顺序"**，
 * 同时也就是 id 里的编号 —— id 一旦给出就不再变化，动画和指针才能稳定地跟着结点走。
 */
interface Bst {
  nodes: Map<number, TNode>
  root: number | null
  /** 已分配过的结点数，只增不减（删掉的结点也不复用编号） */
  seq: number
}

export function makeBst(): Bst {
  return { nodes: new Map(), root: null, seq: 0 }
}

/** 造一个新结点（还没接到树上），返回它的编号 */
export function addNode(t: Bst, v: number): number {
  const i = t.seq++
  t.nodes.set(i, { id: nodeId(i), v, left: null, right: null })
  return i
}

interface SearchResult {
  /** 依次比较过的结点（不含最后的空位） */
  path: number[]
  /** 命中的结点；没找到就是 null */
  found: number | null
  /** 落点空位的父结点 */
  parent: number | null
  /** 落点方向 */
  side: 'left' | 'right' | null
}

/** BST 查找：一路记下比较过的结点、落点的父结点和方向 */
function searchKey(t: Bst, key: number): SearchResult {
  const path: number[] = []
  let cur = t.root
  let parent: number | null = null
  let side: 'left' | 'right' | null = null
  while (cur !== null) {
    const n = t.nodes.get(cur)!
    path.push(cur)
    if (key === n.v) return { path, found: cur, parent, side }
    parent = cur
    if (key < n.v) {
      side = 'left'
      cur = n.left
    } else {
      side = 'right'
      cur = n.right
    }
  }
  return { path, found: null, parent, side }
}

/** 普通 BST 插入（不旋转）：重复的关键字直接返回原结点 */
function insertNode(t: Bst, key: number): number {
  const r = searchKey(t, key)
  if (r.found !== null) return r.found
  const i = addNode(t, key)
  if (r.parent === null) t.root = i
  else {
    const p = t.nodes.get(r.parent)!
    if (r.side === 'left') p.left = i
    else p.right = i
  }
  return i
}

export function treeHas(t: Bst, key: number): boolean {
  return searchKey(t, key).found !== null
}

/**
 * 升序去重的一串值 -> 完全平衡的 BST（"对半取中"先插根，再递归插左右半边）。
 * 这样建出来的树中序序列就是这串值本身，而且层数最少，画出来最好看。
 */
export function balancedBst(values: number[]): Bst {
  const t = makeBst()
  const put = (lo: number, hi: number): void => {
    if (lo > hi) return
    const mid = (lo + hi) >> 1
    insertNode(t, values[mid]!)
    put(lo, mid - 1)
    put(mid + 1, hi)
  }
  put(0, values.length - 1)
  return t
}

function parentOf(t: Bst, i: number): number | null {
  for (const [k, n] of t.nodes) {
    if (n.left === i || n.right === i) return k
  }
  return null
}

function childCount(t: Bst, i: number): number {
  const n = t.nodes.get(i)!
  return (n.left === null ? 0 : 1) + (n.right === null ? 0 : 1)
}

/** 只有一个孩子时返回那个孩子，否则 null */
function onlyChild(t: Bst, i: number): number | null {
  const n = t.nodes.get(i)!
  return n.left ?? n.right ?? null
}

/** 中序后继：右子树里最靠左（最小）的那个结点 */
function successorOf(t: Bst, i: number): number | null {
  const n = t.nodes.get(i)!
  const start = n.right
  if (start === null) return null
  let cur: number = start
  for (;;) {
    const next = t.nodes.get(cur)!.left
    if (next === null) break
    cur = next
  }
  return cur
}

function heightOf(t: Bst, i: number | null): number {
  if (i === null) return 0
  const n = t.nodes.get(i)
  if (!n) return 0
  return 1 + Math.max(heightOf(t, n.left), heightOf(t, n.right))
}

/** 平衡因子 = 左子树高 − 右子树高 */
function bfOf(t: Bst, i: number): number {
  const n = t.nodes.get(i)!
  return heightOf(t, n.left) - heightOf(t, n.right)
}

function inorderIds(t: Bst): number[] {
  const out: number[] = []
  const walk = (i: number | null): void => {
    if (i === null) return
    const n = t.nodes.get(i)
    if (!n) return
    walk(n.left)
    out.push(i)
    walk(n.right)
  }
  walk(t.root)
  return out
}

/** 当前树的中序关键字序列 —— 每一步的 array 都用它（BST 里正好是升序） */
function inorderValues(t: Bst): number[] {
  return inorderIds(t).map((i) => t.nodes.get(i)!.v)
}

function cloneBst(t: Bst): Bst {
  const out: Bst = { nodes: new Map(), root: t.root, seq: t.seq }
  for (const [k, n] of t.nodes) out.nodes.set(k, { ...n })
  return out
}

/** 把结点摘下来：0/1 个孩子用孩子顶替，2 个孩子用中序后继顶替（预演用，不改动真正的树） */
function unlink(t: Bst, i: number): void {
  if (childCount(t, i) === 2) {
    const s = successorOf(t, i)!
    t.nodes.get(i)!.v = t.nodes.get(s)!.v
    unlink(t, s) // 后继一定没有左孩子，递归下去只会走 0/1 个孩子的分支
    return
  }
  const p = parentOf(t, i)
  const child = onlyChild(t, i)
  if (p === null) t.root = child
  else {
    const pn = t.nodes.get(p)!
    if (pn.left === i) pn.left = child
    else pn.right = child
  }
  t.nodes.delete(i)
}

/** 以 i 为轴右旋：左孩子上升接替它的位置（LL 型用） */
function rotateRight(t: Bst, i: number): void {
  const n = t.nodes.get(i)!
  const l = n.left!
  const ln = t.nodes.get(l)!
  const p = parentOf(t, i)
  n.left = ln.right
  ln.right = i
  if (p === null) t.root = l
  else {
    const pn = t.nodes.get(p)!
    if (pn.left === i) pn.left = l
    else pn.right = l
  }
}

/** 以 i 为轴左旋：右孩子上升接替它的位置（RR 型用） */
function rotateLeft(t: Bst, i: number): void {
  const n = t.nodes.get(i)!
  const r = n.right!
  const rn = t.nodes.get(r)!
  const p = parentOf(t, i)
  n.right = rn.left
  rn.left = i
  if (p === null) t.root = r
  else {
    const pn = t.nodes.get(p)!
    if (pn.left === i) pn.left = r
    else pn.right = r
  }
}

// ===========================================================================
// 二、快照
// ===========================================================================

interface ViewOpts {
  hot?: number[]
  done?: number[]
  pointers?: Record<string, number | null>
  note?: string
  /** 结点下方的小字（AVL 用它显示平衡因子） */
  sub?: (t: Bst, i: number) => string | undefined
}

/** 把内部的 BST 转成渲染器要的 TreeView（parent 也补上，结构才算完整） */
function treeOf(t: Bst, opts: ViewOpts = {}): TreeView {
  const nodes: TreeNodeSnapshot[] = []
  for (const [i, n] of t.nodes) {
    const p = parentOf(t, i)
    const sub = opts.sub ? opts.sub(t, i) : undefined
    const snap: TreeNodeSnapshot = {
      id: n.id,
      value: n.v,
      left: n.left === null ? null : t.nodes.get(n.left)!.id,
      right: n.right === null ? null : t.nodes.get(n.right)!.id,
      parent: p === null ? null : t.nodes.get(p)!.id,
    }
    if (sub !== undefined) snap.sub = sub
    nodes.push(snap)
  }
  const idOf = (i: number | null | undefined): string | null =>
    i === null || i === undefined ? null : (t.nodes.get(i)?.id ?? null)
  const pointers: Record<string, string | null> = {}
  for (const [name, i] of Object.entries(opts.pointers ?? {})) pointers[name] = idOf(i)
  return {
    nodes,
    root: idOf(t.root),
    hot: (opts.hot ?? []).map((i) => idOf(i)).filter((x): x is string => x !== null),
    done: (opts.done ?? []).map((i) => idOf(i)).filter((x): x is string => x !== null),
    pointers,
    note: opts.note,
  }
}

/** 平衡因子的小字：bf=+2 / bf=0 / bf=-1 */
function bfText(b: number): string {
  return `bf=${b > 0 ? '+' : ''}${b}`
}

// ===========================================================================
// 三、输入数据 -> 值池 / 演示用的关键字
// ===========================================================================

/**
 * 数据 -> 升序去重的"值池"。
 * 不足 need 个时在**高端**补几个数（比最大值大 10、20…），
 * 这只是为了把演示用的树撑到必要的形状，不会影响低端的比较关系。
 */
export function valuePool(data: number[], need: number): number[] {
  const pool = [...new Set(data.filter((v) => Number.isFinite(v)))].sort((a, b) => a - b)
  if (pool.length === 0) pool.push(50)
  let top = pool[pool.length - 1]!
  while (pool.length < need) {
    top += 10
    pool.push(top)
  }
  return pool
}

/**
 * 在值池里挑一个"空位上的数"：取两个相邻关键字的中点。
 * 它一定不在值池里（相邻两个关键字之间没有别的关键字），也就一定不在树上，
 * 正好用来演示"插入"和"查找失败"。near 用来挑离它最近的那个空位（一般传根结点的值，
 * 这样比较路径会左一下右一下，两种走向都演得到）。
 */
export function pickGapKey(pool: number[], near?: number): number {
  let best: number | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i + 1 < pool.length; i++) {
    const a = pool[i]!
    const b = pool[i + 1]!
    if (b - a < 2) continue
    const key = (a + b) >> 1
    const dist = near === undefined ? 0 : Math.abs(key - near)
    if (dist < bestDist) {
      best = key
      bestDist = dist
    }
  }
  return best ?? pool[pool.length - 1]! + 5
}

/** 挑一个"查找路径最长、而且路上左右都拐过"的结点当查找目标（两种走向都能演到） */
export function pickSearchTarget(t: Bst): number {
  let bestId = t.root!
  let bestScore = Number.NEGATIVE_INFINITY
  for (const id of inorderIds(t)) {
    const key = t.nodes.get(id)!.v
    let cur = t.root
    let steps = 0
    let wentLeft = false
    let wentRight = false
    while (cur !== null) {
      steps += 1
      const n = t.nodes.get(cur)!
      if (key === n.v) break
      if (key < n.v) {
        wentLeft = true
        cur = n.left
      } else {
        wentRight = true
        cur = n.right
      }
    }
    const score = (wentLeft && wentRight ? 100 : 0) + steps
    if (score > bestScore) {
      bestScore = score
      bestId = id
    }
  }
  return t.nodes.get(bestId)!.v
}

/**
 * 数据 -> **恰好 data.length 个**互不相同、升序排好的关键字。
 *
 * BST 里不放重复的关键字，去重本来是对的；但去掉一个重复值，画面上就少一个结点，
 * 于是"选了 12 个数据、树里只有 11 个"——数据和画面对不上。
 * 这里改成重复的值往后挪一点（30、30 -> 30、31），保证**一个数据一个结点**。
 */
export function distinctKeys(data: number[]): number[] {
  const out: number[] = []
  for (const v of data.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)) {
    const prev = out[out.length - 1]
    out.push(prev === undefined || v > prev ? v : prev + 1)
  }
  // 空数据给一个兜底值：后面的代码都要从根结点开始走，不能没有结点
  return out.length ? out : [50]
}

/**
 * 演示"插入"时要用的两样东西：先在树上摆好 n-1 个关键字（base），
 * 剩下的那一个（key）才是插进去的 —— 插完树上正好 n 个结点 = 数据规模。
 *
 * key 不是随手取最后一个，而是**挑**出来的：拿它插进 base 以后，
 * 比较路径最长、而且左右都拐过弯，演示效果最好。
 */
function planInsert(keys: number[]): { base: number[]; key: number } {
  if (keys.length <= 1) return { base: [], key: keys[0] ?? 50 }
  let best: { base: number[]; key: number; score: number } | null = null
  for (let k = 0; k < keys.length; k++) {
    const base = keys.filter((_, i) => i !== k)
    const key = keys[k]!
    const t = balancedBst(base)
    let cur = t.root
    let steps = 0
    let left = false
    let right = false
    while (cur !== null) {
      const node = t.nodes.get(cur)!
      steps += 1
      if (key === node.v) break
      if (key < node.v) {
        left = true
        cur = node.left
      } else {
        right = true
        cur = node.right
      }
    }
    const score = steps * 10 + (left && right ? 100 : 0)
    if (!best || score > best.score) best = { base, key, score }
  }
  return { base: best!.base, key: best!.key }
}

// ===========================================================================
// 四、二叉排序树 · 插入
// ===========================================================================

const BST_INSERT_CODE = [
  'bool insert(BiTree &T, int key, BiTree pre) {',
  '  if (T == NULL) {                     // 走到空位：就在这里挂新结点',
  '    T = new BiTNode(key);              // 新结点的左右孩子都是 NULL',
  '    return true;',
  '  }',
  '  if (key == T->data) return false;    // BST 里一般不放重复的关键字',
  '  if (key < T->data) return insert(T->left, key, T);   // 小了往左子树走',
  '  else               return insert(T->right, key, T);  // 大了往右子树走',
  '}',
]

function* runBstInsert(data: number[], ctx: RunnerContext = {}): AlgoRunner {
  const keys = distinctKeys(data)
  // 数据里的 n 个关键字：先在树上摆好 n-1 个，把挑出来的那一个插进去，插完正好 n 个结点
  const { base, key: planned } = planInsert(keys)
  const t = balancedBst(base)
  const rootV = t.root === null ? null : t.nodes.get(t.root)!.v
  /** 要插入的关键字：外部传了就用外部的（但不能是树上已有的），否则用挑出来的那一个 */
  const key =
    ctx.value !== undefined && Number.isFinite(ctx.value) && !treeHas(t, ctx.value) ? ctx.value : planned

  const frame = (
    line: number,
    action: StepAction,
    comment: string,
    vars: Record<string, number>,
    opts: ViewOpts = {},
  ): AlgoEvent => ({
    line,
    action,
    // 数据条一直显示数据里的全部关键字（n 个），不跟着树的增删变长变短
    array: keys.slice(),
    tree: treeOf(t, opts),
    comment,
    vars,
  })

  yield frame(
    1,
    'mark',
    `要在二叉排序树里插入 ${key}：数据里一共 ${keys.length} 个关键字，树上先摆好了 ${t.nodes.size} 个，就差 ${key} 这一个没进去。从根结点 ${rootV} 出发，比它小就往左、比它大就往右`,
    { 插入值: key, 结点数: t.nodes.size },
    {
      hot: t.root === null ? [] : [t.root],
      pointers: { p: t.root, pre: null },
      note: 'p = 当前比到的结点，pre = 它的父结点',
    },
  )

  // ① 一路比大小，直到走到空位
  let cur: number | null = t.root
  let pre: number | null = null
  while (cur !== null) {
    const n = t.nodes.get(cur)!
    const small = key < n.v
    yield frame(
      small ? 7 : 8,
      'compare',
      `${key} ${small ? '<' : '>'} ${n.v}：${small ? '往左孩子' : '往右孩子'}走`,
      { 插入值: key, 比较: n.v },
      { hot: [cur], pointers: { p: cur, pre }, note: `${key} 与 ${n.v} 比较` },
    )
    pre = cur
    cur = small ? n.left : n.right
  }

  // ② 空位上挂新结点（先改结构，再出这一帧）
  const id = addNode(t, key)
  const preV = pre === null ? null : t.nodes.get(pre)!.v
  const sideName = preV === null ? '' : key < preV ? '左' : '右'
  if (pre === null) t.root = id
  else {
    const pn = t.nodes.get(pre)!
    if (key < pn.v) pn.left = id
    else pn.right = id
  }
  yield frame(
    3,
    'set',
    `走到 ${preV === null ? '空树的根' : `${preV} 的${sideName}孩子`}位置是 NULL —— 把新结点 ${key} 挂在这里`,
    { 插入值: key, 结点数: t.nodes.size },
    { hot: [id], pointers: { p: id, pre }, note: '新结点接在 pre 的下面' },
  )
  yield frame(
    4,
    'set',
    `插入成功：中序序列变成 ${inorderValues(t).join(' → ')}（依然升序，说明 BST 的性质没被破坏）`,
    { 插入值: key, 结点数: t.nodes.size },
    { hot: [id], done: [id], note: `${key} 就位` },
  )

  // ③ 对照：再把同一个关键字插一次，演示"重复关键字"的处理
  yield frame(
    6,
    'mark',
    `再做一次对照：还是插 ${key}。BST 里一般不放重复的关键字，看看它是怎么被挡住的`,
    { 插入值: key, 结点数: t.nodes.size },
    { hot: [id], pointers: { p: t.root, pre: null }, note: '重复值不会新建结点' },
  )
  cur = t.root
  pre = null
  while (cur !== null) {
    const n = t.nodes.get(cur)!
    if (key === n.v) {
      yield frame(
        6,
        'compare',
        `${key} == ${n.v}：遇到了相同的关键字，马上停下来 —— 不往左也不往右`,
        { 插入值: key, 比较: n.v },
        { hot: [cur], pointers: { p: cur, pre }, note: '相等：BST 只保留一个这样的关键字' },
      )
      break
    }
    const small = key < n.v
    yield frame(
      small ? 7 : 8,
      'compare',
      `${key} ${small ? '<' : '>'} ${n.v}：${small ? '往左' : '往右'}继续比`,
      { 插入值: key, 比较: n.v },
      { hot: [cur], pointers: { p: cur, pre }, note: `${key} 与 ${n.v} 比较` },
    )
    pre = cur
    cur = small ? n.left : n.right
  }
  yield frame(
    6,
    'done',
    `插入失败：${key} 已经在树里了。关键字重复时不新建结点（否则查找、删除都会分不清删的是哪一个），结点数仍然是 ${t.nodes.size}`,
    { 插入值: key, 结点数: t.nodes.size },
    { hot: [id], done: [id], note: '重复关键字：直接返回失败' },
  )
  yield frame(
    9,
    'done',
    `演示结束：${key} 挂到了正确的位置上，中序序列 ${inorderValues(t).join(' → ')} 仍然是升序 —— 这正是"中序遍历二叉排序树得到有序序列"的由来`,
    { 插入值: key, 结点数: t.nodes.size },
    { done: [...t.nodes.keys()], note: 'BST 的性质：中序有序' },
  )
}

// ===========================================================================
// 五、二叉排序树 · 查找
// ===========================================================================

const BST_SEARCH_CODE = [
  'BiTree search(BiTree T, int key) {',
  '  while (T != NULL) {',
  '    if (key == T->data) return T;       // 命中，返回这个结点',
  '    if (key < T->data) T = T->left;     // 小了：到左子树里找',
  '    else               T = T->right;    // 大了：到右子树里找',
  '  }',
  '  return NULL;                          // 走到空指针，说明树里没有 key',
  '}',
]

function* runBstSearch(data: number[], ctx: RunnerContext = {}): AlgoRunner {
  // 数据里的关键字全都建进树里：n 个数据就是 n 个结点
  const keys = distinctKeys(data)
  const t = balancedBst(keys)
  const rootId = t.root!
  const rootV = t.nodes.get(rootId)!.v
  const hitKey = pickSearchTarget(t)
  const first = ctx.target ?? hitKey
  const firstIn = treeHas(t, first)
  // 第二个目标一定和第一个相反：先命中就再查一个不存在的，先落空就再查一个存在的
  const second = firstIn ? pickGapKey(keys, rootV) : hitKey

  const frame = (
    line: number,
    action: StepAction,
    comment: string,
    vars: Record<string, number>,
    opts: ViewOpts = {},
  ): AlgoEvent => ({
    line,
    action,
    array: inorderValues(t),
    tree: treeOf(t, opts),
    comment,
    vars,
  })

  yield frame(
    1,
    'mark',
    `在这棵二叉排序树（中序序列 ${inorderValues(t).join(' → ')}）里查找。共查两次：先查 ${first}，再查 ${second}`,
    { 结点数: t.nodes.size, 第一次: first, 第二次: second },
    { hot: [rootId], pointers: { p: rootId }, note: '每次查找都从根结点开始' },
  )

  /** 查一个关键字：命中返回 true */
  function* searchOnce(key: number, round: number): Generator<AlgoEvent, boolean, void> {
    yield frame(
      1,
      'mark',
      `第 ${round} 次查找：target = ${key}，从根结点 ${rootV} 开始`,
      { target: key, 比较次数: 0 },
      { hot: [rootId], pointers: { p: rootId }, note: `查找 ${key}` },
    )
    let cur: number | null = t.root
    let pre: number | null = null
    let side: 'left' | 'right' = 'left'
    let compares = 0
    while (cur !== null) {
      const n = t.nodes.get(cur)!
      compares += 1
      if (key === n.v) {
        yield frame(
          3,
          'compare',
          `第 ${compares} 次比较：${key} == ${n.v}，命中！`,
          { target: key, 比较次数: compares },
          { hot: [cur], pointers: { p: cur, pre }, note: '命中：这个结点标绿' },
        )
        yield frame(
          3,
          'done',
          `查找成功：${key} 就在树里。一路只比了 ${compares} 次 —— 每比一次就砍掉一棵子树`,
          { target: key, 比较次数: compares },
          { hot: [cur], done: [cur], note: '绿色 = 命中的结点' },
        )
        return true
      }
      const small = key < n.v
      side = small ? 'left' : 'right'
      yield frame(
        small ? 4 : 5,
        'compare',
        `第 ${compares} 次比较：${key} ${small ? '<' : '>'} ${n.v}，${small ? '到左子树里找' : '到右子树里找'}`,
        { target: key, 比较次数: compares },
        { hot: [cur], pointers: { p: cur, pre }, note: `当前结点的值是 ${n.v}` },
      )
      pre = cur
      cur = small ? n.left : n.right
    }
    const preV = pre === null ? rootV : t.nodes.get(pre)!.v
    yield frame(
      7,
      'done',
      `第 ${compares} 次比较后指针变成了 NULL：${key} ${side === 'left' ? '<' : '>'} ${preV}，而 ${preV} 的${side === 'left' ? '左' : '右'}孩子是空的 —— 查找失败，树里没有 ${key}`,
      { target: key, 比较次数: compares },
      { hot: pre === null ? [] : [pre], pointers: { p: null, pre }, note: '走到空指针 = 没找到' },
    )
    return false
  }

  yield* searchOnce(first, 1)
  yield frame(
    2,
    'mark',
    firstIn
      ? `${first} 找到了。再查一个不存在的关键字做对照：${second} 落在两个相邻关键字中间（或者比最大的还大一点），树里肯定没有`
      : `${first} 不在树里。再查一个存在的关键字做对照：${second}`,
    { target: second },
    { hot: [rootId], pointers: { p: rootId }, note: '两种情况都演一遍' },
  )
  yield* searchOnce(second, 2)

  yield frame(
    8,
    'done',
    `查找结束：存在就在树里命中（${firstIn ? `${first} 命中` : `${second} 命中`}），不存在就会一路走到 NULL。比较次数不会超过树高，平均只要 O(log n) 次`,
    { 结点数: t.nodes.size, 树高: heightOf(t, t.root) },
    { done: [...t.nodes.keys()], note: 'BST 的查找效率取决于树高' },
  )
}

// ===========================================================================
// 六、二叉排序树 · 删除（三种情况都要演到）
// ===========================================================================

const BST_DELETE_CODE = [
  'bool delNode(BiTree &T, int key) {                    // 从 T 出发删除关键字 key',
  '  BiTree p = T, pre = NULL;                           // p 找目标，pre 记它的父结点',
  '  while (p != NULL && p->data != key) { pre = p; p = (key < p->data) ? p->left : p->right; }',
  '  if (p == NULL) return false;                        // 树里没有这个关键字',
  '  if (p->left == NULL) p = p->right;                  // 情况① 叶子 / 情况② 只有右孩子',
  '  else if (p->right == NULL) p = p->left;             // 情况② 只有左孩子',
  '  else {                                              // 情况③ 有两个孩子',
  '    BiTree s = p->right, sp = p;                      // s 去找右子树里最小的结点',
  '    while (s->left != NULL) { sp = s; s = s->left; }  // 一路向左到底 = 中序后继',
  '    p->data = s->data;                                // 后继的值搬进被删结点',
  '    if (sp == p) sp->right = s->right; else sp->left = s->right;   // 再把后继自己摘掉',
  '  }',
  '  return true;',
  '}',
]

const CASE_NAME: Record<1 | 2 | 3, string> = {
  1: '叶子结点',
  2: '只有一个孩子',
  3: '有两个孩子',
}

interface Phase {
  case: 1 | 2 | 3
  id: number
}

/**
 * 依次挑出三个要删的结点，让三种情况**都能演到**：
 * ① 先删一个叶子；② 删完之后"只剩一个孩子"的那个结点；③ 再找一个有两个孩子的结点。
 * 直接在树的小副本上把三个条件验一遍，验得过才用这个顺序。
 */
function planDeletes(t: Bst): Phase[] | null {
  for (const a of t.nodes.keys()) {
    if (childCount(t, a) !== 0) continue
    const t1 = cloneBst(t)
    unlink(t1, a)
    for (const b of t1.nodes.keys()) {
      if (childCount(t1, b) !== 1) continue
      const t2 = cloneBst(t1)
      unlink(t2, b)
      for (const c of t2.nodes.keys()) {
        if (childCount(t2, c) === 2) return [{ case: 1, id: a }, { case: 2, id: b }, { case: 3, id: c }]
      }
    }
  }
  return null
}

/** 兜底：挑不出完整的三步时，能演几种演几种 */
function greedyPhases(t: Bst): Phase[] {
  const out: Phase[] = []
  const cur = cloneBst(t)
  for (const kase of [1, 2, 3] as const) {
    const want = kase === 1 ? 0 : kase === 2 ? 1 : 2
    let picked: number | null = null
    for (const i of cur.nodes.keys()) {
      if (childCount(cur, i) === want) {
        picked = i
        break
      }
    }
    if (picked === null) continue
    out.push({ case: kase, id: picked })
    unlink(cur, picked)
  }
  return out
}

function* runBstDelete(data: number[], _ctx: RunnerContext = {}): AlgoRunner {
  // 数据里的关键字全都建进树里（n 个数据 = n 个结点），再依次挑三个删掉
  const keys = distinctKeys(data)
  const t = balancedBst(keys)
  const phases = planDeletes(t) ?? greedyPhases(t)

  const frame = (
    line: number,
    action: StepAction,
    comment: string,
    vars: Record<string, number>,
    opts: ViewOpts = {},
  ): AlgoEvent => ({
    line,
    action,
    array: inorderValues(t),
    tree: treeOf(t, opts),
    comment,
    vars,
  })

  const intro = phases.map((ph) => `${t.nodes.get(ph.id)!.v}（${CASE_NAME[ph.case]}）`).join('、')
  yield frame(
    1,
    'mark',
    `先建好一棵二叉排序树，中序序列是 ${inorderValues(t).join(' → ')}。BST 的删除分三种情况，下面依次删 ${intro}`,
    { 结点数: t.nodes.size },
    { hot: [t.root!], note: '① 叶子直接摘 ② 一个孩子顶替 ③ 两个孩子用中序后继顶替' },
  )

  for (const ph of phases) {
    const target = ph.id
    const tv = t.nodes.get(target)!.v
    const no = ph.case === 1 ? '①' : ph.case === 2 ? '②' : '③'

    // 删除的第一步永远是"查找"：先按关键字把目标结点找出来
    yield frame(
      3,
      'mark',
      `接下来删 ${tv}（情况${no} ${CASE_NAME[ph.case]}）：先像查找那样从根结点出发把它找出来`,
      { 待删: tv, 结点数: t.nodes.size },
      { hot: [target], pointers: { p: t.root, pre: null }, note: `p 从根开始找 ${tv}` },
    )
    let cur: number | null = t.root
    let pre: number | null = null
    while (cur !== null && cur !== target) {
      const n = t.nodes.get(cur)!
      const small = tv < n.v
      yield frame(
        3,
        'compare',
        `${tv} ${small ? '<' : '>'} ${n.v}：${small ? '往左' : '往右'}孩子找`,
        { 待删: tv },
        { hot: [cur], pointers: { p: cur, pre }, note: `比较 ${tv} 与 ${n.v}` },
      )
      pre = cur
      cur = small ? n.left : n.right
    }

    if (ph.case === 1) {
      // ---------------- 情况①：叶子，直接摘 ----------------
      const p = parentOf(t, target)
      yield frame(
        5,
        'set',
        `${tv} 的左右孩子都是 NULL —— 情况① 叶子结点：把它摘掉就行，不用动别的子树`,
        { 待删: tv, 结点数: t.nodes.size },
        { hot: [target], pointers: { p: target, pre: p }, note: '红色 = 将被删除的结点' },
      )
      if (p === null) t.root = null
      else {
        const pn = t.nodes.get(p)!
        if (pn.left === target) pn.left = null
        else pn.right = null
      }
      t.nodes.delete(target)
      yield frame(
        5,
        'set',
        `删除完成：${p === null ? '树空了' : `把 ${t.nodes.get(p)!.v} 对应的孩子指针置成 NULL`}，中序序列变成 ${inorderValues(t).join(' → ')}`,
        { 结点数: t.nodes.size },
        { hot: p === null ? [] : [p], note: '叶子删掉后，别的结点位置都不用动' },
      )
    } else if (ph.case === 2) {
      // ---------------- 情况②：只有一个孩子，孩子顶替 ----------------
      const p = parentOf(t, target)
      const child = onlyChild(t, target)!
      const cv = t.nodes.get(child)!.v
      yield frame(
        6,
        'set',
        `${tv} 只有一个孩子 ${cv} —— 情况②：让 ${cv} 直接顶替它的位置，${cv} 下面那棵子树整体上移一层`,
        { 待删: tv, 顶替: cv },
        { hot: [target, child], pointers: { p: target, q: child }, note: '用唯一的孩子顶替' },
      )
      if (p === null) t.root = child
      else {
        const pn = t.nodes.get(p)!
        if (pn.left === target) pn.left = child
        else pn.right = child
      }
      t.nodes.delete(target)
      yield frame(
        6,
        'set',
        `删除完成：${cv} 接到了${p === null ? '根的位置' : ` ${t.nodes.get(p)!.v} 的下面`}，中序序列变成 ${inorderValues(t).join(' → ')}（还是升序）`,
        { 结点数: t.nodes.size },
        { hot: [child], note: '孩子顶替，BST 性质不变' },
      )
    } else {
      // ---------------- 情况③：有两个孩子，用中序后继顶替 ----------------
      const s = successorOf(t, target)!
      const sv = t.nodes.get(s)!.v
      yield frame(
        7,
        'mark',
        `${tv} 有两个孩子，不能直接摘：先找它的中序后继 —— 右子树里一路向左到底的那个结点，是 ${sv}（它正好是比 ${tv} 大的数里最小的一个）`,
        { 待删: tv, 后继: sv },
        { hot: [target, s], pointers: { p: target, s }, note: 's = 中序后继（统一用后继，不用前驱）' },
      )
      t.nodes.get(target)!.v = sv
      yield frame(
        10,
        'set',
        `把后继的值 ${sv} 搬进被删结点的位置：这一步只改值、不改结构，所以树里暂时有两个 ${sv}（中序序列里它们挨在一起），问题就转化成"删掉那个后继结点"`,
        { 待删: sv, 结点数: t.nodes.size },
        { hot: [target, s], pointers: { p: target, s }, note: '值顶替：先搬值，再摘结点' },
      )
      const sp = parentOf(t, s)!
      const sr = t.nodes.get(s)!.right
      if (sp === target) t.nodes.get(sp)!.right = sr
      else t.nodes.get(sp)!.left = sr
      t.nodes.delete(s)
      yield frame(
        11,
        'set',
        `把后继结点本身摘掉：它是右子树里最靠左的，一定没有左孩子，${sr === null ? '也没有右孩子，直接摘' : `用它的右孩子 ${t.nodes.get(sr)!.v} 顶替`} —— 情况③ 删除完成，中序序列 ${inorderValues(t).join(' → ')}`,
        { 结点数: t.nodes.size },
        { hot: [target], done: [target], note: '后继顶替 + 摘掉后继 = 完整的删除' },
      )
    }
  }

  yield frame(
    14,
    'done',
    `删除结束：① 叶子直接摘；② 只有一个孩子时用孩子顶替；③ 有两个孩子时先用中序后继的值顶替、再把后继结点摘掉。剩下的结点中序序列 ${inorderValues(t).join(' → ')} 仍然升序`,
    { 结点数: t.nodes.size },
    { done: [...t.nodes.keys()], note: 'BST 的删除必须保住"中序有序"' },
  )
}

// ===========================================================================
// 七、平衡二叉树 AVL · 四种旋转
// ===========================================================================

type AvlKind = 'LL' | 'RR' | 'LR' | 'RL'

interface AvlSetup {
  /** 失衡前那棵树的 5 个结点的关键字（按中序升序） */
  values: number[]
  /** 要插入的关键字（插完就失衡） */
  key: number
  /** 失衡前的形状：left = 根有左孩子(它带两个孩子)和右孩子；right = 左右镜像 */
  shape: 'left' | 'right'
}

/** 从候选值里挑 5 个满足条件的（按字典序，优先用真实数据里靠前的值） */
function pickCombos(cand: number[], ok: (v: number[]) => boolean): number[] | null {
  for (let a = 0; a < cand.length; a++) {
    for (let b = a + 1; b < cand.length; b++) {
      for (let c = b + 1; c < cand.length; c++) {
        for (let d = c + 1; d < cand.length; d++) {
          for (let e = d + 1; e < cand.length; e++) {
            const v = [cand[a]!, cand[b]!, cand[c]!, cand[d]!, cand[e]!]
            if (ok(v)) return v
          }
        }
      }
    }
  }
  return null
}

/**
 * 为某种失衡型别构造一个"插入完就失衡"的最小例子。
 *
 * 形状一（LL / LR）：中序是 A L B R T
 *        R                 A = L 的左孩子、B = L 的右孩子、T = R 的右孩子
 *      L   T               插入值 < A          -> L 的左子树变高 -> LL
 *     A B                  插入值 ∈ (L, B)     -> L 的右子树变高 -> LR
 * 形状二（RR / RL）：中序是 L R D T E
 *        R                 L = R 的左孩子、D = T 的左孩子、E = T 的右孩子
 *      L   T               插入值 > E          -> T 的右子树变高 -> RR
 *        D E               插入值 ∈ (R, D)     -> T 的左子树变高 -> RL
 *
 * LR / RL 还要求 (L,R) 或者 (R,T) 之间留得下至少一个空位（差值 ≥ 3），
 * 否则插入值只能落在被占着的位置上；不够时就用高端的补位值把形状撑开。
 */
export function pickAvlSetup(pool: number[], kind: AvlKind): AvlSetup {
  const cand = [...pool]
  let top = cand[cand.length - 1] ?? 50
  for (let k = 0; k < 3; k++) {
    top += 10
    cand.push(top)
  }
  const needGap = kind === 'LR' || kind === 'RL'
  const values =
    pickCombos(cand, (v) => !needGap || v[3]! - v[1]! >= 3) ??
    [cand[0]!, cand[1]!, cand[2]!, cand[3]!, cand[cand.length - 1]!]

  let key: number
  if (kind === 'LL') {
    // 比树上最小的值还小：一定沿着左链走到底，插进左孩子的左子树
    key = values[0]! > 10 ? values[0]! - 10 : values[0]! - 1
  } else if (kind === 'RR') {
    // 比树上最大的值还大：一定沿着右链走到底
    key = values[4]! + 10
  } else if (kind === 'LR') {
    const l = values[1]!
    const b = values[2]!
    key = b <= l + 1 ? b + 1 : Math.floor((l + b) / 2)
  } else {
    const r = values[1]!
    const d = values[2]!
    key = d <= r + 1 ? d + 1 : Math.floor((r + d) / 2)
  }
  return { values, key, shape: kind === 'LL' || kind === 'LR' ? 'left' : 'right' }
}

/** 按 setup 把"失衡前"那棵树搭出来 */
export function buildAvlBefore(setup: AvlSetup): Bst {
  const t = makeBst()
  const [v0, v1, v2, v3, v4] = setup.values as [number, number, number, number, number]
  if (setup.shape === 'left') {
    // 中序 A L B R T：根 = R，它的左孩子 L 带 A / B 两个孩子
    const r = addNode(t, v3)
    const l = addNode(t, v1)
    const tr = addNode(t, v4)
    const a = addNode(t, v0)
    const b = addNode(t, v2)
    t.root = r
    t.nodes.get(r)!.left = l
    t.nodes.get(r)!.right = tr
    t.nodes.get(l)!.left = a
    t.nodes.get(l)!.right = b
  } else {
    // 中序 L R D T E：根 = R，它的右孩子 T 带 D / E 两个孩子
    const r = addNode(t, v1)
    const l = addNode(t, v0)
    const tr = addNode(t, v3)
    const d = addNode(t, v2)
    const e = addNode(t, v4)
    t.root = r
    t.nodes.get(r)!.left = l
    t.nodes.get(r)!.right = tr
    t.nodes.get(tr)!.left = d
    t.nodes.get(tr)!.right = e
  }
  return t
}

/** AVL 那一套源码：1~6 行是公共的插入 + 回溯，7~12 行按型别不同 */
const AVL_HEAD = [
  'void insertAVL(BiTree &T, int key) {',
  '  if (T == NULL) { T = new BiTNode(key); return; }   // ① 先按 BST 规则插到空位',
  '  if (key < T->data) insertAVL(T->left, key);',
  '  else               insertAVL(T->right, key);',
  '  T->h = max(h(T->left), h(T->right)) + 1;           // ② 回溯：更新结点高度',
  '  int bf = h(T->left) - h(T->right);                 // ③ 平衡因子 = 左高 - 右高',
]

const AVL_ROTATE: Record<AvlKind, string[]> = {
  LL: [
    '  if (bf > 1 && key < T->left->data) {               // ④ LL：插在左孩子的左子树上',
    '    T = rotateRight(T);                              //    对失衡点做一次右单旋',
    '    // 一次旋转就够：转完子树高度复原，上层结点不必再调整',
    '  }',
    '  return;                                            // ⑤ 交还上层：这棵子树已经平衡',
    '}',
  ],
  RR: [
    '  if (bf < -1 && key > T->right->data) {             // ④ RR：插在右孩子的右子树上',
    '    T = rotateLeft(T);                               //    对失衡点做一次左单旋',
    '    // 一次旋转就够：转完子树高度复原，上层结点不必再调整',
    '  }',
    '  return;                                            // ⑤ 交还上层：这棵子树已经平衡',
    '}',
  ],
  LR: [
    '  if (bf > 1 && key > T->left->data) {               // ④ LR：插在左孩子的右子树上',
    '    T->left = rotateLeft(T->left);                   //    第一步：先对左孩子左旋',
    '    T = rotateRight(T);                              //    第二步：再对失衡点右旋',
    '  }',
    '  return;                                            // ⑤ 交还上层：这棵子树已经平衡',
    '}',
  ],
  RL: [
    '  if (bf < -1 && key < T->right->data) {             // ④ RL：插在右孩子的左子树上',
    '    T->right = rotateRight(T->right);                //    第一步：先对右孩子右旋',
    '    T = rotateLeft(T);                               //    第二步：再对失衡点左旋',
    '  }',
    '  return;                                            // ⑤ 交还上层：这棵子树已经平衡',
    '}',
  ],
}

function avlCodeLines(kind: AvlKind): string[] {
  return [...AVL_HEAD, ...AVL_ROTATE[kind]]
}

const AVL_TEXT: Record<AvlKind, { label: string; rot: string; where: string }> = {
  LL: { label: 'LL 型', rot: '一次右单旋', where: '左孩子的左子树' },
  RR: { label: 'RR 型', rot: '一次左单旋', where: '右孩子的右子树' },
  LR: { label: 'LR 型', rot: '先左旋后右旋', where: '左孩子的右子树' },
  RL: { label: 'RL 型', rot: '先右旋后左旋', where: '右孩子的左子树' },
}

function* runAvl(data: number[], kind: AvlKind): AlgoRunner {
  const setup = pickAvlSetup(valuePool(data, 5), kind)
  const t = buildAvlBefore(setup)
  const key = setup.key
  const text = AVL_TEXT[kind]
  const sub = (tt: Bst, i: number): string => bfText(bfOf(tt, i))
  const valOf = (i: number | null): number | null => (i === null ? null : (t.nodes.get(i)?.v ?? null))

  const frame = (
    line: number,
    action: StepAction,
    comment: string,
    vars: Record<string, number>,
    opts: ViewOpts = {},
  ): AlgoEvent => ({
    line,
    action,
    array: inorderValues(t),
    tree: treeOf(t, { sub, ...opts }),
    comment,
    vars,
  })

  yield frame(
    1,
    'mark',
    `失衡前是一棵 AVL 树：结点下端的小字是平衡因子 bf = 左子树高 − 右子树高，此时每个结点的 |bf| 都不超过 1。中序序列 ${inorderValues(t).join(' → ')}，现在插入 ${key}`,
    { 插入值: key, 结点数: t.nodes.size },
    { hot: [t.root!], pointers: { p: t.root }, note: 'bf 就是结点下面的小字' },
  )

  // ① 按 BST 规则一路比较到空位
  const path: number[] = []
  let cur: number | null = t.root
  let pre: number | null = null
  while (cur !== null) {
    const n = t.nodes.get(cur)!
    path.push(cur)
    const small = key < n.v
    yield frame(
      small ? 3 : 4,
      'compare',
      `${key} ${small ? '<' : '>'} ${n.v}：${small ? '往左' : '往右'}孩子走`,
      { 插入值: key },
      { hot: [cur], pointers: { p: cur, pre }, note: `${key} 与 ${n.v} 比较` },
    )
    pre = cur
    cur = small ? n.left : n.right
  }
  const newNode = addNode(t, key)
  const preNode = pre === null ? null : t.nodes.get(pre)!
  if (preNode === null) t.root = newNode
  else if (key < preNode.v) preNode.left = newNode
  else preNode.right = newNode
  yield frame(
    2,
    'set',
    `走到 ${preNode === null ? '空树的根' : `${preNode.v} 的${key < preNode.v ? '左' : '右'}孩子`}位置是 NULL，把 ${key} 挂上去`,
    { 插入值: key, 结点数: t.nodes.size },
    { hot: [newNode], pointers: { p: newNode, pre }, note: '新结点挂好，开始沿原路回溯' },
  )

  // ② 回溯：更新高度、算平衡因子，第一个 |bf| > 1 的就是最低失衡点
  let bad = -1
  let badBf = 0
  for (let k = path.length - 1; k >= 0; k--) {
    const i = path[k]!
    const n = t.nodes.get(i)!
    const hl = heightOf(t, n.left)
    const hr = heightOf(t, n.right)
    const b = hl - hr
    if (Math.abs(b) > 1) {
      bad = i
      badBf = b
      yield frame(
        6,
        'set',
        `${n.v}：左子树高 ${hl}、右子树高 ${hr}，平衡因子 bf = ${hl} − ${hr} = ${b > 0 ? '+' : ''}${b}，绝对值超过了 1 —— 最低的失衡点就是它`,
        { 失衡点: n.v, 平衡因子: b },
        { hot: [i], pointers: { p: i }, note: '红色 = 失衡点' },
      )
      break
    }
    yield frame(
      5,
      'mark',
      `回溯到 ${n.v}：左子树高 ${hl}、右子树高 ${hr}，高度更新为 ${Math.max(hl, hr) + 1}，bf = ${b > 0 ? '+' : ''}${b}，还在 −1 ~ 1 之间，先记下高度继续往上走`,
      { 平衡因子: b },
      { hot: [i], pointers: { p: i }, note: `${n.v} 仍然平衡` },
    )
  }

  if (bad < 0) {
    // 兜底分支：构造出来的例子一定失衡，真走到这里也要能正常收尾
    yield frame(
      11,
      'done',
      `插入 ${key} 之后每个结点的 |bf| 都不超过 1，不需要旋转`,
      { 结点数: t.nodes.size, 树高: heightOf(t, t.root) },
      { done: [...t.nodes.keys()], note: '保持平衡' },
    )
    return
  }

  // ③ 判型：失衡点 + 被插高那一侧的孩子（这两个结点就是要转的）
  const badNode = t.nodes.get(bad)!
  const childId = badBf > 0 ? badNode.left! : badNode.right!
  const childV = t.nodes.get(childId)!.v
  const childBf = bfOf(t, childId)
  const badParentV = valOf(parentOf(t, bad))
  const sideName = badBf > 0 ? '左' : '右'
  let newRootId = childId

  yield frame(
    7,
    'mark',
    `判型：失衡点 ${badNode.v} 的 bf = ${badBf > 0 ? '+' : ''}${badBf}，变高的是它的${sideName}孩子 ${childV}；再看 ${childV} 的 bf = ${childBf > 0 ? '+' : ''}${childBf} → 属于 ${text.label}（插入发生在${text.where}）`,
    { 失衡点: badNode.v, 平衡因子: badBf, 孩子bf: childBf },
    { hot: [bad, childId], pointers: { p: bad, [badBf > 0 ? 'l' : 'r']: childId }, note: '紫色 = 参与旋转的结点' },
  )

  if (kind === 'LL') {
    const moved = valOf(t.nodes.get(childId)!.right)
    yield frame(
      8,
      'mark',
      `LL 型只需要一次右单旋：以失衡点 ${badNode.v} 为轴，让左孩子 ${childV} 转上来接替它的位置`,
      { 平衡因子: badBf },
      { hot: [bad, childId], pointers: { p: bad, l: childId }, note: '右旋：左孩子上升' },
    )
    rotateRight(t, bad)
    newRootId = childId
    yield frame(
      8,
      'set',
      `右旋完成：${childV} 成了这棵子树的根${moved === null ? '' : `，${childV} 原来的右孩子 ${moved} 改接到 ${badNode.v} 的左边`}，${badNode.v} 变成 ${childV} 的右孩子`,
      { 新根: childV, 结点数: t.nodes.size },
      { hot: [bad, childId], pointers: { p: childId }, note: '红色 = 刚搬动的结点' },
    )
  } else if (kind === 'RR') {
    const moved = valOf(t.nodes.get(childId)!.left)
    yield frame(
      8,
      'mark',
      `RR 型只需要一次左单旋：以失衡点 ${badNode.v} 为轴，让右孩子 ${childV} 转上来接替它的位置`,
      { 平衡因子: badBf },
      { hot: [bad, childId], pointers: { p: bad, r: childId }, note: '左旋：右孩子上升' },
    )
    rotateLeft(t, bad)
    newRootId = childId
    yield frame(
      8,
      'set',
      `左旋完成：${childV} 成了这棵子树的根${moved === null ? '' : `，${childV} 原来的左孩子 ${moved} 改接到 ${badNode.v} 的右边`}，${badNode.v} 变成 ${childV} 的左孩子`,
      { 新根: childV, 结点数: t.nodes.size },
      { hot: [bad, childId], pointers: { p: childId }, note: '红色 = 刚搬动的结点' },
    )
  } else if (kind === 'LR') {
    const mid = t.nodes.get(childId)!.right!
    const midV = t.nodes.get(mid)!.v
    const moved = valOf(t.nodes.get(mid)!.left)
    yield frame(
      8,
      'mark',
      `LR 型要转两次。第一步：对左孩子 ${childV} 做左旋，把它右子树里的 ${midV} 提上来（${midV} 的 bf 是 ${bfText(bfOf(t, mid))}，它才是将来这棵子树的新根）`,
      { 平衡因子: badBf },
      { hot: [childId, mid], pointers: { p: childId, r: mid }, note: '第一步：左旋左孩子' },
    )
    rotateLeft(t, childId)
    newRootId = mid
    yield frame(
      8,
      'set',
      `第一步左旋完成：${midV} 挂在 ${badNode.v} 的左边，${childV} 变成了它的左孩子${moved === null ? '' : `，${moved} 改接到 ${childV} 的右边`}。注意 ${midV} 现在的 bf = ${bfText(bfOf(t, mid))}，看着也"失衡"，别急 —— 第二步右旋之后就正常了`,
      { 结点数: t.nodes.size },
      { hot: [mid, childId], pointers: { p: bad, l: mid }, note: '双旋的中间状态' },
    )
    yield frame(
      9,
      'mark',
      `第二步：对失衡点 ${badNode.v} 做右旋，让 ${midV} 升到最上面`,
      { 失衡点: badNode.v },
      { hot: [bad, mid], pointers: { p: bad, l: mid }, note: '第二步：右旋失衡点' },
    )
    rotateRight(t, bad)
    yield frame(
      9,
      'set',
      `LR 双旋完成：${midV} 成了这棵子树的根，左孩子是 ${childV}、右孩子是 ${badNode.v}，两棵子树的高度差不超过 1`,
      { 新根: midV, 结点数: t.nodes.size },
      { hot: [bad, mid], pointers: { p: mid }, note: '红色 = 刚搬动的结点' },
    )
  } else {
    const mid = t.nodes.get(childId)!.left!
    const midV = t.nodes.get(mid)!.v
    const moved = valOf(t.nodes.get(mid)!.right)
    yield frame(
      8,
      'mark',
      `RL 型要转两次。第一步：对右孩子 ${childV} 做右旋，把它左子树里的 ${midV} 提上来（${midV} 的 bf 是 ${bfText(bfOf(t, mid))}，它才是将来这棵子树的新根）`,
      { 平衡因子: badBf },
      { hot: [childId, mid], pointers: { p: childId, l: mid }, note: '第一步：右旋右孩子' },
    )
    rotateRight(t, childId)
    newRootId = mid
    yield frame(
      8,
      'set',
      `第一步右旋完成：${midV} 挂在 ${badNode.v} 的右边，${childV} 变成了它的右孩子${moved === null ? '' : `，${moved} 改接到 ${childV} 的左边`}。注意 ${midV} 现在的 bf = ${bfText(bfOf(t, mid))}，看着也"失衡"，别急 —— 第二步左旋之后就正常了`,
      { 结点数: t.nodes.size },
      { hot: [mid, childId], pointers: { p: bad, r: mid }, note: '双旋的中间状态' },
    )
    yield frame(
      9,
      'mark',
      `第二步：对失衡点 ${badNode.v} 做左旋，让 ${midV} 升到最上面`,
      { 失衡点: badNode.v },
      { hot: [bad, mid], pointers: { p: bad, r: mid }, note: '第二步：左旋失衡点' },
    )
    rotateLeft(t, bad)
    yield frame(
      9,
      'set',
      `RL 双旋完成：${midV} 成了这棵子树的根，左孩子是 ${badNode.v}、右孩子是 ${childV}`,
      { 新根: midV, 结点数: t.nodes.size },
      { hot: [bad, mid], pointers: { p: mid }, note: '红色 = 刚搬动的结点' },
    )
  }

  const newRootV = t.nodes.get(newRootId)!.v
  const newRootH = heightOf(t, newRootId)
  yield frame(
    11,
    'mark',
    `${text.rot}之后，这棵子树的高度回到插入前的 ${newRootH} —— 所以${badParentV === null ? '失衡点本来就是根，整棵树都重新平衡了' : `${badParentV} 看到的子树高度没变，它上面的结点都不用再调整`}。${newRootV} 的新平衡因子是 ${bfText(bfOf(t, newRootId))}`,
    { 新根: newRootV, 子树高: newRootH },
    { hot: [newRootId], note: '子树高度复原，旋转到此为止' },
  )
  yield frame(
    12,
    'done',
    `插入 ${key} 触发 ${text.label} 失衡，用「${text.rot}」修正完成：现在每个结点的 |bf| 都不超过 1，树高 ${heightOf(t, t.root)}，查找仍然是 O(log n)`,
    { 结点数: t.nodes.size, 树高: heightOf(t, t.root) },
    { done: [...t.nodes.keys()], note: '绿色 = 全部结点都已平衡' },
  )
}

// ===========================================================================
// 八、注册用的 spec
// ===========================================================================

const BST_DATA = () => [20, 30, 40, 50, 60, 70, 80]

/** 失衡前的 AVL 快照（首帧由 engine 造，所以必须在这里给） */
function avlInitTree(data: number[], kind: AvlKind): TreeView {
  const setup = pickAvlSetup(valuePool(data, 5), kind)
  const t = buildAvlBefore(setup)
  return treeOf(t, {
    sub: (tt, i) => bfText(bfOf(tt, i)),
    pointers: { p: t.root },
    note: `准备插入 ${setup.key}`,
  })
}

function avlSpec(kind: AvlKind, id: string, name: string, summary: string, data: number[]): AlgorithmSpec {
  const text = AVL_TEXT[kind]
  return {
    id,
    name,
    category: 'search',
    group: '平衡二叉树 AVL',
    summary,
    complexity: { time: 'O(log n)', space: 'O(log n)（递归回溯的栈）' },
    renderer: 'tree',
    codeLines: avlCodeLines(kind),
    defaultData: () => [...data],
    // 四种旋转必须是"插完刚好失衡"的那个最小形状：失衡前 5 个结点 + 新插入的 1 个 = 6 个，
    // 形状是定死的，所以数据规模只有 6 这一个合法值（下拉框里也只给这一个）
    sizes: [6],
    initComment: (d) => {
      const setup = pickAvlSetup(valuePool(d, 5), kind)
      return `失衡前是一棵 AVL 树，结点下端的小字是平衡因子 bf：中序序列 ${setup.values.join(' → ')}。接下来插入 ${setup.key}，触发${text.label}（${text.where}）失衡`
    },
    initTree: (d) => avlInitTree(d, kind),
    createRunner: (d) => runAvl(d, kind),
  }
}

export const treeSearchSpecs: AlgorithmSpec[] = [
  // ---------------- 二叉排序树 ----------------
  {
    id: 'bst-insert',
    name: '二叉排序树·插入',
    category: 'search',
    group: '二叉排序树',
    summary: '比它小往左、比它大往右，走到空位挂上去；相同的关键字不插入',
    complexity: { time: '平均 O(log n)，最坏 O(n)', space: 'O(1)' },
    renderer: 'tree',
    codeLines: BST_INSERT_CODE,
    defaultData: BST_DATA,
    // n 个数据：树上先摆 n-1 个，插进去剩下的那一个，插完正好 n 个结点
    sizes: TREE_SIZES,
    defaultValue: (data) => planInsert(distinctKeys(data)).key,
    initComment: (data) => {
      const keys = distinctKeys(data)
      const { key } = planInsert(keys)
      return `数据里一共 ${keys.length} 个关键字（升序：${keys.join(' → ')}）。树上先按升序摆好了其中 ${keys.length - 1} 个，就差 ${key} 这一个没进去 —— 现在把它插进去，插完树上正好 ${keys.length} 个结点`
    },
    initTree: (data) =>
      treeOf(balancedBst(planInsert(distinctKeys(data)).base), {
        note: '播放：从根开始比大小，走到空位把新结点挂上',
      }),
    createRunner: runBstInsert,
  },
  {
    id: 'bst-search',
    name: '二叉排序树·查找',
    category: 'search',
    group: '二叉排序树',
    summary: '逐层比较，命中就标绿；走到 NULL 说明树里没有',
    complexity: { time: '平均 O(log n)，最坏 O(n)', space: 'O(1)' },
    renderer: 'tree',
    codeLines: BST_SEARCH_CODE,
    defaultData: BST_DATA,
    sizes: TREE_SIZES,
    defaultTarget: (data) => pickSearchTarget(balancedBst(distinctKeys(data))),
    initComment: (data) =>
      `在一棵二叉排序树里查找（中序序列 ${distinctKeys(data).join(' → ')}，${distinctKeys(data).length} 个结点）：命中会标绿，走不到就会一路走到 NULL`,
    initTree: (data) =>
      treeOf(balancedBst(distinctKeys(data)), { note: '查找从根结点开始，每比一次就砍掉一棵子树' }),
    createRunner: runBstSearch,
  },
  {
    id: 'bst-delete',
    name: '二叉排序树·删除',
    category: 'search',
    group: '二叉排序树',
    summary: '① 叶子直接摘 ② 一个孩子顶替 ③ 两个孩子用中序后继顶替（再摘掉后继）',
    complexity: { time: '平均 O(log n)，最坏 O(n)', space: 'O(1)' },
    renderer: 'tree',
    codeLines: BST_DELETE_CODE,
    defaultData: BST_DATA,
    // 数据里的关键字全建进树里；5~12 个数据都排得出"叶子 / 一个孩子 / 两个孩子"三种删除情况
    sizes: TREE_SIZES,
    initComment: (data) =>
      `先建一棵二叉排序树（中序序列 ${distinctKeys(data).join(' → ')}，${distinctKeys(data).length} 个结点），然后依次演示删除的三种情况：叶子、只有一个孩子、有两个孩子（每删一个结点数就少一个）`,
    initTree: (data) =>
      treeOf(balancedBst(distinctKeys(data)), { note: '删除的第一步都是"按关键字查找"' }),
    createRunner: runBstDelete,
  },

  // ---------------- 平衡二叉树 AVL ----------------
  avlSpec('LL', 'avl-ll', 'AVL 旋转·LL（右单旋）', '在左孩子的左子树上插入导致失衡 -> 对失衡点做一次右单旋', [20, 30, 40, 50, 70, 90]),
  avlSpec('RR', 'avl-rr', 'AVL 旋转·RR（左单旋）', '在右孩子的右子树上插入导致失衡 -> 对失衡点做一次左单旋', [30, 40, 50, 60, 80, 100]),
  avlSpec('LR', 'avl-lr', 'AVL 旋转·LR（先左后右）', '在左孩子的右子树上插入导致失衡 -> 先左旋左孩子，再右旋失衡点', [20, 30, 40, 50, 70, 90]),
  avlSpec('RL', 'avl-rl', 'AVL 旋转·RL（先右后左）', '在右孩子的左子树上插入导致失衡 -> 先右旋右孩子，再左旋失衡点', [20, 30, 50, 70, 80, 100]),
]
