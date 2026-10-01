import type { AlgorithmSpec, AlgoRunner, ListView, RunnerContext } from '@/core/types'
import { dataOrder, idGen, view, type MutableNode, type ViewOptions } from '@/core/list'

/** 链表最长演示长度（再长一行就摆不下了） */
const LINK_CAP = 8

/** 一次性打包"值序列 + 结构快照"，省得每个 yield 写两遍 */
function state(nodes: MutableNode[], head: string | null, opts: ViewOptions = {}) {
  return { array: dataOrder(nodes, head), list: view(nodes, head, opts) }
}

/** 建一条带头结点的单链表 */
function headedChain(values: number[]): { nodes: MutableNode[]; head: string } {
  const nodes: MutableNode[] = [{ id: 'head', value: 0, next: null, dummy: true }]
  let prev = 'head'
  values.forEach((value, i) => {
    const id = `n${i}`
    nodes.push({ id, value, next: null })
    nodes.find((n) => n.id === prev)!.next = id
    prev = id
  })
  return { nodes, head: 'head' }
}

const LINK_DATA = () => [12, 25, 37, 48, 59, 71]
const LINK_PREPARE = (raw: number[]) => raw.slice(0, LINK_CAP)

/** 首帧：一条已经建好的带头结点单链表 */
const initHeaded = (a: number[]): ListView => {
  const { nodes, head } = headedChain(a)
  return view(nodes, head, { pointers: { L: head } })
}

/** 首帧：只有头结点的空链表（建表类算法用） */
const initEmpty = (): ListView => {
  const nodes: MutableNode[] = [{ id: 'head', value: 0, next: null, dummy: true }]
  return view(nodes, 'head', { pointers: { L: 'head' } })
}

// ---------------------------------------------------------------------------
// 1. 头插法建立链表
// ---------------------------------------------------------------------------
export const SLL_HEAD_CODE = `void createListHead(LinkList &L, int a[], int n) {
    L = new LNode; L->next = NULL;            // 建立头结点
    for (int i = 0; i < n; i++) {
        LNode *s = new LNode; s->data = a[i]; // 申请新结点
        s->next = L->next;                    // 新结点接上原来的首结点
        L->next = s;                          // 头结点改指新结点
    }
}`

/**
 * 头插法：每来一个新元素就插在头结点之后，所以最终顺序和输入**正好相反**。
 * 这正是头插法的特点，也是考试常考的结论。
 */
export function* sllCreateHead(a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const nodes: MutableNode[] = [{ id: 'head', value: 0, next: null, dummy: true }]
  const head = 'head'
  const nextId = idGen('h')
  const vars = (i: number) => ({ n: a.length, i })

  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { hot: [head], pointers: { L: head } }),
    vars: vars(-1),
    comment: `建立头结点（不存数据），此时链表为空`,
  }

  for (let i = 0; i < a.length; i++) {
    const id = nextId()
    nodes.push({ id, value: a[i]!, next: null })
    yield {
      line: 4,
      action: 'set',
      ...state(nodes, head, { hot: [id], pointers: { L: head, s: id } }),
      vars: vars(i),
      comment: `申请结点 s，s->data = a[${i}] = ${a[i]}`,
    }
    const oldFirst = nodes.find((n) => n.id === head)!.next
    nodes.find((n) => n.id === id)!.next = oldFirst
    yield {
      line: 5,
      action: 'mark',
      ...state(nodes, head, { hot: oldFirst ? [id, oldFirst] : [id], pointers: { L: head, s: id } }),
      vars: vars(i),
      comment: oldFirst
        ? `s->next 指向原来的首结点，新结点插到最前面`
        : `s->next = NULL，它是链表的第一个结点`,
    }
    nodes.find((n) => n.id === head)!.next = id
    yield {
      line: 6,
      action: 'mark',
      ...state(nodes, head, { hot: [head, id], pointers: { L: head, s: id } }),
      vars: vars(i),
      comment: `头结点改指新结点 s，插入完成`,
    }
  }

  yield {
    line: 8,
    action: 'done',
    ...state(nodes, head, { pointers: { L: head } }),
    vars: vars(a.length),
    comment: `建表完成。头插法的结果和输入顺序相反：[${dataOrder(nodes, head).join(', ')}]`,
  }
}

// ---------------------------------------------------------------------------
// 2. 尾插法建立链表
// ---------------------------------------------------------------------------
export const SLL_TAIL_CODE = `void createListTail(LinkList &L, int a[], int n) {
    L = new LNode; L->next = NULL;            // 建立头结点
    LNode *r = L;                             // r 始终指向尾结点
    for (int i = 0; i < n; i++) {
        LNode *s = new LNode; s->data = a[i];
        s->next = NULL;                       // 新结点将成为新的尾
        r->next = s;                          // 原来的尾结点接上新结点
        r = s;                                // r 后移，继续指向尾结点
    }
}`

/** 尾插法：新元素总是接在尾部，所以最终顺序和输入**一致** */
export function* sllCreateTail(a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const nodes: MutableNode[] = [{ id: 'head', value: 0, next: null, dummy: true }]
  const head = 'head'
  const nextId = idGen('t')
  let r = 'head'
  const vars = (i: number) => ({ n: a.length, i })

  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { hot: [head], pointers: { L: head, r } }),
    vars: vars(-1),
    comment: `建立头结点，此时链表为空`,
  }
  yield {
    line: 3,
    action: 'mark',
    ...state(nodes, head, { hot: [head], pointers: { L: head, r } }),
    vars: vars(-1),
    comment: `让 r 指向尾结点。空表时尾结点就是头结点`,
  }

  for (let i = 0; i < a.length; i++) {
    const id = nextId()
    nodes.push({ id, value: a[i]!, next: null })
    yield {
      line: 5,
      action: 'set',
      ...state(nodes, head, { hot: [id], pointers: { L: head, r, s: id } }),
      vars: vars(i),
      comment: `申请结点 s，s->data = a[${i}] = ${a[i]}`,
    }
    nodes.find((n) => n.id === r)!.next = id
    yield {
      line: 7,
      action: 'mark',
      ...state(nodes, head, { hot: [r, id], pointers: { L: head, r, s: id } }),
      vars: vars(i),
      comment: `把新结点接到原来的尾结点 r 后面`,
    }
    r = id
    yield {
      line: 8,
      action: 'mark',
      ...state(nodes, head, { hot: [id], pointers: { L: head, r, s: id } }),
      vars: vars(i),
      comment: `r 后移，继续指向新的尾结点`,
    }
  }

  yield {
    line: 10,
    action: 'done',
    ...state(nodes, head, { pointers: { L: head, r } }),
    vars: vars(a.length),
    comment: `建表完成。尾插法的结果和输入顺序一致：[${dataOrder(nodes, head).join(', ')}]`,
  }
}

// ---------------------------------------------------------------------------
// 3. 按序号查找
// ---------------------------------------------------------------------------
export const SLL_GET_CODE = `LNode *getByIndex(LinkList L, int i) {
    if (i < 1) return NULL;
    LNode *p = L->next;                       // p 指向首结点
    int j = 1;
    while (p != NULL && j < i) {              // 顺着 next 一步一步走
        p = p->next;
        j++;
    }
    return p;
}`

/** 按序号查找：链表不支持随机存取，只能从头一个个走，O(n) */
export function* sllGetByIndex(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const { nodes, head } = headedChain(a)
  const n = a.length
  // 这里**不把 pos 夹到合法范围**：越界时正好演示"返回 NULL"那条分支
  const i = Math.max(1, ctx.pos ?? Math.min(3, n))
  const seq = nodes.filter((x) => !x.dummy).map((x) => x.id)
  const vars = (j: number) => ({ n, i, j })

  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { pointers: { L: head, p: null } }),
    vars: vars(0),
    comment: `要找的是第 ${i} 个结点（位序从 1 开始）`,
  }

  let p: string | null = seq[0] ?? null
  let j = 1
  yield {
    line: 3,
    action: 'mark',
    ...state(nodes, head, { hot: p ? [p] : [], pointers: { L: head, p } }),
    vars: vars(j),
    comment: p ? `p 指向首结点（第 1 个），j = 1` : `链表为空，直接返回 NULL`,
  }

  while (p !== null && j < i) {
    p = nodes.find((x) => x.id === p)!.next
    j += 1
    yield {
      line: 5,
      action: 'set',
      ...state(nodes, head, { hot: p ? [p] : [], pointers: { L: head, p } }),
      vars: vars(j),
      comment: p ? `p 后移一步，现在指向第 ${j} 个结点` : `p 走到 NULL，说明表长不足 ${i}`,
    }
  }

  yield {
    line: 8,
    action: 'done',
    ...state(nodes, head, { hot: p ? [p] : [], pointers: { L: head, p } }),
    vars: vars(j),
    comment:
      p === null
        ? `返回 NULL：第 ${i} 个结点不存在`
        : `返回第 ${i} 个结点，它的 data = ${nodes.find((x) => x.id === p)!.value}；共走了 ${j - 1} 步`,
  }
}

// ---------------------------------------------------------------------------
// 4. 按值查找
// ---------------------------------------------------------------------------
export const SLL_LOCATE_CODE = `LNode *locateByValue(LinkList L, int x) {
    LNode *p = L->next;
    while (p != NULL && p->data != x) {       // 顺着 next 一直找
        p = p->next;
    }
    return p;                                 // 没找到时 p 就是 NULL
}`

export function* sllLocateByValue(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const { nodes, head } = headedChain(a)
  const n = a.length
  const x = ctx.target ?? a[0]!
  const seq = nodes.filter((y) => !y.dummy).map((y) => y.id)
  const vars = (step: number) => ({ n, x, step })

  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { pointers: { L: head, p: seq[0] ?? null } }),
    vars: vars(0),
    comment: `p 从首结点开始，要找的值是 x = ${x}`,
  }

  let p: string | null = seq[0] ?? null
  let steps = 0
  while (p !== null) {
    steps += 1
    const node = nodes.find((y) => y.id === p)!
    yield {
      line: 3,
      action: 'compare',
      ...state(nodes, head, { hot: [p], pointers: { L: head, p } }),
      vars: vars(steps),
      comment: `比较 p->data = ${node.value} 与 x = ${x}`,
    }
    if (node.value === x) {
      yield {
        line: 5,
        action: 'done',
        ...state(nodes, head, { hot: [p], pointers: { L: head, p } }),
        vars: vars(steps),
        comment: `找到了！值为 ${x} 的结点就是 p，共比较 ${steps} 次`,
      }
      return
    }
    p = node.next
  }

  yield {
    line: 5,
    action: 'done',
    ...state(nodes, head, { pointers: { L: head, p: null } }),
    vars: vars(steps),
    comment: `p 走到 NULL 都没找到 ${x}，返回 NULL`,
  }
}

// ---------------------------------------------------------------------------
// 5. 插入
// ---------------------------------------------------------------------------
export const SLL_INSERT_CODE = `bool listInsert(LinkList &L, int i, int x) {
    LNode *p = L; int j = 0;                  // 从头结点开始走
    while (p != NULL && j < i - 1) {          // 找第 i-1 个结点
        p = p->next; j++;
    }
    if (p == NULL) return false;              // 位序非法
    LNode *s = new LNode; s->data = x;        // 申请新结点
    s->next = p->next;                        // ① 先让新结点接上后面
    p->next = s;                              // ② 再让前驱指向新结点
    return true;
}`

/** 单链表插入：两行指针的顺序不能反，否则后半段链表会丢 */
export function* sllInsert(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const { nodes, head } = headedChain(a)
  const n = a.length
  const i = Math.min(Math.max(1, ctx.pos ?? Math.min(3, n + 1)), n + 1)
  const x = ctx.value ?? 99
  const vars = (j: number) => ({ n, i, j, x })

  let p: string | null = head
  let j = 0
  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { hot: [head], pointers: { L: head, p: head } }),
    vars: vars(j),
    comment: `p 从头结点出发，要找到第 ${i - 1} 个结点（j 从 0 开始数）`,
  }

  while (p !== null && j < i - 1) {
    p = nodes.find((y) => y.id === p)!.next
    j += 1
    yield {
      line: 4,
      action: 'set',
      ...state(nodes, head, { hot: p ? [p] : [], pointers: { L: head, p } }),
      vars: vars(j),
      comment: `p 后移一步，j = ${j}${j === i - 1 ? `，已经找到第 ${i - 1} 个结点` : ''}`,
    }
  }

  if (p === null) {
    yield {
      line: 6,
      action: 'done',
      ...state(nodes, head, { pointers: { L: head, p: null } }),
      vars: vars(j),
      comment: `p 走到 NULL，位序 ${i} 非法，插入失败`,
    }
    return
  }

  yield {
    line: 6,
    action: 'mark',
    ...state(nodes, head, { hot: [p], pointers: { L: head, p } }),
    vars: vars(j),
    comment: `p 合法，位序 ${i} 可以插入`,
  }

  const id = idGen('i')()
  nodes.push({ id, value: x, next: null })
  yield {
    line: 7,
    action: 'set',
    ...state(nodes, head, { hot: [id], pointers: { L: head, p, s: id } }),
    vars: vars(j),
    comment: `申请新结点 s，s->data = ${x}`,
  }

  const after = nodes.find((y) => y.id === p)!.next
  nodes.find((y) => y.id === id)!.next = after
  yield {
    line: 8,
    action: 'mark',
    ...state(nodes, head, {
      hot: after ? [id, after] : [id],
      pointers: { L: head, p, s: id },
    }),
    vars: vars(j),
    comment: after
      ? `① s->next = p->next，新结点先接上后面那一串`
      : `① s->next = NULL，新结点将是新的尾结点`,
  }

  nodes.find((y) => y.id === p)!.next = id
  yield {
    line: 9,
    action: 'mark',
    ...state(nodes, head, { hot: [p, id], pointers: { L: head, p, s: id } }),
    vars: vars(j),
    comment: `② p->next = s，前驱接上新结点。插入完成`,
  }

  yield {
    line: 10,
    action: 'done',
    ...state(nodes, head, { pointers: { L: head } }),
    vars: vars(j),
    comment: `插入成功，返回 true。现在的链表：[${dataOrder(nodes, head).join(', ')}]`,
  }
}

// ---------------------------------------------------------------------------
// 6. 删除
// ---------------------------------------------------------------------------
export const SLL_DELETE_CODE = `bool listDelete(LinkList &L, int i, int &e) {
    LNode *p = L; int j = 0;                  // 找第 i-1 个结点
    while (p != NULL && j < i - 1) {
        p = p->next; j++;
    }
    if (p == NULL || p->next == NULL) return false;
    LNode *q = p->next; e = q->data;          // q 指向被删结点，并取出数据
    p->next = q->next;                        // 让前驱直接越过 q
    delete q;                                 // 释放被删结点
    return true;
}`

export function* sllDelete(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const { nodes, head } = headedChain(a)
  const n = a.length
  const i = Math.min(Math.max(1, ctx.pos ?? Math.min(3, n)), n)
  const vars = (j: number) => ({ n, i, j })

  let p: string | null = head
  let j = 0
  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { hot: [head], pointers: { L: head, p: head } }),
    vars: vars(j),
    comment: `p 从头结点出发，要找到第 ${i - 1} 个结点`,
  }

  while (p !== null && j < i - 1) {
    p = nodes.find((y) => y.id === p)!.next
    j += 1
    yield {
      line: 4,
      action: 'set',
      ...state(nodes, head, { hot: p ? [p] : [], pointers: { L: head, p } }),
      vars: vars(j),
      comment: `p 后移一步，j = ${j}`,
    }
  }

  const q = p === null ? null : nodes.find((y) => y.id === p)!.next
  if (p === null || q === null) {
    yield {
      line: 6,
      action: 'done',
      ...state(nodes, head, { pointers: { L: head, p: null } }),
      vars: vars(j),
      comment: `p 或 p->next 为 NULL，位序 ${i} 非法，删除失败`,
    }
    return
  }

  const removed = nodes.find((y) => y.id === q)!.value
  yield {
    line: 7,
    action: 'mark',
    ...state(nodes, head, { hot: [p, q], pointers: { L: head, p, q } }),
    vars: vars(j),
    comment: `q = p->next 指向要被删掉的结点，先取出它的数据 e = ${removed}`,
  }

  const after = nodes.find((y) => y.id === q)!.next
  nodes.find((y) => y.id === p)!.next = after
  yield {
    line: 8,
    action: 'mark',
    ...state(nodes, head, { hot: [p, q], pointers: { L: head, p, q } }),
    vars: vars(j),
    comment: `p->next = q->next，让前驱直接越过 q，q 就从链表里摘下来了`,
  }

  const idx = nodes.findIndex((y) => y.id === q)
  nodes.splice(idx, 1)
  yield {
    line: 9,
    action: 'done',
    ...state(nodes, head, { pointers: { L: head, p } }),
    vars: vars(j),
    comment: `delete q 释放结点。删除完成，被删的是 ${removed}；剩下的链表：[${dataOrder(nodes, head).join(', ')}]`,
  }
}

// ---------------------------------------------------------------------------
// 注册表项
// ---------------------------------------------------------------------------
export const sllCreateHeadSpec: AlgorithmSpec = {
  id: 'sll-create-head',
  name: '头插法建表',
  category: 'linear',
  group: '单链表',
  summary: '每次插到最前面，结果与输入相反',
  complexity: { time: 'O(n)', space: 'O(n)' },
  renderer: 'linked',
  codeLines: SLL_HEAD_CODE.split('\n'),
  defaultData: LINK_DATA,
  prepareData: LINK_PREPARE,
  initList: initEmpty,
  createRunner: sllCreateHead,
}

export const sllCreateTailSpec: AlgorithmSpec = {
  id: 'sll-create-tail',
  name: '尾插法建表',
  category: 'linear',
  group: '单链表',
  summary: '每次接到尾部，结果与输入一致',
  complexity: { time: 'O(n)', space: 'O(n)' },
  renderer: 'linked',
  codeLines: SLL_TAIL_CODE.split('\n'),
  defaultData: LINK_DATA,
  prepareData: LINK_PREPARE,
  initList: initEmpty,
  createRunner: sllCreateTail,
}

export const sllGetByIndexSpec: AlgorithmSpec = {
  id: 'sll-get',
  name: '按序号查找',
  category: 'linear',
  group: '单链表',
  summary: '只能从头一个个走，O(n)',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'linked',
  codeLines: SLL_GET_CODE.split('\n'),
  defaultData: LINK_DATA,
  prepareData: LINK_PREPARE,
  defaultPos: (d) => Math.min(3, d.length),
  initList: initHeaded,
  createRunner: sllGetByIndex,
}

export const sllLocateSpec: AlgorithmSpec = {
  id: 'sll-locate',
  name: '按值查找',
  category: 'linear',
  group: '单链表',
  summary: '顺着 next 找等于 x 的结点',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'linked',
  codeLines: SLL_LOCATE_CODE.split('\n'),
  defaultData: LINK_DATA,
  prepareData: LINK_PREPARE,
  defaultTarget: (d) => d[Math.floor(Math.random() * d.length)]!,
  initList: initHeaded,
  createRunner: sllLocateByValue,
}

export const sllInsertSpec: AlgorithmSpec = {
  id: 'sll-insert',
  name: '插入',
  category: 'linear',
  group: '单链表',
  summary: '找到前驱，两行指针不能反',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'linked',
  codeLines: SLL_INSERT_CODE.split('\n'),
  defaultData: LINK_DATA,
  prepareData: LINK_PREPARE,
  defaultPos: (d) => Math.min(3, d.length + 1),
  defaultValue: () => 99,
  initList: initHeaded,
  createRunner: sllInsert,
}

export const sllDeleteSpec: AlgorithmSpec = {
  id: 'sll-delete',
  name: '删除',
  category: 'linear',
  group: '单链表',
  summary: '让前驱越过被删结点',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'linked',
  codeLines: SLL_DELETE_CODE.split('\n'),
  defaultData: LINK_DATA,
  prepareData: LINK_PREPARE,
  defaultPos: (d) => Math.min(3, d.length),
  initList: initHeaded,
  createRunner: sllDelete,
}
