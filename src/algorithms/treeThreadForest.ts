import type {
  AlgorithmSpec,
  AlgoRunner,
  BoardView,
  CellItem,
  CellTone,
  TreeNodeSnapshot,
  TreeView,
} from '@/core/types'
import { makeCompleteTree, nodeId } from './treeTraverse'

/**
 * 树与森林 —— 线索二叉树 + 树的三种存储表示 + 树/森林的遍历与转换。
 *
 * 数据约定（和 treeTraverse 保持一致）：一维数字串按**层序**还原成结点，
 * 第 i 个元素就是结点 i，左右孩子是 2i+1 / 2i+2（线索化那两颗完全二叉树）。
 * 树与森林那五个算法共用一棵写死的 7 结点多叉树 / 三棵树的小森林，
 * 结构由下面的 PARENT_OF / FOREST_PARENT 唯一确定，不依赖数据内容。
 *
 * 快照约定：
 *   - 二叉树用 left / right，多叉树用 children，双亲表示法只填 parent；
 *   - 线索放在 threadPrev / threadNext 里（= 中序前驱 / 后继），
 *     ltag / rtag = true 表示"这一侧原来是空指针，现在被改成了线索"；
 *     连线只画**真的被替换掉的那几根**（画成橙色虚线），
 *     否则会和孩子的实线完全重叠（比如"有右孩子的结点"，它的中序后继就在右子树里）。
 *   - 虚线连线（线索 / 双亲）统一往 links 里塞。
 */
const MAX_NODES = 7

/** 样例多叉树的双亲下标：t0 -> t1,t2,t3；t1 -> t4,t5；t3 -> t6 */
const PARENT_OF = [-1, 0, 0, 0, 1, 1, 3]
/** 小森林：三棵互不相交的树，根分别是 t0 / t3 / t6 */
const FOREST_PARENT = [-1, 0, 0, -1, 3, 3, -1]
const FOREST_ROOTS = [0, 3, 6]

const tid = (i: number): string => `t${i}`

type TreeLink = { from: string; to: string; kind: 'thread' | 'parent' }

interface ViewOpts {
  root?: string | null
  roots?: string[]
  hot?: string[]
  done?: string[]
  pointers?: Record<string, string | null>
  links?: TreeLink[]
  note?: string
}

/** 树快照：每次都新建结点对象（含 children 数组），免得历史帧被后面的改动污染 */
function treeView(nodes: TreeNodeSnapshot[], opts: ViewOpts = {}): TreeView {
  return {
    nodes: nodes.map((n) => ({ ...n, children: n.children ? [...n.children] : undefined })),
    root: opts.root !== undefined ? opts.root : nodes.length ? nodes[0]!.id : null,
    roots: opts.roots ? [...opts.roots] : undefined,
    hot: opts.hot ? [...opts.hot] : [],
    done: opts.done ? [...opts.done] : [],
    pointers: opts.pointers ? { ...opts.pointers } : {},
    links: opts.links ? opts.links.map((l) => ({ ...l })) : undefined,
    note: opts.note,
  }
}

/** 按"双亲下标表"造出每个结点的孩子表（孩子表示法用的就是它） */
function childLists(parent: number[], n: number): string[][] {
  const cs: string[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    const p = parent[i]!
    if (p >= 0 && p < n) cs[p]!.push(tid(i))
  }
  return cs
}

function firstChildOf(cs: string[][], i: number): string | null {
  return cs[i]?.[0] ?? null
}

function nextSiblingOf(parent: number[], cs: string[][], i: number): string | null {
  const p = parent[i]!
  if (p < 0 || p >= cs.length) return null
  const sibs = cs[p]!
  const k = sibs.indexOf(tid(i))
  return k >= 0 && k + 1 < sibs.length ? sibs[k + 1]! : null
}

/** 这个结点是沿"孩子"指针还是沿"兄弟"指针连上来的（根结点单独标） */
function roleOf(parent: number[], cs: string[][], i: number): string {
  const p = parent[i]!
  if (p < 0 || p >= cs.length) return '根'
  return cs[p]![0] === tid(i) ? '孩子' : '兄弟'
}

/** 多叉树（孩子表示法）：结点上挂 children */
function multiNodes(data: number[], parent: number[], n: number): TreeNodeSnapshot[] {
  const cs = childLists(parent, n)
  return Array.from({ length: n }, (_, i) => ({
    id: tid(i),
    value: data[i]!,
    children: cs[i]!,
  }))
}

/** 孩子兄弟表示法（二叉链表）：left = 第一个孩子，right = 下一个兄弟 */
function csNodes(data: number[], n: number): TreeNodeSnapshot[] {
  const cs = childLists(PARENT_OF, n)
  return Array.from({ length: n }, (_, i) => ({
    id: tid(i),
    value: data[i]!,
    left: firstChildOf(cs, i),
    right: nextSiblingOf(PARENT_OF, cs, i),
    sub: roleOf(PARENT_OF, cs, i),
  }))
}

/* ================================================================== *
 * 一、线索二叉树
 * ================================================================== */

/**
 * 中序线索二叉树的结点：left / right 始终是**真孩子**，不动；
 * 线索放到 threadPrev / threadNext 里，ltag / rtag 记录"这一侧的空指针被改成了线索"。
 * 这样画面上"实线 = 孩子、橙色虚线 = 线索"一眼能分清。
 */
function threadNodes(data: number[]): TreeNodeSnapshot[] {
  return makeCompleteTree(data).map((n) => ({
    ...n,
    ltag: false,
    rtag: false,
    threadPrev: null,
    threadNext: null,
  }))
}

/** 结点下方小字 = ltag / rtag：L / R 表示这一侧已经改成线索，- 表示还是真孩子 */
const tagText = (n: TreeNodeSnapshot): string => `${n.ltag ? 'L' : '-'}${n.rtag ? 'R' : '-'}`
const tagNodes = (nodes: TreeNodeSnapshot[]): TreeNodeSnapshot[] =>
  nodes.map((n) => ({ ...n, sub: tagText(n) }))

interface ThreadedTree {
  nodes: TreeNodeSnapshot[]
  byId: Map<string, TreeNodeSnapshot>
  /** 中序序列（结点 id） */
  order: string[]
  /** 真正的线索（只画这些橙虚线） */
  links: TreeLink[]
}

/** 一次性把完全二叉树线索化（结果与"中序线索化"跑完时完全一致） */
function buildThreadedTree(data: number[]): ThreadedTree {
  const nodes = threadNodes(data)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const order: string[] = []
  const links: TreeLink[] = []
  let pre: string | null = null

  const visit = (id: string | null): void => {
    if (!id) return
    const n = byId.get(id)
    if (!n) return
    visit(n.left ?? null)
    const prev = pre
    // 走到 T 时，pre 就是 T 的中序前驱 —— 这条关系不管左指针空不空都成立
    n.threadPrev = prev
    if (prev) byId.get(prev)!.threadNext = id
    n.ltag = !n.left
    n.rtag = !n.right
    if (!n.left && prev) links.push({ from: id, to: prev, kind: 'thread' })
    if (prev && !byId.get(prev)!.right) links.push({ from: prev, to: id, kind: 'thread' })
    pre = id
    order.push(id)
    visit(n.right ?? null)
  }

  visit(nodes.length ? nodeId(0) : null)
  return { nodes, byId, order, links }
}

const CODE_THREAD_INORDER = [
  'void InThread(BiTree T, BiTree &pre) {',
  '  if (T == NULL) return;                   // 空树直接返回',
  '  InThread(T->left, pre);                  // ① 先线索化左子树',
  '  if (T->left == NULL) {                   // ② 左指针空 -> 改成指向前驱',
  '    T->left = pre;  T->ltag = 1;',
  '  }',
  '  if (pre != NULL && pre->right == NULL) { // ③ 前驱的右指针空 -> 改成指向后继',
  '    pre->right = T;  pre->rtag = 1;',
  '  }',
  '  pre = T;                                 // ④ pre 后移：它始终停在"上一个访问过的结点"上',
  '  InThread(T->right, pre);                 // ⑤ 再线索化右子树',
  '}',
]

function* runThreadInorder(data: number[]): AlgoRunner {
  const nodes = threadNodes(data)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const order: string[] = []
  const links: TreeLink[] = []
  let pre: string | null = null

  const val = (id: string | null | undefined): string => (id ? String(byId.get(id)?.value ?? '?') : 'NULL')
  const vals = (): number[] => order.map((id) => Number(byId.get(id)!.value))
  /*
   * snap 默认把"目前累积到的线索"带上（links: [...links]）。
   * 之前靠每个 yield 自己写 links，结果"进入结点、先线索化左子树"那一帧忘了写，
   * 橙虚线就闪没一帧、下一步又回来 —— 累积性的东西必须由 snap 统一兜底。
   */
  const snap = (o: ViewOpts = {}): TreeView => treeView(tagNodes(nodes), { links: [...links], ...o })
  const vars = () => ({ n: nodes.length, 中序序号: order.length, 线索条数: links.length })
  const seqText = () => order.map((id) => byId.get(id)!.value).join(' → ')

  yield {
    line: 1,
    action: 'init',
    array: vals(),
    tree: snap({
      pointers: { pre: null, T: nodes.length ? nodeId(0) : null },
      note: '中序线索化：pre 始终指向上一个访问过的结点',
    }),
    comment: '调用 InThread(T, pre)：pre 先置空，然后按"左 → 根 → 右"走一遍，边走边把空指针改成线索',
    vars: vars(),
  }

  if (!nodes.length) {
    yield {
      line: 12,
      action: 'done',
      array: [],
      tree: treeView([]),
      comment: '空树，不需要线索化',
      vars: { n: 0 },
    }
    return
  }

  function* walk(id: string | null): AlgoRunner {
    if (!id) return
    const n = byId.get(id)
    if (!n) return
    yield {
      line: 3,
      action: 'mark',
      array: vals(),
      tree: snap({
        hot: [id],
        done: [...order],
        pointers: { T: id, pre },
        note: `进入结点 ${n.value}：先线索化它的左子树`,
      }),
      comment: `进入结点 ${n.value}：按中序先递归线索化它的左子树`,
      vars: vars(),
    }
    yield* walk(n.left ?? null)

    // T 的中序前驱就是 pre（不管左指针空不空，这条关系都成立）
    const prev = pre
    n.threadPrev = prev
    if (prev) byId.get(prev)!.threadNext = id

    yield {
      line: 4,
      action: 'compare',
      array: vals(),
      tree: snap({
        hot: [id],
        done: [...order],
        pointers: { T: id, pre },
        links: [...links],
        note: `回到 ${n.value}：检查它的左指针是不是空的`,
      }),
      comment: `回到结点 ${n.value}：检查它的左指针是否为空（此刻 pre 指着 ${val(prev)}，也就是上一个访问过的结点）`,
      vars: vars(),
    }

    if (!n.left) {
      n.ltag = true
      if (prev) links.push({ from: id, to: prev, kind: 'thread' })
      yield {
        line: 5,
        action: 'set',
        array: vals(),
        tree: snap({
          hot: [id],
          done: [...order],
          pointers: { T: id, pre },
          links: [...links],
          note: `左指针空 → 改成指向前驱 ${val(prev)}，并把 ltag 置 1`,
        }),
        comment: `${n.value} 的左指针是空的 → 改成指向前驱 ${val(prev)}，并置 ltag = 1（画面上就是这根橙色虚线）`,
        vars: vars(),
      }
    }

    if (prev) {
      const p = byId.get(prev)!
      yield {
        line: 7,
        action: 'compare',
        array: vals(),
        tree: snap({
          hot: [prev],
          done: [...order],
          pointers: { pre: prev, T: id },
          links: [...links],
          note: `检查前驱 ${p.value} 的右指针是不是空的`,
        }),
        comment: `再检查前驱 ${p.value} 的右指针是否为空`,
        vars: vars(),
      }
      if (!p.right) {
        p.rtag = true
        links.push({ from: prev, to: id, kind: 'thread' })
        yield {
          line: 8,
          action: 'set',
          array: vals(),
          tree: snap({
            hot: [prev],
            done: [...order],
            pointers: { pre: prev, T: id },
            links: [...links],
            note: `前驱 ${p.value} 的右指针空 → 改成指向后继 ${n.value}，rtag = 1`,
          }),
          comment: `前驱 ${p.value} 的右指针是空的 → 改成指向后继 ${n.value}，并置 rtag = 1（又一根橙色虚线）`,
          vars: vars(),
        }
      }
    }

    pre = id
    order.push(id)
    yield {
      line: 10,
      action: 'mark',
      array: vals(),
      tree: snap({
        hot: [id],
        done: [...order],
        pointers: { pre: id },
        links: [...links],
        note: `访问 ${n.value}，随后 pre 后移到它身上`,
      }),
      comment: `访问结点 ${n.value}（中序第 ${order.length} 个）：pre 后移指向 ${n.value}，它现在就是"上一个访问过的结点"`,
      vars: vars(),
    }

    if (n.right) {
      yield {
        line: 11,
        action: 'mark',
        array: vals(),
        tree: snap({
          hot: [n.right],
          done: [...order],
          pointers: { pre: id },
          links: [...links],
          note: `继续线索化 ${n.value} 的右子树`,
        }),
        comment: `最后线索化 ${n.value} 的右子树（右孩子的值是 ${byId.get(n.right)?.value}）`,
        vars: vars(),
      }
      yield* walk(n.right)
    }
  }

  yield* walk(nodeId(0))

  // 中序最后一个结点的右指针也是空的（它的"后继"是 NULL），
  // 按教材写法同样把 rtag 置 1 —— 只是没有虚线可画
  const tail = order[order.length - 1]
  const tailNode = tail ? byId.get(tail) : undefined
  if (tailNode && !tailNode.right) tailNode.rtag = true

  yield {
    line: 12,
    action: 'done',
    array: vals(),
    tree: snap({
      done: [...order],
      links: [...links],
      note: '线索化完成：橙色虚线就是线索，顺着它走不用栈也不用递归',
    }),
    comment: `线索化完成：共建立 ${links.length} 条线索（中序最后一个结点 ${tailNode ? tailNode.value : ''} 的右指针空着，它的后继是 NULL，所以只置 rtag = 1、不画线），中序序列是 ${seqText()}`,
    vars: vars(),
  }
}

const CODE_THREAD_TRAVERSE = [
  'void InOrderTraverse_Thr(BiThrTree T) {',
  '  BiThrTree p = T;',
  '  if (p == NULL) return;                          // 空树直接返回',
  '  while (p->ltag == 0 && p->left) p = p->left;    // ① 一路向左，找到中序第一个结点',
  '  while (p != NULL) {',
  '    visit(p);                                     // ② 访问当前结点',
  '    if (p->rtag == 1) p = p->right;               // ③ 有右线索：顺着线索一步到后继',
  '    else {                                        // ④ 没有右线索：进右子树找',
  '      p = p->right;',
  '      while (p->ltag == 0 && p->left) p = p->left;  // 右子树里最左下的结点就是中序后继',
  '    }',
  '  }',
  '}',
]

function* runThreadTraverse(data: number[]): AlgoRunner {
  // links 必须一起解构出来：这是线索本身，不带上画面就一条橙虚线都没有
  const { nodes, byId, links } = buildThreadedTree(data)
  const visited: string[] = []

  const val = (id: string | null | undefined): string => (id ? String(byId.get(id)?.value ?? '?') : 'NULL')
  const vals = (): number[] => visited.map((id) => Number(byId.get(id)!.value))
  const snap = (o: ViewOpts = {}): TreeView => treeView(tagNodes(nodes), { links: [...links], ...o })
  const vars = () => ({ n: nodes.length, 遍历序号: visited.length })
  const seqText = () => visited.map((id) => byId.get(id)!.value).join(' → ')

  yield {
    line: 1,
    action: 'init',
    array: [],
    tree: snap({ pointers: { p: null }, note: '线索二叉树的遍历：不用栈、也不用递归' }),
    comment:
      '这棵二叉树已经中序线索化了（橙色虚线）。中序后继就存在空指针里，所以遍历时只要一个指针 p 一路走到底',
    vars: { n: nodes.length, 遍历序号: 0 },
  }

  if (!nodes.length) {
    yield { line: 13, action: 'done', array: [], tree: treeView([]), comment: '空树，直接结束', vars: { n: 0 } }
    return
  }

  let p: string | null = nodeId(0)
  yield {
    line: 2,
    action: 'mark',
    array: vals(),
    tree: snap({ hot: [p], pointers: { p }, note: 'p 从根出发' }),
    comment: `p 从根结点 ${val(p)} 出发（线索树里 left / right 上画的橙色虚线就是线索）`,
    vars: vars(),
  }

  // ① 一路向左：直到左指针是线索（说明左边没结点了）
  while (p) {
    const node: TreeNodeSnapshot | undefined = byId.get(p)
    if (!node || node.ltag || !node.left) break
    const nx: string = node.left
    yield {
      line: 4,
      action: 'mark',
      array: vals(),
      tree: snap({ hot: [nx], pointers: { p: nx }, note: `${node.value} 有左孩子，p 继续向左` }),
      comment: `${node.value} 的左指针指向真孩子 → p 向左移动到 ${val(nx)}`,
      vars: vars(),
    }
    p = nx
  }
  yield {
    line: 4,
    action: 'mark',
    array: vals(),
    tree: snap({ hot: p ? [p] : [], pointers: { p }, note: `p 停在 ${val(p)}：它就是中序第一个结点` }),
    comment: `p 停在 ${val(p)}：它的左指针已经是线索，说明左边再没有结点了 —— 它就是中序第一个结点`,
    vars: vars(),
  }

  // ② 顺着线索 / 右子树一路走完
  while (p) {
    const n: TreeNodeSnapshot = byId.get(p)!
    visited.push(p)
    yield {
      line: 6,
      action: 'mark',
      array: vals(),
      tree: snap({
        hot: [p],
        done: [...visited],
        pointers: { p },
        note: `访问第 ${visited.length} 个结点：${n.value}`,
      }),
      comment: `② 访问结点 ${n.value}，它是中序第 ${visited.length} 个`,
      vars: vars(),
    }

    if (n.rtag) {
      const nx: string | null = n.threadNext ?? null
      yield {
        line: 7,
        action: 'mark',
        array: vals(),
        tree: snap({
          hot: nx ? [nx] : [],
          done: [...visited],
          pointers: { p: nx },
          note: nx ? `${n.value} 有右线索，一步跳到后继 ${val(nx)}` : `${n.value} 的后继是 NULL，走完了`,
        }),
        comment: nx
          ? `③ ${n.value} 的右指针是线索 → 顺着它一步跳到中序后继 ${val(nx)}，不用栈也不用递归`
          : `③ ${n.value} 的右指针是线索，但后继是 NULL → 整棵树走完了`,
        vars: vars(),
      }
      p = nx
      continue
    }

    // ④ 没有右线索：进右子树，找最左下的结点
    let q: string | null = n.right ?? null
    yield {
      line: 9,
      action: 'mark',
      array: vals(),
      tree: snap({
        hot: q ? [q] : [],
        done: [...visited],
        pointers: { p: q },
        note: `${n.value} 没有右线索 → 进它的右子树`,
      }),
      comment: `④ ${n.value} 的右指针是真孩子，没有线索可走 → 进它的右子树，再一路向左找最左下的结点`,
      vars: vars(),
    }
    while (q) {
      const m = byId.get(q)!
      if (m.ltag || !m.left) break
      const nx = m.left
      yield {
        line: 10,
        action: 'mark',
        array: vals(),
        tree: snap({ hot: [nx], done: [...visited], pointers: { p: nx }, note: `一路向左：移到 ${val(nx)}` }),
        comment: `一路向左：p 从 ${m.value} 移到 ${val(nx)}`,
        vars: vars(),
      }
      q = nx
    }
    p = q
    if (p) {
      yield {
        line: 10,
        action: 'mark',
        array: vals(),
        tree: snap({ hot: [p], done: [...visited], pointers: { p }, note: `p 停在 ${val(p)}，它就是中序后继` }),
        comment: `p 停在 ${val(p)}：它是右子树里最左下的结点，也就是 ${n.value} 的中序后继`,
        vars: vars(),
      }
    } else {
      yield {
        line: 11,
        action: 'mark',
        array: vals(),
        tree: snap({ done: [...visited], pointers: { p: null }, note: `${n.value} 没有右子树，遍历到头了` }),
        comment: `${n.value} 没有右子树也没有右线索 → 它是中序最后一个结点，遍历结束`,
        vars: vars(),
      }
    }
  }

  yield {
    line: 13,
    action: 'done',
    array: vals(),
    tree: snap({ done: [...visited], pointers: { p: null }, note: '线索遍历完成：一个指针、两层循环就够了' }),
    comment: `遍历完成，中序序列是 ${seqText()}；和递归写法得到的序列一模一样，但全程没有用栈（辅助空间 O(1)）`,
    vars: vars(),
  }
}

/* ================================================================== *
 * 二、树的存储表示 / 树与森林的遍历与转换
 * ================================================================== */

/*
 * 存储结构板子。
 *
 * 这两种存储表示光看树看不出名堂 —— 树是"逻辑结构"，用户要看的是"存储结构"：
 * 底下那片用来存的数组到底长什么样、每一格存的是什么。
 * 所以每帧除了 tree 再给一块 boards，TreePanel 会自动把它接在树下面。
 */

/**
 * 双亲表示法的「连续存储空间」板子 —— 就是真正存树的那片一维数组。
 *
 * 用 grid 铺成**两行**（items 是行优先的，所以前 n 格是第一行、后 n 格是第二行）：
 *   上排 = 每个位置存的 data（小字写它在数组里的下标）
 *   下排 = 每个位置存的 parent（小字写"双亲"）
 * 同一列上下两格才是数组里的一个元素，读一列就知道"这一格存了什么"。
 *
 * 配色：
 *   hot  —— 本步正在写（或正在读）的位置，紫；
 *   done —— 已经写好的位置，绿；
 *   dim  —— 数组已经把位置开好了、但还没轮到填的空格，暗且不写字；
 *   mark —— 本步真正从里面读出答案的那一格（求双亲时就是下排那一格）。
 */
function parentReprBoard(
  data: number[],
  n: number,
  o: {
    /** 已经写好了几个位置；默认 = 全部 n 个 */
    filled?: number
    /** 本步正在处理的结点下标（它的数据格和双亲格一起上色） */
    hot?: number[]
    /** 已经处理完的结点下标 */
    done?: number[]
    /** 直接点名要画红的格子序号（0..2n-1），用来指"这一格就是答案" */
    marks?: number[]
    /** 已经填好的格子默认画成绿色；查询阶段传 'base'，让底表回到蓝色 */
    filledTone?: CellTone
    pointers?: Record<string, number>
    note: string
  },
): BoardView {
  const filled = o.filled ?? n
  const hot = new Set(o.hot ?? [])
  const done = new Set(o.done ?? [])
  const marks = new Set(o.marks ?? [])
  const items: CellItem[] = []

  // 行优先铺格子：序号 idx 在第 Math.floor(idx / n) 行、第 idx % n 列，
  // 所以 idx 和 idx + n 上下两格，正好是同一个数组元素的"数据 / 双亲"两项。
  for (let idx = 0; idx < 2 * n; idx++) {
    const k = idx % n
    const isParentRow = idx >= n
    const ok = k < filled
    const tone: CellTone = !ok
      ? 'dim'
      : marks.has(idx)
        ? 'mark'
        : hot.has(k)
          ? 'hot'
          : done.has(k)
            ? 'done'
            : (o.filledTone ?? 'done')
    items.push({
      // 根的双亲下标是 -1（它没有双亲），这一格照写不误 —— 它就是数组里存的值
      text: ok ? (isParentRow ? String(k === 0 ? -1 : PARENT_OF[k]!) : String(data[k]!)) : '',
      sub: ok ? (isParentRow ? '双亲' : `下标 ${k}`) : undefined,
      tone,
    })
  }

  return {
    title: '连续存储空间（一维数组，每格两项：数据 / 双亲下标）',
    layout: 'grid',
    cols: n,
    items,
    pointers: o.pointers ?? {},
    note: o.note,
  }
}

/** 顺序表里的一行：这个结点建出来了没有 + 它已经挂上去的孩子链表（存的是孩子下标） */
interface ChildReprRow {
  exists: boolean
  kids: number[]
}

/**
 * 孩子表示法的板子 —— 就按教材那张图画：
 *   **左列**是顺序表，一格一个结点（格里写数据，小字写它在数组里的下标）；
 *   **右边**从顺序表的格子向右伸出一串箭头，一支箭头连一个"孩子链表结点"，
 *   链表结点里存的是**孩子在数组里的下标**（小字写出这个下标对应的数据，好和树对上）。
 *   孩子链表为空的结点：右边第一格写 NULL（就是代码里的 firstchild = NULL），没有箭头。
 *
 * 格子按行优先摆，cols = 1 + 孩子最多的那个结点的孩子个数，于是：
 *   第 i 行第 0 格 = 顺序表里下标 i 那一项；
 *   第 i 行第 1..maxKids 格 = 它的孩子链表结点，从左往右一个接一个。
 * 箭头（links）只画**真的已经挂上去**的那几根：
 *   第 0 格 → 第 1 格（顺序表 → 第一个孩子）、第 1 格 → 第 2 格（第一个孩子 → 下一个孩子）……
 * 所以"建树"的过程在画面上就是箭头一格一格地长出来，叶子结点则一支箭头都没有。
 *
 * 配色：hot = 本步正在动的那一格（刚 malloc 出来的链表结点也用它），
 *       done = 已经建好的行，dim = 顺序表开好了位置但还没建到它 / 链表已经到底的空位。
 *
 * 注意：这块板子**不挂 pointers**。
 * ScenePanel 给"有指针的板子"加了 padding-top: 24px（好让第一行的指针标签不压住标题），
 * 而画连线的那层 SVG 是按 top: 0 绝对定位的，两者一叠加，箭头会整体上移 24px、
 * 落在行与行之间的缝里（实测：格子中心在 y=490，箭头却画在 y=461~468，正好是格子的上边缘）。
 * 孩子链表全靠箭头表达，所以这里宁可不挂指针标签：指针位置改用紫色高亮 + note 文字说清楚。
 */
function childReprBoard(
  data: number[],
  rows: ChildReprRow[],
  o: {
    /** 孩子最多的那个结点有几个孩子 —— 顺序表右边就给孩子链表留几格 */
    maxKids: number
    hotRows?: number[]
    doneRows?: number[]
    /** 本步刚挂到孩子链表上的那一格：[第几行, 它在孩子链表里第几个] */
    hotKid?: [number, number]
    /** 本步 malloc 出来、还没接到链上的那个链表结点：[挂在第几行, 它的 child 值] */
    pending?: [number, number]
    note: string
  },
): BoardView {
  const cols = 1 + o.maxKids
  const hot = new Set(o.hotRows ?? [])
  const done = new Set(o.doneRows ?? [])
  const items: CellItem[] = []
  const links: Array<{ from: number; to: number; dir: 'right' }> = []

  rows.forEach((row, i) => {
    // 第 0 格：顺序表里下标 i 那一项。位置是数组一开始就开好的，内容要等建到它才写上去
    const rowTone: CellTone = !row.exists
      ? 'dim'
      : hot.has(i)
        ? 'hot'
        : done.has(i)
          ? 'done'
          : 'base'
    items.push({ text: String(data[i]!), sub: `下标 ${i}`, tone: rowTone })

    for (let k = 0; k < o.maxKids; k++) {
      const j = row.kids[k]
      if (!row.exists) {
        items.push({ text: '', tone: 'dim' })
        continue
      }
      // 本步刚 malloc 出来的链表结点：先摆在这一格上，箭头要等下一步接上去才画
      if (j === undefined && o.pending && o.pending[0] === i && k === row.kids.length) {
        const child = o.pending[1]
        items.push({ text: String(child), sub: `值${data[child]!}`, tone: 'hot' })
        continue
      }
      if (j === undefined) {
        // 孩子链表到底了：没有孩子的结点在第一格写 NULL，后面的格子本来就该空着
        items.push(k === 0 ? { text: 'NULL', sub: '无孩子', tone: 'dim' } : { text: '', tone: 'dim' })
        continue
      }
      items.push({
        text: String(j),
        sub: `值${data[j]!}`,
        tone: o.hotKid && o.hotKid[0] === i && o.hotKid[1] === k ? 'hot' : 'base',
      })
    }

    // 箭头：第 0 格 → 第 1 格 → 第 2 格 …… 一条孩子链表一格接一格连到底
    for (let k = 0; k < row.kids.length && k + 1 <= o.maxKids; k++) {
      links.push({ from: i * cols + k, to: i * cols + k + 1, dir: 'right' })
    }
  })

  return {
    title: '孩子表示法：顺序表（左列）+ 孩子链表（向右的箭头）',
    layout: 'grid',
    cols,
    items,
    links,
    note: o.note,
  }
}

const CODE_PARENT = [
  '// 双亲表示法：每个结点只存"双亲在数组里的下标"，根结点的 parent = -1',
  'typedef struct {',
  '  ElemType data;                    // 结点本身的值',
  '  int parent;                       // 双亲的下标；根结点存 -1',
  '} PTNode;',
  'typedef struct {',
  '  PTNode nodes[MAX_TREE_SIZE];      // 一棵树就存在这个一维数组里',
  '  int n;                            // 结点个数',
  '} PTree;',
  '// ---- 建树：把每个结点的双亲下标写进数组 ----',
  'void BuildParentTree(PTree &T) {',
  '  for (int i = 0; i < T.n; i++) {',
  '    T.nodes[i].parent = parentIndexOf(i);   // 只要知道双亲是谁，一步就能写进去',
  '  }',
  '}',
  '// ---- 求双亲：直接读数组，数组能随机存取，所以是 O(1) ----',
  'int Parent(PTree T, int i) { return T.nodes[i].parent; }',
  '// ---- 求孩子：数组里压根没存孩子，只能从头扫一遍，O(n) ----',
  'int Children(PTree T, int i, int out[]) {',
  '  int k = 0;',
  '  for (int j = 0; j < T.n; j++) {',
  '    if (T.nodes[j].parent == i) out[k++] = j;   // 谁的 parent 是我，谁就是我孩子',
  '  }',
  '  return k;',
  '}',
]

function* runParentRepr(data: number[]): AlgoRunner {
  const n = Math.min(data.length, MAX_NODES)
  const nodes: TreeNodeSnapshot[] = []
  const links: TreeLink[] = []
  const vals = (): number[] => nodes.map((x) => Number(x.value))
  const vars = () => ({ n, 数组长度: nodes.length })

  if (!n) {
    yield {
      line: 1,
      action: 'done',
      array: [],
      tree: treeView([]),
      boards: [
        {
          title: '连续存储空间（空表）',
          layout: 'grid',
          cols: 1,
          items: [{ text: '空', sub: 'n = 0', tone: 'dim' }],
          note: '没有数据，这片存储空间里一格都没开',
        },
      ],
      comment: '数据为空，没有结点可以建树，用来存树的数组也是空的',
      vars: { n: 0 },
    }
    return
  }

  // 0 号位置先放根结点：它没有双亲，parent = -1
  nodes.push({ id: tid(0), value: data[0]!, parent: null, sub: 'p:-1' })
  const snap = (o: ViewOpts = {}): TreeView => treeView(nodes, o)
  const noteBase =
    '双亲表示法：只记每个结点的双亲下标，结点下方小字就是存下来的下标（-1 表示根）；灰色虚线是 parent 指针。只记双亲 → 求双亲 O(1)，找孩子必须遍历整个数组'
  /** 当前这片连续存储空间：默认只画到"已经写进数组的结点个数"，后面的格子留空位 */
  const board = (o: {
    filled?: number
    hot?: number[]
    done?: number[]
    marks?: number[]
    filledTone?: CellTone
    pointers?: Record<string, number>
    note: string
  }): BoardView => parentReprBoard(data, n, { filled: nodes.length, ...o })

  yield {
    line: 11,
    action: 'init',
    array: vals(),
    tree: snap({ hot: [tid(0)], note: noteBase }),
    boards: [
      board({
        hot: [0],
        pointers: { i: 0 },
        note: `马上要写下标 0 这一格：上面存数据 ${data[0]}，下面存它的双亲下标 —— 根没有双亲，所以写 -1`,
      }),
    ],
    comment: `一棵树就是一个一维数组：先在下标 0 放根结点 ${data[0]}，它的 parent = -1（它没有双亲）。数组里每一格都存两项：结点的数据 + 它双亲在数组里的下标`,
    vars: vars(),
  }

  yield {
    line: 12,
    action: 'mark',
    array: vals(),
    tree: snap({ note: noteBase }),
    boards: [
      board({
        note: `数组一共开了 n = ${n} 个位置，暗色的格子是还没填的空位（每个位置都要存"数据 + 双亲下标"两项）；下面从下标 1 开始一格一格填`,
      }),
    ],
    comment: `从下标 1 开始，逐个把结点的双亲下标写进数组（共 ${n} 个结点）。数组先把 ${n} 个位置开好，写一格少一格空位`,
    vars: vars(),
  }

  for (let i = 1; i < n; i++) {
    const pi = PARENT_OF[i]!
    const p = pi >= 0 && pi < n ? tid(pi) : null
    nodes.push({ id: tid(i), value: data[i]!, parent: p, sub: `p:${pi}` })
    if (p) links.push({ from: tid(i), to: p, kind: 'parent' })
    yield {
      line: 13,
      action: 'set',
      array: vals(),
      tree: snap({
        hot: [tid(i)],
        links: [...links],
        note: noteBase,
      }),
      boards: [
        board({
          hot: [i],
          pointers: { i },
          note: `本步写下标 ${i} 这一格：上面存数据 ${data[i]}，下面存双亲下标 ${pi}（双亲是下标 ${pi} 的结点 ${data[pi]}）`,
        }),
      ],
      comment: `把结点 ${data[i]} 写进下标 ${i}：它的双亲是下标 ${pi} 的结点 ${data[pi]}，于是这一格记的 parent 就写 ${pi}。注意数组里存的是"双亲的下标"，不是双亲本身`,
      vars: vars(),
    }
  }

  // 求双亲：数组能随机存取，一步到位
  const target = n - 1
  const ti = PARENT_OF[target]!
  yield {
    line: 17,
    action: 'compare',
    array: vals(),
    tree: snap({ hot: [tid(target)], links: [...links], note: '求双亲：直接读 T.nodes[i].parent，不用扫' }),
    boards: [
      board({
        filledTone: 'base',
        hot: [target],
        pointers: { i: target },
        note: `求双亲：只要读下标 ${target} 这一格记的第二项（下排那个 parent），数组能随机存取，一格就够`,
      }),
    ],
    comment: `先演示"求双亲"：找结点 ${data[target]}（下标 ${target}）的双亲 —— 数组里下标 ${target} 那一格就存着它的双亲下标，读一下就行`,
    vars: vars(),
  }
  yield {
    line: 17,
    action: 'mark',
    array: vals(),
    tree: snap({
      hot: ti >= 0 ? [tid(target), tid(ti)] : [tid(target)],
      done: ti >= 0 ? [tid(ti)] : [],
      links: [...links],
      pointers: { i: tid(target) },
      note: '求双亲只用一步：数组下标一读就出来',
    }),
    boards: [
      board({
        filledTone: 'base',
        hot: ti >= 0 ? [target, ti] : [target],
        marks: [n + target],
        pointers: { i: target },
        note:
          ti >= 0
            ? `红色那一格（下标 ${target} 的 parent）里写的正是 ${ti}：所以它的双亲是下标 ${ti} 的结点 ${data[ti]}，一步搞定（O(1)）`
            : `红色那一格（下标 ${target} 的 parent）里写的是 -1：说明它是根，没有双亲 —— 也是一步读出来`,
      }),
    ],
    comment:
      ti >= 0
        ? `一步读到 parent = ${ti}，所以结点 ${data[target]} 的双亲就是下标 ${ti} 的结点 ${data[ti]} —— 这就是 O(1) 的随机存取`
        : `一步读到 parent = -1：结点 ${data[target]} 就是根，它没有双亲 —— 随机存取，一步就有答案（O(1)）`,
    vars: vars(),
  }

  // 求孩子：只能扫整个数组
  const found: string[] = []
  const foundIdx: number[] = []
  yield {
    line: 21,
    action: 'mark',
    array: vals(),
    tree: snap({ hot: [tid(0)], links: [...links], note: '求孩子：数组里没存孩子，只能从头扫一遍' }),
    boards: [
      board({
        filledTone: 'base',
        hot: [0],
        pointers: { j: 0 },
        note: '找根的孩子：数组里只有"双亲"这一项、根本没有"孩子"这一项，只能把每一格记的 parent 都拿出来比一比',
      }),
    ],
    comment: `再演示"求孩子"：找根结点 ${data[0]} 的孩子。数组里没存孩子，只能从下标 0 开始把整个数组扫一遍`,
    vars: vars(),
  }
  for (let j = 0; j < n; j++) {
    const isChild = j > 0 && PARENT_OF[j] === 0
    if (isChild) {
      found.push(tid(j))
      foundIdx.push(j)
    }
    yield {
      line: 22,
      action: 'compare',
      array: vals(),
      tree: snap({
        hot: [tid(j)],
        done: [...found],
        links: [...links],
        pointers: { j: tid(j) },
        note: `扫到下标 ${j}：它的 parent 是 ${PARENT_OF[j]}，${isChild ? '等于 0 → 是孩子' : '不等于 0 → 不是'}`,
      }),
      boards: [
        board({
          filledTone: 'base',
          hot: [j],
          done: [...foundIdx],
          pointers: { j },
          note: `扫到下标 ${j}：把这一格存的 parent 拿下来看是 ${PARENT_OF[j]}，${isChild ? '正好等于 0 → 它是根的孩子，记下来' : '不等于 0 → 不是根的孩子，跳过'}`,
        }),
      ],
      comment: isChild
        ? `扫到下标 ${j}（结点 ${data[j]}）：parent = ${PARENT_OF[j]}，正好是我 → 记下来`
        : `扫到下标 ${j}（结点 ${data[j]}）：parent = ${PARENT_OF[j]}，不是 0 → 跳过`,
      vars: vars(),
    }
  }
  yield {
    line: 24,
    action: 'done',
    array: vals(),
    tree: snap({
      hot: [tid(0)],
      done: [...found],
      links: [...links],
      note: '找孩子要遍历整个数组，所以是 O(n)',
    }),
    boards: [
      board({
        filledTone: 'base',
        hot: [0],
        done: [...foundIdx],
        note: `扫完全部 ${n} 格才把根的孩子找齐：${found.map((id) => data[Number(id.slice(1))]).join('、')}。数组里没有孩子的信息，只能一格一格比 parent，所以是 O(n)`,
      }),
    ],
    comment: `扫完 ${n} 个位置才找到孩子：${found.map((id) => data[Number(id.slice(1))]).join('、')}。双亲表示法只记双亲，找孩子必须遍历整个数组（O(n)）`,
    vars: vars(),
  }
}

const CODE_CHILD = [
  '// 孩子表示法：n 个结点 + 每个结点各挂一条"孩子链表"，把它的孩子串起来',
  'typedef struct CNode {            // 孩子链表上的一个结点',
  '  int child;                      // 孩子在数组里的下标',
  '  struct CNode *next;             // 下一个孩子',
  '} CNode;',
  'typedef struct {',
  '  ElemType data;                  // 结点本身的值',
  '  CNode *firstchild;              // 指向第一个孩子（孩子链表的表头）',
  '} CTNode;',
  'typedef struct {',
  '  CTNode nodes[MAX_TREE_SIZE];    // 每个下标位置都挂一条孩子链表',
  '  int n;                          // 结点个数',
  '} CTree;',
  '// ---- 建树：每一条"双亲 i -> 孩子 j"的关系，都调一次 AddChild ----',
  'void AddChild(CTree &T, int i, int j) {',
  '  CNode *s = (CNode *)malloc(sizeof(CNode));',
  '  s->child = j;                     // ① 给孩子 j 造一个链表结点',
  '  s->next = T.nodes[i].firstchild;  // ② 头插法接到 i 的孩子链表上',
  '  T.nodes[i].firstchild = s;',
  '}',
  '// ---- 找孩子：顺着孩子链表走，O(孩子个数)；找双亲：要把 n 条链表全扫一遍 ----',
  'int FindParent(CTree T, int i) {',
  '  for (int j = 0; j < T.n; j++)',
  '    for (CNode *p = T.nodes[j].firstchild; p; p = p->next)',
  '      if (p->child == i) return j;   // 谁的孩子链表里有 i，谁就是 i 的双亲',
  '  return -1;',
  '}',
]

function* runChildRepr(data: number[]): AlgoRunner {
  const n = Math.min(data.length, MAX_NODES)
  const cs = childLists(PARENT_OF, n)
  /** 孩子最多的那个结点有几个孩子 —— 顺序表右边就给孩子链表留几格（板子的一行 = 1 + maxKids 格） */
  const maxKids = Math.max(0, ...cs.map((kids) => kids.length))
  const nodes: TreeNodeSnapshot[] = []
  const byId = new Map<string, TreeNodeSnapshot>()

  if (!n) {
    yield {
      line: 1,
      action: 'done',
      array: [],
      tree: treeView([]),
      boards: [
        {
          title: '孩子表示法：顺序表（左列）+ 孩子链表（空表）',
          layout: 'grid',
          cols: 1,
          items: [{ text: '空', sub: 'n = 0', tone: 'dim' }],
          note: '没有数据，顺序表一格里一个结点都没有，也就没有孩子链表',
        },
      ],
      comment: '数据为空，没有结点可以建树，顺序表也是空的',
      vars: { n: 0 },
    }
    return
  }

  const ensure = (i: number): TreeNodeSnapshot => {
    const id = tid(i)
    const old = byId.get(id)
    if (old) return old
    const node: TreeNodeSnapshot = { id, value: data[i]!, children: [] }
    nodes.push(node)
    byId.set(id, node)
    return node
  }

  ensure(0)
  const vals = (): number[] => nodes.map((x) => Number(x.value))
  const vars = () => ({ n, 结点数: nodes.length })
  const snap = (o: ViewOpts = {}): TreeView => treeView(nodes, o)
  const noteBase = '孩子表示法：顺序表一格一个结点，每格向右伸出一条孩子链表；找孩子顺着箭头走，找双亲要把所有链表扫一遍'
  /** 顺序表的当前样子：每行建出来了没有、它的孩子链表上挂了哪些（存的是孩子下标） */
  const tableRows = (): ChildReprRow[] =>
    Array.from({ length: n }, (_, i) => {
      const x = byId.get(tid(i))
      return { exists: !!x, kids: (x?.children ?? []).map((c) => Number(c.slice(1))) }
    })
  const board = (o: {
    hotRows?: number[]
    doneRows?: number[]
    hotKid?: [number, number]
    /** 本步刚 malloc 出来、还没接到链上的那个链表结点：[挂在第几行, 它的 child 值] */
    pending?: [number, number]
    note: string
  }): BoardView => childReprBoard(data, tableRows(), { maxKids, ...o })
  /** 0..k-1，用来写"前 k 行已经建好了" */
  const upTo = (k: number): number[] => Array.from({ length: k }, (_, x) => x)
  /** 一条孩子链表读成人话 —— note 里就要说清"这支箭头指向谁"（存的是下标，这里也写下标） */
  const chainOf = (i: number): string => {
    const kids = (byId.get(tid(i))?.children ?? []).map((c) => Number(c.slice(1)))
    if (!kids.length) return `下标 ${i}（${data[i]}）没有孩子：右边第一格写 NULL，一支箭头都没有`
    const first = `下标 ${i}（${data[i]}）的第一个孩子是下标 ${kids[0]}`
    const rest = kids.slice(1).map((k) => `再下一个是下标 ${k}`).join('，')
    return rest ? `${first}，${rest}` : first
  }

  yield {
    line: 14,
    action: 'init',
    array: vals(),
    tree: snap({ hot: [tid(0)], note: noteBase }),
    boards: [
      board({
        hotRows: [0],
        note: `左列是顺序表：一共 ${n} 格（暗色的是还没建出来的结点），右边给孩子最多的结点留了 ${maxKids} 格。指针 i 先停在下标 0 这一格（紫色）：这里放根结点 ${data[0]}，它还没有孩子，右边第一格就写 NULL —— 空指针，所以没有箭头`,
      }),
    ],
    comment: `孩子表示法 = 顺序表（左列）+ 孩子链表（向右伸出的箭头）：顺序表里一格一个结点，每格向右伸出一条链表，把它的孩子串起来，链表结点里存的是孩子在数组里的下标。先把根结点 ${data[0]} 放进下标 0，它还没有孩子，右边第一格就是 NULL`,
    vars: vars(),
  }

  let built = 0
  for (let i = 0; i < n; i++) {
    for (const child of cs[i]!) {
      const j = Number(child.slice(1))
      const fresh = !byId.has(child)
      ensure(j)
      const parentNode = byId.get(tid(i))!
      const before = parentNode.children ?? []
      if (fresh) {
        yield {
          line: 16,
          action: 'set',
          array: vals(),
          tree: snap({ hot: [child], note: noteBase }),
          boards: [
            board({
              hotRows: [j],
              doneRows: upTo(i),
              pending: [i, j],
              note: `① s->child = ${j}：指针 i 还停在下标 ${i} 那一行，先给孩子 ${data[j]} 造一个孩子链表结点，里面存的就是孩子在数组里的下标 ${j}（紫色那一格）。它现在还没接到下标 ${i} 的孩子链表上，所以这一格还没有箭头指过来；顺手把顺序表里下标 ${j} 那一格也点亮了`,
            }),
          ],
          comment: `① 给孩子 ${data[j]} 申请一个链表结点，把它的下标 ${j} 存进去。它现在还是游离的，没接到谁的孩子链表上 —— 画面上就是紫色那一格，一支箭头都没有`,
          vars: vars(),
        }
      }
      const kids = [...before, child]
      parentNode.children = kids
      built += 1
      yield {
        line: 18,
        action: 'set',
        array: vals(),
        tree: snap({ hot: [tid(i), child], pointers: { i: tid(i) }, note: noteBase }),
        boards: [
          board({
            hotRows: [i],
            doneRows: upTo(i),
            hotKid: [i, kids.length - 1],
            note:
              kids.length === 1
                ? `② 指针 i 停在下标 ${i} 这一格（紫色）：这一格就是它的第一个孩子。箭头从现在这一格（左列）向右伸到右边第 1 个孩子链表结点上，终点格里存着孩子下标 ${j}`
                : `② 箭头从上一个孩子链表结点（下标 ${kids[kids.length - 2]!.slice(1)}）继续向右串到这一格（下标 ${j}，紫色）—— ${chainOf(i)}`,
          }),
        ],
        comment: `② 把下标 ${j} 接到 ${data[i]}（下标 ${i}）的孩子链表上：${kids.length === 1 ? '这是它的第一个孩子，箭头从顺序表那一格直接指过来' : `这是它第 ${kids.length} 个孩子，箭头从上一个链表结点继续往右串`} —— 现在的走向是 下标 ${i} → ${kids.map((c) => c.slice(1)).join(' → ')}`,
        vars: vars(),
      }
    }
  }

  // 叶子结点（孩子链表空的那些）：右边第一格写 NULL，一支箭头都没有
  const leafIdx = cs.map((kids, i) => (kids.length ? -1 : i)).filter((i) => i >= 0)
  yield {
    line: 20,
    action: 'done',
    array: vals(),
    tree: snap({ pointers: { 根: tid(0) }, note: `${built} 条孩子关系都挂好了：一共 ${n} 个结点、${built} 个孩子链表结点` }),
    boards: [
      board({
        doneRows: upTo(n),
        note: `建好了：左列 ${n} 格是顺序表，每格向右伸出的箭头串起自己的孩子链表，终点格里存的是孩子的下标（小字是它的值）。根那一行最热闹：${chainOf(0)}；${leafIdx.length} 个叶子结点（下标 ${leafIdx.join('、')}）右边第一格写 NULL，一支箭头都没有`,
      }),
    ],
    comment: `建树完成：${n} 个结点一共挂出了 ${built} 个孩子链表结点，正好等于边数 n-1；想知道谁是孩子，顺着那一格的箭头走就行（O(孩子个数)）`,
    vars: vars(),
  }

  // 找双亲：没有指向双亲的指针，只能把所有孩子链表扫一遍
  const target = n - 1
  if (target > 0) {
    yield {
      line: 23,
      action: 'compare',
      array: vals(),
      tree: snap({ hot: [tid(target)], note: '找双亲：从下标 0 开始，一条条孩子链表查过去' }),
      boards: [
        board({
          hotRows: [target],
          doneRows: upTo(n),
          note: `要找下标 ${target}（数据 ${data[target]}）的双亲。箭头全是从顺序表那一格向右指向孩子的，没有一支指回双亲 —— 只能从下标 0 开始一行一行查过去（指针 i 从第 0 行出发）`,
        }),
      ],
      comment: `再来看"找双亲"：找结点 ${data[target]}（下标 ${target}）的双亲 —— 没有向上的指针，只能把所有孩子链表扫一遍`,
      vars: vars(),
    }
    for (let j = 0; j < n; j++) {
      const kids = byId.get(tid(j))?.children ?? []
      const hit = kids.includes(tid(target))
      const kInList = kids.indexOf(tid(target))
      const label = kids.length ? kids.map((c) => data[Number(c.slice(1))]).join('、') : '（NULL，没有孩子）'
      yield {
        line: 25,
        action: 'compare',
        array: vals(),
        tree: snap({
          hot: [tid(j)],
          done: hit ? [tid(j), tid(target)] : [],
          pointers: { j: tid(j) },
          note: hit ? `下标 ${j} 的孩子链表里有 ${data[target]} → 它就是双亲` : `检查下标 ${j} 的孩子链表`,
        }),
        boards: [
          board({
            hotRows: hit ? [j, target] : [j],
            doneRows: upTo(n),
            ...(hit ? { hotKid: [j, kInList] as [number, number] } : {}),
            note: hit
              ? `查第 ${j} 行（指针 j 停在这一行，紫色）：顺着一格一格的箭头往右走，指针 p 走到存着下标 ${target} 的那个链表结点（紫色）—— 命中了！${data[j]} 就是它的双亲`
              : `查第 ${j} 行（结点 ${data[j]}）：${label}，指针 p 顺着这一行的箭头走到底也没看见下标 ${target} → 换下一行`,
          }),
        ],
        comment: hit
          ? `检查下标 ${j}（结点 ${data[j]}）的孩子链表：里面有下标 ${target} → 找到了！${data[j]} 就是它的双亲`
          : `检查下标 ${j}（结点 ${data[j]}）的孩子链表：${kids.length ? kids.map((c) => data[Number(c.slice(1))]).join('、') : '空'} → 不是`,
        vars: vars(),
      }
      if (hit) break
    }
  }

  yield {
    line: 27,
    action: 'done',
    array: vals(),
    tree: snap({
      done: target > 0 ? [tid(0), tid(target)] : [tid(0)],
      note: '找孩子快、找双亲慢 —— 这就是孩子表示法的取舍',
    }),
    boards: [
      board({
        doneRows: target > 0 ? [0, target] : [0],
        note: `顺序表（左列）+ 孩子链表（向右的箭头）全在这儿：找孩子顺着自己那一行的箭头走（O(孩子个数)），找双亲却要把 ${n} 行的链表全查一遍（O(n)）`,
      }),
    ],
    comment: `孩子表示法总结：找孩子只要顺着孩子链表走（O(孩子个数)），找双亲却要把 ${n} 条链表全扫一遍（O(n)）`,
    vars: vars(),
  }
}

const CODE_SIBLING = [
  '// 孩子兄弟表示法（二叉树表示法）：左指针 = 第一个孩子，右指针 = 下一个兄弟',
  'typedef struct CSNode {',
  '  ElemType data;                  // 结点本身的值',
  '  struct CSNode *firstchild;      // 左指针：第一个孩子',
  '  struct CSNode *nextsibling;     // 右指针：下一个兄弟',
  '} CSNode, *CSTree;',
  'void Link(CSNode *p) {',
  '  p->firstchild = firstChildOf(p);    // ① 左指针连"第一个孩子"',
  '  p->nextsibling = nextSiblingOf(p);  // ② 右指针连"下一个兄弟"',
  '  // 每个结点都这样连一遍，得到的二叉树就是这棵树的孩子兄弟表示',
  '}',
  '// 找孩子 / 找兄弟都只要一步；找双亲只能从根开始一层层找过去',
  'CSNode *FindParent(CSNode *T, CSNode *x) {',
  '  for (CSNode *p = T; p; p = p->nextsibling)',
  '    if (p->firstchild == x) return p;    // 我的第一个孩子就是你 -> 我就是你双亲',
  '  return NULL;                           // 找不到就再往孩子那边递归',
  '}',
]

function* runSiblingRepr(data: number[]): AlgoRunner {
  const n = Math.min(data.length, MAX_NODES)
  const nodes = csNodes(data, n)
  const byId = new Map(nodes.map((x) => [x.id, x]))
  const walkOrder: string[] = []

  if (!n) {
    yield { line: 1, action: 'done', array: [], tree: treeView([]), comment: '数据为空，没有结点可以建树', vars: { n: 0 } }
    return
  }

  const val = (id: string | null | undefined): string => (id ? String(byId.get(id)?.value ?? '?') : '空')
  const vals = (): number[] => nodes.map((x) => Number(x.value))
  const snap = (o: ViewOpts = {}): TreeView => treeView(nodes.map((x) => ({ ...x })), o)
  const vars = () => ({ n, 已讲解: walkOrder.length })
  const noteBase = '孩子兄弟表示法：左指针 = 第一个孩子，右指针 = 下一个兄弟；小字标出它是被"孩子"还是"兄弟"指针连过来的'

  yield {
    line: 7,
    action: 'init',
    array: vals(),
    tree: snap({ hot: [tid(0)], note: noteBase }),
    comment:
      '同一棵树，换成孩子兄弟表示法存：每个结点只有两个指针 —— 左边连第一个孩子，右边连下一个兄弟（画面上就成了一棵二叉树）',
    vars: vars(),
  }

  for (let i = 0; i < n; i++) {
    const x = byId.get(tid(i))!
    walkOrder.push(tid(i))
    yield {
      line: 8,
      action: 'set',
      array: vals(),
      tree: snap({
        hot: [tid(i), ...(x.left ? [x.left] : [])],
        done: [...walkOrder],
        pointers: { p: tid(i) },
        note: `${data[i]} 的左指针指向第一个孩子 ${val(x.left)}`,
      }),
      comment: x.left
        ? `① 结点 ${data[i]} 的左指针 → 它的第一个孩子 ${val(x.left)}`
        : `① 结点 ${data[i]} 没有孩子，左指针为空（NULL）`,
      vars: vars(),
    }
    yield {
      line: 9,
      action: 'set',
      array: vals(),
      tree: snap({
        hot: [tid(i), ...(x.right ? [x.right] : [])],
        done: [...walkOrder],
        pointers: { p: tid(i) },
        note: `${data[i]} 的右指针指向下一个兄弟 ${val(x.right)}`,
      }),
      comment: x.right
        ? `② 结点 ${data[i]} 的右指针 → 它的下一个兄弟 ${val(x.right)}（同一层的下一个）`
        : `② 结点 ${data[i]} 是同一层里最后一个，右指针为空（NULL）`,
      vars: vars(),
    }
  }

  // 找孩子 / 找兄弟：都是一步
  const demo = n > 2 ? 1 : 0
  yield {
    line: 9,
    action: 'mark',
    array: vals(),
    tree: snap({
      hot: [tid(demo), ...(byId.get(tid(demo))!.left ? [byId.get(tid(demo))!.left!] : [])],
      done: [...walkOrder],
      note: '找孩子：一步（左指针）；找下一个兄弟：一步（右指针）',
    }),
    comment: `找孩子只要一步：结点 ${data[demo]} 的左指针就指向它的第一个孩子 ${val(byId.get(tid(demo))!.left)}；找下一个兄弟也是一步，走右指针就行 —— 都是 O(1)`,
    vars: vars(),
  }

  // 找双亲：只能从根开始按左右指针一层层找
  const target = n - 1
  const path = n > 1 ? findParentPath(PARENT_OF, n, target) : []
  for (const id of path) {
    yield {
      line: 15,
      action: 'compare',
      array: vals(),
      tree: snap({ hot: [id], done: [...walkOrder], note: `找双亲：沿左孩子 / 右兄弟一路找过去，走到 ${val(id)}` }),
      comment:
        id === tid(target)
          ? `走到 ${val(id)}：它就是我们要找的结点，上一站就是它的双亲`
          : `沿"左孩子 / 右兄弟"往下找：现在停在 ${val(id)}`,
      vars: vars(),
    }
  }
  yield {
    line: 16,
    action: 'done',
    array: vals(),
    tree: snap({
      hot: [tid(target)],
      done: [...walkOrder],
      note: '找双亲要一层层找过去，没有捷径（O(n)）',
    }),
    comment: `孩子兄弟表示法总结：找孩子、找兄弟都是 O(1)，但找双亲只能从根一路找过去（O(n)）—— 树里没有一个指针是指向双亲的`,
    vars: vars(),
  }
}

/** 从根走到 target 的路径（结点 id 列表），演示"找双亲"要一层层走 */
function findParentPath(parent: number[], n: number, target: number): string[] {
  const path: string[] = []
  const dfs = (i: number): boolean => {
    path.push(tid(i))
    if (i === target) return true
    for (let j = 0; j < n; j++) if (parent[j] === i && dfs(j)) return true
    path.pop()
    return false
  }
  if (n) dfs(0)
  return path
}

const CODE_FOREST = [
  '// 树与森林的遍历：森林 = 若干棵互不相交的树，逐棵走一遍就行',
  '// 树的先根遍历：先访问根，再依次先根遍历它的每一棵子树',
  'void PreOrder(CSTree T) {',
  '  if (T == NULL) return;',
  '  visit(T);                              // ① 先访问根',
  '  for (p = T->firstchild; p; p = p->nextsibling)',
  '    PreOrder(p);                         // ② 依次先根遍历每一棵子树',
  '}',
  '// 树的后根遍历：先依次后根遍历每一棵子树，最后才访问根',
  'void PostOrder(CSTree T) {',
  '  if (T == NULL) return;',
  '  for (p = T->firstchild; p; p = p->nextsibling)',
  '    PostOrder(p);                        // ① 先把所有子树走完',
  '  visit(T);                              // ② 最后才访问根',
  '}',
  '// 森林的先根遍历 = 依次对各棵树先根遍历；森林的后根遍历 = 依次对各棵树后根遍历',
  'void ForestTraverse(CSTree forest[], int k) {',
  '  for (int i = 0; i < k; i++) PreOrder(forest[i]);   // 先根：逐棵走',
  '  for (int i = 0; i < k; i++) PostOrder(forest[i]);  // 后根：逐棵走',
  '}',
]

function* runForestTraverse(data: number[]): AlgoRunner {
  const n = Math.min(data.length, MAX_NODES)
  const cs = childLists(FOREST_PARENT, n)
  const nodes: TreeNodeSnapshot[] = Array.from({ length: n }, (_, i) => ({
    id: tid(i),
    value: data[i]!,
    children: [...cs[i]!],
  }))
  const byId = new Map(nodes.map((x) => [x.id, x]))
  const roots = FOREST_ROOTS.filter((i) => i < n).map(tid)
  const preSeq: string[] = []
  const postSeq: string[] = []

  if (!n) {
    yield { line: 1, action: 'done', array: [], tree: treeView([], { roots: [] }), comment: '数据为空，没有森林可以遍历', vars: { n: 0 } }
    return
  }

  const val = (id: string | null | undefined): string => (id ? String(byId.get(id)?.value ?? '?') : '空')
  const nums = (ids: string[]): number[] => ids.map((id) => Number(byId.get(id)!.value))
  const snap = (o: ViewOpts = {}): TreeView => treeView(nodes, { root: null, roots, ...o })
  const noteBase = `森林：roots 给出 ${roots.length} 棵树的根，各棵树互不相交`
  const text = (ids: string[]) => ids.map((id) => byId.get(id)!.value).join(' → ')

  yield {
    line: 1,
    action: 'init',
    array: nums(preSeq),
    tree: snap({ hot: [...roots], note: noteBase }),
    comment: `这组数据还原成一个森林：${roots.map((id) => val(id)).join('、')} 分别是 ${roots.length} 棵树的根，它们互不相交`,
    vars: { n, 棵数: roots.length },
  }

  function* pre(id: string): AlgoRunner {
    const x = byId.get(id)!
    preSeq.push(id)
    yield {
      line: 5,
      action: 'mark',
      array: nums(preSeq),
      tree: snap({ hot: [id], done: [...preSeq], pointers: { p: id }, note: `先根遍历：先访问根 ${x.value}` }),
      comment: `① 先访问根结点 ${x.value}（先根序列第 ${preSeq.length} 个）`,
      vars: { n, 先根序号: preSeq.length },
    }
    for (const c of x.children ?? []) {
      yield {
        line: 7,
        action: 'mark',
        array: nums(preSeq),
        tree: snap({
          hot: [c],
          done: [...preSeq],
          pointers: { p: id },
          note: `接着先根遍历 ${x.value} 的子树（根是 ${val(c)}）`,
        }),
        comment: `② 依次先根遍历 ${x.value} 的子树：下一棵子树的根是 ${val(c)}`,
        vars: { n, 先根序号: preSeq.length },
      }
      yield* pre(c)
    }
  }

  function* post(id: string): AlgoRunner {
    const x = byId.get(id)!
    for (const c of x.children ?? []) {
      yield {
        line: 13,
        action: 'mark',
        array: nums(postSeq),
        tree: snap({
          hot: [c],
          done: [...postSeq],
          pointers: { p: id },
          note: `后根遍历：先走 ${x.value} 的子树（根是 ${val(c)}）`,
        }),
        comment: `① 先后根遍历 ${x.value} 的子树：根是 ${val(c)}`,
        vars: { n, 后根序号: postSeq.length },
      }
      yield* post(c)
    }
    postSeq.push(id)
    yield {
      line: 14,
      action: 'mark',
      array: nums(postSeq),
      tree: snap({ hot: [id], done: [...postSeq], pointers: { p: id }, note: `后根遍历：最后才访问 ${x.value}` }),
      comment: `② 子树都走完了，最后才访问根结点 ${x.value}（后根序列第 ${postSeq.length} 个）`,
      vars: { n, 后根序号: postSeq.length },
    }
  }

  // ---- 先根遍历：逐棵树走 ----
  for (let k = 0; k < roots.length; k++) {
    const r = roots[k]!
    yield {
      line: 18,
      action: 'mark',
      array: nums(preSeq),
      tree: snap({ hot: [r], done: [...preSeq], note: `先根遍历第 ${k + 1} 棵树（根是 ${val(r)}）` }),
      comment: `森林的先根遍历 = 各棵树依次先根遍历：现在轮到第 ${k + 1} 棵树，根是 ${val(r)}`,
      vars: { n, 棵数: roots.length },
    }
    yield* pre(r)
  }
  yield {
    line: 18,
    action: 'mark',
    array: nums(preSeq),
    tree: snap({ done: [...preSeq], note: `先根遍历序列：${text(preSeq)}` }),
    comment: `森林的先根遍历序列是 ${text(preSeq)}（逐棵树走完，一棵树的根走完才轮到下一棵）`,
    vars: { n, 先根序号: preSeq.length },
  }

  // ---- 后根遍历：逐棵树走 ----
  for (let k = 0; k < roots.length; k++) {
    const r = roots[k]!
    yield {
      line: 19,
      action: 'mark',
      array: nums(postSeq),
      tree: snap({
        hot: [r],
        done: [...postSeq],
        note: `后根遍历第 ${k + 1} 棵树（根是 ${val(r)}）：先子树后根`,
      }),
      comment: `再做完根遍历：第 ${k + 1} 棵树（根是 ${val(r)}），规则是"先子树、后根"`,
      vars: { n, 棵数: roots.length },
    }
    yield* post(r)
  }

  yield {
    line: 20,
    action: 'done',
    array: nums(postSeq),
    tree: snap({ done: [...postSeq], note: `先根：${text(preSeq)}　后根：${text(postSeq)}` }),
    comment: `遍历完成。先根序列 ${text(preSeq)}；后根序列 ${text(postSeq)}。森林的这两种遍历正好对应它转成二叉树后的先序和中序遍历`,
    vars: { n, 先根序号: preSeq.length, 后根序号: postSeq.length },
  }
}

const CODE_TO_BINARY = [
  '// 树转二叉树："左孩子右兄弟"—— 左指针连第一个孩子，右指针连下一个兄弟',
  '// 原树的每个结点孩子个数不定，用定长的指针域根本存不下来；',
  '// 换成"第一个孩子 + 下一个兄弟"这两个指针后，任意多叉树都变成了一棵二叉树。',
  'typedef struct CSNode {',
  '  ElemType data;',
  '  struct CSNode *firstchild;      // 左：第一个孩子',
  '  struct CSNode *nextsibling;     // 右：下一个兄弟',
  '} CSNode, *CSTree;',
  'void TreeToBinary(CSNode *p) {',
  '  p->firstchild = firstChildOf(p);    // ① 左指针 = 第一个孩子',
  '  p->nextsibling = nextSiblingOf(p);  // ② 右指针 = 下一个兄弟',
  '  TreeToBinary(p->firstchild);        // ③ 对孩子、兄弟都递归做同样的转换',
  '  TreeToBinary(p->nextsibling);',
  '}',
  '// 结论：树的先根遍历 ⟺ 这棵二叉树的先序遍历（顺序完全一样）',
  '//       树的后根遍历 ⟺ 这棵二叉树的中序遍历',
]

function* runTreeToBinary(data: number[]): AlgoRunner {
  const n = Math.min(data.length, MAX_NODES)
  const cs = childLists(PARENT_OF, n)
  const cst = csNodes(data, n)
  const byId = new Map(cst.map((x) => [x.id, x]))
  const walk: string[] = []

  if (!n) {
    yield { line: 1, action: 'done', array: [], tree: treeView([]), comment: '数据为空，没有树可以转换', vars: { n: 0 } }
    return
  }

  const val = (id: string | null | undefined): string => (id ? String(byId.get(id)?.value ?? '?') : '空')
  const vals = (): number[] => cst.map((x) => Number(x.value))
  const snapBin = (o: ViewOpts = {}): TreeView => treeView(cst.map((x) => ({ ...x })), o)
  const noteBase = '转换后的二叉树：左指针 = 第一个孩子，右指针 = 下一个兄弟（小字标出这个结点是怎么连过来的）'
  const vars = () => ({ n, 已访问: walk.length })

  yield {
    line: 1,
    action: 'init',
    array: data.slice(0, n),
    tree: treeView(multiNodes(data, PARENT_OF, n), {
      hot: [tid(0)],
      note: '原树：一个结点的孩子个数不定（比如根结点有 3 个孩子）',
    }),
    comment: `这是原树：根结点 ${data[0]} 有 ${cs[0]!.length} 个孩子，别的结点孩子个数又不一样 —— 没有一个定长的指针域能存下它`,
    vars: vars(),
  }

  yield {
    line: 2,
    action: 'mark',
    array: data.slice(0, n),
    tree: treeView(multiNodes(data, PARENT_OF, n), {
      hot: [tid(0)],
      note: '每个结点的孩子个数都不一样，存起来很麻烦',
    }),
    comment: `如果给每个结点都开若干个孩子指针，n 个结点就要按"孩子最多的那个"来开，太浪费；开少了又存不下`,
    vars: vars(),
  }

  yield {
    line: 9,
    action: 'mark',
    array: data.slice(0, n),
    tree: treeView(multiNodes(data, PARENT_OF, n), {
      hot: [tid(0)],
      note: '开始转换：对每个结点做同样两件事 —— 左连第一个孩子、右连下一个兄弟',
    }),
    comment:
      '转换开始：对每个结点都做两件事 —— ① 左指针连它的第一个孩子；② 右指针连它的下一个兄弟。整棵树一起改，画面上的结点会整体挪成二叉树的样子',
    vars: vars(),
  }

  // 演示用的两个指针位置（数据很短时可能没有，取不到就不画）
  const firstChildId = byId.get(tid(0))?.left ?? null
  const siblingId = byId.get(tid(1))?.right ?? null

  yield {
    line: 10,
    action: 'set',
    array: vals(),
    tree: snapBin({
      hot: firstChildId ? [tid(0), firstChildId] : [tid(0)],
      pointers: { firstchild: firstChildId },
      note: `${noteBase}　（结点整体挪成了二叉树的样子）`,
    }),
    comment:
      '① 左指针 = 第一个孩子：根结点的左指针指向它的第一个孩子；其它结点也一样，谁有孩子谁就把左指针连过去',
    vars: vars(),
  }

  yield {
    line: 11,
    action: 'set',
    array: vals(),
    tree: snapBin({
      hot: siblingId ? [tid(1), siblingId] : [tid(0)],
      pointers: { nextsibling: siblingId },
      note: noteBase,
    }),
    comment:
      '② 右指针 = 下一个兄弟：原来"同一个双亲的兄弟"用右指针串起来，所以同一层的兄弟在二叉树里是一条往右的链',
    vars: vars(),
  }

  for (let i = 0; i < n; i++) {
    const x = byId.get(tid(i))!
    yield {
      line: 12,
      action: 'mark',
      array: vals(),
      tree: snapBin({
        hot: [tid(i), ...(x.left ? [x.left] : []), ...(x.right ? [x.right] : [])],
        pointers: { p: tid(i) },
        note: `${data[i]}：左 → ${val(x.left)}（第一个孩子），右 → ${val(x.right)}（下一个兄弟）`,
      }),
      comment: `结点 ${data[i]}：左指针 → 第一个孩子 ${val(x.left)}；右指针 → 下一个兄弟 ${val(x.right)}`,
      vars: vars(),
    }
  }

  // 验证：二叉树的先序遍历 == 原树的先根遍历
  const childIdx: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    const p = PARENT_OF[i]!
    if (p >= 0 && p < n) childIdx[p]!.push(i)
  }
  const treePre: number[] = []
  const walkTree = (i: number): void => {
    treePre.push(Number(data[i]!))
    for (const c of childIdx[i]!) walkTree(c)
  }
  walkTree(0)

  yield {
    line: 15,
    action: 'mark',
    array: vals(),
    tree: snapBin({ done: [], note: '转换完了，来验证一下：二叉树的先序遍历' }),
    comment: `转换完成。现在按"根 → 左 → 右"先序遍历这棵二叉树，看看它和原树的先根遍历是不是一样`,
    vars: vars(),
  }

  function* preCs(id: string | null): AlgoRunner {
    if (!id) return
    const x = byId.get(id)
    if (!x) return
    walk.push(id)
    yield {
      line: 15,
      action: 'mark',
      array: walk.map((w) => Number(byId.get(w)!.value)),
      tree: snapBin({ hot: [id], done: [...walk], pointers: { p: id }, note: `先序遍历：访问 ${x.value}` }),
      comment: `二叉树先序遍历访问 ${x.value}（第 ${walk.length} 个）`,
      vars: vars(),
    }
    yield* preCs(x.left ?? null)
    yield* preCs(x.right ?? null)
  }

  yield* preCs(tid(0))

  const binPre = walk.map((w) => Number(byId.get(w)!.value))
  yield {
    line: 16,
    action: 'done',
    array: binPre,
    tree: snapBin({ done: [...walk], note: `二叉树先序：${binPre.join(' → ')}` }),
    comment: `二叉树的先序遍历是 ${binPre.join(' → ')}，原树的先根遍历是 ${treePre.join(' → ')}，两者完全一样 —— 这就是"树转二叉树"最有用的地方：树的遍历可以直接用二叉树的遍历来做`,
    vars: vars(),
  }
}

export const treeThreadForestSpecs: AlgorithmSpec[] = [
  {
    id: 'thread-inorder',
    name: '中序线索化',
    category: 'tree',
    group: '线索二叉树',
    summary: '把中序序列里的"前驱 / 后继"存进空指针，pre 始终指向上一个访问过的结点',
    complexity: { time: 'O(n)', space: 'O(h)，h 是树高（递归栈）' },
    renderer: 'tree',
    codeLines: CODE_THREAD_INORDER,
    defaultData: () => [1, 2, 3, 4, 5, 6, 7],
    initComment: (data) =>
      `把 [${data.slice(0, MAX_NODES).join(', ')}] 按层序还原成一棵完全二叉树，开始中序线索化`,
    initTree: (data) =>
      treeView(tagNodes(threadNodes(data)), {
        pointers: { pre: null, T: data.length ? nodeId(0) : null },
        note: '中序线索化：pre 始终指向上一个访问过的结点',
      }),
    createRunner: runThreadInorder,
  },
  {
    id: 'thread-traverse',
    name: '线索二叉树的遍历',
    category: 'tree',
    group: '线索二叉树',
    summary: '不用栈、不用递归走完中序：有右线索顺线索走，没有就进右子树找最左下结点',
    complexity: { time: 'O(n)', space: 'O(1)，只用一个指针 p' },
    renderer: 'tree',
    codeLines: CODE_THREAD_TRAVERSE,
    defaultData: () => [1, 2, 3, 4, 5, 6, 7],
    initComment: (data) =>
      `把 [${data.slice(0, MAX_NODES).join(', ')}] 还原成完全二叉树并做中序线索化，然后不用栈、不用递归地遍历它`,
    initTree: (data) =>
      treeView(tagNodes(buildThreadedTree(data).nodes), {
        pointers: { p: null },
        note: '线索二叉树的遍历：不用栈、也不用递归',
      }),
    createRunner: runThreadTraverse,
  },
  {
    id: 'tree-parent-repr',
    name: '树的存储·双亲表示法',
    category: 'tree',
    group: '树与森林',
    summary: '一维数组存结点，每个结点只记双亲下标：找双亲 O(1)，找孩子要遍历整个数组',
    complexity: { time: '查双亲 O(1)，查孩子 O(n)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: CODE_PARENT,
    defaultData: () => [1, 2, 3, 4, 5, 6, 7],
    initComment: (data) =>
      `把 [${data.slice(0, MAX_NODES).join(', ')}] 还原成一棵树，再用"双亲表示法"把它存进一个一维数组`,
    initTree: (data) =>
      data.length
        ? treeView([{ id: tid(0), value: data[0]!, parent: null, sub: 'p:-1' }], {
            hot: [tid(0)],
            note: '双亲表示法：只记双亲下标，找孩子要把整个数组扫一遍',
          })
        : treeView([]),
    createRunner: runParentRepr,
  },
  {
    id: 'tree-child-repr',
    name: '树的存储·孩子表示法',
    category: 'tree',
    group: '树与森林',
    summary: '每个结点挂一条孩子链表：找孩子 O(1)，找双亲要把所有链表扫一遍',
    complexity: { time: '查孩子 O(孩子个数)，查双亲 O(n)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: CODE_CHILD,
    defaultData: () => [1, 2, 3, 4, 5, 6, 7],
    initComment: (data) =>
      `把 [${data.slice(0, MAX_NODES).join(', ')}] 还原成一棵树，再用"孩子表示法"给它挂上孩子链表`,
    initTree: (data) =>
      data.length
        ? treeView([{ id: tid(0), value: data[0]!, children: [] }], {
            hot: [tid(0)],
            note: '孩子表示法：每个结点挂一条孩子链表；找孩子 O(1)（顺着链表走），找双亲要遍历所有链表',
          })
        : treeView([]),
    createRunner: runChildRepr,
  },
  {
    id: 'tree-sibling-repr',
    name: '树的存储·孩子兄弟表示法',
    category: 'tree',
    group: '树与森林',
    summary: '左指针连第一个孩子、右指针连下一个兄弟，多叉树直接变成二叉树',
    complexity: { time: '查孩子 / 查兄弟 O(1)，查双亲 O(n)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: CODE_SIBLING,
    defaultData: () => [1, 2, 3, 4, 5, 6, 7],
    initComment: (data) =>
      `把 [${data.slice(0, MAX_NODES).join(', ')}] 还原成一棵树，再用"孩子兄弟表示法"存成二叉链表`,
    initTree: (data) =>
      treeView(csNodes(data, Math.min(data.length, MAX_NODES)), {
        hot: data.length ? [tid(0)] : [],
        note: '孩子兄弟表示法：左指针 = 第一个孩子，右指针 = 下一个兄弟；小字标出它是被"孩子"还是"兄弟"指针连过来的',
      }),
    createRunner: runSiblingRepr,
  },
  {
    id: 'tree-forest-traverse',
    name: '树与森林的遍历',
    category: 'tree',
    group: '树与森林',
    summary: '森林逐棵树走：先根遍历（对应二叉树先序）与后根遍历（对应二叉树中序）',
    complexity: { time: 'O(n)', space: 'O(h)，h 是树高（递归栈）' },
    renderer: 'tree',
    codeLines: CODE_FOREST,
    defaultData: () => [1, 2, 3, 4, 5, 6, 7],
    initComment: (data) =>
      `把 [${data.slice(0, MAX_NODES).join(', ')}] 还原成一个森林（3 棵树），分别做先根遍历和后根遍历`,
    initTree: (data) => {
      const n = Math.min(data.length, MAX_NODES)
      return treeView(
        Array.from({ length: n }, (_, i) => ({ id: tid(i), value: data[i]!, children: [...childLists(FOREST_PARENT, n)[i]!] })),
        {
          root: null,
          roots: FOREST_ROOTS.filter((i) => i < n).map(tid),
          note: `森林：roots 给出 ${FOREST_ROOTS.filter((i) => i < n).length} 棵树的根，各棵树互不相交`,
        },
      )
    },
    createRunner: runForestTraverse,
  },
  {
    id: 'tree-to-binary',
    name: '树与森林转二叉树',
    category: 'tree',
    group: '树与森林',
    summary: '左孩子右兄弟：原树 -> 二叉树，并且树的先根遍历 = 二叉树的先序遍历',
    complexity: { time: 'O(n)', space: 'O(n)' },
    renderer: 'tree',
    codeLines: CODE_TO_BINARY,
    defaultData: () => [1, 2, 3, 4, 5, 6, 7],
    initComment: (data) =>
      `把 [${data.slice(0, MAX_NODES).join(', ')}] 还原成一棵多叉树，然后用"左孩子右兄弟"把它转成二叉树`,
    initTree: (data) =>
      treeView(multiNodes(data, PARENT_OF, Math.min(data.length, MAX_NODES)), {
        hot: data.length ? [tid(0)] : [],
        note: '原树：一个结点的孩子个数不定（比如根结点有 3 个孩子）',
      }),
    createRunner: runTreeToBinary,
  },
]
