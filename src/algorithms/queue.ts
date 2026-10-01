import type {
  AlgorithmSpec,
  AlgoRunner,
  BoardView,
  CellTone,
  ListView,
  RunnerContext,
} from '@/core/types'
import {
  dataOrder,
  idGen,
  makeChain,
  makeHeadedList,
  view,
  type MutableNode,
  type ViewOptions,
} from '@/core/list'

/**
 * 队列：循环队列（环形顺序存储）+ 链队列（带头结点）。
 *
 * ================= 循环队列的取模约定 =================
 * data[0..MAXSIZE-1] 首尾相接成一个环，容量 MAXSIZE = 8，并且**牺牲一个空位**：
 *   front 指向**队头元素**；
 *   rear  指向**队尾元素的下一个空位**（也就是下一个可插入的位置）。
 *   队空：front == rear
 *   队满：(rear + 1) % MAXSIZE == front
 *   元素个数：count = (rear - front + MAXSIZE) % MAXSIZE
 *   入队：data[rear] = x;  Q.rear = (Q.rear + 1) % MAXSIZE;
 *   出队：x = data[front]; Q.front = (Q.front + 1) % MAXSIZE;
 *
 * 为什么这么定：两个指针的取值范围永远落在 [0, MAXSIZE-1] 里，所以把它们直接当格子序号
 * 画成指针**绝不会越界**；而"牺牲一个空位"换来的好处是 —— 不用额外的 count 或 tag，
 * 只比较 front / rear 就能区分队空和队满（代价是环里最多只装 MAXSIZE-1 个元素）。
 *
 * ================= 链队列的约定 =================
 * 带头结点：front 指向头结点，rear 指向队尾结点（头结点不存数据）。
 *   队空：front == rear，两个指针都指着头结点
 *   入队：只允许在队尾结点之后插入，插完 rear = s
 *   出队：摘掉 front->next 那个结点；若出队后队列变空（rear == q），
 *         必须让 rear = front 重新指回头结点，否则 rear 会指着已被 delete 的结点
 */
const CAP = 8
/** 链队列一行最多摆几个结点（再长就摆不下了） */
const LINKQ_CAP = 6

// ---------------------------------------------------------------------------
// 循环队列：环形场景板子
// ---------------------------------------------------------------------------

/**
 * 队空时 front 和 rear 落在同一格，两个标签会叠在一起看不清，
 * 所以重合时合成一个 `front=rear` 画出来（下标依然落在 items 范围内）。
 */
function ringPointers(front: number, rear: number): Record<string, number> {
  return front === rear ? { 'front=rear': front } : { front, rear }
}

/**
 * 画一圈格子：第 0 格在 12 点方向，顺时针排下去。
 * 队列里有效元素 = "从 front 开始连续 count 格"（跨过末尾就绕回 0），其余格子是空位。
 */
function ringBoard(
  slots: (number | null)[],
  front: number,
  rear: number,
  count: number,
  opts: { marks?: Record<number, CellTone>; note?: string } = {},
): BoardView {
  const cap = slots.length
  const valid = (i: number) => ((i - front + cap) % cap) < count && slots[i] !== null
  return {
    title: `循环队列 data[0..${cap - 1}]`,
    layout: 'ring',
    items: Array.from({ length: cap }, (_, i) => ({
      text: valid(i) ? String(slots[i]) : '',
      sub: String(i),
      tone: opts.marks?.[i] ?? (valid(i) ? 'base' : 'dim'),
    })),
    pointers: ringPointers(front, rear),
    note:
      opts.note ??
      (front === rear
        ? `front == rear = ${front} → 队空`
        : (rear + 1) % cap === front
          ? `(rear + 1) % ${cap} == front → 队满（那一个空位只好一直留着）`
          : `front = ${front}，rear = ${rear}，count = ${count}`),
  }
}

/**
 * 入队演示的初始队形：空队，但 front / rear 停在 4（之前入过队又出过队）。
 * 从这里开始入队，rear 一定会绕过数组末尾回到 0，"循环"才看得见。
 */
function emptyRing(cap: number): { slots: (number | null)[]; front: number } {
  return { slots: Array.from({ length: cap }, () => null), front: Math.min(4, cap - 2) }
}

/**
 * 出队演示的初始队形：元素从 front 开始摆，故意跨过数组末尾，
 * 这样一开始就能看到"元素分居数组两头"，出队时 front 也会绕回 0。
 */
function arrangedRing(data: number[], cap: number): {
  slots: (number | null)[]
  front: number
  rear: number
  count: number
} {
  const items = data.slice(0, cap - 1)
  const front = Math.max(0, Math.min(cap - 3, cap - 1))
  const slots: (number | null)[] = Array.from({ length: cap }, () => null)
  let p = front
  for (const x of items) {
    slots[p] = x
    p = (p + 1) % cap
  }
  return { slots, front, rear: p, count: items.length }
}

const CODE_CQ_ENQ = [
  `#define MAXSIZE ${CAP}`,
  'typedef struct { int data[MAXSIZE]; int front, rear; } SqQueue;',
  '// 约定：front 指向队头元素，rear 指向队尾元素的下一个空位',
  '// 队空：front == rear；队满：(rear + 1) % MAXSIZE == front（牺牲一个空位）',
  'int enQueue(SqQueue &Q, int x) {',
  '  if ((Q.rear + 1) % MAXSIZE == Q.front) return 0;  // 队满，入队失败',
  '  Q.data[Q.rear] = x;                              // 放进 rear 指着的空位',
  '  Q.rear = (Q.rear + 1) % MAXSIZE;                 // rear 后移，到末尾就绕回 0',
  '  return 1;                                        // 入队成功',
  '}',
]

const CODE_CQ_DEQ = [
  `#define MAXSIZE ${CAP}`,
  'typedef struct { int data[MAXSIZE]; int front, rear; } SqQueue;',
  '// 约定：front 指向队头元素，rear 指向队尾元素的下一个空位',
  '// 队空：front == rear；队满：(rear + 1) % MAXSIZE == front',
  'int deQueue(SqQueue &Q, int &x) {',
  '  if (Q.front == Q.rear) return 0;            // 队空，出队失败',
  '  x = Q.data[Q.front];                        // 取出队头元素',
  '  Q.front = (Q.front + 1) % MAXSIZE;          // front 后移，超过末尾绕回 0',
  '  return 1;                                   // 出队成功',
  '}',
]

/** 循环队列入队：先判满（牺牲一个空位），再把 x 写进 rear 指着的空位，最后 rear 后移取模 */
function* runCircularEnqueue(data: number[], ctx: RunnerContext = {}): AlgoRunner {
  const cap = Math.max(2, ctx.capacity ?? CAP)
  const { slots, front: front0 } = emptyRing(cap)
  const front = front0
  let rear = front0
  let count = 0
  // 多取一个元素：正好用最后一个演示"队满被拒绝"
  const items = data.slice(0, cap)
  /** 当前队列里的有效元素（从队头到队尾，先进先出） */
  const values = () => Array.from({ length: count }, (_, k) => slots[(front + k) % cap] as number)
  const vars = () => ({ front, rear, count })

  let rejected: number | null = null
  for (const x of items) {
    if ((rear + 1) % cap === front) {
      rejected = x
      yield {
        line: 6,
        action: 'mark',
        array: values(),
        boards: [ringBoard(slots, front, rear, count)],
        vars: vars(),
        comment: `判断队满：(rear + 1) % MAXSIZE = (${rear} + 1) % ${cap} = ${(rear + 1) % cap}，正好等于 front = ${front} → 队满，${x} 入队失败（return 0）`,
      }
      break
    }

    yield {
      line: 6,
      action: 'mark',
      array: values(),
      boards: [ringBoard(slots, front, rear, count)],
      vars: vars(),
      comment: `判断队满：(rear + 1) % MAXSIZE = (${rear} + 1) % ${cap} = ${(rear + 1) % cap}，front = ${front}，两者不等 → 还有空位，可以入队`,
    }

    const at = rear
    slots[at] = x
    count += 1
    yield {
      line: 7,
      action: 'set',
      array: values(),
      boards: [ringBoard(slots, front, rear, count, { marks: { [at]: 'hot' } })],
      vars: vars(),
      comment: `${x} 写进 data[${at}]：rear 指着的正是这个空位，它成了新的队尾元素`,
    }

    rear = (rear + 1) % cap
    yield {
      line: 8,
      action: 'mark',
      array: values(),
      boards: [ringBoard(slots, front, rear, count, { marks: { [at]: 'hot' } })],
      vars: vars(),
      comment: `rear 后移：(rear + 1) % MAXSIZE = ${rear}${rear < at ? `，从 ${at} 绕回了数组开头 —— 这就是"循环"` : ''}；队列里现在有 ${count} 个元素`,
    }
  }

  const full = (rear + 1) % cap === front
  yield {
    line: 9,
    action: 'done',
    array: values(),
    boards: [ringBoard(slots, front, rear, count)],
    vars: vars(),
    comment:
      rejected !== null
        ? `入队结束：成功入队 ${count} 个元素，队列已满；${rejected} 因为队满被拒绝。环里其实还剩一个空格，为了区分队空和队满，只能留着它不用`
        : `入队结束：队列里共 ${count} 个元素，front = ${front}，rear = ${rear}${full ? '（(rear + 1) % MAXSIZE == front，队满）' : ''}`,
  }
}

/** 循环队列出队：先判空，再取出 front 指着的元素，最后 front 后移取模 */
function* runCircularDequeue(data: number[], ctx: RunnerContext = {}): AlgoRunner {
  const cap = Math.max(2, ctx.capacity ?? CAP)
  const init = arrangedRing(data, cap)
  const slots = init.slots
  const front0 = init.front
  let front = front0
  let rear = init.rear
  let count = init.count
  const total = count
  /** 当前队列里的有效元素（从队头到队尾） */
  const values = () => Array.from({ length: count }, (_, k) => slots[(front + k) % cap] as number)
  const vars = () => ({ front, rear, count })

  for (let k = 0; k < total; k++) {
    yield {
      line: 6,
      action: 'mark',
      array: values(),
      boards: [ringBoard(slots, front, rear, count, { marks: { [front]: 'mark' } })],
      vars: vars(),
      comment: `判断队空：front = ${front}，rear = ${rear}，两者不等 → 队里有元素，可以出队`,
    }

    const at = front
    const x = slots[at] as number
    yield {
      line: 7,
      action: 'mark',
      array: values(),
      boards: [ringBoard(slots, front, rear, count, { marks: { [at]: 'mark' } })],
      vars: vars(),
      comment: `取出队头元素：x = data[${front}] = ${x}，它就是最早进来的那个`,
    }

    slots[at] = null
    front = (front + 1) % cap
    count -= 1
    yield {
      line: 8,
      action: 'set',
      array: values(),
      boards: [ringBoard(slots, front, rear, count, { marks: { [at]: 'dim' }, note: `data[${at}] 已出队，作废；front = ${front}，rear = ${rear}` })],
      vars: vars(),
      comment: `front 后移：(front + 1) % MAXSIZE = ${front}${front < at ? `，从 ${at} 绕回数组开头` : ''}；data[${at}] 这一格逻辑上作废，队列里还剩 ${count} 个元素`,
    }
  }

  yield {
    line: 6,
    action: 'done',
    array: values(),
    boards: [ringBoard(slots, front, rear, count, { note: `front == rear = ${front} → 队空` })],
    vars: vars(),
    comment: `再判断队空：front = ${front} 正好等于 rear = ${rear} → 队空，没有元素可以出队了（return 0）`,
  }
  yield {
    line: 9,
    action: 'done',
    array: values(),
    boards: [ringBoard(slots, front, rear, count)],
    vars: vars(),
    comment: `出队结束：一共出队 ${total} 个元素。注意 front 和 rear 并没有回到 0，而是都停在 ${front} —— 下一次入队就从 ${front} 这一格接着用`,
  }
}

// ---------------------------------------------------------------------------
// 链队列：结构快照 + 辅助
// ---------------------------------------------------------------------------

/** 一次性打包"值序列 + 结构快照"（array 永远是队列里的元素，先进先出） */
function state(nodes: MutableNode[], head: string | null, opts: ViewOptions = {}) {
  return { array: dataOrder(nodes, head), list: view(nodes, head, opts) }
}

/** 建一条带头结点的链队列：head -> n0 -> n1 -> ... */
function headedQueue(values: number[]): { nodes: MutableNode[]; head: string } {
  const chain = makeChain(values)
  const nodes: MutableNode[] = [
    { id: 'head', value: 0, next: chain[0]?.id ?? null, dummy: true },
    ...chain,
  ]
  return { nodes, head: 'head' }
}

/** 首帧：只有头结点的空链队列，front 和 rear 都指着它 */
const initQueueEmpty = (): ListView => view(makeHeadedList(), 'head', { pointers: { front: 'head', rear: 'head' } })

/** 首帧：已经有元素的链队列，rear 指着队尾结点 */
const initQueueFilled = (data: number[]): ListView => {
  const { nodes, head } = headedQueue(data.slice(0, LINKQ_CAP))
  return view(nodes, head, { pointers: { front: head, rear: nodes[nodes.length - 1]!.id } })
}

const CODE_LQ_ENQ = [
  'typedef struct LNode { int data; struct LNode *next; } LNode;',
  'typedef struct { LNode *front, *rear; } LinkQueue;    // front 指向头结点，rear 指向队尾结点',
  'int enQueue(LinkQueue &Q, int x) {',
  '  LNode *s = new LNode; s->data = x; s->next = NULL;  // 申请新结点',
  '  Q.rear->next = s;                                   // 只允许接在队尾结点之后',
  '  Q.rear = s;                                         // rear 后移，指向新的队尾',
  '  return 1;',
  '}',
]

const CODE_LQ_DEQ = [
  'typedef struct LNode { int data; struct LNode *next; } LNode;',
  'typedef struct { LNode *front, *rear; } LinkQueue;    // front 指向头结点，rear 指向队尾结点',
  'int deQueue(LinkQueue &Q, int &x) {',
  '  if (Q.front == Q.rear) return 0;           // 队空：front 和 rear 都指向头结点',
  '  LNode *q = Q.front->next; x = q->data;     // q 指向队头结点，先取出它的数据',
  '  Q.front->next = q->next;                   // 头结点越过 q，q 脱离队列',
  '  if (Q.rear == q) Q.rear = Q.front;         // 队列变空时，rear 要重新指回头结点',
  '  delete q;                                  // 释放被删结点',
  '  return 1;',
  '}',
]

/** 链队列入队：新结点只接在队尾结点之后，然后 rear 追上去 */
function* runLinkedEnqueue(data: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const nodes = makeHeadedList()
  const head = 'head'
  const nextId = idGen('n')
  const items = data.slice(0, LINKQ_CAP)
  let rear = head
  let count = 0

  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { hot: [head], pointers: { front: head, rear } }),
    vars: { count },
    comment: '带头结点的链队列：front 和 rear 都指向头结点，front == rear 表示队空。入队只动 rear 这一端',
  }

  for (let k = 0; k < items.length; k++) {
    const x = items[k]!
    const id = nextId()
    nodes.push({ id, value: x, next: null })
    yield {
      line: 4,
      action: 'set',
      ...state(nodes, head, { hot: [id], pointers: { front: head, rear, s: id } }),
      vars: { i: k, count, x },
      comment: `申请新结点 s：s->data = ${x}，s->next = NULL，它将成为新的队尾`,
    }

    nodes.find((y) => y.id === rear)!.next = id
    yield {
      line: 5,
      action: 'mark',
      ...state(nodes, head, { hot: [rear, id], pointers: { front: head, rear, s: id } }),
      vars: { i: k, count, x },
      comment: `Q.rear->next = s：把新结点挂到原来的队尾结点后面 —— 链队列只允许在队尾插入`,
    }

    rear = id
    count += 1
    yield {
      line: 6,
      action: 'mark',
      ...state(nodes, head, { hot: [id], pointers: { front: head, rear, s: id } }),
      vars: { i: k, count, x },
      comment: `Q.rear = s：rear 后移，继续指向新的队尾结点。队列里现在有 ${count} 个元素`,
    }
  }

  yield {
    line: 7,
    action: 'done',
    ...state(nodes, head, { hot: [rear], pointers: { front: head, rear } }),
    vars: { count },
    comment: `入队结束：队列是 [${dataOrder(nodes, head).join(', ')}]，front 指着（不存数据的）头结点，rear 指着队尾结点${count === 0 ? '（还是空队）' : ''}`,
  }
}

/** 链队列出队：摘掉 front->next；若队列就此变空，必须把 rear 拉回头结点 */
function* runLinkedDequeue(data: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const { nodes, head } = headedQueue(data.slice(0, LINKQ_CAP))
  const front = head
  let rear = nodes[nodes.length - 1]!.id
  let count = dataOrder(nodes, head).length
  const total = count

  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { hot: [front], pointers: { front, rear } }),
    vars: { count },
    comment: `开始出队：front 指向头结点，rear 指向队尾结点，队列里有 ${count} 个元素。出队只动 front 这一端`,
  }

  for (let k = 0; k < total; k++) {
    yield {
      line: 4,
      action: 'mark',
      ...state(nodes, head, { hot: [front], pointers: { front, rear } }),
      vars: { i: k, count },
      comment: `判断队空：front == rear 吗？front 指着头结点，rear 指着队尾结点，两者不等 → 队里有元素，可以出队`,
    }

    const q = nodes.find((y) => y.id === front)!.next!
    const x = nodes.find((y) => y.id === q)!.value
    yield {
      line: 5,
      action: 'mark',
      ...state(nodes, head, { hot: [q], pointers: { front, rear, q } }),
      vars: { i: k, count, x },
      comment: `q = Q.front->next 指向队头结点，x = q->data = ${x}：它就是队头元素（头结点不存数据，所以要跳过它）`,
    }

    const after = nodes.find((y) => y.id === q)!.next
    nodes.find((y) => y.id === front)!.next = after
    yield {
      line: 6,
      action: 'mark',
      ...state(nodes, head, { hot: [front, q], pointers: { front, rear, q } }),
      vars: { i: k, count, x },
      comment: `Q.front->next = q->next：头结点直接越过 q 指向 ${after ? '下一个结点' : 'NULL'}，q 就从队列里摘下来了`,
    }

    const last = rear === q
    if (last) rear = front
    yield {
      line: 7,
      action: 'mark',
      ...state(nodes, head, { hot: last ? [front, q] : [q], pointers: { front, rear, q } }),
      vars: { i: k, count, x },
      comment: last
        ? `Q.rear == q：出队的是最后一个结点，队列马上要空了 → 必须让 rear = front 重新指回头结点，否则 rear 会一直指着即将被 delete 的 q`
        : `Q.rear == q 吗？rear 指着队尾结点，q 只是刚摘下来的队头，两者不等 → rear 不用动`,
    }

    const idx = nodes.findIndex((y) => y.id === q)
    nodes.splice(idx, 1)
    count -= 1
    yield {
      line: 8,
      action: 'mark',
      ...state(nodes, head, { hot: last ? [front] : after ? [after] : [], pointers: { front, rear } }),
      vars: { i: k, count, x },
      comment: `delete q 释放结点，${x} 出队完成；队列里还剩 ${count} 个元素${count === 0 ? '，而且 rear 已经指回头结点了' : ''}`,
    }
  }

  yield {
    line: 4,
    action: 'done',
    ...state(nodes, head, { hot: [front], pointers: { front, rear } }),
    vars: { count },
    comment: '再判断队空：front 和 rear 都指回头结点了（front == rear）→ 队空，出队结束（return 0）',
  }
  yield {
    line: 9,
    action: 'done',
    ...state(nodes, head, { hot: [front], pointers: { front, rear } }),
    vars: { count },
    comment: `出队结束：一共出队 ${total} 个元素，队列已经空了。头结点始终留着，所以"队空"永远是 front == rear 这一个条件，不用另外处理空表`,
  }
}

/**
 * 循环队列的取模约定（front 指向队头元素、rear 指向队尾后面的空位、
 * 牺牲一个空位来区分 front==rear 的队空与 (rear+1)%MAXSIZE==front 的队满）
 * 在文件头有完整说明，这里不再重复。
 */
export const queueSpecs: AlgorithmSpec[] = [
  {
    id: 'queue-circular-enqueue',
    name: '循环队列入队',
    category: 'queue',
    group: '循环队列',
    summary: 'rear 所指处写入元素，再 rear = (rear + 1) % MAXSIZE 绕环后移',
    complexity: { time: 'O(1)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: CODE_CQ_ENQ,
    capacity: CAP,
    defaultData: () => [3, 7, 1, 9, 5, 2, 8, 6],
    prepareData: (raw) => raw.slice(0, CAP),
    initComment: (data, ctx) => {
      const cap = Math.max(2, ctx.capacity ?? CAP)
      const front = Math.min(4, cap - 2)
      return `要把 [${data.slice(0, cap).join(', ')}] 依次入队。现在 front = rear = ${front}，两个指针重合就是队空；它们停在 ${front} 而不是 0，说明这个队列之前用过、出过队 —— 这正是"循环"的意思`
    },
    initScene: (_data, ctx) => {
      const cap = Math.max(2, ctx.capacity ?? CAP)
      const { slots, front } = emptyRing(cap)
      return {
        boards: [
          ringBoard(slots, front, front, 0, {
            note: `front == rear = ${front} → 队空（两个指针重合在同一格）`,
          }),
        ],
      }
    },
    createRunner: runCircularEnqueue,
  },
  {
    id: 'queue-circular-dequeue',
    name: '循环队列出队',
    category: 'queue',
    group: '循环队列',
    summary: '取出 front 所指元素，再 front = (front + 1) % MAXSIZE 绕环后移',
    complexity: { time: 'O(1)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: CODE_CQ_DEQ,
    capacity: CAP,
    defaultData: () => [12, 25, 37, 48, 59],
    prepareData: (raw) => raw.slice(0, CAP - 1),
    initComment: (data, ctx) => {
      const cap = Math.max(2, ctx.capacity ?? CAP)
      const { front, count } = arrangedRing(data, cap)
      return `队列里已经有 ${count} 个元素，从 front = ${front} 开始摆到了数组末尾又绕回开头（这就是"循环"），现在依次出队`
    },
    initScene: (data, ctx) => {
      const cap = Math.max(2, ctx.capacity ?? CAP)
      const { slots, front, rear, count } = arrangedRing(data, cap)
      return {
        boards: [
          ringBoard(slots, front, rear, count, {
            note: `front = ${front}，rear = ${rear}，count = ${count}`,
          }),
        ],
      }
    },
    createRunner: runCircularDequeue,
  },
  {
    id: 'queue-linked-enqueue',
    name: '链队列入队',
    category: 'queue',
    group: '链队列',
    summary: '带头结点，新结点只接在队尾之后，然后 rear 后移',
    complexity: { time: 'O(1)', space: 'O(1)' },
    renderer: 'linked',
    codeLines: CODE_LQ_ENQ,
    defaultData: () => [12, 25, 37, 48, 59],
    prepareData: (raw) => raw.slice(0, LINKQ_CAP),
    initComment: () =>
      '带头结点的链队列：一开始 front 和 rear 都指向头结点，front == rear 就是队空。入队只在 rear 那一端接新结点，不需要遍历找队尾',
    initList: initQueueEmpty,
    createRunner: runLinkedEnqueue,
  },
  {
    id: 'queue-linked-dequeue',
    name: '链队列出队',
    category: 'queue',
    group: '链队列',
    summary: '摘掉头结点后面的队头结点；变空时 rear 要指回头结点',
    complexity: { time: 'O(1)', space: 'O(1)' },
    renderer: 'linked',
    codeLines: CODE_LQ_DEQ,
    defaultData: () => [12, 25, 37, 48, 59],
    prepareData: (raw) => raw.slice(0, LINKQ_CAP),
    initComment: (data) =>
      `队列里有 [${data.slice(0, LINKQ_CAP).join(', ')}]，front 指向头结点、rear 指向队尾结点。出队摘的是 front->next 那个结点`,
    initList: initQueueFilled,
    createRunner: runLinkedDequeue,
  },
]
