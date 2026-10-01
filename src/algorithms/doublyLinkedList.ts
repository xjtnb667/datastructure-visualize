import type { AlgorithmSpec, AlgoRunner, ListView, RunnerContext } from '@/core/types'
import { dataOrder, idGen, view, type MutableNode, type ViewOptions } from '@/core/list'

const LINK_CAP = 8

function state(nodes: MutableNode[], head: string | null, opts: ViewOptions = {}) {
  return { array: dataOrder(nodes, head), list: view(nodes, head, opts) }
}

/** 建一条带头结点的双向链表（每个结点的 prev 都接好） */
function doublyChain(values: number[]): { nodes: MutableNode[]; head: string } {
  const nodes: MutableNode[] = [{ id: 'head', value: 0, next: null, prev: null, dummy: true }]
  let prev = 'head'
  values.forEach((value, i) => {
    const id = `n${i}`
    nodes.push({ id, value, next: null, prev })
    nodes.find((n) => n.id === prev)!.next = id
    prev = id
  })
  return { nodes, head: 'head' }
}

const DLINK_DATA = () => [12, 25, 37, 48, 59, 71]
const DLINK_PREPARE = (raw: number[]) => raw.slice(0, LINK_CAP)

/** 首帧：一条已经建好的带头结点双向链表 */
const initHeaded = (a: number[]): ListView => {
  const { nodes, head } = doublyChain(a)
  return view(nodes, head, { pointers: { L: head } })
}

// ---------------------------------------------------------------------------
// 1. 双链表插入
// ---------------------------------------------------------------------------
export const DLL_INSERT_CODE = `bool dInsert(DLinkList L, int i, int x) {    // L 为头结点
    DNode *p = L; int j = 0;
    while (p != NULL && j < i - 1) { p = p->next; j++; }
    if (p == NULL) return false;
    DNode *s = new DNode; s->data = x;
    s->next = p->next;                        // ① 新结点接上后继
    if (p->next != NULL) p->next->prev = s;   // ② 后继回指新结点
    p->next = s;                              // ③ 前驱指向新结点
    s->prev = p;                              // ④ 新结点回指前驱
    return true;
}`

/**
 * 双链表插入：一共要改 4 根指针，而且**顺序不能乱** ——
 * ①② 必须在前，因为 ③ 一执行就把 p->next 改成 s 了，p 原来的后继就找不到了。
 */
export function* dllInsert(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const { nodes, head } = doublyChain(a)
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
    comment: `p 从头结点出发，寻找第 ${i - 1} 个结点`,
  }

  while (p !== null && j < i - 1) {
    p = nodes.find((y) => y.id === p)!.next
    j += 1
    yield {
      line: 3,
      action: 'set',
      ...state(nodes, head, { hot: p ? [p] : [], pointers: { L: head, p } }),
      vars: vars(j),
      comment: `p 后移一步，j = ${j}`,
    }
  }

  if (p === null) {
    yield {
      line: 4,
      action: 'done',
      ...state(nodes, head, { pointers: { L: head, p: null } }),
      vars: vars(j),
      comment: `p 走到 NULL，位序 ${i} 非法，插入失败`,
    }
    return
  }

  const id = idGen('d')()
  nodes.push({ id, value: x, next: null, prev: null })
  yield {
    line: 5,
    action: 'set',
    ...state(nodes, head, { hot: [id], pointers: { L: head, p, s: id } }),
    vars: vars(j),
    comment: `申请新结点 s，s->data = ${x}`,
  }

  const oldNext = nodes.find((y) => y.id === p)!.next
  nodes.find((y) => y.id === id)!.next = oldNext
  yield {
    line: 6,
    action: 'mark',
    ...state(nodes, head, {
      hot: oldNext ? [id, oldNext] : [id],
      pointers: { L: head, p, s: id },
    }),
    vars: vars(j),
    comment: oldNext
      ? `① s->next = p->next，新结点先接上原来的后继`
      : `① s->next = NULL，新结点将成为尾结点`,
  }

  if (oldNext !== null) {
    nodes.find((y) => y.id === oldNext)!.prev = id
  }
  yield {
    line: 7,
    action: 'mark',
    ...state(nodes, head, {
      hot: oldNext ? [oldNext, id] : [id],
      pointers: { L: head, p, s: id },
    }),
    vars: vars(j),
    comment: oldNext
      ? `② p->next->prev = s，原来的后继回指新结点`
      : `② p->next 是 NULL，这一步跳过`,
  }

  nodes.find((y) => y.id === p)!.next = id
  yield {
    line: 8,
    action: 'mark',
    ...state(nodes, head, { hot: [p, id], pointers: { L: head, p, s: id } }),
    vars: vars(j),
    comment: `③ p->next = s，前驱指向新结点`,
  }

  nodes.find((y) => y.id === id)!.prev = p
  yield {
    line: 9,
    action: 'mark',
    ...state(nodes, head, { hot: [id, p], pointers: { L: head, p, s: id } }),
    vars: vars(j),
    comment: `④ s->prev = p，新结点回指前驱。四根指针全部接好`,
  }

  yield {
    line: 10,
    action: 'done',
    ...state(nodes, head, { pointers: { L: head } }),
    vars: vars(j),
    comment: `插入成功：[${dataOrder(nodes, head).join(', ')}]`,
  }
}

// ---------------------------------------------------------------------------
// 2. 双链表删除
// ---------------------------------------------------------------------------
export const DLL_DELETE_CODE = `bool dDelete(DLinkList L, int i, int &e) {
    DNode *p = L; int j = 0;
    while (p != NULL && j < i - 1) { p = p->next; j++; }
    if (p == NULL || p->next == NULL) return false;
    DNode *q = p->next; e = q->data;          // q 指向被删结点
    p->next = q->next;                        // 前驱越过 q
    if (q->next != NULL) q->next->prev = p;   // 后继回指前驱
    delete q;
    return true;
}`

export function* dllDelete(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const { nodes, head } = doublyChain(a)
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
    comment: `p 从头结点出发，寻找第 ${i - 1} 个结点`,
  }

  while (p !== null && j < i - 1) {
    p = nodes.find((y) => y.id === p)!.next
    j += 1
    yield {
      line: 3,
      action: 'set',
      ...state(nodes, head, { hot: p ? [p] : [], pointers: { L: head, p } }),
      vars: vars(j),
      comment: `p 后移一步，j = ${j}`,
    }
  }

  const q = p === null ? null : nodes.find((y) => y.id === p)!.next
  if (p === null || q === null) {
    yield {
      line: 4,
      action: 'done',
      ...state(nodes, head, { pointers: { L: head, p: null } }),
      vars: vars(j),
      comment: `p 或 p->next 为 NULL，位序 ${i} 非法，删除失败`,
    }
    return
  }

  const removed = nodes.find((y) => y.id === q)!.value
  yield {
    line: 5,
    action: 'mark',
    ...state(nodes, head, { hot: [p, q], pointers: { L: head, p, q } }),
    vars: vars(j),
    comment: `q = p->next 指向被删结点，取出 e = ${removed}`,
  }

  const after = nodes.find((y) => y.id === q)!.next
  nodes.find((y) => y.id === p)!.next = after
  yield {
    line: 6,
    action: 'mark',
    ...state(nodes, head, { hot: [p, q], pointers: { L: head, p, q } }),
    vars: vars(j),
    comment: `p->next = q->next，前驱的 next 越过 q`,
  }

  if (after !== null) {
    nodes.find((y) => y.id === after)!.prev = p
    yield {
      line: 7,
      action: 'mark',
      ...state(nodes, head, { hot: [after, q], pointers: { L: head, p, q } }),
      vars: vars(j),
      comment: `q->next->prev = p，后继的 prev 回指前驱 —— 两个方向都要断开`,
    }
  } else {
    yield {
      line: 7,
      action: 'mark',
      ...state(nodes, head, { hot: [q], pointers: { L: head, p, q } }),
      vars: vars(j),
      comment: `q->next 是 NULL，说明删的是尾结点，这一步跳过`,
    }
  }

  const idx = nodes.findIndex((y) => y.id === q)
  nodes.splice(idx, 1)
  yield {
    line: 9,
    action: 'done',
    ...state(nodes, head, { pointers: { L: head, p } }),
    vars: vars(j),
    comment: `delete q 释放结点。删除完成，剩下：[${dataOrder(nodes, head).join(', ')}]`,
  }
}

const DLL_INSERT_PREPARE = DLINK_PREPARE

export const dllInsertSpec: AlgorithmSpec = {
  id: 'dll-insert',
  name: '插入',
  category: 'linear',
  group: '双链表',
  summary: '四根指针，顺序不能乱',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'linked',
  codeLines: DLL_INSERT_CODE.split('\n'),
  defaultData: DLINK_DATA,
  prepareData: DLL_INSERT_PREPARE,
  defaultPos: (d) => Math.min(3, d.length + 1),
  defaultValue: () => 99,
  initList: initHeaded,
  createRunner: dllInsert,
}

export const dllDeleteSpec: AlgorithmSpec = {
  id: 'dll-delete',
  name: '删除',
  category: 'linear',
  group: '双链表',
  summary: '前后两个方向都要断开',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'linked',
  codeLines: DLL_DELETE_CODE.split('\n'),
  defaultData: DLINK_DATA,
  prepareData: DLINK_PREPARE,
  defaultPos: (d) => Math.min(3, d.length),
  initList: initHeaded,
  createRunner: dllDelete,
}
