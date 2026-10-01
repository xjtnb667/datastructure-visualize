import type { AlgorithmSpec, AlgoRunner, TreeNodeSnapshot, TreeView } from '@/core/types'

/**
 * 树与二叉树 —— 框架示范算法。
 *
 * 数据约定：一维数字串按**层序（BFS）**还原成一棵完全二叉树，
 * 第 i 个元素是结点 i（从 0 开始编号），左右孩子分别是 2i+1 / 2i+2。
 * 这样"随机数据"按钮也能直接用，而且树的形状稳定、好讲解。
 *
 * 快照约定：
 *   - 二叉树就填 left / right；多叉树填 children；双亲表示法 / 并查集填 parent；
 *   - 线索二叉树再填 threadPrev / threadNext；
 *   - 想画虚线（线索、并查集的向上指针）就往 links 里塞。
 */
const MAX_NODES = 15

export function nodeId(i: number): string {
  return `n${i}`
}

/** 一维数据 -> 完全二叉树（层序编号） */
export function makeCompleteTree(data: number[]): TreeNodeSnapshot[] {
  const n = Math.min(data.length, MAX_NODES)
  const nodes: TreeNodeSnapshot[] = []
  for (let i = 0; i < n; i++) {
    const left = 2 * i + 1 < n ? nodeId(2 * i + 1) : null
    const right = 2 * i + 2 < n ? nodeId(2 * i + 2) : null
    nodes.push({ id: nodeId(i), value: data[i]!, left, right, sub: String(i) })
  }
  return nodes
}

export function completeTreeView(
  data: number[],
  opts: { hot?: string[]; done?: string[]; pointers?: Record<string, string | null>; note?: string } = {},
): TreeView {
  return {
    nodes: makeCompleteTree(data),
    root: data.length ? nodeId(0) : null,
    hot: opts.hot ?? [],
    done: opts.done ?? [],
    pointers: opts.pointers ?? {},
    note: opts.note,
  }
}

const CODE_PRE = [
  'void preOrder(BiTree T) {',
  '  if (T == NULL) return;        // 空树直接返回',
  '  visit(T);                     // ① 先访问根',
  '  preOrder(T->left);            // ② 再递归遍历左子树',
  '  preOrder(T->right);           // ③ 最后递归遍历右子树',
  '}',
]

function* runPreOrder(data: number[]): AlgoRunner {
  const nodes = makeCompleteTree(data)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const done: string[] = []

  yield {
    line: 1,
    action: 'init',
    array: data.slice(0, nodes.length),
    tree: completeTreeView(data, { note: '先序遍历：根 -> 左 -> 右' }),
    comment: `把数据按层序还原成一棵完全二叉树，${nodes.length} 个结点。下面从根开始先序遍历`,
    vars: { n: nodes.length },
  }
  if (!nodes.length) return

  function* visit(id: string | null | undefined): AlgoRunner {
    if (!id) return
    const n = byId.get(id)
    if (!n) return
    done.push(id)
    yield {
      line: 3,
      action: 'mark',
      array: data.slice(0, nodes.length),
      tree: completeTreeView(data, {
        hot: [id],
        done: [...done],
        note: `访问结点 ${n.value}`,
      }),
      comment: `① 访问根结点 ${n.value}`,
      vars: { 访问: Number(n.value) },
    }
    if (n.left) {
      yield {
        line: 4,
        action: 'mark',
        array: data.slice(0, nodes.length),
        tree: completeTreeView(data, {
          hot: [n.left],
          done: [...done],
          note: `进入 ${n.value} 的左子树`,
        }),
        comment: `② 递归遍历 ${n.value} 的左子树（根是 ${byId.get(n.left)?.value}）`,
        vars: {},
      }
      yield* visit(n.left)
    }
    if (n.right) {
      yield {
        line: 5,
        action: 'mark',
        array: data.slice(0, nodes.length),
        tree: completeTreeView(data, {
          hot: [n.right],
          done: [...done],
          note: `进入 ${n.value} 的右子树`,
        }),
        comment: `③ 递归遍历 ${n.value} 的右子树（根是 ${byId.get(n.right)?.value}）`,
        vars: {},
      }
      yield* visit(n.right)
    }
  }

  yield* visit(nodeId(0))

  yield {
    line: 6,
    action: 'done',
    array: data.slice(0, nodes.length),
    tree: completeTreeView(data, { done: [...done], note: '先序遍历结束' }),
    comment: `先序遍历结束，访问顺序是：${done.map((id) => byId.get(id)!.value).join(' → ')}`,
    vars: {},
  }
}

export const treeSpecs: AlgorithmSpec[] = [
  {
    id: 'tree-preorder-rec',
    name: '先序遍历（递归）',
    category: 'tree',
    group: '遍历',
    summary: '根 -> 左 -> 右，递归实现',
    complexity: { time: 'O(n)', space: 'O(h)，h 是树高' },
    renderer: 'tree',
    codeLines: CODE_PRE,
    defaultData: () => [1, 2, 3, 4, 5, 6, 7],
    initTree: (data) => completeTreeView(data, { note: '先序遍历：根 -> 左 -> 右' }),
    createRunner: runPreOrder,
  },
]
