import type {
  AlgorithmSpec,
  AlgoRunner,
  BoardView,
  CellTone,
  TreeNodeSnapshot,
} from '@/core/types'
import { completeTreeView, makeCompleteTree, nodeId, TREE_SIZES } from './treeTraverse'

/**
 * 树与二叉树 —— 遍历的六种写法（递归 3 个 + 非递归 3 个）。
 *
 * 数据约定跟示范算法 treeTraverse.ts 完全一致：一维数字串按**层序**还原成一棵完全二叉树，
 * 第 i 个元素是结点 i（从 0 开始），左右孩子是 2i+1 / 2i+2。
 * 快照直接用 completeTreeView 生成，这里只负责"什么时候高亮谁、栈里有什么"。
 *
 * 纪律：**一个 yield = 一步**。递归版的"进左子树 / 访问根 / 进右子树"各占一帧；
 * 非递归版的"压栈 / 弹栈 / 访问 / 转向右子树"各占一帧，不把两个动作塞进同一帧。
 *
 * 非递归版还要让用户**看见栈和队列本身**，靠三层东西一起说清楚：
 *   - pointers 给栈（队列）里的每个结点挂一个小标签 S0、S1…，栈顶那个叫「栈顶」（队首叫「队首」）
 *     —— 它回答的是"栈里这个结点在树上长什么样"；
 *   - **boards**（见 stackBoard / queueBoard）在树下面另画一块数组板，把栈 / 队列本身整个摊开：
 *     竖排的栈第 0 格在**最下面**（0 号是栈底），横排的队列第 0 格在**最左边**（0 号是队首），
 *     每格的 sub 就是它在栈 / 队列里的位置；本步刚压进去的结点画紫色 hot，
 *     本步重点盯着的那一格（后序"只看栈顶、先不弹"）画红色 mark；
 *   - vars 带出 栈深 / 队列长度 / 已访问 这些量；解说词一律写明"栈里存的是什么、什么时候压、什么时候弹"。
 *
 * 板子下面的 note 一律是「本步做了什么 + 现在的栈深 / 队列长」。空栈空队列把 items 留空、
 * 在 note 里写"栈空 / 队列空"—— 指针没有落点，绝不能硬给下标。
 */

type NodeMap = Map<string, TreeNodeSnapshot>

const byIdOf = (nodes: TreeNodeSnapshot[]): NodeMap => new Map(nodes.map((n) => [n.id, n]))

/** 结点显示值；id 为空就显示"空" */
const valOf = (byId: NodeMap, id: string | null | undefined): string =>
  id ? String(byId.get(id)?.value ?? '?') : '空'

/** 访问顺序的最终结果文字，用来写收尾帧的解说词 */
const orderText = (order: string[], byId: NodeMap): string =>
  order.map((id) => valOf(byId, id)).join(' → ')

/**
 * 把「栈 / 队列里存了哪些结点」翻译成结点上方的小标签。
 * 每个在里面的结点挂一个标签 S0、S1…，栈顶（队首）那个换成 keyName；
 * extra 是额外的变量指针（p、last 之类），万一它跟栈里的结点是同一个就只留一个标签 ——
 * 否则两行小字会重叠在一起看不清。
 */
function framePtrs(
  slots: string[],
  keyIndex: number,
  keyName: string,
  extra: Record<string, string | null> = {},
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  const used = new Set<string>()
  slots.forEach((id, i) => {
    out[i === keyIndex ? keyName : `S${i}`] = id
    used.add(id)
  })
  if (!slots.length) out[keyName] = null
  for (const [name, id] of Object.entries(extra)) {
    if (id !== null && used.has(id)) continue
    out[name] = id
  }
  return out
}

/** 栈：栈底在下标 0，栈顶是最后一个 */
const stackPtrs = (stack: string[], extra: Record<string, string | null> = {}) =>
  framePtrs(stack, stack.length - 1, '栈顶', extra)

/** 队列：队首在下标 0（每次都从队首出队） */
const queuePtrs = (queue: string[], extra: Record<string, string | null> = {}) =>
  framePtrs(queue, 0, '队首', extra)

/* ------------------------------------------------------------------ */
/* 栈 / 队列板子：把栈（队列）本身整个画出来                             */
/* ------------------------------------------------------------------ */

/**
 * 板子的补充说明。
 *   hot   —— 本步刚压入 / 刚入队的那个结点，画成紫色，一眼看出"这一步栈里多了谁"；
 *   focus —— 本步重点盯着的那一格（后序"只看栈顶、先不弹"就是它），画成红色；
 *   act   —— 本步对栈 / 队列做了什么，写在板子下面那行小字的最前面。
 */
interface BoardOpts {
  hot?: string | null
  focus?: number
  act?: string
}

/** 板子下面那行小字 = 本步的动作 + 当前的规模 */
const boardNote = (act: string | undefined, state: string): string =>
  act ? `${act}　${state}` : state

/**
 * 格子的配色：本步刚入栈 / 入队的紫色（hot）、本步重点看的红色（mark）、其余蓝色（base）。
 * 注意"刚弹出"的结点已经不在栈里了，所以板子上没有它的格子 ——
 * 弹栈靠"这一格消失"来表现，再在 note 里写明"刚弹出谁、栈深从几变成几"。
 */
const toneOf = (id: string, i: number, opts: BoardOpts): CellTone =>
  id === opts.hot ? 'hot' : i === opts.focus ? 'mark' : 'base'

/**
 * 栈板子。column 布局第 0 格在**最下面**，所以 items 从栈底往栈顶排，
 * 最后一格就是栈顶，指针「栈顶」指向它（下标 = 栈长 - 1）。
 */
function stackBoard(stack: string[], byId: NodeMap, opts: BoardOpts = {}): BoardView {
  const n = stack.length
  return {
    title: n ? `栈（栈底在下，共 ${n} 个）` : '栈（空）',
    layout: 'column',
    items: stack.map((id, i) => ({
      text: valOf(byId, id),
      sub: String(i), // 在栈里的位置：0 是栈底
      tone: toneOf(id, i, opts),
    })),
    // 空栈不给指针：栈顶根本就不存在，硬给下标就越界了
    pointers: n ? { 栈顶: n - 1 } : {},
    note: boardNote(opts.act, n ? `栈深 ${n}` : '栈空'),
  }
}

/**
 * 队列板子。row 布局从左往右排，items 从队首往队尾排，
 * 第 0 格就是队首，指针「队首」指向它。
 */
function queueBoard(queue: string[], byId: NodeMap, opts: BoardOpts = {}): BoardView {
  const n = queue.length
  return {
    title: n ? `队列（队首在左，共 ${n} 个）` : '队列（空）',
    layout: 'row',
    items: queue.map((id, i) => ({
      text: valOf(byId, id),
      sub: String(i), // 在队列里的位置：0 是队首
      tone: toneOf(id, i, opts),
    })),
    pointers: n ? { 队首: 0 } : {},
    note: boardNote(opts.act, n ? `队列长 ${n}` : '队列空'),
  }
}

/* ------------------------------------------------------------------ */
/* ① 中序遍历（递归）                                                   */
/* ------------------------------------------------------------------ */

const CODE_INORDER_REC = [
  'void inOrder(BiTree T) {',
  '  if (T == NULL) return;         // 空树直接返回',
  '  inOrder(T->left);              // ① 先递归遍历左子树',
  '  visit(T);                      // ② 左子树走完才访问根',
  '  inOrder(T->right);             // ③ 最后递归遍历右子树',
  '}',
]

function* runInorderRec(data: number[]): AlgoRunner {
  const nodes = makeCompleteTree(data)
  const byId = byIdOf(nodes)
  const seq = data.slice(0, nodes.length)
  const done: string[] = []

  yield {
    line: 1,
    action: 'init',
    array: seq,
    tree: completeTreeView(data, { note: '中序遍历：左子树 -> 根 -> 右子树' }),
    comment: `把数据按层序还原成完全二叉树，共 ${nodes.length} 个结点。中序遍历的口诀是"左 -> 根 -> 右"，下面从根开始递归`,
    vars: { n: nodes.length },
  }
  if (!nodes.length) return

  // 递归函数翻译成生成器：每进一层就 yield* 下去，访问顺序自然就是中序
  function* walk(id: string | null | undefined): AlgoRunner {
    if (!id) return
    const n = byId.get(id)
    if (!n) return

    if (n.left) {
      yield {
        line: 3,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [n.left],
          done: [...done],
          pointers: { T: id },
          note: `先钻到 ${n.value} 的左子树（根是 ${valOf(byId, n.left)}）`,
        }),
        comment: `① 结点 ${n.value} 有左子树（根是 ${valOf(byId, n.left)}），先递归进去，它自己先不访问`,
        vars: { n: nodes.length },
      }
      yield* walk(n.left)
    }

    done.push(id)
    yield {
      line: 4,
      action: 'mark',
      array: seq,
      tree: completeTreeView(data, {
        hot: [id],
        done: [...done],
        pointers: { T: id },
        note: `访问 ${n.value}（第 ${done.length} 个）`,
      }),
      comment: `② 左子树已经走完，轮到自己：访问根结点 ${n.value}，这是第 ${done.length} 个被访问的结点`,
      vars: { 已访问: done.length },
    }

    if (n.right) {
      yield {
        line: 5,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [n.right],
          done: [...done],
          pointers: { T: id },
          note: `再钻到 ${n.value} 的右子树（根是 ${valOf(byId, n.right)}）`,
        }),
        comment: `③ ${n.value} 处理完了，最后递归它的右子树（根是 ${valOf(byId, n.right)}）`,
        vars: { 已访问: done.length },
      }
      yield* walk(n.right)
    }
  }

  yield* walk(nodeId(0))

  yield {
    line: 6,
    action: 'done',
    array: seq,
    tree: completeTreeView(data, { done: [...done], note: '中序遍历结束' }),
    comment: `中序遍历结束，访问顺序是：${orderText(done, byId)}`,
    vars: { 已访问: done.length },
  }
}

/* ------------------------------------------------------------------ */
/* ② 后序遍历（递归）                                                   */
/* ------------------------------------------------------------------ */

const CODE_POSTORDER_REC = [
  'void postOrder(BiTree T) {',
  '  if (T == NULL) return;         // 空树直接返回',
  '  postOrder(T->left);            // ① 先递归遍历左子树',
  '  postOrder(T->right);           // ② 再递归遍历右子树',
  '  visit(T);                      // ③ 左右都完了才访问根',
  '}',
]

function* runPostorderRec(data: number[]): AlgoRunner {
  const nodes = makeCompleteTree(data)
  const byId = byIdOf(nodes)
  const seq = data.slice(0, nodes.length)
  const done: string[] = []

  yield {
    line: 1,
    action: 'init',
    array: seq,
    tree: completeTreeView(data, { note: '后序遍历：左子树 -> 右子树 -> 根' }),
    comment: `把数据按层序还原成完全二叉树，共 ${nodes.length} 个结点。后序遍历的口诀是"左 -> 右 -> 根"，根是最后才访问的`,
    vars: { n: nodes.length },
  }
  if (!nodes.length) return

  function* walk(id: string | null | undefined): AlgoRunner {
    if (!id) return
    const n = byId.get(id)
    if (!n) return

    if (n.left) {
      yield {
        line: 3,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [n.left],
          done: [...done],
          pointers: { T: id },
          note: `先进 ${n.value} 的左子树（根是 ${valOf(byId, n.left)}）`,
        }),
        comment: `① 结点 ${n.value} 先递归左子树（根是 ${valOf(byId, n.left)}）`,
        vars: { n: nodes.length },
      }
      yield* walk(n.left)
    }

    if (n.right) {
      yield {
        line: 4,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [n.right],
          done: [...done],
          pointers: { T: id },
          note: `再进 ${n.value} 的右子树（根是 ${valOf(byId, n.right)}）`,
        }),
        comment: `② ${n.value} 的左子树走完了，接着递归它的右子树（根是 ${valOf(byId, n.right)}）`,
        vars: { 已访问: done.length },
      }
      yield* walk(n.right)
    }

    done.push(id)
    yield {
      line: 5,
      action: 'mark',
      array: seq,
      tree: completeTreeView(data, {
        hot: [id],
        done: [...done],
        pointers: { T: id },
        note: `访问 ${n.value}（第 ${done.length} 个）`,
      }),
      comment: `③ 结点 ${n.value} 的左右子树都走完了，最后才访问它 —— 这就是"根在最后"，第 ${done.length} 个被访问`,
      vars: { 已访问: done.length },
    }
  }

  yield* walk(nodeId(0))

  yield {
    line: 6,
    action: 'done',
    array: seq,
    tree: completeTreeView(data, { done: [...done], note: '后序遍历结束' }),
    comment: `后序遍历结束，访问顺序是：${orderText(done, byId)}`,
    vars: { 已访问: done.length },
  }
}

/* ------------------------------------------------------------------ */
/* ③ 层次遍历（队列）                                                   */
/* ------------------------------------------------------------------ */

const CODE_LEVEL = [
  'void levelOrder(BiTree T) {',
  '  Queue Q; InitQueue(Q);                     // 队列里放"还没访问的结点"',
  '  if (T) EnQueue(Q, T);                      // ① 根结点入队',
  '  while (!QueueEmpty(Q)) {',
  '    p = DeQueue(Q);                          // ② 队首出队',
  '    visit(p);                                // ③ 访问它',
  '    if (p->left)  EnQueue(Q, p->left);       // ④ 左孩子排到队尾',
  '    if (p->right) EnQueue(Q, p->right);      // ⑤ 右孩子排到队尾',
  '  }',
  '}',
]

function* runLevel(data: number[]): AlgoRunner {
  const nodes = makeCompleteTree(data)
  const byId = byIdOf(nodes)
  const seq = data.slice(0, nodes.length)
  const done: string[] = []
  /** 队列：队首在 [0]，出队从队首走 */
  const queue: string[] = []
  /** 跟 queue 一一对应的"第几层"，这样解说词能说出"现在是第几层" */
  const depths: number[] = []

  yield {
    line: 1,
    action: 'init',
    array: seq,
    tree: completeTreeView(data, { note: '层次遍历：用队列，一层一层往下推进' }),
    comment: `把数据按层序还原成完全二叉树，共 ${nodes.length} 个结点。层次遍历要借一个队列：先进先出，所以同一层的结点必然连着出队`,
    vars: { n: nodes.length, 队列长度: 0 },
    boards: [queueBoard(queue, byId, { act: '初始化：队列还是空的' })],
  }
  if (!nodes.length) return

  const root = nodeId(0)
  queue.push(root)
  depths.push(1)
  yield {
    line: 3,
    action: 'mark',
    array: seq,
    tree: completeTreeView(data, {
      hot: [root],
      pointers: queuePtrs(queue),
      note: '根结点入队',
    }),
    comment: `① 先把根结点 ${valOf(byId, root)} 入队 —— 队列里存的就是"已经排上号、还没访问"的结点`,
    vars: { 队列长度: queue.length, 层: 1 },
    boards: [
      queueBoard(queue, byId, {
        hot: root,
        act: `根结点 ${valOf(byId, root)} 入队，它就是队首`,
      }),
    ],
  }

  while (queue.length) {
    const id = queue.shift()!
    const dep = depths.shift()!
    const n = byId.get(id)!

    yield {
      line: 5,
      action: 'mark',
      array: seq,
      tree: completeTreeView(data, {
        hot: [id],
        done: [...done],
        pointers: queuePtrs(queue, { p: id }),
        note: `第 ${dep} 层：${n.value} 出队`,
      }),
      comment: `② 队首 ${n.value} 出队（它是第 ${dep} 层的结点）—— 队列先进先出，所以上一层没出完，下一层的结点绝不会先出队，画面就是一层一层往下推`,
      vars: { 队列长度: queue.length, 层: dep },
      boards: [
        queueBoard(queue, byId, {
          act: `刚把队首 ${n.value} 出队：队列长 ${queue.length + 1} -> ${queue.length}`,
        }),
      ],
    }

    done.push(id)
    yield {
      line: 6,
      action: 'mark',
      array: seq,
      tree: completeTreeView(data, {
        hot: [id],
        done: [...done],
        pointers: queuePtrs(queue, { p: id }),
        note: `访问 ${n.value}（第 ${done.length} 个）`,
      }),
      comment: `③ 访问 ${n.value}（第 ${dep} 层，总共第 ${done.length} 个）—— 已经访问过的结点变成绿色`,
      vars: { 队列长度: queue.length, 层: dep },
      boards: [
        queueBoard(queue, byId, { act: `只是访问 ${n.value}，队列没动（它的孩子下一步才入队）` }),
      ],
    }

    if (n.left) {
      queue.push(n.left)
      depths.push(dep + 1)
      yield {
        line: 7,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [n.left],
          done: [...done],
          pointers: queuePtrs(queue),
          note: `${valOf(byId, n.left)} 排到队尾`,
        }),
        comment: `④ 左孩子 ${valOf(byId, n.left)} 入队、排到队尾（它属于第 ${dep + 1} 层，要等第 ${dep} 层的结点全出完才轮到它）`,
        vars: { 队列长度: queue.length, 层: dep },
        boards: [
          queueBoard(queue, byId, {
            hot: n.left,
            act: `左孩子 ${valOf(byId, n.left)} 入队，排到队尾`,
          }),
        ],
      }
    }

    if (n.right) {
      queue.push(n.right)
      depths.push(dep + 1)
      yield {
        line: 8,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [n.right],
          done: [...done],
          pointers: queuePtrs(queue),
          note: `${valOf(byId, n.right)} 排到队尾`,
        }),
        comment: `⑤ 右孩子 ${valOf(byId, n.right)} 入队、排在左孩子后面 —— 同一层里永远是"先左后右"`,
        vars: { 队列长度: queue.length, 层: dep },
        boards: [
          queueBoard(queue, byId, {
            hot: n.right,
            act: `右孩子 ${valOf(byId, n.right)} 入队，排在左孩子后面`,
          }),
        ],
      }
    }
  }

  yield {
    line: 10,
    action: 'done',
    array: seq,
    tree: completeTreeView(data, { done: [...done], note: '层次遍历结束' }),
    comment: `队列空了，遍历结束。访问顺序是：${orderText(done, byId)}`,
    vars: { 队列长度: 0, 已访问: done.length },
    boards: [queueBoard(queue, byId, { act: '队首全部出完，队列空了' })],
  }
}

/* ------------------------------------------------------------------ */
/* ④ 先序遍历（非递归，栈）                                             */
/* ------------------------------------------------------------------ */

const CODE_PRE_ITER = [
  'void preOrderIter(BiTree T) {',
  '  Stack S; InitStack(S);',
  '  if (T) Push(S, T);                        // 根结点先入栈',
  '  while (!StackEmpty(S)) {',
  '    p = Pop(S);                             // ① 弹出栈顶',
  '    visit(p);                               // ② 出栈即访问',
  '    if (p->right) Push(S, p->right);        // ③ 右孩子先入栈',
  '    if (p->left)  Push(S, p->left);         // ④ 左孩子后入栈：后进先出，左孩子先出栈',
  '  }',
  '}',
]

function* runPreorderIter(data: number[]): AlgoRunner {
  const nodes = makeCompleteTree(data)
  const byId = byIdOf(nodes)
  const seq = data.slice(0, nodes.length)
  const done: string[] = []
  const stack: string[] = []

  yield {
    line: 1,
    action: 'init',
    array: seq,
    tree: completeTreeView(data, { note: '先序非递归：用栈模拟递归，出栈即访问' }),
    comment: `把数据按层序还原成完全二叉树，共 ${nodes.length} 个结点。非递归先序用一个栈：栈里存的是"还没访问的子树根"`,
    vars: { n: nodes.length, 栈深: 0 },
    boards: [stackBoard(stack, byId, { act: '初始化：栈还是空的' })],
  }
  if (!nodes.length) return

  const root = nodeId(0)
  stack.push(root)
  yield {
    line: 3,
    action: 'mark',
    array: seq,
    tree: completeTreeView(data, { hot: [root], pointers: stackPtrs(stack), note: '根结点入栈' }),
    comment: `根结点 ${valOf(byId, root)} 先入栈 —— 栈里放的就是"已经排上、还没访问"的子树根`,
    vars: { 栈深: stack.length, 已访问: 0 },
    boards: [
      stackBoard(stack, byId, { hot: root, act: `根结点 ${valOf(byId, root)} 压栈，它成了栈顶` }),
    ],
  }

  while (stack.length) {
    const id = stack.pop()!
    const n = byId.get(id)!

    yield {
      line: 5,
      action: 'mark',
      array: seq,
      tree: completeTreeView(data, {
        hot: [id],
        done: [...done],
        pointers: stackPtrs(stack, { p: id }),
        note: `弹出栈顶 ${n.value}（栈深 ${stack.length}）`,
      }),
      comment: `① 弹出栈顶结点 ${n.value}（压栈时它是子树的根，现在出栈了）—— 先序里"出栈的顺序就是访问顺序"，栈深从 ${stack.length + 1} 变成 ${stack.length}`,
      vars: { 栈深: stack.length, 已访问: done.length },
      boards: [
        stackBoard(stack, byId, {
          act: `刚弹出栈顶 ${n.value}：栈深 ${stack.length + 1} -> ${stack.length}，它已经不在栈里了`,
        }),
      ],
    }

    done.push(id)
    yield {
      line: 6,
      action: 'mark',
      array: seq,
      tree: completeTreeView(data, {
        hot: [id],
        done: [...done],
        pointers: stackPtrs(stack, { p: id }),
        note: `访问 ${n.value}（第 ${done.length} 个）`,
      }),
      comment: `② 访问 ${n.value}，这是第 ${done.length} 个被访问的结点（先序：根先被访问）`,
      vars: { 栈深: stack.length, 已访问: done.length },
      boards: [stackBoard(stack, byId, { act: `只是访问 ${n.value}，栈没动` })],
    }

    if (n.right) {
      stack.push(n.right)
      yield {
        line: 7,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [n.right],
          done: [...done],
          pointers: stackPtrs(stack),
          note: `右孩子 ${valOf(byId, n.right)} 入栈`,
        }),
        comment: `③ 先把**右**孩子 ${valOf(byId, n.right)} 压栈 —— 它要排在左子树后面，所以先进栈（后出栈）`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [
          stackBoard(stack, byId, {
            hot: n.right,
            act: `右孩子 ${valOf(byId, n.right)} 压栈：先压右孩子，它反而后出栈`,
          }),
        ],
      }
    }

    if (n.left) {
      stack.push(n.left)
      yield {
        line: 8,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [n.left],
          done: [...done],
          pointers: stackPtrs(stack),
          note: `左孩子 ${valOf(byId, n.left)} 入栈（成为栈顶）`,
        }),
        comment: `④ 再把**左**孩子 ${valOf(byId, n.left)} 压栈 —— 它后进栈却成了栈顶，下一个弹出的就是它，这样就实现了"先左后右"`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [
          stackBoard(stack, byId, {
            hot: n.left,
            act: `左孩子 ${valOf(byId, n.left)} 压栈，成了新栈顶，下一个弹的就是它`,
          }),
        ],
      }
    }
  }

  yield {
    line: 10,
    action: 'done',
    array: seq,
    tree: completeTreeView(data, { done: [...done], note: '先序非递归结束' }),
    comment: `栈空了，遍历结束。访问顺序是：${orderText(done, byId)}`,
    vars: { 栈深: 0, 已访问: done.length },
    boards: [stackBoard(stack, byId, { act: '栈空了，遍历结束' })],
  }
}

/* ------------------------------------------------------------------ */
/* ⑤ 中序遍历（非递归，栈）                                             */
/* ------------------------------------------------------------------ */

const CODE_IN_ITER = [
  'void inOrderIter(BiTree T) {',
  '  Stack S; InitStack(S);',
  '  p = T;                        // p 是工作指针，栈里放"还没访问的祖先"',
  '  while (p != NULL || !StackEmpty(S)) {',
  '    if (p != NULL) {',
  '      Push(S, p);               // ① 沿左链一路压栈',
  '      p = p->left;              // ② p 继续往左下走',
  '    } else {',
  '      p = Pop(S);               // ③ 左链到头，弹出栈顶',
  '      visit(p);                 // ④ 访问它（左子树已全部访问完）',
  '      p = p->right;             // ⑤ 转向右子树',
  '    }',
  '  }',
  '}',
]

function* runInorderIter(data: number[]): AlgoRunner {
  const nodes = makeCompleteTree(data)
  const byId = byIdOf(nodes)
  const seq = data.slice(0, nodes.length)
  const done: string[] = []
  const stack: string[] = []
  let p: string | null = nodes.length ? nodeId(0) : null

  yield {
    line: 1,
    action: 'init',
    array: seq,
    tree: completeTreeView(data, { note: '中序非递归：沿左链压栈，弹出来访问后再转向右子树' }),
    comment: `把数据按层序还原成完全二叉树，共 ${nodes.length} 个结点。非递归中序的策略是"能往左就往左，走不动了才弹栈"：栈里放的是左子树还没走完的祖先`,
    vars: { n: nodes.length, 栈深: 0 },
    boards: [stackBoard(stack, byId, { act: '初始化：p 还没动，栈是空的' })],
  }
  if (!nodes.length) return

  yield {
    line: 3,
    action: 'mark',
    array: seq,
    tree: completeTreeView(data, {
      hot: [p!],
      pointers: { p },
      note: `工作指针 p 指向根结点 ${valOf(byId, p)}`,
    }),
    comment: `工作指针 p 指向根结点 ${valOf(byId, p)}，栈还是空的`,
    vars: { 栈深: 0, 已访问: 0 },
    boards: [stackBoard(stack, byId, { act: `p 指向根结点 ${valOf(byId, p)}，还没压栈` })],
  }

  while (p || stack.length) {
    if (p) {
      const n = byId.get(p)!
      stack.push(p)
      yield {
        line: 6,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [p],
          done: [...done],
          pointers: stackPtrs(stack),
          note: `把 ${n.value} 压入栈（栈深 ${stack.length}）`,
        }),
        comment: `① 结点 ${n.value} 压栈：它的左子树还没走完，所以它自己先不访问，先记在栈里。栈深变成 ${stack.length}`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [
          stackBoard(stack, byId, {
            hot: p,
            act: `${n.value} 压栈：它的左子树还没走完，先记在栈里`,
          }),
        ],
      }

      p = n.left ?? null
      yield {
        line: 7,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: p ? [p] : [],
          done: [...done],
          pointers: stackPtrs(stack, { p }),
          note: p ? `p 往左下走到 ${valOf(byId, p)}` : 'p 变成空：左链走到头了',
        }),
        comment: p
          ? `② p = p->left，继续往左下走，指向 ${valOf(byId, p)} —— 只要还有左孩子就一直压栈`
          : `② p = p->left 得到空，说明已经走到最左端 —— 该弹栈了`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [
          stackBoard(stack, byId, {
            act: p ? `p 走到 ${valOf(byId, p)}，栈没动` : 'p 变成空，栈没动（该弹栈了）',
          }),
        ],
      }
    } else {
      const id = stack[stack.length - 1]!
      stack.pop()
      yield {
        line: 9,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [id],
          done: [...done],
          pointers: stackPtrs(stack, { p: null }),
          note: `弹出栈顶 ${valOf(byId, id)}`,
        }),
        comment: `③ 左链走到空，弹出栈顶 ${valOf(byId, id)} —— 它就是当前最靠左、还没被访问的结点（栈深 ${stack.length + 1} -> ${stack.length}）`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [
          stackBoard(stack, byId, {
            act: `刚弹出栈顶 ${valOf(byId, id)}：栈深 ${stack.length + 1} -> ${stack.length}，它已经不在栈里了`,
          }),
        ],
      }

      done.push(id)
      yield {
        line: 10,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [id],
          done: [...done],
          pointers: stackPtrs(stack, { p: null }),
          note: `访问 ${valOf(byId, id)}（第 ${done.length} 个）`,
        }),
        comment: `④ 访问 ${valOf(byId, id)}：此时它的左子树已经全部访问完，才轮到它自己（左 -> 根）`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [stackBoard(stack, byId, { act: `只是访问 ${valOf(byId, id)}，栈没动` })],
      }

      p = byId.get(id)!.right ?? null
      yield {
        line: 11,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: p ? [p] : [],
          done: [...done],
          pointers: stackPtrs(stack, { p }),
          note: p ? `p 转向右子树 ${valOf(byId, p)}` : '没有右子树，p 仍为空',
        }),
        comment: p
          ? `⑤ p = p->right，转向 ${valOf(byId, id)} 的右子树（根是 ${valOf(byId, p)}）：右子树要重新"能往左就往左"地压栈`
          : `⑤ ${valOf(byId, id)} 没有右子树，p 保持为空 —— 下一个循环继续弹栈，回到它的祖先`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [
          stackBoard(stack, byId, {
            act: p ? `p 转向右子树 ${valOf(byId, p)}，栈没动` : '没有右子树，栈没动',
          }),
        ],
      }
    }
  }

  yield {
    line: 14,
    action: 'done',
    array: seq,
    tree: completeTreeView(data, { done: [...done], note: '中序非递归结束' }),
    comment: `栈空了、p 也空了，遍历结束。访问顺序是：${orderText(done, byId)}`,
    vars: { 栈深: 0, 已访问: done.length },
    boards: [stackBoard(stack, byId, { act: '栈空了、p 也空了，遍历结束' })],
  }
}

/* ------------------------------------------------------------------ */
/* ⑥ 后序遍历（非递归，栈 + 访问标记）                                   */
/* ------------------------------------------------------------------ */

const CODE_POST_ITER = [
  'void postOrderIter(BiTree T) {',
  '  Stack S; InitStack(S);',
  '  p = T; last = NULL;              // last 记住"上一个被访问的结点"',
  '  while (p != NULL || !StackEmpty(S)) {',
  '    if (p != NULL) {',
  '      Push(S, p);                  // ① 一路向左，走过的结点全部压栈',
  '      p = p->left;                 // ② p 继续往左下走',
  '    } else {',
  '      top = GetTop(S);             // ③ 看栈顶，但先别弹',
  '      if (top->right != NULL && last != top->right) {',
  '        p = top->right;            // ④ 右子树还没访问，先去右子树',
  '      } else {',
  '        visit(top);                // ⑤ 右子树访问过了（或本来没有），才能访问栈顶',
  '        last = top;                // ⑥ 记下它：下次靠它判断"右子树是否已访问"',
  '        Pop(S);                    // ⑦ 它彻底处理完了，出栈',
  '      }',
  '    }',
  '  }',
  '}',
]

function* runPostorderIter(data: number[]): AlgoRunner {
  const nodes = makeCompleteTree(data)
  const byId = byIdOf(nodes)
  const seq = data.slice(0, nodes.length)
  const done: string[] = []
  const stack: string[] = []
  let p: string | null = nodes.length ? nodeId(0) : null
  let last: string | null = null

  yield {
    line: 1,
    action: 'init',
    array: seq,
    tree: completeTreeView(data, { note: '后序非递归：栈 + last 标记，右子树访问过才敢访问根' }),
    comment: `把数据按层序还原成完全二叉树，共 ${nodes.length} 个结点。后序非递归比中序多一个难题：栈顶结点的左右子树都访问完才能访问它，可是"右子树到底访问过没有"从栈里看不出来，所以要额外用 last 记住上一个被访问的结点`,
    vars: { n: nodes.length, 栈深: 0 },
    boards: [
      stackBoard(stack, byId, {
        act: `初始化：栈是空的，last = ${valOf(byId, last)}（还没访问过任何结点）`,
      }),
    ],
  }
  if (!nodes.length) return

  yield {
    line: 3,
    action: 'mark',
    array: seq,
    tree: completeTreeView(data, {
      hot: [p!],
      pointers: { p, last: null },
      note: `p 指向根 ${valOf(byId, p)}，last = NULL`,
    }),
    comment: `工作指针 p 指向根结点 ${valOf(byId, p)}；last（上一个被访问的结点）初值为 NULL —— 它就是判断"右子树是否已访问"的依据`,
    vars: { 栈深: 0, 已访问: 0 },
    boards: [
      stackBoard(stack, byId, { act: `p 指向根 ${valOf(byId, p)}，还没压栈；last = ${valOf(byId, last)}` }),
    ],
  }

  while (p || stack.length) {
    if (p) {
      const n = byId.get(p)!
      stack.push(p)
      yield {
        line: 6,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [p],
          done: [...done],
          pointers: stackPtrs(stack, { last }),
          note: `把 ${n.value} 压入栈（栈深 ${stack.length}）`,
        }),
        comment: `① 结点 ${n.value} 压栈：后序要等它的左右子树都访问完，所以现在还不能访问它，先记着。栈深变成 ${stack.length}`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [
          stackBoard(stack, byId, {
            hot: p,
            act: `${n.value} 压栈：左右子树都还没走完，先记着；last = ${valOf(byId, last)}`,
          }),
        ],
      }

      p = n.left ?? null
      yield {
        line: 7,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: p ? [p] : [],
          done: [...done],
          pointers: stackPtrs(stack, { p, last }),
          note: p ? `p 往左下走到 ${valOf(byId, p)}` : 'p 变成空：左链走到头了',
        }),
        comment: p
          ? `② p = p->left，继续往左下走，指向 ${valOf(byId, p)}`
          : `② p = p->left 得到空，左链走到头 —— 该看栈顶了，但只看不弹`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [
          stackBoard(stack, byId, {
            act:
              (p ? `p 走到 ${valOf(byId, p)}` : 'p 变成空，左链到头了') +
              `，栈没动；last = ${valOf(byId, last)}`,
          }),
        ],
      }
    } else {
      const top = stack[stack.length - 1]!
      const tn = byId.get(top)!
      const right = tn.right ?? null

      yield {
        line: 9,
        action: 'mark',
        array: seq,
        tree: completeTreeView(data, {
          hot: [top],
          done: [...done],
          pointers: stackPtrs(stack, { p: null, last }),
          note: `看栈顶 top = ${tn.value}（先不弹）`,
        }),
        comment: `③ p 为空，取栈顶 top = ${valOf(byId, top)}，但**先不弹** —— 得先确认它的右子树访问完了没有`,
        vars: { 栈深: stack.length, 已访问: done.length },
        boards: [
          stackBoard(stack, byId, {
            focus: stack.length - 1,
            act: `看栈顶 top = ${tn.value}（红色那格），先不弹；last = ${valOf(byId, last)}`,
          }),
        ],
      }

      if (right && last !== right) {
        p = right
        yield {
          line: 11,
          action: 'mark',
          array: seq,
          tree: completeTreeView(data, {
            hot: [right],
            done: [...done],
            pointers: stackPtrs(stack, { p: right, last }),
            note: `右子树 ${valOf(byId, right)} 还没访问，先转过去`,
          }),
          comment: `④ 栈顶 ${valOf(byId, top)} 的右孩子是 ${valOf(byId, right)}，而 last = ${valOf(byId, last)} 不等于它 —— 说明右子树还没访问过，所以不能访问栈顶，先转去右子树`,
          vars: { 栈深: stack.length, 已访问: done.length },
          boards: [
            stackBoard(stack, byId, {
              act: `右子树 ${valOf(byId, right)} 还没访问（它 != last = ${valOf(byId, last)}），先转过去；栈没动`,
            }),
          ],
        }
      } else {
        done.push(top)
        yield {
          line: 13,
          action: 'mark',
          array: seq,
          tree: completeTreeView(data, {
            hot: [top],
            done: [...done],
            pointers: stackPtrs(stack, { p: null, last }),
            note: `访问 ${valOf(byId, top)}（第 ${done.length} 个）`,
          }),
          comment: right
            ? `⑤ 栈顶 ${valOf(byId, top)} 的右子树根是 ${valOf(byId, right)}，而 last = ${valOf(byId, last)} 正好等于它 —— 说明右子树刚访问完，现在左右都完了，可以访问 ${valOf(byId, top)} 了`
            : `⑤ 栈顶 ${valOf(byId, top)} 根本没有右子树，左边也已经走完，所以可以直接访问它（第 ${done.length} 个）`,
          vars: { 栈深: stack.length, 已访问: done.length },
          boards: [
            stackBoard(stack, byId, {
              act: `访问栈顶 ${valOf(byId, top)}，但它还在栈里（下一步才弹）；last 现在还是 ${valOf(byId, last)}`,
            }),
          ],
        }

        last = top
        yield {
          line: 14,
          action: 'mark',
          array: seq,
          tree: completeTreeView(data, {
            hot: [top],
            done: [...done],
            pointers: stackPtrs(stack, { p: null, last }),
            note: `last = ${valOf(byId, last)}`,
          }),
          comment: `⑥ 把 last 更新为刚访问的 ${valOf(byId, last)} —— 这一步就是为了回答"右子树是否已访问"：下次再看栈顶时，只要 last 等于栈顶的右孩子，就说明它的右子树处理完了`,
          vars: { 栈深: stack.length, 已访问: done.length },
          boards: [
            stackBoard(stack, byId, {
              focus: stack.length - 1,
              act: `last 更新成 ${valOf(byId, last)} —— 它此刻还压在栈顶（红色那格），下一步才出栈`,
            }),
          ],
        }

        stack.pop()
        yield {
          line: 15,
          action: 'mark',
          array: seq,
          tree: completeTreeView(data, {
            hot: [],
            done: [...done],
            pointers: stackPtrs(stack, { p: null, last }),
            note: `${valOf(byId, top)} 已访问完，出栈（栈深 ${stack.length}）`,
          }),
          comment: `⑦ ${valOf(byId, top)} 已经访问完了，它彻底没用了，出栈。栈深 ${stack.length + 1} -> ${stack.length}，接下来回到它的祖先`,
          vars: { 栈深: stack.length, 已访问: done.length },
          boards: [
            stackBoard(stack, byId, {
              act: `刚弹出 ${valOf(byId, top)}：它已经不在栈里了，可 last 还记着它（last = ${valOf(byId, last)}）—— 这就是后序判断"右子树是否已访问"的依据`,
            }),
          ],
        }
      }
    }
  }

  yield {
    line: 19,
    action: 'done',
    array: seq,
    tree: completeTreeView(data, { done: [...done], note: '后序非递归结束' }),
    comment: `栈空了、p 也空了，遍历结束。访问顺序是：${orderText(done, byId)}`,
    vars: { 栈深: 0, 已访问: done.length },
    boards: [
      stackBoard(stack, byId, {
        act: `栈空了，遍历结束；last = ${valOf(byId, last)} 是最后访问的那个，它也不在栈里了`,
      }),
    ],
  }
}

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_DATA = () => [1, 2, 3, 4, 5, 6, 7]

export const treeTraverse2Specs: AlgorithmSpec[] = [
  {
    id: 'tree-inorder-rec',
    name: '中序遍历（递归）',
    category: 'tree',
    group: '二叉树的遍历',
    summary: '左 -> 根 -> 右，递归实现',
    complexity: { time: 'O(n)', space: 'O(h)，h 是树高（递归栈深度）' },
    renderer: 'tree',
    codeLines: CODE_INORDER_REC,
    defaultData: DEFAULT_DATA,
    // 结点数就是数据个数：选几个数据就画几个结点
    sizes: TREE_SIZES,
    initTree: (data) => completeTreeView(data, { note: '中序遍历：左子树 -> 根 -> 右子树' }),
    createRunner: runInorderRec,
  },
  {
    id: 'tree-postorder-rec',
    name: '后序遍历（递归）',
    category: 'tree',
    group: '二叉树的遍历',
    summary: '左 -> 右 -> 根，递归实现',
    complexity: { time: 'O(n)', space: 'O(h)，h 是树高（递归栈深度）' },
    renderer: 'tree',
    codeLines: CODE_POSTORDER_REC,
    defaultData: DEFAULT_DATA,
    // 结点数就是数据个数：选几个数据就画几个结点
    sizes: TREE_SIZES,
    initTree: (data) => completeTreeView(data, { note: '后序遍历：左子树 -> 右子树 -> 根' }),
    createRunner: runPostorderRec,
  },
  {
    id: 'tree-level',
    name: '层次遍历',
    category: 'tree',
    group: '二叉树的遍历',
    summary: '用队列一层一层地访问，先进先出',
    complexity: { time: 'O(n)', space: 'O(w)，w 是树的最大宽度' },
    renderer: 'tree',
    codeLines: CODE_LEVEL,
    defaultData: DEFAULT_DATA,
    // 结点数就是数据个数：选几个数据就画几个结点
    sizes: TREE_SIZES,
    initTree: (data) => completeTreeView(data, { note: '层次遍历：队列实现，一层一层往下推进' }),
    createRunner: runLevel,
  },
  {
    id: 'tree-preorder-iter',
    name: '先序遍历（非递归）',
    category: 'tree',
    group: '二叉树的遍历',
    summary: '用栈模拟递归，出栈即访问（右孩子先入栈）',
    complexity: { time: 'O(n)', space: 'O(h)，h 是树高（栈的深度）' },
    renderer: 'tree',
    codeLines: CODE_PRE_ITER,
    defaultData: DEFAULT_DATA,
    // 结点数就是数据个数：选几个数据就画几个结点
    sizes: TREE_SIZES,
    initTree: (data) => completeTreeView(data, { note: '先序非递归：用栈模拟递归' }),
    createRunner: runPreorderIter,
  },
  {
    id: 'tree-inorder-iter',
    name: '中序遍历（非递归）',
    category: 'tree',
    group: '二叉树的遍历',
    summary: '沿左链一路压栈，弹出来访问后再转向右子树',
    complexity: { time: 'O(n)', space: 'O(h)，h 是树高（栈的深度）' },
    renderer: 'tree',
    codeLines: CODE_IN_ITER,
    defaultData: DEFAULT_DATA,
    // 结点数就是数据个数：选几个数据就画几个结点
    sizes: TREE_SIZES,
    initTree: (data) => completeTreeView(data, { note: '中序非递归：左链压栈 -> 弹栈访问 -> 转右子树' }),
    createRunner: runInorderIter,
  },
  {
    id: 'tree-postorder-iter',
    name: '后序遍历（非递归）',
    category: 'tree',
    group: '二叉树的遍历',
    summary: '栈 + last 访问标记：确认右子树访问过，才敢访问栈顶',
    complexity: { time: 'O(n)', space: 'O(h)，h 是树高（栈的深度）' },
    renderer: 'tree',
    codeLines: CODE_POST_ITER,
    defaultData: DEFAULT_DATA,
    // 结点数就是数据个数：选几个数据就画几个结点
    sizes: TREE_SIZES,
    initTree: (data) =>
      completeTreeView(data, { note: '后序非递归：栈 + last 标记，判断右子树是否已访问' }),
    createRunner: runPostorderIter,
  },
]
