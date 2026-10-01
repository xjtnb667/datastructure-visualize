import type {
  AlgorithmSpec,
  AlgoEvent,
  AlgoRunner,
  RunnerContext,
  StepAction,
  TreeNodeSnapshot,
  TreeView,
} from '@/core/types'
import { distinctKeys, pickGapKey } from './treeSearch'
import { TREE_SIZES } from './treeTraverse'

/**
 * 查找 —— 红黑树 / B 树 / B+ 树（三类"平衡的多路/二叉查找树"）。
 *
 * 三者的公共点：都是"比大小往下走"的查找结构，都用对数级的树高保证查找效率。
 * 区别在于"靠什么保持平衡"：
 *   - 红黑树：给结点染色 + 旋转，把树高控制在 2log(n+1) 以内（二叉，每个结点 1 个关键字）；
 *   - B 树：  一个结点里排好几个关键字，关键字多了就"分裂"、把中间的关键字顶到父结点，
 *             所有叶子在同一层（多路，树矮、磁盘 I/O 少）；
 *   - B+ 树： 所有关键字都出现在叶子层，内部结点只是"索引"的副本，叶子之间还用链表串起来，
 *             范围查找只要顺着叶子走 —— 数据库索引用的就是它。
 *
 * 快照约定
 * --------
 *   - 二叉的红黑树填 left / right，另外补上 parent；
 *   - 多路的 B 树 / B+ 树填 children（**不填 left / right** —— 渲染器据此走"叶子占位、父居中"
 *     的多叉布局），关键字放在 keys 里，渲染器会把它画成一个宽框、框里横排 n 个关键字；
 *   - 红黑树用 color 强制指定底色：红结点 '#ef4444'、黑结点 '#30363d'，sub 写颜色名；
 *   - B 树的 sub 标"第几层"，B+ 树的 sub 标"叶子 / 索引"（内部结点只当索引）；
 *   - B+ 树叶子之间的链表用 links（kind: 'thread'，画成橙色虚线）。
 */

// ===========================================================================
// 一、红黑树
// ===========================================================================

const RB_RED = '#ef4444'
const RB_BLACK = '#30363d'

type RbColor = 'red' | 'black'

interface RbNode {
  id: string
  v: number
  color: RbColor
  left: number | null
  right: number | null
  parent: number | null
}

interface RbTree {
  nodes: Map<number, RbNode>
  root: number | null
  /** 已分配过的结点数，只增不减，编号一旦给出就不再变（动画、指针才稳得住） */
  seq: number
}

function makeRb(): RbTree {
  return { nodes: new Map(), root: null, seq: 0 }
}

/**
 * 数据 -> 红黑树的**插入序列**。
 * 这里刻意**不排序**：红黑树最后长成什么形状完全由插入顺序决定，
 * 演示用的默认数据就是按"刚好能演出三种修复情况"的顺序排的。
 */
function rbKeys(data: number[]): number[] {
  const out = data.filter((v) => Number.isFinite(v))
  return out.length ? out : [10, 20, 30, 40, 35, 50, 45]
}

function rbAdd(t: RbTree, v: number): number {
  const i = t.seq++
  // 新结点一律先建成红色（性质⑤不受影响，只可能违反性质②/④）
  t.nodes.set(i, { id: `r${i}`, v, color: 'red', left: null, right: null, parent: null })
  return i
}

/** 空指针（NIL）一律按黑色算 —— 性质③ */
function rbColor(t: RbTree, i: number | null): RbColor {
  return i === null ? 'black' : (t.nodes.get(i)?.color ?? 'black')
}

function rbFind(t: RbTree, key: number): number | null {
  let cur = t.root
  while (cur !== null) {
    const n = t.nodes.get(cur)!
    if (key === n.v) return cur
    cur = key < n.v ? n.left : n.right
  }
  return null
}

/** 以 i 为轴左旋：右孩子升上来接替它的位置 */
function rbRotateLeft(t: RbTree, i: number): void {
  const n = t.nodes.get(i)!
  const r = n.right!
  const rn = t.nodes.get(r)!
  const p = n.parent
  n.right = rn.left
  if (rn.left !== null) t.nodes.get(rn.left)!.parent = i
  rn.parent = p
  if (p === null) t.root = r
  else if (t.nodes.get(p)!.left === i) t.nodes.get(p)!.left = r
  else t.nodes.get(p)!.right = r
  rn.left = i
  n.parent = r
}

/** 以 i 为轴右旋：左孩子升上来接替它的位置 */
function rbRotateRight(t: RbTree, i: number): void {
  const n = t.nodes.get(i)!
  const l = n.left!
  const ln = t.nodes.get(l)!
  const p = n.parent
  n.left = ln.right
  if (ln.right !== null) t.nodes.get(ln.right)!.parent = i
  ln.parent = p
  if (p === null) t.root = l
  else if (t.nodes.get(p)!.left === i) t.nodes.get(p)!.left = l
  else t.nodes.get(p)!.right = l
  ln.right = i
  n.parent = l
}

/**
 * 首帧（以及生成器的起点）用的树：空树里先放进第一个关键字，它就是黑色的根。
 * 首帧由 engine 造，所以 initTree 必须给出这棵树，否则第一帧是空画面。
 */
function rbSetup(keys: number[]): RbTree {
  const t = makeRb()
  const i = rbAdd(t, keys[0] ?? 50)
  t.nodes.get(i)!.color = 'black' // 性质②：根结点必须是黑色
  t.root = i
  return t
}

function rbInorder(t: RbTree): number[] {
  const out: number[] = []
  const walk = (i: number | null): void => {
    if (i === null) return
    const n = t.nodes.get(i)
    if (!n) return
    walk(n.left)
    out.push(n.v)
    walk(n.right)
  }
  walk(t.root)
  return out
}

function rbHeight(t: RbTree, i: number | null): number {
  if (i === null) return 0
  const n = t.nodes.get(i)
  if (!n) return 0
  return 1 + Math.max(rbHeight(t, n.left), rbHeight(t, n.right))
}

/** 紧凑地把整棵树写成一行：20黑(10红 35红(30黑 40黑))，方便核对每一步的红黑状态 */
function rbShape(t: RbTree, i: number | null): string {
  if (i === null) return ''
  const n = t.nodes.get(i)!
  const kids = [n.left, n.right].filter((x): x is number => x !== null)
  const tag = n.color === 'red' ? '红' : '黑'
  if (!kids.length) return `${n.v}${tag}`
  return `${n.v}${tag}(${kids.map((c) => rbShape(t, c)).join(' ')})`
}

interface RbViewOpts {
  hot?: number[]
  done?: number[]
  pointers?: Record<string, number | null>
  note?: string
}

/** 内部的红黑树 -> 渲染器要的 TreeView（二叉：left / right + parent，底色用 color 强制指定） */
function rbView(t: RbTree, opts: RbViewOpts = {}): TreeView {
  const nodes: TreeNodeSnapshot[] = []
  for (const n of t.nodes.values()) {
    nodes.push({
      id: n.id,
      value: n.v,
      // 填了 color 就强制用这个底色：红结点画红、黑结点画深色
      color: n.color === 'red' ? RB_RED : RB_BLACK,
      sub: n.color === 'red' ? '红' : '黑',
      left: n.left === null ? null : t.nodes.get(n.left)!.id,
      right: n.right === null ? null : t.nodes.get(n.right)!.id,
      parent: n.parent === null ? null : t.nodes.get(n.parent)!.id,
    })
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

const RB_CODE = [
  'void RBInsert(Tree &T, int key) {',
  '  RBNode *z = new RBNode(key);              // 新结点一律先染成红色',
  '  z->color = RED; z->left = z->right = NIL;',
  '  RBNode *x = T.root, *y = NIL;             // x 一路往下比，y 记住它的父结点',
  '  while (x != NIL) {',
  '    y = x;',
  '    x = (key < x->key) ? x->left : x->right; // 小往左、大往右（BST 的规则）',
  '  }',
  '  z->parent = y;',
  '  if (y == NIL) T.root = z;                  // 空树：z 直接就是根',
  '  else if (key < y->key) y->left = z; else y->right = z;',
  '  while (z->parent != NIL && z->parent->color == RED) {   // 父红才可能红红相连',
  '    RBNode *p = z->parent, *g = p->parent;',
  '    RBNode *u = (p == g->left) ? g->right : g->left;      // 叔叔 = 父的兄弟',
  '    if (u != NIL && u->color == RED) {       // 情况① 叔叔是红：只变色',
  '      p->color = BLACK; u->color = BLACK; g->color = RED;',
  '      z = g;                                 // 祖父变红，上移继续检查',
  '    } else {                                 // 叔叔是黑（NIL 也算黑）',
  '      if (z == (p == g->left ? p->right : p->left)) {   // 情况② 自己是"内侧"孩子',
  '        z = p;                               // 先把它换到外侧',
  '        if (p == g->left) rotateLeft(T, z); else rotateRight(T, z);',
  '      }',
  '      p = z->parent; g = p->parent;          // 这时 z 已经在"外侧"了',
  '      p->color = BLACK; g->color = RED;      // 情况③ 旋转 + 变色',
  '      if (p == g->left) rotateRight(T, g); else rotateLeft(T, g);',
  '    }',
  '  }',
  '  T.root->color = BLACK;                     // 性质②：根结点永远是黑色',
  '}',
]

function* runRbTree(data: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const keys = rbKeys(data)
  const t = rbSetup(keys)
  const firstV = keys[0] ?? 50

  const frame = (
    line: number,
    action: StepAction,
    comment: string,
    vars: Record<string, number>,
    opts: RbViewOpts = {},
  ): AlgoEvent => ({
    line,
    action,
    // 数据栏按**插入顺序**给出（插入顺序决定红黑树最后长什么样）
    array: keys.slice(),
    tree: rbView(t, opts),
    comment,
    vars,
  })

  yield frame(
    1,
    'mark',
    `红黑树是一棵"每个结点都带颜色"的二叉排序树，任何时候都要满足 5 条性质：① 结点非红即黑；② 根结点是黑色；③ 所有空指针（NULL）都算黑色；④ 红结点的两个孩子都必须是黑色（不能"红红相连"）；⑤ 从任一结点往下走到每个空指针，路上的黑结点个数都一样。先把第一个关键字 ${firstV} 放进空树当根、染成黑色（性质②满足）。接下来依次插入其余 ${keys.length - 1} 个关键字`,
    { 插入值: firstV, 结点数: 1, 已插入: 1 },
    { pointers: { z: t.root }, note: '结点框的红色/深色就是它的颜色，下面小字写着颜色名' },
  )

  for (let k = 1; k < keys.length; k++) {
    const key = keys[k]!

    if (rbFind(t, key) !== null) {
      yield frame(
        1,
        'mark',
        `第 ${k + 1} 个数据是 ${key}，它已经在树里了 —— 红黑树里不放重复的关键字，这一趟跳过`,
        { 插入值: key, 结点数: t.nodes.size },
        { note: '重复的关键字不入树' },
      )
      continue
    }

    yield frame(
      4,
      'mark',
      `准备插入第 ${k + 1} 个关键字 ${key}。红黑树首先是一棵二叉排序树，第一步和普通 BST 完全一样：从根结点出发，比它小往左、比它大往右，一直走到空位`,
      { 插入值: key, 结点数: t.nodes.size },
      { pointers: { x: t.root, y: null }, note: 'x = 当前比到的结点，y = 它的父结点' },
    )

    // ① 按 BST 规则走到空位
    let cur = t.root
    let pre: number | null = null
    while (cur !== null) {
      const n = t.nodes.get(cur)!
      const small = key < n.v
      yield frame(
        7,
        'compare',
        `${key} ${small ? '<' : '>'} ${n.v}：${small ? '往左' : '往右'}孩子走`,
        { 插入值: key, 比较: n.v },
        { hot: [cur], pointers: { x: cur, y: pre }, note: `${key} 与 ${n.v} 比大小` },
      )
      pre = cur
      cur = small ? n.left : n.right
    }

    // ② 挂上新结点（先染红）
    const z = rbAdd(t, key)
    const preV = pre === null ? null : t.nodes.get(pre)!.v
    if (pre === null) t.root = z
    else {
      const pn = t.nodes.get(pre)!
      if (key < pn.v) pn.left = z
      else pn.right = z
      t.nodes.get(z)!.parent = pre
    }
    yield frame(
      2,
      'set',
      `走到空位，把新结点 ${key} 挂到${preV === null ? '根的位置' : ` ${preV} 的${key < preV ? '左' : '右'}边`}。**新结点一律先染成红色**：插入一个红结点不会改变任何一条路径上的黑结点个数（性质⑤不受影响），所以最多只会违反性质④（红红相连），或者当它是根时违反性质②`,
      { 插入值: key, 结点数: t.nodes.size },
      { pointers: { z, p: pre }, note: `新结点 ${key} 现在是红色` },
    )

    if (rbColor(t, t.nodes.get(z)!.parent) === 'black') {
      // 父结点是黑的：什么都不用做
      yield frame(
        12,
        'mark',
        `${key} 的父结点${preV === null ? '' : ` ${preV}`}是黑色 —— 红结点接在黑结点下面，没有红红相连（性质④满足），整棵树仍然合法，一步都不用调整`,
        { 插入值: key, 结点数: t.nodes.size },
        { pointers: { z, p: pre }, note: '父结点是黑：不需要修复' },
      )
    } else {
      yield frame(
        12,
        'mark',
        `${key} 的父结点 ${preV} 是红色 —— **违反了性质④**（红结点的两个孩子必须都是黑的，这里"红红相连"了）。要修的只有这一处，怎么修看**叔叔结点**（父结点的兄弟）是什么颜色，分三种情况`,
        { 插入值: key, 结点数: t.nodes.size },
        { pointers: { z, p: pre }, note: '父红 = 违反性质④，开始修复' },
      )

      let zz = z
      for (;;) {
        const p = t.nodes.get(zz)!.parent
        if (p === null) break // 上移到根了：退出循环后统一把根染黑
        const pn = t.nodes.get(p)!
        if (pn.color !== 'red') break // 父结点已经是黑的：不再红红相连
        const g = pn.parent! // 父结点是红的 => 它不可能是根 => 祖父一定存在
        const gn = t.nodes.get(g)!
        const leftSide = gn.left === p
        const u = leftSide ? gn.right : gn.left
        const uColor = rbColor(t, u)
        const uText =
          u === null ? 'NIL（空指针，按黑色算）' : `${t.nodes.get(u)!.v}（${uColor === 'red' ? '红' : '黑'}）`

        if (uColor === 'red') {
          // ---------------- 情况①：叔叔是红，只变色 ----------------
          yield frame(
            15,
            'mark',
            `看叔叔 ${uText} —— **情况①：叔叔是红色**。叔叔和父结点都是红的，说明祖父一定是黑的；这时靠旋转没用，只要把父和叔的"红"一起推到祖父头上就行`,
            { 插入值: key, 结点数: t.nodes.size },
            {
              pointers: { z: zz, p, u, g },
              note: '情况①：叔叔是红 → 变色即可，不用旋转',
            },
          )
          pn.color = 'black'
          t.nodes.get(u!)!.color = 'black'
          gn.color = 'red'
          yield frame(
            16,
            'set',
            `把父结点 ${pn.v} 和叔叔 ${t.nodes.get(u!)!.v} 染黑、祖父 ${gn.v} 染红。这样"红"整体上移了一层：从祖父往下看，每条路径上原来经过 ${pn.v} / ${t.nodes.get(u!)!.v} 的那个黑结点，现在改成经过祖父这个黑结点，**黑结点个数一点没变（性质⑤保住）**，红红相连也解开了`,
            { 插入值: key, 结点数: t.nodes.size },
            { pointers: { z: zz, p, u, g }, note: '父、叔染黑，祖父染红' },
          )
          zz = g
          const gParent = gn.parent
          const gParentRed = rbColor(t, gParent) === 'red'
          yield frame(
            17,
            'set',
            `但祖父 ${gn.v} 现在变成红色了：如果它的父结点也是红的，就又红红相连了 —— 于是把 z 上移到祖父 ${gn.v}，${gParent === null ? '它是根，循环结束，等下把根染回黑色就行' : gParentRed ? `它的父结点 ${t.nodes.get(gParent)!.v} 是红的，继续按三种情况处理` : `它的父结点 ${t.nodes.get(gParent)!.v} 是黑的，这一趟修复到此结束`}`,
            { 插入值: key, 结点数: t.nodes.size },
            {
              pointers: { z: zz, p: gParent },
              note: 'z 上移到祖父，继续往上检查',
            },
          )
          continue
        }

        // ---------------- 叔叔是黑 ----------------
        const inner = leftSide ? pn.right === zz : pn.left === zz
        if (inner) {
          // 情况②：内侧孩子 -> 先旋转成外侧
          const rotName = leftSide ? '左旋' : '右旋'
          const kidSide = leftSide ? '右' : '左'
          yield frame(
            19,
            'mark',
            `叔叔是 ${uText}，只靠变色解决不了（黑叔叔染不黑，光把祖父染红又会少一个黑结点）—— **情况②**：${t.nodes.get(zz)!.v} 是父结点 ${pn.v} 的${kidSide}孩子，从祖父 ${gn.v} 看它长在"内侧"。先把算法里的 z 上移到父结点 ${pn.v}，对它做一次${rotName}，把自己换到"外侧"去`,
            { 插入值: key, 结点数: t.nodes.size },
            { pointers: { z: zz, p, g }, note: `情况②：内侧孩子，先${rotName}换成外侧` },
          )
          zz = p
          if (leftSide) rbRotateLeft(t, zz)
          else rbRotateRight(t, zz)
          yield frame(
            21,
            'set',
            `${rotName}完成：新结点 ${key} 升上来顶替了 ${pn.v} 的位置，${pn.v} 变成了它的${kidSide === '右' ? '左' : '右'}孩子 —— 现在从祖父 ${gn.v} 看，${key} 已经是"外侧"孩子了，情况② 就这样转成了情况③`,
            { 插入值: key, 结点数: t.nodes.size },
            { pointers: { z: zz, p: t.nodes.get(zz)!.parent, g: gn.parent }, note: '内侧 -> 外侧，接着走情况③' },
          )
        }

        // 情况③：外侧孩子 -> 旋转 + 变色
        const p2 = t.nodes.get(zz)!.parent!
        const g2 = t.nodes.get(p2)!.parent!
        const p2n = t.nodes.get(p2)!
        const g2n = t.nodes.get(g2)!
        const rotName = leftSide ? '右旋' : '左旋'
        const outerText = leftSide
          ? `${t.nodes.get(zz)!.v} 是 ${p2n.v} 的左孩子、${p2n.v} 又是 ${g2n.v} 的左孩子（"左-左"一条线）`
          : `${t.nodes.get(zz)!.v} 是 ${p2n.v} 的右孩子、${p2n.v} 又是 ${g2n.v} 的右孩子（"右-右"一条线）`
        yield frame(
          23,
          'mark',
          `叔叔是黑色，而且 ${outerText} —— **情况③：外侧孩子**。这就要"旋转 + 变色"一起上：对祖父 ${g2n.v} 做一次${rotName}，让父结点 ${p2n.v} 转上来当这棵子树的根`,
          { 插入值: key, 结点数: t.nodes.size },
          { pointers: { z: zz, p: p2, g: g2 }, note: `情况③：外侧孩子，${rotName} + 变色` },
        )
        p2n.color = 'black'
        g2n.color = 'red'
        if (leftSide) rbRotateRight(t, g2)
        else rbRotateLeft(t, g2)
        yield frame(
          25,
          'set',
          `${rotName} + 变色完成：${p2n.v} 成了这棵子树的根（黑），祖父 ${g2n.v} 变成它的${leftSide ? '右' : '左'}孩子（红），原来在"内侧"的那棵子树改接到祖父的另一边。黑结点总数没变（祖父原来的"黑"给了父结点），所以从 ${g2n.v} 往上的结点都不用再动 —— 这一趟修复结束`,
          { 插入值: key, 结点数: t.nodes.size },
          { pointers: { p: p2, g: g2 }, note: '旋转 + 变色完成，子树黑高不变' },
        )
        break
      }

      // 上移到了根：根可能是红的 -> 违反性质②，染回黑
      const rootNow = t.root!
      if (t.nodes.get(rootNow)!.color === 'red') {
        const rv = t.nodes.get(rootNow)!.v
        t.nodes.get(rootNow)!.color = 'black'
        yield frame(
          28,
          'set',
          `循环走到头了，发现根结点 ${rv} 是红色 —— **违反性质②**（根必须是黑色）。把根染黑：所有路径都多经过一个黑结点，每条路径同样 +1，性质⑤依然成立`,
          { 插入值: key, 结点数: t.nodes.size },
          { pointers: { z: rootNow }, note: '根结点重新染黑（性质②）' },
        )
      }
    }

    // 每插完一个，给一次"体检"：红黑状态 + 5 条性质是否满足
    yield frame(
      8,
      'mark',
      `插入 ${key} 完成。当前的红黑状态：${rbShape(t, t.root)}。体检一遍：根是黑的（性质②）；没有红红相连（性质④）；从根到每个空指针的黑结点个数都一样（性质⑤）—— 树依然是一棵合格的红黑树`,
      { 插入值: key, 结点数: t.nodes.size },
      { pointers: { z: t.root }, note: '每一步插入后都检查一遍性质②④⑤' },
    )
  }

  const reds = [...t.nodes.values()].filter((n) => n.color === 'red').length
  const treeHeight = rbHeight(t, t.root)
  yield frame(
    28,
    'done',
    `演示结束：${keys.join(' → ')} 依次插入，红黑树最终是 ${rbShape(t, t.root)}（中序序列 ${rbInorder(t).join(' → ')}，${t.nodes.size} 个结点，树高 ${treeHeight}，其中红结点 ${reds} 个）。修复只用到三种情况：① 叔叔是红 -> 变色并把 z 上移到祖父；② 叔叔是黑且自己在"内侧" -> 先旋转换成外侧；③ 叔叔是黑且自己在"外侧" -> 旋转 + 变色。插入最多 O(log n) 次修复，查找和插入都是 O(log n)`,
    { 结点数: t.nodes.size, 树高: treeHeight, 红结点: reds },
    { done: [...t.nodes.keys()], note: '红结点用红色、黑结点用深色；根一定是黑的' },
  )
}

// ===========================================================================
// 二、多路查找树（B 树 / B+ 树共用的内部表示）
// ===========================================================================

/** 阶 m：每个结点最多 m 个孩子、m - 1 个关键字 */
const MW_M = 3
const MW_MAX_KEYS = MW_M - 1

interface MwNode {
  id: string
  keys: number[]
  children: number[]
  parent: number | null
  leaf: boolean
  /** 只有 B+ 树的叶子用：链表里的下一个叶子 */
  next: number | null
}

interface MwTree {
  nodes: Map<number, MwNode>
  root: number | null
  seq: number
  /** true = B+ 树（叶子链表 + 索引结点），false = B 树 */
  plus: boolean
}

function makeMw(plus: boolean): MwTree {
  return { nodes: new Map(), root: null, seq: 0, plus }
}

function mwNew(t: MwTree, leaf: boolean): number {
  const i = t.seq++
  t.nodes.set(i, {
    id: `${t.plus ? 'p' : 'b'}${i}`,
    keys: [],
    children: [],
    parent: null,
    leaf,
    next: null,
  })
  return i
}

/** 首帧（以及生成器的起点）用的树：空树里先放进第一个关键字，它既是根也是叶子 */
function mwSetup(keys: number[], plus: boolean): MwTree {
  const t = makeMw(plus)
  const leaf = mwNew(t, true)
  t.nodes.get(leaf)!.keys = [keys[0] ?? 50]
  t.root = leaf
  return t
}

/**
 * 分裂结点 i（关键字超过 m - 1 个了）。返回"升到父结点的关键字"和"新建的右半边结点"。
 *
 * 三种分裂的规矩不一样，这正是 B 树和 B+ 树的关键区别：
 *   - 内部结点（两者一样）：中间的关键字**搬**到父结点当"路标"，它不必留在下面（它只是索引）；
 *   - B+ 树的叶子：关键字必须**全部留在叶子层**，所以只把右边第一个关键字**复制**一份上去；
 *     同时把新叶子接进叶子链表（p->next = r）；
 *   - B 树的叶子：和内部结点一样，中间的关键字**搬**上去（B 树里每个关键字只出现一次）。
 *
 * 分裂的是根时，会新造一个根，整棵树长高一层 —— 所有叶子仍然在同一层。
 */
function mwSplit(t: MwTree, i: number): { up: number; right: number } {
  const n = t.nodes.get(i)!
  const mid = Math.floor(n.keys.length / 2)
  const right = mwNew(t, n.leaf)
  const rn = t.nodes.get(right)!
  let up: number
  if (!n.leaf) {
    up = n.keys[mid]!
    rn.keys = n.keys.slice(mid + 1)
    n.keys = n.keys.slice(0, mid)
    rn.children = n.children.slice(mid + 1)
    n.children = n.children.slice(0, mid + 1)
    for (const c of rn.children) t.nodes.get(c)!.parent = right
  } else if (t.plus) {
    up = n.keys[mid + 1]!
    rn.keys = n.keys.slice(mid + 1)
    n.keys = n.keys.slice(0, mid + 1)
    rn.next = n.next
    n.next = right
  } else {
    up = n.keys[mid]!
    rn.keys = n.keys.slice(mid + 1)
    n.keys = n.keys.slice(0, mid)
  }

  const parent = n.parent
  if (parent === null) {
    // 分裂的是根：造一个新根，树长高一层
    const root = mwNew(t, false)
    const rootN = t.nodes.get(root)!
    rootN.keys = [up]
    rootN.children = [i, right]
    n.parent = root
    rn.parent = root
    t.root = root
  } else {
    const pn = t.nodes.get(parent)!
    let pos = 0
    while (pos < pn.keys.length && pn.keys[pos]! < up) pos++
    pn.keys.splice(pos, 0, up)
    const ci = pn.children.indexOf(i)
    pn.children.splice(ci < 0 ? pn.children.length : ci + 1, 0, right)
    rn.parent = parent
  }
  return { up, right }
}

/** 每个结点的层号（根是第 1 层），用来在 sub 里标"第几层" */
function mwDepths(t: MwTree): Map<number, number> {
  const d = new Map<number, number>()
  if (t.root === null) return d
  const queue: Array<[number, number]> = [[t.root, 1]]
  while (queue.length) {
    const [i, lv] = queue.shift()!
    if (d.has(i)) continue
    d.set(i, lv)
    for (const c of t.nodes.get(i)!.children) queue.push([c, lv + 1])
  }
  return d
}

/**
 * 中序序列（升序）。
 * B 树的关键字"只存一份"、内部结点里也有真关键字，所以必须**穿插**着走：
 * 走一棵子树、输出一个关键字、再走下一棵子树。
 * （B+ 树的关键字全在叶子层，用 mwLeafKeys 取叶子那一串就行，走中序反而会把索引副本重复输出。）
 */
function mwInorder(t: MwTree): number[] {
  const out: number[] = []
  const walk = (i: number | null): void => {
    if (i === null) return
    const n = t.nodes.get(i)
    if (!n) return
    if (n.leaf) {
      out.push(...n.keys)
      return
    }
    for (let k = 0; k < n.keys.length; k++) {
      walk(n.children[k] ?? null)
      out.push(n.keys[k]!)
    }
    walk(n.children[n.keys.length] ?? null)
  }
  walk(t.root)
  return out
}

/** 叶子层从左到右的关键字（B+ 树的链表顺序 / B 树的中序序列） */
function mwLeaves(t: MwTree): MwNode[] {
  const out: MwNode[] = []
  const walk = (i: number | null): void => {
    if (i === null) return
    const n = t.nodes.get(i)
    if (!n) return
    if (n.leaf) {
      out.push(n)
      return
    }
    for (const c of n.children) walk(c)
  }
  walk(t.root)
  return out
}

function mwLeafChainText(t: MwTree): string {
  return mwLeaves(t)
    .map((n) => `[${n.keys.join(' ')}]`)
    .join(' → ')
}

/** 叶子层从左到右的全部关键字（B+ 树的数据全在叶子层，这一串就是它的全部关键字） */
function mwLeafKeys(t: MwTree): number[] {
  return mwLeaves(t).flatMap((n) => n.keys)
}

interface MwViewOpts {
  hot?: number[]
  done?: number[]
  pointers?: Record<string, number | null>
  note?: string
}

/** 内部的多路树 -> TreeView（多关键字结点用 keys 画宽框，父子关系用 children） */
function mwView(t: MwTree, opts: MwViewOpts = {}): TreeView {
  const depth = mwDepths(t)
  const nodes: TreeNodeSnapshot[] = []
  for (const [i, n] of t.nodes) {
    const snap: TreeNodeSnapshot = {
      id: n.id,
      // keys 填了之后 value 会被渲染器忽略，这里仍给一个可读的兜底
      value: n.keys.join(' '),
      keys: n.keys.map(String),
      children: n.children.map((c) => t.nodes.get(c)!.id),
      parent: n.parent === null ? null : t.nodes.get(n.parent)!.id,
      // B 树标层号；B+ 树标"叶子 / 索引"，一眼看出内部结点只当索引
      sub: t.plus ? (n.leaf ? '叶子' : '索引') : `第${depth.get(i) ?? 1}层`,
    }
    nodes.push(snap)
  }
  const idOf = (i: number | null | undefined): string | null =>
    i === null || i === undefined ? null : (t.nodes.get(i)?.id ?? null)
  const pointers: Record<string, string | null> = {}
  for (const [name, i] of Object.entries(opts.pointers ?? {})) pointers[name] = idOf(i)

  const links: Array<{ from: string; to: string; kind: 'thread' }> = []
  if (t.plus) {
    // 叶子之间的 next 指针：画成橙色虚线，这就是 B+ 树那条"叶子链表"
    for (const [, n] of t.nodes) {
      if (n.leaf && n.next !== null) {
        links.push({ from: n.id, to: t.nodes.get(n.next)!.id, kind: 'thread' })
      }
    }
  }

  return {
    nodes,
    root: idOf(t.root),
    hot: (opts.hot ?? []).map((i) => idOf(i)).filter((x): x is string => x !== null),
    done: (opts.done ?? []).map((i) => idOf(i)).filter((x): x is string => x !== null),
    pointers,
    links,
    note: opts.note,
  }
}

/** 结点内定出"该走第几个孩子"时，用一句话描述那个孩子的关键字范围 */
function childRangeText(n: MwNode, i: number, plus: boolean): string {
  const lo = i > 0 ? n.keys[i - 1]! : null
  const hi = i < n.keys.length ? n.keys[i]! : null
  const loOp = plus ? '≥' : '>'
  if (lo === null && hi === null) return '不管什么关键字都走它'
  if (lo === null) return `key < ${hi}`
  if (hi === null) return `key ${loOp} ${lo}`
  return plus ? `${lo} ≤ key < ${hi}` : `${lo} < key ≤ ${hi}`
}

// ===========================================================================
// 三、B 树
// ===========================================================================

const BTREE_CODE = [
  '/* ====== 一、插入：关键字多了就"分裂"，中间的关键字升到父结点 ====== */',
  '#define M 3                       // 阶 m = 3：每个结点最多 3 个孩子、2 个关键字',
  'void BTreeInsert(BTree &T, int key) {',
  '  if (T.root == NULL) {                    // 空树：新建一个叶子当根',
  '    T.root = newNode(leaf, key); return;',
  '  }',
  '  BNode *p = T.root;                       // ① 从根往下，找 key 该去哪个叶子',
  '  while (!p->leaf) {',
  '    int i = 0;                             //    结点内从小到大顺序比较',
  '    while (i < p->n && key > p->key[i]) i++;   // 定出走第几个孩子',
  '    p = p->child[i];',
  '  }',
  '  insertIntoNode(p, key);                  // ② 把 key 按序插进这个叶子',
  '  while (p->n > M - 1) {                   // ③ 关键字超过 m-1 = 2：必须分裂',
  '    int mid = p->n / 2;                    //    中间那个关键字要升到父结点',
  '    BNode *r = splitRight(p, mid);         //    右半边搬进新结点 r，mid 交给父结点',
  '    if (p->parent == NULL) {               //    分裂的是根：造新根，树长高一层',
  '      T.root = newRoot(p->key[mid], p, r);',
  '    } else {',
  '      insertIntoNode(p->parent, p->key[mid]);   // 父结点多一个关键字',
  '      linkChild(p->parent, r);                  // 父结点也多一个孩子',
  '    }',
  '    p = p->parent;                         //    父结点可能也超了，继续往上分裂',
  '  }',
  '}',
  '/* ====== 二、查找：结点内顺序比较，比不中就下到对应的子树 ====== */',
  'BNode *BTreeSearch(BTree T, int key) {',
  '  BNode *p = T.root;',
  '  while (p != NULL) {',
  '    int i = 0;',
  '    while (i < p->n && key > p->key[i]) i++;    // 结点内顺序比较',
  '    if (i < p->n && key == p->key[i]) return p; // 命中：就在这个结点里',
  '    if (p->leaf) return NULL;                   // 到叶子还没命中 -> 失败',
  '    p = p->child[i];                            // 否则进对应的子树接着找',
  '  }',
  '  return NULL;',
  '}',
]

function* runBTree(data: number[], ctx: RunnerContext = {}): AlgoRunner {
  // 关键字按**升序**一个个插入：B 树"填满就分裂"的过程看得最清楚
  const keys = distinctKeys(data)
  const t = mwSetup(keys, false)

  const frame = (
    line: number,
    action: StepAction,
    comment: string,
    vars: Record<string, number>,
    opts: MwViewOpts = {},
  ): AlgoEvent => ({
    line,
    action,
    array: keys.slice(),
    tree: mwView(t, opts),
    comment,
    vars,
  })

  yield frame(
    3,
    'mark',
    `B 树是一棵"多路平衡查找树"。阶 m = 3 的意思是：每个结点最多 3 个孩子、2 个关键字；除根以外每个结点至少有 ⌈m/2⌉ = 2 个孩子；所有叶子都在同一层 —— 所以从根到任何叶子的路径长度都一样长。先把第一个关键字 ${keys[0]} 放进空树（它既是根也是叶子）。下面把升序排好的 ${keys.length} 个关键字一个个插进去，看它什么时候**分裂**`,
    { 插入值: keys[0] ?? 0, 结点数: 1, 阶: MW_M },
    { pointers: { p: t.root }, note: '每个结点最多装 m-1 = 2 个关键字，装不下就分裂' },
  )

  let splits = 0
  for (let k = 1; k < keys.length; k++) {
    const key = keys[k]!
    yield frame(
      7,
      'mark',
      `插入第 ${k + 1} 个关键字 ${key}：从根结点开始往下，逐层找它该去哪个叶子。内部结点里只做"比大小、挑孩子"，真正插入一定发生在叶子层`,
      { 插入值: key, 结点数: t.nodes.size },
      { pointers: { p: t.root }, note: `p 从根出发去找 ${key} 该去的叶子` },
    )

    // ① 往下走到叶子（沿途每个内部结点都比一次）
    let p = t.root!
    while (!t.nodes.get(p)!.leaf) {
      const n = t.nodes.get(p)!
      let i = 0
      while (i < n.keys.length && key > n.keys[i]!) i++
      yield frame(
        10,
        'compare',
        `在结点 [${n.keys.join(' ')}] 里顺序比较，定出范围：${childRangeText(n, i, false)}，所以走第 ${i + 1} 个孩子`,
        { 插入值: key, 结点数: t.nodes.size, 层: mwDepths(t).get(p) ?? 1 },
        { hot: [p], pointers: { p }, note: `第 ${i + 1} 个孩子` },
      )
      p = n.children[i]!
    }

    // ② 插进叶子
    const leaf = t.nodes.get(p)!
    const leafBefore = leaf.keys.join(' ')
    let pos = 0
    while (pos < leaf.keys.length && leaf.keys[pos]! < key) pos++
    leaf.keys.splice(pos, 0, key)
    yield frame(
      13,
      'set',
      `走到叶子 [${leafBefore}]：在结点内把 ${key} 按序插进去 → [${leaf.keys.join(' ')}]${leaf.keys.length > MW_MAX_KEYS ? ` —— 现在有 ${leaf.keys.length} 个关键字，超过上限了` : '，没超过上限，插入就算完成'}`,
      { 插入值: key, 结点数: t.nodes.size },
      { hot: [p], pointers: { p }, note: '关键字只能插在叶子层' },
    )

    // ③ 关键字超了就往上一路分裂
    let node = p
    while (t.nodes.get(node)!.keys.length > MW_MAX_KEYS) {
      const n = t.nodes.get(node)!
      const before = n.keys.join(' ')
      const parentKeysBefore = n.parent === null ? '' : t.nodes.get(n.parent)!.keys.join(' ')
      yield frame(
        14,
        'mark',
        `结点 [${before}] 有 ${n.keys.length} 个关键字，超过了 m − 1 = 2 —— 必须**分裂**：把中间的关键字交给父结点，剩下的关键字连同各自的子树分成左右两半`,
        { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
        { hot: [node], pointers: { p: node }, note: '关键字超了：这个结点要分裂' },
      )
      const rootBefore = t.root
      const { up, right } = mwSplit(t, node)
      splits += 1
      const nn = t.nodes.get(node)!
      const rn = t.nodes.get(right)!
      if (t.root !== rootBefore) {
        yield frame(
          18,
          'set',
          `分裂的正好是根结点：新建一个根 [${up}]，原来的 [${nn.keys.join(' ')}] 当左孩子、新结点 [${rn.keys.join(' ')}] 当右孩子 —— 整棵树长高了一层，但**所有叶子仍然在同一层**（B 树的平衡就是靠这个"从根往下长"保住的）`,
          { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
          { hot: [t.root!, node, right], pointers: { p: t.root }, note: '根分裂：树长高一层' },
        )
      } else {
        const parent = nn.parent!
        const pn = t.nodes.get(parent)!
        yield frame(
          20,
          'set',
          `中间的关键字 ${up} 升到父结点：父结点的关键字由 [${parentKeysBefore}] 变成 [${pn.keys.join(' ')}]；新结点 [${rn.keys.join(' ')}] 也挂到父结点下面 —— 父结点现在有 ${pn.keys.length} 个关键字、${pn.children.length} 个孩子`,
          { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
          { hot: [parent], pointers: { p: parent }, note: '父结点多一个关键字、多一个孩子' },
        )
      }
      node = nn.parent!
    }

    yield frame(
      24,
      'mark',
      `插入 ${key} 完成：树上共 ${t.nodes.size} 个结点，把关键字按中序读出来是 ${mwInorder(t).join(' → ')}`,
      { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
      { note: '所有叶子还是同一层，树依然平衡' },
    )
  }

  // ---------------- 查找 ----------------
  const nodeCount = t.nodes.size
  const layers = Math.max(...[...mwDepths(t).values()])
  const target =
    ctx.target !== undefined && Number.isFinite(ctx.target) ? ctx.target : keys[keys.length - 1]!
  const miss = pickGapKey(keys, target)

  yield frame(
    26,
    'mark',
    `关键字全部插完，B 树建好了：${keys.length} 个关键字、${nodeCount} 个结点、树高 ${layers} 层。下面演示查找 —— 先找树里有的 ${target}，再找树里没有的 ${miss} 做对照`,
    { 关键字数: keys.length, 结点数: nodeCount, 树高: layers },
    { hot: [t.root!], pointers: { p: t.root }, note: '查找也从根结点出发' },
  )

  function* searchOnce(key: number, round: number): Generator<AlgoEvent, boolean, void> {
    yield frame(
      27,
      'mark',
      `第 ${round} 次查找：target = ${key}，从根结点 [${t.nodes.get(t.root!)!.keys.join(' ')}] 开始`,
      { target: key, 比较结点数: 0 },
      { hot: [t.root!], pointers: { p: t.root }, note: `查找 ${key}` },
    )
    let p: number | null = t.root
    let visited = 0
    while (p !== null) {
      const n = t.nodes.get(p)!
      visited += 1
      let i = 0
      while (i < n.keys.length && key > n.keys[i]!) i++
      if (i < n.keys.length && n.keys[i] === key) {
        yield frame(
          32,
          'done',
          `在第 ${visited} 个结点 [${n.keys.join(' ')}] 里比到第 ${i + 1} 个关键字：${key} == ${n.keys[i]}，命中！查找成功`,
          { target: key, 比较结点数: visited },
          { hot: [p], done: [p], pointers: { p }, note: '命中：这个结点标绿' },
        )
        return true
      }
      if (n.leaf) {
        yield frame(
          33,
          'mark',
          `这里已经是叶子 [${n.keys.join(' ')}]，结点内没比到 ${key}，而叶子下面再没有孩子了 —— 查找失败，树里没有 ${key}`,
          { target: key, 比较结点数: visited },
          { hot: [p], pointers: { p }, note: '到了叶子还没命中 = 查找失败' },
        )
        return false
      }
      yield frame(
        34,
        'compare',
        `第 ${visited} 个结点 [${n.keys.join(' ')}] 里没有 ${key}，但按大小它落在第 ${i + 1} 个孩子的范围里（${childRangeText(n, i, false)}）—— 下到那棵子树接着找`,
        { target: key, 比较结点数: visited },
        { hot: [p], pointers: { p }, note: `进入第 ${i + 1} 棵子树` },
      )
      p = n.children[i] ?? null
    }
    return false
  }

  const hit = yield* searchOnce(target, 1)
  yield frame(
    29,
    'mark',
    hit
      ? `${target} 找到了。再查一个**不存在**的关键字 ${miss} 做对照：它落在两个相邻关键字的中间，看它是怎么一路走到叶子然后失败的`
      : `${target} 不在树里。再查一个存在的关键字 ${miss} 做对照`,
    { target: miss },
    { hot: [t.root!], pointers: { p: t.root }, note: '命中、失败两种情况都演一遍' },
  )
  yield* searchOnce(miss, 2)

  yield frame(
    37,
    'done',
    `演示结束。B 树的三个要点：① 一个结点里装多个关键字（这里最多 2 个），所以树比二叉排序树**矮**得多，读磁盘的次数就少；② 关键字超了就把中间的那个**升到父结点**、自己裂成两半，根分裂时树长高一层；③ 所有叶子都在同一层，任何查找都一定走到叶子层，比较次数稳定在 O(log n)。当前中序序列 ${mwInorder(t).join(' → ')}`,
    { 关键字数: keys.length, 结点数: t.nodes.size, 分裂次数: splits, 树高: layers },
    { done: [...t.nodes.keys()], note: `共分裂 ${splits} 次；所有叶子都在第 ${layers} 层` },
  )
}

// ===========================================================================
// 四、B+ 树
// ===========================================================================

const BPLUS_CODE = [
  '/* ====== 一、插入：关键字一律插到叶子层，内部结点只当"索引" ====== */',
  '#define M 3                       // 阶 m = 3',
  'void BPlusInsert(BPlus &T, int key) {',
  '  if (T.root == NULL) { T.root = newLeaf(key); return; }',
  '  BNode *p = T.root;                     // ① 从根一直往下走到叶子',
  '  while (!p->leaf) {',
  '    int i = 0;',
  '    while (i < p->n && key >= p->key[i]) i++;  // 只看索引：不小于索引就往右走',
  '    p = p->child[i];',
  '  }',
  '  insertIntoLeaf(p, key);                // ② 关键字只能插在叶子层',
  '  while (p->n > M - 1) {                 // ③ 关键字超了：分裂',
  '    BNode *r = splitRight(p);            //    右半边搬进新结点 r',
  '    int up = p->leaf ? r->key[0] : p->key[p->n / 2];  // 叶子"复制"，内部"搬走"',
  '    linkLeaf(p, r);                      // ④ 叶子链表接上：p->next = r（B+ 树特有）',
  '    if (p->parent == NULL) T.root = newRoot(up, p, r);',
  '    else { insertIntoNode(p->parent, up); linkChild(p->parent, r); }',
  '    p = p->parent;                       //    父结点可能也超了，继续往上',
  '  }',
  '}',
  '/* ====== 二、查找：不管查哪个关键字，最后一定落到叶子层 ====== */',
  'BNode *BPlusSearch(BPlus T, int key) {',
  '  BNode *p = T.root;',
  '  while (!p->leaf) {',
  '    int i = 0;',
  '    while (i < p->n && key >= p->key[i]) i++;   // 内部结点只当路标',
  '    p = p->child[i];',
  '  }',
  '  int i = 0;',
  '  while (i < p->n && p->key[i] < key) i++;      // 到了叶子才真正比较关键字',
  '  return (i < p->n && p->key[i] == key) ? p : NULL;',
  '}',
  '/* 和 B 树的区别：① 关键字全都出现在叶子层，内部结点只是索引的副本（会有重复）；',
  '   ② 叶子之间用 next 指针串成一条有序链表，范围查找只要顺着叶子走；',
  '   ③ 每次查找都要走到叶子，路径长度都一样，性能非常稳定 —— 数据库索引爱用它。 */',
]

function* runBPlusTree(data: number[], ctx: RunnerContext = {}): AlgoRunner {
  const keys = distinctKeys(data)
  const t = mwSetup(keys, true)

  const frame = (
    line: number,
    action: StepAction,
    comment: string,
    vars: Record<string, number>,
    opts: MwViewOpts = {},
  ): AlgoEvent => ({
    line,
    action,
    array: keys.slice(),
    tree: mwView(t, opts),
    comment,
    vars,
  })

  yield frame(
    3,
    'mark',
    `B+ 树是 B 树的改良版，阶同样是 m = 3（每个结点最多 2 个关键字、3 个孩子），但有两条硬规矩：① **所有关键字都必须出现在叶子层**，内部结点里放的是"索引"（是它右边那棵子树里最小的关键字，只是一个副本）；② **叶子之间用 next 指针串成一条有序链表**（画面上叶子层那条橙色虚线）。先把第一个关键字 ${keys[0]} 放进空树。下面同样是升序一个个插入`,
    { 插入值: keys[0] ?? 0, 结点数: 1, 阶: MW_M },
    { pointers: { p: t.root }, note: 'sub 写"叶子 / 索引"：内部结点只当索引' },
  )

  let splits = 0
  for (let k = 1; k < keys.length; k++) {
    const key = keys[k]!
    yield frame(
      5,
      'mark',
      `插入第 ${k + 1} 个关键字 ${key}：从根出发往下走。注意内部结点的比较只是"看路标"——${key} 不小于这个索引就往右边的孩子走，最后一定落到某个叶子上`,
      { 插入值: key, 结点数: t.nodes.size },
      { pointers: { p: t.root }, note: `从根往下找存放 ${key} 的那个叶子` },
    )

    // ① 走到叶子
    let p = t.root!
    while (!t.nodes.get(p)!.leaf) {
      const n = t.nodes.get(p)!
      let i = 0
      while (i < n.keys.length && key >= n.keys[i]!) i++
      yield frame(
        8,
        'compare',
        `内部结点（索引）[${n.keys.join(' ')}]：${childRangeText(n, i, true)}，所以走第 ${i + 1} 个孩子。这里比的是**索引的副本**，不是真正的数据`,
        { 插入值: key, 结点数: t.nodes.size },
        { hot: [p], pointers: { p }, note: '内部结点只用来指路' },
      )
      p = n.children[i]!
    }

    // ② 插进叶子
    const leaf = t.nodes.get(p)!
    const leafBefore = leaf.keys.join(' ')
    let pos = 0
    while (pos < leaf.keys.length && leaf.keys[pos]! < key) pos++
    leaf.keys.splice(pos, 0, key)
    yield frame(
      11,
      'set',
      `走到叶子 [${leafBefore}]，把 ${key} 插进去 → [${leaf.keys.join(' ')}]。B+ 树里**只有叶子层存关键字**，所以插入动作永远发生在这一层${leaf.keys.length > MW_MAX_KEYS ? `；现在它有 ${leaf.keys.length} 个关键字，超上限了` : '；没超上限，插入完成'}`,
      { 插入值: key, 结点数: t.nodes.size },
      { hot: [p], pointers: { p }, note: '关键字只插在叶子层' },
    )

    // ③ 分裂
    let node = p
    while (t.nodes.get(node)!.keys.length > MW_MAX_KEYS) {
      const n = t.nodes.get(node)!
      const before = n.keys.join(' ')
      const isLeaf = n.leaf
      const parentKeysBefore = n.parent === null ? '' : t.nodes.get(n.parent)!.keys.join(' ')
      yield frame(
        12,
        'mark',
        `结点 [${before}] 有 ${n.keys.length} 个关键字，超过 m − 1 = 2 —— 分裂：右半边搬进新结点${isLeaf ? '，因为关键字必须留在叶子层，所以把右边第一个关键字**复制**一份交给父结点当索引' : '（内部结点只当索引，所以中间那个关键字直接**搬**上去，不用留副本）'}`,
        { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
        { hot: [node], pointers: { p: node }, note: isLeaf ? '叶子分裂：索引是复制上去的' : '索引结点分裂' },
      )
      const rootBefore = t.root
      const { up, right } = mwSplit(t, node)
      splits += 1
      const nn = t.nodes.get(node)!
      const rn = t.nodes.get(right)!

      if (isLeaf) {
        yield frame(
          14,
          'set',
          `叶子分裂完成：左叶子 [${nn.keys.join(' ')}]、右叶子 [${rn.keys.join(' ')}]，关键字 ${up} **复制**一份给父结点当索引（关键字自己还留在右叶子里 —— 这是 B+ 树和 B 树最大的不同：B 树分裂时中间的关键字是"搬走"的，树里只出现一次）`,
          { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
          { hot: [node, right], pointers: { p: node }, note: '关键字留在叶子层，索引只是副本' },
        )
        yield frame(
          15,
          'set',
          `同时把新叶子接进叶子链表：${mwLeafChainText(t)} —— 这条链表让 B+ 树做**范围查找**时（比如"查 20 到 60 之间的所有数"）只要顺着叶子一路往右走，完全不用回到上层`,
          { 插入值: key, 结点数: t.nodes.size },
          { hot: [node, right], pointers: { p: node }, note: '叶子链表：画面上叶子层那条橙色虚线' },
        )
      } else {
        yield frame(
          14,
          'set',
          `索引结点分裂完成：中间的关键字 ${up} 搬到父结点当索引，左半边 [${nn.keys.join(' ')}]、右半边 [${rn.keys.join(' ')}]`,
          { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
          { hot: [node, right], pointers: { p: node }, note: '索引结点分裂：中间的关键字搬上去' },
        )
      }

      if (t.root === rootBefore) {
        const parent = nn.parent!
        const pn = t.nodes.get(parent)!
        yield frame(
          17,
          'set',
          `把索引 ${up} 插进父结点：父结点由 [${parentKeysBefore}] 变成 [${pn.keys.join(' ')}]，新结点 [${rn.keys.join(' ')}] 也挂到它下面（父结点现在 ${pn.keys.length} 个索引、${pn.children.length} 个孩子）`,
          { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
          { hot: [parent], pointers: { p: parent }, note: '父结点多一个索引 + 一个孩子' },
        )
      } else {
        yield frame(
          16,
          'set',
          `分裂的正好是根：新建一个索引根 [${up}]，左孩子 [${nn.keys.join(' ')}]、右孩子 [${rn.keys.join(' ')}] —— 树长高一层。因为内部结点不存数据，同样大小的结点能装更多"路标"，所以 B+ 树比 B 树更矮`,
          { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
          { hot: [t.root!, node, right], pointers: { p: t.root }, note: '根分裂：树长高一层' },
        )
      }
      node = nn.parent!
    }

    yield frame(
      19,
      'mark',
      `插入 ${key} 完成：叶子链表是 ${mwLeafChainText(t)}`,
      { 插入值: key, 结点数: t.nodes.size, 分裂次数: splits },
      { note: '所有关键字都能在叶子层找到；叶子之间按大小串成链表' },
    )
  }

  // ---------------- 查找 ----------------
  const nodeCount = t.nodes.size
  const layers = Math.max(...[...mwDepths(t).values()])
  const target =
    ctx.target !== undefined && Number.isFinite(ctx.target) ? ctx.target : keys[keys.length - 1]!
  const miss = pickGapKey(keys, target)

  yield frame(
    21,
    'mark',
    `树建好了：${keys.length} 个关键字、${nodeCount} 个结点、树高 ${layers} 层；关键字全在叶子层（从左到右 ${mwLeafKeys(t).join(' → ')}），叶子链表 ${mwLeafChainText(t)}。下面演示查找：先找 ${target}（树里有），再找 ${miss}（树里没有）。B+ 树的查找有个特点 —— **不管找哪个关键字，都必须一路走到叶子层**`,
    { 关键字数: keys.length, 结点数: nodeCount, 树高: layers },
    { hot: [t.root!], pointers: { p: t.root }, note: '查找一定落到叶子层' },
  )

  function* searchOnce(key: number, round: number): Generator<AlgoEvent, boolean, void> {
    yield frame(
      22,
      'mark',
      `第 ${round} 次查找：target = ${key}，从索引根 [${t.nodes.get(t.root!)!.keys.join(' ')}] 出发`,
      { target: key, 比较结点数: 0 },
      { hot: [t.root!], pointers: { p: t.root }, note: `查找 ${key}` },
    )
    let p: number | null = t.root
    let visited = 0
    while (p !== null) {
      const n = t.nodes.get(p)!
      visited += 1
      if (!n.leaf) {
        let i = 0
        while (i < n.keys.length && key >= n.keys[i]!) i++
        yield frame(
          26,
          'compare',
          `内部结点（索引）[${n.keys.join(' ')}]：${childRangeText(n, i, true)}，走第 ${i + 1} 个孩子。这里只是拿索引指路 —— 就算要找的关键字正好等于某个索引，也**不能停下**，因为真正存数据的是叶子`,
          { target: key, 比较结点数: visited },
          { hot: [p], pointers: { p }, note: '索引命中也不停，继续往下' },
        )
        p = n.children[i] ?? null
        continue
      }
      let i = 0
      while (i < n.keys.length && n.keys[i]! < key) i++
      if (i < n.keys.length && n.keys[i] === key) {
        yield frame(
          31,
          'done',
          `到了叶子 [${n.keys.join(' ')}]，在里面顺序比较，第 ${i + 1} 个关键字就是 ${key} —— 命中！B+ 树的查找总是在叶子层结束：成功也在叶子、失败也在叶子`,
          { target: key, 比较结点数: visited },
          { hot: [p], done: [p], pointers: { p }, note: '命中：标绿的这个叶子' },
        )
        return true
      }
      yield frame(
        30,
        'mark',
        `到了叶子 [${n.keys.join(' ')}]，一条条比过去没有 ${key} —— 叶子是最后一层，往下没有结点了，查找失败：树里没有 ${key}`,
        { target: key, 比较结点数: visited },
        { hot: [p], pointers: { p }, note: '叶子层没找到 = 失败' },
      )
      return false
    }
    return false
  }

  const hit = yield* searchOnce(target, 1)
  yield frame(
    22,
    'mark',
    hit
      ? `${target} 命中。再查一个树里没有的 ${miss}：注意它走的路径和刚才一样长 —— 都是"从根一路到叶子"，所以 B+ 树的查找性能非常稳定（这是数据库愿意用它做索引的原因之一）`
      : `${target} 没找到。再查一个存在的关键字 ${miss} 做对照`,
    { target: miss },
    { hot: [t.root!], pointers: { p: t.root }, note: '不管成功失败，路径都要走到叶子层' },
  )
  yield* searchOnce(miss, 2)

  yield frame(
    35,
    'done',
    `演示结束。B+ 树和 B 树的区别小结：① **关键字位置**：B 树的关键字"只存一份"，可能在内部结点就命中；B+ 树**所有关键字都在叶子层**，内部结点只是索引副本（所以同一批关键字，B+ 树里会看到重复的数字）。② **指针**：B+ 树的叶子用 next 串成有序链表（橙色虚线），范围查找、顺序遍历顺着叶子走就行；B 树没有这条链，范围查找要反复回到上层。③ **查找代价**：B 树可能提前命中、也可能提前失败；B+ 树**每次都走到叶子**，路径长度完全一样，性能稳定、好估算。④ **树高**：内部结点不存数据，同样大小的结点能放更多路标，树更矮 —— 所以数据库和文件系统的索引几乎都用 B+ 树。最终叶子链表：${mwLeafChainText(t)}`,
    { 关键字数: keys.length, 结点数: t.nodes.size, 分裂次数: splits, 树高: layers },
    { done: [...t.nodes.keys()], note: '所有关键字都在叶子层，叶子之间串成链表' },
  )
}

// ===========================================================================
// 五、注册用的 spec
// ===========================================================================

/** 红黑树的默认插入序列：刚好把插入修复的三种情况都演一遍（见文件末尾说明） */
const RB_DATA = () => [10, 20, 30, 40, 35, 50, 45]

/** B 树 / B+ 树的默认数据（升序插入时，8 个关键字能演到 3 次分裂、其中一次是根分裂） */
const B_DATA = () => [17, 35, 6, 42, 8, 55, 29, 61]

function rbInitTree(data: number[]): TreeView {
  const keys = rbKeys(data)
  return rbView(rbSetup(keys), {
    pointers: { z: 0 },
    note: `空树里先放进第一个关键字 ${keys[0]}，它必须是黑色的根；接下来依次插入 ${keys.slice(1).join('、')}`,
  })
}

function mwInitTree(data: number[], plus: boolean): TreeView {
  const keys = distinctKeys(data)
  return mwView(mwSetup(keys, plus), {
    pointers: { p: 0 },
    note: plus
      ? `空树里先放进第一个关键字 ${keys[0]}；B+ 树的关键字一律插在叶子层，叶子之间用 next 串成链表`
      : `空树里先放进第一个关键字 ${keys[0]}；阶 m = 3，每个结点最多 2 个关键字，装不下就分裂`,
  })
}

export const searchTreeSpecs: AlgorithmSpec[] = [
  // ---------------- 红黑树 ----------------
  {
    id: 'rb-tree',
    name: '红黑树·插入与调整',
    category: 'search',
    group: '平衡二叉树',
    summary: '新结点先染红，按"叔叔的颜色"分三种情况修复：变色 / 旋转成外侧 / 旋转加变色',
    complexity: { time: 'O(log n)', space: 'O(1)（只要几个指针；旋转是常数次）' },
    renderer: 'tree',
    codeLines: RB_CODE,
    defaultData: RB_DATA,
    // 红黑树本身支持任意规模（数据一个一个插进去，结点数 = 数据个数），
    // 但默认数据只有恰好演全三种修复情况的那一条序列，规模也就在这个范围内
    sizes: TREE_SIZES,
    initComment: (data) =>
      `红黑树要满足 5 条性质：① 结点非红即黑 ② 根结点是黑色 ③ 空指针算黑色 ④ 红结点的孩子必须是黑色（不能红红相连）⑤ 从任一结点到每个空指针的黑结点个数相同。数据按插入顺序 ${rbKeys(data).join(' → ')} 一个个插进去，先放进第一个当黑根，后面每插一个都检查一遍性质`,
    initTree: rbInitTree,
    createRunner: runRbTree,
  },

  // ---------------- B 树 ----------------
  {
    id: 'b-tree',
    name: 'B 树·插入与查找',
    category: 'search',
    group: '多路平衡查找树',
    summary: '阶 m = 3：结点装满了就分裂，中间的关键字升到父结点；所有叶子都在同一层',
    complexity: { time: 'O(log n)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: BTREE_CODE,
    defaultData: B_DATA,
    // 关键字个数就是数据个数，5~12 个关键字都装得下（结点数不超过 10，画得清）
    sizes: TREE_SIZES,
    defaultTarget: (data) => {
      const keys = distinctKeys(data)
      return keys[keys.length - 1]!
    },
    initComment: (data) => {
      const keys = distinctKeys(data)
      return `B 树的"阶 m = 3"表示每个结点最多 3 个孩子、2 个关键字。把这 ${keys.length} 个关键字按升序 ${keys.join(' → ')} 一个个插进去：装不下的结点就分裂、把中间的关键字顶到父结点；插完再演示一次查找（树上有的、树上没有的各一次）`
    },
    initTree: (data) => mwInitTree(data, false),
    createRunner: runBTree,
  },

  // ---------------- B+ 树 ----------------
  {
    id: 'b-plus-tree',
    name: 'B+ 树·插入与查找',
    category: 'search',
    group: '多路平衡查找树',
    summary: '所有关键字都在叶子层，内部结点只当索引，叶子之间用链表串起来',
    complexity: { time: 'O(log n)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: BPLUS_CODE,
    defaultData: B_DATA,
    sizes: TREE_SIZES,
    defaultTarget: (data) => {
      const keys = distinctKeys(data)
      return keys[keys.length - 1]!
    },
    initComment: (data) => {
      const keys = distinctKeys(data)
      return `B+ 树和 B 树一样是阶 m = 3 的多路平衡查找树，但关键字全部放在叶子层，内部结点只存"索引"（副本）；叶子之间用 next 指针串成有序链表。把这 ${keys.length} 个关键字按升序 ${keys.join(' → ')} 插进去，每一步都盯着"关键字一定落在叶子上"和"叶子链表又接长了"这两件事`
    },
    initTree: (data) => mwInitTree(data, true),
    createRunner: runBPlusTree,
  },
]

/*
 * 红黑树默认插入序列 [10, 20, 30, 40, 35, 50, 45] 的设计（手算核对用）：
 *
 *   插入前：空树
 *   ① 10        空树 -> 10 是黑色的根（性质②）
 *   ② 20        挂在 10 右边、红色；父 10 是黑的 -> 不用调整
 *   ③ 30        挂在 20 右边、红色；父 20 是红的 -> 违反性质④。
 *               叔叔是 NIL（黑）且自己是"外侧"（右-右）-> 情况③：左旋 10 + 变色
 *               结果：20黑(10红 30红)
 *   ④ 40        挂在 30 右边、红色；父 30 红、叔叔 10 也是红 -> 情况①：变色
 *               （30、10 变黑，20 变红），z 上移到 20，它是根 -> 把根染黑
 *               结果：20黑(10黑 30黑(· 40红))
 *   ⑤ 35        20 -> 30 -> 40 左边、红色；父 40 红、叔叔是 NIL（黑），
 *               而自己是"内侧"（父 40 是祖父 30 的右孩子、自己在父的左边）
 *               -> 情况②：先对 40 右旋，35 升上来变成外侧；紧接着情况③：
 *                  对 30 左旋 + 变色（35 变黑、30 变红）
 *               结果：20黑(10黑 35黑(30红 40红))
 *   ⑥ 50        挂在 40 右边、红色；父 40 红、叔叔 30 红 -> 情况①：变色
 *               （40、30 变黑，35 变红），z 上移到 35，父 20 是黑的 -> 结束
 *               结果：20黑(10黑 35红(30黑 40黑(· 50红)))
 *   ⑦ 45        20 -> 35 -> 40 -> 50 左边、红色；父 50 红、叔叔 NIL（黑），
 *               自己在"内侧"（父 50 是祖父 40 的右孩子、自己在父的左边）
 *               -> 情况②：对 50 右旋，45 升上来；情况③：对 40 左旋 + 变色
 *               结果：20黑(10黑 35红(30黑 45黑(40红 50红)))
 *
 *   终态检查：根 20 是黑的（性质②）；红结点 35 的孩子是 30黑/45黑、
 *   40 的孩子都是 NIL、50 的孩子都是 NIL（性质④）；
 *   从 20 到每个空指针的黑结点个数都是 3（性质⑤）。
 */
