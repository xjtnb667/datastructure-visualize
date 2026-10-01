import type { ListNodeSnapshot, ListView } from './types'

/**
 * 链表算法的公用小工具。
 * 每个生成器都只操作自己那份 nodes 副本，每次 yield 之前用 view() 拍一张结构快照。
 */

export interface MutableNode {
  id: string
  value: number
  next: string | null
  prev?: string | null
  dummy?: boolean
}

/** 按固定 id 规则建一串结点：n0 -> n1 -> ... -> null */
export function makeChain(values: number[]): MutableNode[] {
  return values.map((value, i) => ({
    id: `n${i}`,
    value,
    next: i < values.length - 1 ? `n${i + 1}` : null,
  }))
}

/** 建一个带头结点的空链表（头结点不存数据） */
export function makeHeadedList(): MutableNode[] {
  return [{ id: 'head', value: 0, next: null, dummy: true }]
}

/** 从 @param startId 开始新建结点时用的 id 生成器（避免和已有 id 撞） */
export function idGen(prefix: string): () => string {
  let k = 0
  return () => `${prefix}${k++}`
}

/** 沿 next 走，收集能走到的结点 id；遇到环会停下来 */
export function walk(nodes: MutableNode[], head: string | null): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: string[] = []
  const seen = new Set<string>()
  let cur = head
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    cur = byId.get(cur)!.next
  }
  return out
}

/** 把 data 值按 head -> tail 顺序取出来（跳过不存数据的头结点） */
export function dataOrder(nodes: MutableNode[], head: string | null): number[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return walk(nodes, head)
    .map((id) => byId.get(id)!)
    .filter((n) => !n.dummy)
    .map((n) => n.value)
}

export interface ViewOptions {
  hot?: string[]
  pointers?: Record<string, string | null>
  cycleEntry?: string | null
  hasCycle?: boolean
}

/**
 * 拍一张结构快照（深拷贝，保证历史帧不会被后续改动污染）。
 *
 * order 的构成：先放"从头指针走得到的结点"，再把**还没接到链上的游离结点**追加在后面。
 * 这样"刚 new 出来、还没插进去"的新结点也能画出来（建表、插入时都会出现这种中间态），
 * 否则那一步画面上什么都不会发生。
 */
export function view(nodes: MutableNode[], head: string | null, opts: ViewOptions = {}): ListView {
  const reachable = walk(nodes, head)
  const seen = new Set(reachable)
  const floating = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id)
  return {
    nodes: nodes.map<ListNodeSnapshot>((n) => ({ ...n })),
    order: [...reachable, ...floating],
    reachable,
    head,
    hot: [...(opts.hot ?? [])],
    pointers: { ...(opts.pointers ?? {}) },
    cycleEntry: opts.cycleEntry ?? null,
    hasCycle: opts.hasCycle ?? false,
  }
}

/** 在 nodes 里按 id 找结点下标 */
export function indexOfId(nodes: MutableNode[], id: string | null): number {
  if (id === null) return -1
  return nodes.findIndex((n) => n.id === id)
}
