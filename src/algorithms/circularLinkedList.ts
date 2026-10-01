import type { AlgorithmSpec, AlgoRunner, ListView, RunnerContext } from '@/core/types'
import { dataOrder, makeChain, view, type MutableNode, type ViewOptions } from '@/core/list'

const LINK_CAP = 8
/** 兜底：万一环检测写错，也不会让生成器无限跑下去把页面卡死 */
const LOOP_GUARD = 300

function state(nodes: MutableNode[], head: string | null, opts: ViewOptions = {}) {
  return { array: dataOrder(nodes, head), list: view(nodes, head, opts) }
}

/**
 * 造一条**带环**的链：把尾结点的 next 指回第 entryIdx 个结点。
 * 这样才有"环"可检测。
 */
function cyclicChain(values: number[], entryIdx: number) {
  const nodes = makeChain(values)
  const last = nodes[nodes.length - 1]!
  last.next = nodes[entryIdx]!.id
  return { nodes, head: nodes[0]!.id }
}

const CYCLE_DATA = () => [12, 25, 37, 48, 59, 71]
const CYCLE_PREPARE = (raw: number[]) => raw.slice(0, LINK_CAP)
/** 环的入口定在第 3 个结点上 */
const ENTRY_IDX = 2

/** 首帧：一条已经成环的链，两个指针都停在首结点 */
const initCyclic = (a: number[]): ListView => {
  const { nodes, head } = cyclicChain(a, Math.min(ENTRY_IDX, a.length - 1))
  return view(nodes, head, { pointers: { slow: head, fast: head } })
}

// ---------------------------------------------------------------------------
// 1. 判断链表是否有环（快慢指针 / Floyd 判圈）
// ---------------------------------------------------------------------------
export const CYCLE_DETECT_CODE = `bool hasCycle(LinkList L) {
    LNode *slow = L, *fast = L;
    while (fast != NULL && fast->next != NULL) {
        slow = slow->next;                    // 慢指针走一步
        fast = fast->next->next;              // 快指针走两步
        if (slow == fast) return true;        // 相遇就说明有环
    }
    return false;
}`

/**
 * 快慢指针判圈：快指针每次走两步、慢指针走一步。
 * 如果有环，快指针一定会在环里"追上"慢指针；如果没有环，快指针会先走到 NULL。
 */
export function* hasCycle(a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const { nodes, head } = cyclicChain(a, Math.min(ENTRY_IDX, a.length - 1))
  const n = a.length
  const nextOf = (id: string | null) => (id === null ? null : nodes.find((x) => x.id === id)!.next)
  const vars = (round: number) => ({ n, round })

  let slow: string | null = head
  let fast: string | null = head

  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { hot: [head], pointers: { slow, fast } }),
    vars: vars(0),
    comment: `慢指针 slow 和快指针 fast 都从首结点出发`,
  }

  let round = 0
  let guard = 0
  while (fast !== null && nextOf(fast) !== null) {
    if (++guard > LOOP_GUARD) break
    round += 1

    slow = nextOf(slow)
    yield {
      line: 4,
      action: 'set',
      ...state(nodes, head, {
        hot: slow ? [slow] : [],
        pointers: { slow, fast },
      }),
      vars: vars(round),
      comment: `第 ${round} 轮：慢指针走一步，slow 现在在 ${slow ? nodes.find((x) => x.id === slow)!.value : 'NULL'}`,
    }

    fast = nextOf(nextOf(fast))
    yield {
      line: 5,
      action: 'set',
      ...state(nodes, head, {
        hot: fast ? [fast] : [],
        pointers: { slow, fast },
      }),
      vars: vars(round),
      comment: `快指针走两步，fast 现在在 ${fast ? nodes.find((x) => x.id === fast)!.value : 'NULL'}`,
    }

    if (slow === fast) {
      yield {
        line: 6,
        action: 'done',
        ...state(nodes, head, {
          hot: fast ? [fast] : [],
          pointers: { slow, fast },
          hasCycle: true,
        }),
        vars: vars(round),
        comment: `slow 和 fast 在结点 ${nodes.find((x) => x.id === fast)!.value} 相遇 —— 链表有环！`,
      }
      return
    }
  }

  yield {
    line: 8,
    action: 'done',
    ...state(nodes, head, { pointers: { slow, fast } }),
    vars: vars(round),
    comment: `fast 走到了 NULL，说明链表没有环，返回 false`,
  }
}

// ---------------------------------------------------------------------------
// 2. 寻找环的入口
// ---------------------------------------------------------------------------
export const CYCLE_ENTRY_CODE = `LNode *findCycleEntry(LinkList L) {
    LNode *slow = L, *fast = L;
    while (fast != NULL && fast->next != NULL) {
        slow = slow->next; fast = fast->next->next;
        if (slow == fast) break;              // 第一阶段：先找到相遇点
    }
    if (fast == NULL || fast->next == NULL) return NULL;
    slow = L;                                 // 一个指针回到表头
    while (slow != fast) {                    // 第二阶段：同速前进
        slow = slow->next; fast = fast->next;
    }
    return slow;                              // 相遇处就是环的入口
}`

/**
 * 找环入口，分两个阶段：
 *   ① 快慢指针先相遇（说明有环）
 *   ② 一个指针回到表头，然后两个指针**同速**前进，再次相遇的位置就是环的入口
 * 结论（也是考试常考）：从表头到入口的距离 = 从相遇点到入口的距离。
 */
export function* findCycleEntry(a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const { nodes, head } = cyclicChain(a, Math.min(ENTRY_IDX, a.length - 1))
  const n = a.length
  const nextOf = (id: string | null) => (id === null ? null : nodes.find((x) => x.id === id)!.next)
  const valueOf = (id: string | null) =>
    id === null ? 'NULL' : String(nodes.find((x) => x.id === id)!.value)
  const vars = (round: number) => ({ n, round })

  let slow: string | null = head
  let fast: string | null = head

  yield {
    line: 2,
    action: 'mark',
    ...state(nodes, head, { hot: [head], pointers: { slow, fast } }),
    vars: vars(0),
    comment: `第一阶段：快慢指针找相遇点。两个指针都从首结点出发`,
  }

  let round = 0
  let guard = 0
  let met = false
  while (fast !== null && nextOf(fast) !== null) {
    if (++guard > LOOP_GUARD) break
    round += 1
    slow = nextOf(slow)
    fast = nextOf(nextOf(fast))
    yield {
      line: 4,
      action: 'set',
      ...state(nodes, head, {
        hot: [slow, fast].filter((x): x is string => x !== null),
        pointers: { slow, fast },
      }),
      vars: vars(round),
      comment: `第 ${round} 轮：slow 走到 ${valueOf(slow)}，fast 走到 ${valueOf(fast)}`,
    }
    if (slow === fast) {
      met = true
      yield {
        line: 5,
        action: 'compare',
        ...state(nodes, head, {
          hot: fast ? [fast] : [],
          pointers: { slow, fast },
          hasCycle: true,
        }),
        vars: vars(round),
        comment: `slow 和 fast 在 ${valueOf(fast)} 相遇，说明有环。记住这个相遇点`,
      }
      break
    }
  }

  if (!met) {
    yield {
      line: 7,
      action: 'done',
      ...state(nodes, head, { pointers: { slow, fast } }),
      vars: vars(round),
      comment: `fast 走到了 NULL，链表没有环，返回 NULL`,
    }
    return
  }

  slow = head
  yield {
    line: 8,
    action: 'mark',
    ...state(nodes, head, {
      hot: [head, fast].filter((x): x is string => x !== null),
      pointers: { slow, fast },
      hasCycle: true,
    }),
    vars: vars(round),
    comment: `第二阶段：把 slow 拉回表头，fast 留在相遇点，现在两个指针**同速**前进`,
  }

  let step = 0
  guard = 0
  while (slow !== fast) {
    if (++guard > LOOP_GUARD) break
    step += 1
    slow = nextOf(slow)
    fast = nextOf(fast)
    yield {
      line: 10,
      action: 'set',
      ...state(nodes, head, {
        hot: [slow, fast].filter((x): x is string => x !== null),
        pointers: { slow, fast },
        hasCycle: true,
      }),
      vars: vars(round),
      comment: `第 ${step} 步：slow 走到 ${valueOf(slow)}，fast 走到 ${valueOf(fast)}`,
    }
  }

  const entry = slow!
  yield {
    line: 12,
    action: 'done',
    ...state(nodes, head, { pointers: { slow, fast }, hasCycle: true, cycleEntry: entry }),
    vars: vars(round),
    comment: `两个指针在结点 ${valueOf(entry)} 再次相遇 —— 这里就是环的入口`,
  }
}

// ---------------------------------------------------------------------------
// 注册表项
// ---------------------------------------------------------------------------
export const cycleDetectSpec: AlgorithmSpec = {
  id: 'cycle-detect',
  name: '判断链表是否有环',
  category: 'linear',
  group: '循环链表与环',
  summary: '快慢指针相遇即有环',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'linked',
  codeLines: CYCLE_DETECT_CODE.split('\n'),
  defaultData: CYCLE_DATA,
  prepareData: CYCLE_PREPARE,
  initList: initCyclic,
  createRunner: hasCycle,
}

export const cycleEntrySpec: AlgorithmSpec = {
  id: 'cycle-entry',
  name: '寻找环的入口',
  category: 'linear',
  group: '循环链表与环',
  summary: '相遇后同速前进，再遇即入口',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'linked',
  codeLines: CYCLE_ENTRY_CODE.split('\n'),
  defaultData: CYCLE_DATA,
  prepareData: CYCLE_PREPARE,
  initList: initCyclic,
  createRunner: findCycleEntry,
}
