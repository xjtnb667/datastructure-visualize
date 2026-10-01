import type {
  AlgorithmSpec,
  AlgoRunner,
  BoardView,
  ListView,
  RunnerContext,
  TapeView,
} from '@/core/types'
import { dataOrder, idGen, view, type MutableNode } from '@/core/list'

/**
 * 剩下的 7 个栈算法：链栈、共享栈、栈的三个经典应用、以及"栈与递归"。
 *
 * 渲染套路和 stackSeq.ts 一致：
 *   scene  —— 画面完全由每帧的 boards / tapes 描述；
 *   linked —— 链栈用链表渲染器，写法照 singlyLinkedList.ts。
 *
 * 两个反复出现的坑，这里统一处理：
 *   1) 指针下标不能越界（空栈时 top = -1 没法画），所以约定"栈空就不画 top 指针"；
 *   2) 板子的格子数恒定，空位用 dim 表示，这样 capacity 和画面永远对得上。
 */

/** 空格显示成"␣"，否则纸带上什么都看不见（和后缀表达式求值里 split(' ') 对得上） */
const BLANK = '\u2423'

/** 根据纸带上的原始字符算出游标在第几个格子上（空格会被跳过，所以不能直接数） */
function cursor(raw: string, k: number): number {
  let pos = 0
  for (let i = 0; i < k; i++) if (raw[i] !== ' ') pos++
  return pos
}

/** 板子上还没有任何内容时的提示 */
const EMPTY_NOTE = '栈空：top = -1'

// ===========================================================================
// 1 / 2. 链栈进栈、链栈出栈
// ---------------------------------------------------------------------------
// 链栈就是"只允许在头部插入、也只在头部删除"的单链表，
// 所以栈顶就是首结点，入栈 = 头插，出栈 = 删除首结点。
// ===========================================================================

const LINK_CAP = 8

/** 带头结点的空链栈（头结点的 next 就是栈顶） */
function emptyLinkedStack(): MutableNode[] {
  return [{ id: 'head', value: 0, next: null, dummy: true }]
}

/**
 * 把已建好的结点按 next 串起来。
 * 注意入参是**从栈底到栈顶**的顺序：头结点的 next 是栈顶，也就是最后一个元素。
 * 首帧的 array 由 engine 直接对着 defaultData 校验，所以顺序不能反。
 */
function chainNodes(specs: Array<{ id: string; value: number }>): MutableNode[] {
  const nodes: MutableNode[] = emptyLinkedStack()
  let next: string | null = null
  for (let i = specs.length - 1; i >= 0; i--) {
    nodes.push({ id: specs[i]!.id, value: specs[i]!.value, next })
    next = specs[i]!.id
  }
  nodes[0]!.next = next
  return nodes
}

/** 首帧：data 依次进栈后的链栈（栈底在最里面，栈顶是首结点） */
function initLinkedStack(a: number[]): ListView {
  const values = a.slice(0, LINK_CAP)
  const nodes = chainNodes(values.map((value, i) => ({ id: `n${i}`, value })))
  return view(nodes, 'head', { pointers: { top: nodes[0]!.next ?? 'head' } })
}

/**
 * 首帧：一个**空**的链栈。
 * 进栈演示必须从这里开始 —— 否则首帧就把元素全摆上去了，
 * 而生成器又是从空栈开始一个个压，画面会在第 2 帧突然清空一次。
 * （首帧的 array 由 engine 直接设成待进栈的数据，链表校验在 init 帧是跳过的，
 *  所以"数据序列有待压元素、结构还是空栈"是合法的。）
 */
function initLinkedStackEmpty(): ListView {
  return view(emptyLinkedStack(), 'head', { pointers: { top: 'head' } })
}

/** 一次性打包"值序列 + 结构快照"，省得每个 yield 都写两遍 */
function lsState(nodes: MutableNode[], opts: { hot?: string[]; top?: string | null } = {}) {
  const top = opts.top ?? null
  return {
    array: dataOrder(nodes, 'head'),
    list: view(nodes, 'head', {
      hot: opts.hot ?? [],
      pointers: { top: top ?? 'head' },
    }),
  }
}

export const STACK_LINKED_PUSH_CODE = `void push(LinkStack &S, int x) {
    LNode *s = new LNode;                 // 申请新结点
    s->data = x;
    s->next = S->next;                    // ① 新结点先接上原来那一串
    S->next = s;                          // ② 头结点的箭头指向新结点
}`

/**
 * 链栈进栈。带头结点：S 是头结点，S->next 才是栈顶。
 *
 * 顺序说明（这一点没法改）：
 *   ① s->next = S->next —— 新结点先接上原来那一串
 *   ② S->next = s       —— 头结点的箭头指向新结点，s 成为新栈顶
 *
 * 试过把 ② 放到前面（"前驱先指过来"），但那样一执行 S->next = s，
 * 原来那一串就从链上掉下来了 —— 画面上整串旧元素会掉到下方待插入区、
 * 下一步再跳回来，非常乱。所以代码里必须保持这个安全顺序，
 * 视觉上"头结点的箭头指向新结点、新结点滑上去"是在 ② 这一帧发生的。
 */
export function* stackLinkedPush(a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const nodes = emptyLinkedStack()
  const nextId = idGen('s')
  const vars = (n: number) => ({ n, size: n })
  const head = () => nodes.find((n) => n.id === 'head')!

  yield {
    line: 1,
    action: 'mark',
    ...lsState(nodes, { hot: ['head'], top: null }),
    vars: vars(0),
    comment: '带头结点的链栈：头结点不存数据，它的 next 指向栈顶，初始时栈是空的',
  }

  for (let i = 0; i < a.length; i++) {
    const id = nextId()
    nodes.push({ id, value: a[i]!, next: null })
    yield {
      line: 2,
      action: 'set',
      ...lsState(nodes, { hot: [id], top: head().next }),
      vars: vars(i),
      comment: `申请结点 s，s->data = ${a[i]}`,
    }

    const oldTop = head().next
    // ① 新结点先接上原来那一串
    nodes.find((n) => n.id === id)!.next = oldTop
    yield {
      line: 4,
      action: 'mark',
      ...lsState(nodes, { hot: oldTop ? [id, oldTop] : [id], top: oldTop }),
      vars: vars(i),
      comment: oldTop
        ? `s->next = S->next，新结点先接上原来那一串（原来的栈顶是 ${nodes.find((n) => n.id === oldTop)!.value}）。这一步不能和下一步换顺序，换了会把整串弄丢`
        : 's->next = NULL：原来栈是空的，新结点就是栈底',
    }

    // ② 头结点的箭头指向新结点
    head().next = id
    yield {
      line: 5,
      action: 'done',
      ...lsState(nodes, { hot: ['head', id], top: id }),
      vars: vars(i + 1),
      comment: `头结点 S 的箭头指向新结点 s，s 成为新栈顶。栈里有 ${i + 1} 个元素，栈顶是 ${a[i]}`,
    }
  }

  yield {
    line: 5,
    action: 'done',
    ...lsState(nodes, { top: head().next }),
    vars: vars(a.length),
    comment: '全部进栈完成。链栈只在头部操作，不需要预分配空间，也就不会有"栈满"',
  }
}

export const STACK_LINKED_POP_CODE = `int pop(LinkStack &S, int &x) {
    if (S == NULL) return 0;              // 栈空，出栈失败
    LNode *p = S;                         // p 指向栈顶结点
    x = p->data;                          // 取出栈顶数据
    S = p->next;                          // 栈顶指针下移一格
    delete p;                             // 释放原来的栈顶结点
    return 1;
}`

/** 链栈出栈：摘下首结点，栈顶指针顺着 next 下移一格 */
export function* stackLinkedPop(a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const values = a.slice(0, LINK_CAP)
  const nodes = chainNodes(values.map((value, i) => ({ id: `n${i}`, value })))
  const vars = (size: number) => ({ n: values.length, size })

  while (nodes.find((n) => n.id === 'head')!.next !== null) {
    const topId = nodes.find((n) => n.id === 'head')!.next!
    const size = dataOrder(nodes, 'head').length
    yield {
      line: 2,
      action: 'mark',
      ...lsState(nodes, { hot: [topId], top: topId }),
      vars: vars(size),
      comment: `判断栈空：栈顶指针指向结点 ${nodes.find((n) => n.id === topId)!.value}，不是 NULL，可以出栈`,
    }
    yield {
      line: 3,
      action: 'mark',
      ...lsState(nodes, { hot: [topId], top: topId }),
      vars: vars(size),
      comment: 'p = S，让 p 先记住栈顶结点（待会儿要摘掉它，还要释放它）',
    }
    const value = nodes.find((n) => n.id === topId)!.value
    const after = nodes.find((n) => n.id === topId)!.next
    yield {
      line: 4,
      action: 'mark',
      ...lsState(nodes, { hot: [topId], top: topId }),
      vars: vars(size),
      comment: `x = p->data，把栈顶元素 ${value} 取出来`,
    }
    nodes.find((n) => n.id === 'head')!.next = after
    yield {
      line: 5,
      action: 'mark',
      ...lsState(nodes, { hot: [topId], top: after }),
      vars: vars(size),
      comment: after
        ? `S = p->next，栈顶指针下移一格，新的栈顶是 ${nodes.find((n) => n.id === after)!.value}`
        : 'S = p->next = NULL，原栈顶是最后一个元素，现在栈空了',
    }
    nodes.splice(
      nodes.findIndex((n) => n.id === topId),
      1,
    )
    yield {
      line: 6,
      action: 'done',
      ...lsState(nodes, { hot: ['head'], top: nodes.find((n) => n.id === 'head')!.next }),
      vars: vars(size - 1),
      comment: `delete p 释放结点 ${value}。出栈成功，栈里还剩 ${size - 1} 个元素`,
    }
  }

  yield {
    line: 2,
    action: 'done',
    ...lsState(nodes, { hot: ['head'], top: null }),
    vars: vars(0),
    comment: '栈顶指针是 NULL，栈空，出栈失败 —— 这就是链栈的下溢保护',
  }
}

// ===========================================================================
// 3. 共享栈
// ---------------------------------------------------------------------------
// 两个栈共用一段数组，栈 1 从左端往右长（top1 指向栈 1 栈顶），
// 栈 2 从右端往左长（top2 指向栈 2 栈顶）。
// 判满条件：top1 + 1 == top2。此时两个指针都指着真实存在的格子，画指针不会越界。
// ===========================================================================

const SHARED_CAP = 10
/** 为了演示"共享栈满"，最后往两个栈里补压的元素（解说词里会说明） */
const SHARED_FILLER = 9

function sharedBoard(v1: number[], v2: number[], top1: number, top2: number, hot = -1): BoardView {
  const full = top1 + 1 === top2
  const empty = v1.length === 0 && v2.length === 0
  return {
    title: `共享栈 data[0..${SHARED_CAP - 1}]　栈1 从左边往里长，栈2 从右边往里长`,
    layout: 'row',
    items: Array.from({ length: SHARED_CAP }, (_, i) => {
      const use1 = i < v1.length
      const use2 = i >= SHARED_CAP - v2.length
      const text = use1 ? String(v1[i]!) : use2 ? String(v2[i - (SHARED_CAP - v2.length)]!) : ''
      return {
        text,
        sub: String(i),
        tone: i === hot ? 'hot' : use1 || use2 ? 'base' : 'dim',
        // 栈1 从左端往右长 -> 元素从左边滑进来；栈2 从右端往左长 -> 从右边滑进来
        slide: use2 ? ('right' as const) : ('left' as const),
      }
    }),
    // 空栈时 top = -1（或 CAP）根本指不到格子，索性不画指针，改在 note 里说明
    pointers: {
      ...(v1.length > 0 ? { top1 } : {}),
      ...(v2.length > 0 ? { top2 } : {}),
    },
    note: empty
      ? '两个栈都空：top1 = -1，top2 = CAP'
      : full
        ? 'top1 + 1 == top2，两个栈顶顶在一起 —— 这就是"共享栈满"'
        : `栈1 里有 ${v1.length} 个元素，栈2 里有 ${v2.length} 个元素，还能再放 ${top2 - top1 - 1} 个`,
  }
}

export const STACK_SHARED_CODE = `#define MAXSIZE 10
typedef struct { int data[MAXSIZE]; int top1, top2; } DqStack;
// 栈1 从下标 0 开始往右长，栈2 从 MAXSIZE-1 开始往左长
int push(DqStack &S, int i, int x) {
    if (S.top1 + 1 == S.top2) return 0;   // 两个栈顶相邻，栈满
    if (i == 1) S.data[++S.top1] = x;     // 栈1：栈顶右移后放新元素
    else        S.data[--S.top2] = x;     // 栈2：栈顶左移后放新元素
    return 1;
}`

/**
 * 共享栈进栈：注意判满条件不是"某个栈满了"，而是"两个栈顶相邻"。
 * 只有两个栈真正顶到一起，整段数组才算用尽。
 */
export function* stackShared(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const cap = ctx.capacity ?? SHARED_CAP
  const v1: number[] = []
  const v2: number[] = []
  const vars = () => ({ top1: v1.length - 1, top2: cap - v2.length, cap })

  yield {
    line: 2,
    action: 'mark',
    array: [],
    boards: [sharedBoard(v1, v2, -1, cap)],
    vars: vars(),
    comment: `共享栈把容量 ${cap} 的一段数组分给两个栈用：栈1 从左端往右长，栈2 从右端往左长，指针相向而行`,
  }

  for (const x of a) {
    const top1 = v1.length - 1
    const top2 = cap - v2.length
    const full = top1 + 1 === top2
    yield {
      line: 5,
      action: 'mark',
      array: [...v1, ...v2],
      boards: [sharedBoard(v1, v2, top1, top2)],
      vars: vars(),
      comment: full
        ? `top1 + 1 = ${top1 + 1}，正好等于 top2 = ${top2}，两个指针相邻，栈满`
        : `判断栈满：top1 + 1 = ${top1 + 1}，还小于 top2 = ${top2}，两个栈顶之间有空位，可以进栈`,
    }

    const one = v1.length <= v2.length
    if (full) {
      yield {
        line: 5,
        action: 'mark',
        array: [...v1, ...v2],
        boards: [sharedBoard(v1, v2, top1, top2, top1)],
        vars: vars(),
        comment: `整段数组被两个栈用完了，${x} 进栈失败 —— 共享栈的"上溢"要等两个栈顶相遇才会发生`,
      }
      break
    }

    if (one) {
      v1.push(x)
      yield {
        line: 6,
        action: 'set',
        array: [...v1, ...v2],
        boards: [sharedBoard(v1, v2, top1 + 1, top2, top1 + 1)],
        vars: vars(),
        comment: `栈1 的栈顶右移：top1 变成 ${top1 + 1}，把 ${x} 放到 data[${top1 + 1}]`,
      }
    } else {
      v2.unshift(x)
      yield {
        line: 7,
        action: 'set',
        array: [...v1, ...v2],
        boards: [sharedBoard(v1, v2, top1, top2 - 1, top2 - 1)],
        vars: vars(),
        comment: `栈2 的栈顶左移：top2 变成 ${top2 - 1}，把 ${x} 放到 data[${top2 - 1}]`,
      }
    }
    yield {
      line: 8,
      action: 'done',
      array: [...v1, ...v2],
      boards: [sharedBoard(v1, v2, v1.length - 1, cap - v2.length)],
      vars: vars(),
      comment: `进栈成功，返回 1。现在栈1 = [${v1.join(', ')}]，栈2 = [${v2.join(', ')}]（栈2 从栈底到栈顶读）`,
    }
  }

  // 补一次"真的满了"的画面：继续压入 SHARED_FILLER 把剩余空位填满，让两个栈顶顶到一起
  if (v1.length + v2.length < cap) {
    const filler = SHARED_FILLER
    while (v1.length <= v2.length && v1.length + v2.length < cap) v1.push(filler)
    while (v1.length + v2.length < cap) v2.unshift(filler)
    const top1 = v1.length - 1
    const top2 = cap - v2.length
    yield {
      line: 5,
      action: 'mark',
      array: [...v1, ...v2],
      boards: [sharedBoard(v1, v2, top1, top2, top1)],
      vars: vars(),
      comment: `继续往两个栈里压元素（填进来的都是 ${filler}），现在 top1 = ${top1}、top2 = ${top2}，top1 + 1 == top2，两个栈顶相遇，共享栈满`,
    }
  }

  yield {
    line: 5,
    action: 'done',
    array: [...v1, ...v2],
    boards: [sharedBoard(v1, v2, v1.length - 1, cap - v2.length)],
    vars: vars(),
    comment: `演示结束：整段数组被两个栈分完了（后填的 ${SHARED_FILLER} 是凑满用的）。栈1 = [${v1.join(', ')}]，栈2 从栈底到栈顶 = [${v2.join(', ')}]`,
  }
}

// ===========================================================================
// 4. 括号匹配
// ===========================================================================

const BRACKETS = '([{}()])'

const bracketBoard = (chars: string[], hot = -1): BoardView => ({
  title: '匹配栈（从左往右扫描括号串）',
  layout: 'column',
  items: Array.from({ length: 6 }, (_, i) =>
    i < chars.length
      ? { text: chars[i]!, sub: String(i), tone: i === hot ? 'hot' : 'base' }
      : { text: '', sub: String(i), tone: 'dim' },
  ) as BoardView['items'],
  pointers: chars.length > 0 ? { top: chars.length - 1 } : {},
  note: chars.length === 0 ? EMPTY_NOTE : `栈里有 ${chars.length} 个还没匹配上的左括号`,
})

const bracketTape = (pos: number): TapeView => ({
  label: '待匹配的括号串（高亮的是当前扫描到的字符）',
  items: BRACKETS.split(''),
  pos,
  tone: 'in',
})

export const BRACKET_CODE = `bool bracketMatch(char str[]) {
    SqStack S; InitStack(S);              // 初始化一个空栈
    for (int i = 0; str[i] != '\\0'; i++) {
        if (str[i]=='(' || str[i]=='[' || str[i]=='{')
            Push(S, str[i]);              // 左括号一律进栈
        else {
            if (StackEmpty(S)) return false;   // 右括号来了却没得配
            char c; Pop(S, c);
            if (!match(c, str[i])) return false; // 栈顶左括号类型不对
        }
    }
    return StackEmpty(S);                 // 全都配完了栈必须是空的
}`

/**
 * 括号匹配：左括号一律进栈；遇到右括号就弹出栈顶左括号，看两者是不是一对。
 * 扫描结束后栈必须为空，否则说明还有左括号没人配。
 */
export function* bracketMatch(_a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const raw = BRACKETS
  const chars: string[] = []
  // 帮助函数只打包"画面 + 变量"，行号和动作由每个 yield 明确写出来（避免被覆盖写错）
  const frame = (at: number, hot = -1, left = 0) => ({
    boards: [bracketBoard(chars, hot)],
    tapes: [bracketTape(at)],
    vars: { i: at, depth: chars.length, left },
  })

  const OPEN = '([{'
  const PAIR: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

  yield {
    line: 2,
    action: 'mark',
    array: [],
    ...frame(0),
    comment: '先把匹配栈初始化成空栈，然后从左往右一个字符一个字符地扫描括号串',
  }

  let broken = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    const pos = cursor(raw, i)
    if (OPEN.includes(ch)) {
      yield {
        line: 4,
        action: 'set',
        array: [],
        ...frame(pos, -1, 1),
        comment: `扫描到 '${ch}'：它是左括号，直接进栈，等后面来的右括号跟它配对`,
      }
      chars.push(ch)
      yield {
        line: 4,
        action: 'mark',
        array: [],
        ...frame(pos, chars.length - 1),
        comment: `'${ch}' 已压入栈顶，现在栈里是 ${chars.join('')}，栈顶是 '${ch}'`,
      }
      continue
    }

    const need = PAIR[ch]!
    yield {
      line: 6,
      action: 'compare',
      array: [],
      ...frame(pos, chars.length - 1),
      comment: `扫描到 '${ch}'：它是右括号，要先看看栈里还有没有左括号可以配`,
    }
    if (chars.length === 0) {
      yield {
        line: 6,
        action: 'done',
        array: [],
        ...frame(pos),
        comment: `栈是空的，'${ch}' 没有可以配对的左括号，匹配失败（右括号多了）`,
      }
      broken = true
      break
    }
    const top = chars[chars.length - 1]!
    yield {
      line: 7,
      action: 'compare',
      array: [],
      ...frame(pos, chars.length - 1),
      comment: `弹出栈顶元素 '${top}'，拿它和 '${ch}' 比一比`,
    }
    if (top !== need) {
      yield {
        line: 8,
        action: 'done',
        array: [],
        ...frame(pos),
        comment: `'${top}' 和 '${ch}' 不是一对，类型不匹配，匹配失败（交叉嵌套的括号是非法的）`,
      }
      broken = true
      break
    }
    chars.pop()
    yield {
      line: 8,
      action: 'done',
      array: [],
      ...frame(pos, chars.length - 1),
      comment: `'${top}' 与 '${ch}' 正好配对，一起消掉。剩下的栈是 ${chars.length ? chars.join('') : '空栈'}`,
    }
  }

  if (!broken) {
    // 扫完之后游标停在最后一个字符上（pos 只能落在纸带范围内，越界会被校验器拦下）
    const endPos = raw.length - 1
    if (chars.length === 0) {
      yield {
        line: 10,
        action: 'done',
        array: [],
        ...frame(endPos),
        comment: '整串扫描完毕，栈正好是空的 —— 说明每一个左括号都找到了自己的右括号，匹配成功',
      }
    } else {
      yield {
        line: 10,
        action: 'done',
        array: [],
        ...frame(endPos, chars.length - 1),
        comment: `扫描结束但栈里还剩 ${chars.join('')}，这些左括号没人配对，匹配失败（左括号多了）`,
      }
    }
  }
}

// ===========================================================================
// 5. 中缀转后缀
// ===========================================================================

const INFIX = 'A+B*(C-D)-E/F'
/** 算好的答案，收尾帧拿它对一下账，顺便说明后缀式里没有括号也照样能表达运算顺序 */
const EXPECT_POSTFIX = 'AB+CD-*EF/-'
/** 运算过程中出现的运算符总个数，决定运算符栈板子画几格 */
const OP_SLOTS = 6

function opBoard(chars: string[], hot = -1): BoardView {
  return {
    title: '运算符栈（栈底在最下面）',
    layout: 'column',
    items: Array.from({ length: OP_SLOTS }, (_, i) =>
      i < chars.length
        ? { text: chars[i]!, sub: String(i), tone: i === hot ? 'hot' : 'base' }
        : { text: '', sub: String(i), tone: 'dim' },
    ) as BoardView['items'],
    pointers: chars.length > 0 ? { top: chars.length - 1 } : {},
    note: chars.length === 0 ? EMPTY_NOTE : `栈顶是 '${chars[chars.length - 1]!}'`,
  }
}

function exprTape(k: number, out: string): TapeView[] {
  const pos = cursor(INFIX, k)
  return [
    { label: '中缀表达式（高亮的是当前读到的字符）', items: INFIX.split(''), pos, tone: 'in' },
    {
      label: '后缀表达式（已经输出的部分）',
      items: out.length ? out.split('') : [BLANK],
      pos: Math.max(out.length - 1, 0),
      tone: 'out',
    },
  ]
}

const PRIORITY: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }

export const INFIX_TO_POSTFIX_CODE = `void infixToPostfix(char exp[], char res[]) {
    SqStack S; InitStack(S); int k = 0;   // S 存运算符，res 存结果
    for (int i = 0; exp[i] != '\\0'; i++) {
        char ch = exp[i];
        if (isOperand(ch)) res[k++] = ch;               // 操作数直接输出
        else if (ch == '(') Push(S, ch);                // 左括号直接进栈
        else if (ch == ')') {                           // 右括号：弹到左括号为止
            while (Top(S) != '(') res[k++] = Pop(S);
            Pop(S);
        } else {                                        // 运算符：比优先级
            while (!StackEmpty(S) && Top(S) != '(' && prio(Top(S)) >= prio(ch))
                res[k++] = Pop(S);
            Push(S, ch);
        }
    }
    while (!StackEmpty(S)) res[k++] = Pop(S);           // 把栈里剩下的全弹出来
    res[k] = '\\0';
}`

/**
 * 中缀转后缀（调度场算法）：操作数直接输出；运算符要等"栈顶优先级不低于自己"的先出栈；
 * 左括号进栈当分界；右括号把栈里的运算符一直弹到左括号为止。
 */
export function* infixToPostfix(_a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const ops: string[] = []
  let out = ''
  const frame = (k: number, hot = -1, compares = 0) => ({
    boards: [opBoard(ops, hot)],
    tapes: exprTape(k, out),
    vars: { i: k, out: out.length, depth: ops.length, compares },
  })

  yield {
    line: 2,
    action: 'mark',
    array: [],
    ...frame(0),
    comment: '初始化：运算符栈空、结果串空，然后从左往右读中缀表达式',
  }

  for (let i = 0; i < INFIX.length; i++) {
    const ch = INFIX[i]!
    if (ch === '(') {
      yield {
        line: 5,
        action: 'set',
        array: [],
        ...frame(i),
        comment: `读到 '('：左括号进栈，它起到"分界"的作用，括号里的运算符不许弹到它外面`,
      }
      ops.push(ch)
      continue
    }
    if (ch === ')') {
      yield {
        line: 7,
        action: 'compare',
        array: [],
        ...frame(i, ops.length - 1),
        comment: `读到 ')'：把栈顶的运算符一个个弹出并输出，直到遇见 '(' 为止`,
      }
      while (ops.length > 0 && ops[ops.length - 1] !== '(') {
        const op = ops.pop()!
        out += op
        yield {
          line: 7,
          action: 'set',
          array: [],
          ...frame(i, ops.length - 1),
          comment: `弹出栈顶 '${op}' 追加到后缀串，得到 "${out}"`,
        }
      }
      ops.pop()
      yield {
        line: 9,
        action: 'mark',
        array: [],
        ...frame(i, ops.length - 1),
        comment: `把配对的 '(' 也弹掉（不输出）。括号内的运算符已经全部转到后缀串里了`,
      }
      continue
    }
    if (PRIORITY[ch] === undefined) {
      out += ch
      yield {
        line: 4,
        action: 'set',
        array: [],
        ...frame(i, ops.length - 1),
        comment: `'${ch}' 是操作数：操作数的相对次序不会变，直接输出，后缀串变成 "${out}"`,
      }
      continue
    }

    let compares = 0
    let top = ops[ops.length - 1]
    while (ops.length > 0 && top !== '(' && PRIORITY[top]! >= PRIORITY[ch]!) {
      compares += 1
      yield {
        line: 12,
        action: 'compare',
        array: [],
        ...frame(i, ops.length - 1, compares),
        comment: `比较优先级：栈顶 '${top}' 的优先级不低于 '${ch}'，先把栈顶的 '${top}' 弹出来输出`,
      }
      out += ops.pop()!
      top = ops[ops.length - 1]
    }
    if (ops.length > 0 && top !== '(') compares += 1
    yield {
      line: 14,
      action: 'mark',
      array: [],
      ...frame(i, ops.length - 1, compares),
      comment:
        ops.length === 0 || top === '('
          ? `栈空（或者栈顶是括号分界），'${ch}' 直接进栈`
          : `栈顶 '${top}' 的优先级低于 '${ch}'，先不动它，'${ch}' 进栈`,
    }
    ops.push(ch)
  }

  while (ops.length > 0) {
    const op = ops.pop()!
    out += op
    yield {
      line: 16,
      action: 'set',
      array: [],
      ...frame(INFIX.length - 1, ops.length - 1),
      comment: `表达式读完了，把栈里剩下的运算符依次弹出：输出 '${op}'，后缀串变成 "${out}"`,
    }
  }

  yield {
    line: 17,
    action: 'done',
    array: [],
    ...frame(INFIX.length - 1),
    comment: `转换完成：${INFIX} → ${out}，和手算的结果 ${EXPECT_POSTFIX} 一致。后缀表达式里没有括号，运算符出现的顺序就是真正的运算顺序`,
  }
}

// ===========================================================================
// 6. 后缀表达式求值
// ===========================================================================

const POSTFIX_EXPR = '3 4 + 5 * 6 -'
/** 求值过程中操作数栈最深只有 2 层，留 4 格画面更宽松 */
const EVAL_SLOTS = 4

/** 真算一遍后缀表达式，给 vars.result 和文字解说用，让画面和结果永远对得上 */
function evalPostfix(expr: string): number {
  const st: number[] = []
  for (const ch of expr.split(' ')) {
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      const b = st.pop()!
      const a = st.pop()!
      st.push(ch === '+' ? a + b : ch === '-' ? a - b : ch === '*' ? a * b : Math.trunc(a / b))
    } else {
      st.push(Number(ch))
    }
  }
  return st[st.length - 1] ?? 0
}

const evalBoard = (st: number[], hot = -1): BoardView => ({
  title: '操作数栈（栈底在最下面）',
  layout: 'column',
  items: Array.from({ length: EVAL_SLOTS }, (_, i) =>
    i < st.length
      ? { text: String(st[i]!), sub: String(i), tone: i === hot ? 'hot' : 'base' }
      : { text: '', sub: String(i), tone: 'dim' },
  ) as BoardView['items'],
  pointers: st.length > 0 ? { top: st.length - 1 } : {},
  note: st.length === 0 ? EMPTY_NOTE : `栈顶是 ${st[st.length - 1]!}`,
})

const evalTapeItems = POSTFIX_EXPR.split(' ').map((s) => (s === ' ' ? BLANK : s))

export const POSTFIX_EVAL_CODE = `int evalPostfix(char exp[]) {
    SqStack S; InitStack(S);              // 操作数栈
    for (int i = 0; exp[i] != '\\0'; i++) {
        char ch = exp[i];
        if (ch == ' ') continue;
        if (ch >= '0' && ch <= '9') {     // 数字：直接进栈
            Push(S, ch - '0');
        } else {                          // 运算符：弹出两个操作数
            int b = Pop(S), a = Pop(S);
            Push(S, calc(a, ch, b));      // 算完把结果压回栈里
        }
    }
    return Pop(S);                        // 栈里最后剩下的那个数就是答案
}`

/**
 * 后缀表达式求值：遇数字进栈；遇运算符就弹出两个操作数，
 * 先弹出的是右操作数（后进先出），算完把结果压回栈里。
 */
export function* postfixEval(_a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const st: number[] = []
  let compares = 0
  const frame = (k: number, hot = -1) => ({
    boards: [evalBoard(st, hot)],
    tapes: [
      {
        label: '后缀表达式（高亮的是当前处理的符号）',
        items: [...evalTapeItems],
        pos: Math.max(0, Math.min(k, evalTapeItems.length - 1)),
        tone: 'in' as const,
      },
    ],
    vars: { i: k, depth: st.length, result: evalPostfix(POSTFIX_EXPR), compares },
  })

  yield {
    line: 2,
    action: 'mark',
    array: [],
    ...frame(0),
    comment: '初始化一个空的操作数栈，然后从左往右处理后缀表达式的每个符号',
  }

  for (let i = 0; i < evalTapeItems.length; i++) {
    const s = evalTapeItems[i]!
    if (s !== '+' && s !== '-' && s !== '*' && s !== '/') {
      yield {
        line: 6,
        action: 'mark',
        array: [],
        ...frame(i),
        comment: `读到数字 ${s}，进栈待用`,
      }
      st.push(Number(s))
      yield {
        line: 6,
        action: 'set',
        array: [],
        ...frame(i, st.length - 1),
        comment: `${s} 已进栈，现在栈里从栈底到栈顶是 [${st.join(', ')}]`,
      }
      continue
    }

    compares += 1
    yield {
      line: 8,
      action: 'compare',
      array: [],
      ...frame(i, st.length - 1),
      comment: `读到运算符 '${s}'：要把栈顶的两个操作数弹出来，注意先后顺序`,
    }
    const b = st.pop()!
    yield {
      line: 8,
      action: 'mark',
      array: [],
      ...frame(i, st.length - 1),
      comment: `先弹出的是右操作数 b = ${b}`,
    }
    const a = st.pop()!
    yield {
      line: 8,
      action: 'mark',
      array: [],
      ...frame(i, st.length - 1),
      comment: `再弹出的是左操作数 a = ${a}，所以算的是 ${a} ${s} ${b}`,
    }
    const r = s === '+' ? a + b : s === '-' ? a - b : s === '*' ? a * b : Math.trunc(a / b)
    yield {
      line: 9,
      action: 'set',
      array: [],
      ...frame(i),
      comment: `计算 ${a} ${s} ${b} = ${r}`,
    }
    st.push(r)
    yield {
      line: 9,
      action: 'done',
      array: [],
      ...frame(i, st.length - 1),
      comment: `把结果 ${r} 压回栈里，栈里现在从栈底到栈顶是 [${st.join(', ')}]`,
    }
  }

  yield {
    line: 11,
    action: 'done',
    array: [],
    ...frame(evalTapeItems.length - 1, st.length - 1),
    comment: `表达式处理完，栈里只剩一个数 ${st[st.length - 1]!} —— 它就是 ${POSTFIX_EXPR} 的值`,
  }
}

// ===========================================================================
// 7. 递归求阶乘
// ---------------------------------------------------------------------------
// 用调用栈板子表示递归：一层递归就是栈里多一格，返回时从栈顶一层层回代。
// ===========================================================================

const FACT_N = 4
/** 递归深度是 n+1（fact(0) 那一层也要压栈），再留一格空位 */
const CALL_SLOTS = FACT_N + 2

interface Frame {
  /** 帧名，比如 fact(3) */
  name: string
  /** 格子右下角的小字：参数或返回值 */
  sub: string
  /** 'call' 正在推进、'return' 正在回代、'done' 已经算完 */
  phase: 'call' | 'return' | 'done'
}

function callBoard(frames: Frame[], hot = -1): BoardView {
  return {
    title: '系统调用栈（栈底在最下面）',
    layout: 'column',
    items: Array.from({ length: CALL_SLOTS }, (_, i) =>
      i < frames.length
        ? {
            text: frames[i]!.name,
            sub: frames[i]!.sub,
            tone: (i === hot ? 'hot' : frames[i]!.phase === 'done' ? 'done' : 'base') as
              | 'hot'
              | 'done'
              | 'base',
          }
        : { text: '', sub: '', tone: 'dim' as const },
    ) as BoardView['items'],
    pointers: frames.length > 0 ? { top: frames.length - 1 } : {},
    note:
      frames.length === 0
        ? '调用栈为空'
        : `栈深 ${frames.length}，栈顶是 ${frames[frames.length - 1]!.name}`,
  }
}

/** 递归求阶乘的代码：n 写在参数里，所以每一层都有自己的 n，返回时才能逐层回代 */
export const FACT_RECURSION_CODE = `int fact(int n) {
    if (n == 0 || n == 1) return 1;       // 递归出口
    int y = fact(n - 1);                  // ① 先递归求出 (n-1)!
    return n * y;                         // ② 回来后再乘上自己的 n
}`

/**
 * 递归求阶乘：递归的推进和回退本质上就是系统调用栈的压栈与出栈。
 * 每一层的 n 都留在自己的栈帧里，所以回代时谁都不会算错。
 */
export function* factRecursion(a: number[], _ctx: RunnerContext = {}): AlgoRunner {
  const n = Math.min(Math.max(1, a[0] ?? FACT_N), FACT_N)
  const frames: Frame[] = []
  // 只打包"画面 + 变量 + 解说"，行号和动作由每个 yield 明确写出来（避免行号被覆盖）
  const frame = (comment: string, hot = -1) => ({
    boards: [callBoard(frames, hot)],
    vars: { n, depth: frames.length, top: frames.length - 1 },
    comment,
  })

  yield {
    line: 1,
    action: 'mark',
    array: [n],
    ...frame(`主函数调用 fact(${n})，系统为它建一个栈帧压进调用栈`),
  }

  for (let k = n; k >= 1; k--) {
    if (k < n) {
      yield {
        line: 2,
        action: 'compare',
        array: [n],
        ...frame(
          `fact(${k + 1}) 里算出 n = ${k + 1}，它不等于 0 也不等于 1，得继续往下递归`,
          frames.length - 1,
        ),
      }
      yield {
        line: 3,
        action: 'mark',
        array: [n],
        ...frame(
          `fact(${k + 1}) 调用 fact(${k})：注意它这一层的 n = ${k + 1} 被留在了自己的栈帧里`,
          frames.length - 1,
        ),
      }
    }
    frames.push({ name: `fact(${k})`, sub: `n=${k}`, phase: 'call' })
    yield {
      line: 1,
      action: 'mark',
      array: [n],
      ...frame(`fact(${k}) 的栈帧压栈，n = ${k}，现在调用栈有 ${frames.length} 层`, frames.length - 1),
    }
  }

  yield {
    line: 2,
    action: 'compare',
    array: [n],
    ...frame('栈顶是 fact(1)，参数 n = 1，命中了递归出口，不再往下递归', frames.length - 1),
  }
  frames[frames.length - 1]!.phase = 'done'
  frames[frames.length - 1]!.sub = 'return 1'
  yield {
    line: 2,
    action: 'done',
    array: [n],
    ...frame('fact(1) 直接返回 1。这一层的栈帧用完就可以弹出了', frames.length - 1),
  }

  for (let k = 1; k <= n; k++) {
    const self = frames[frames.length - 1]!
    self.sub = k === 1 ? 'return 1' : `y=${k - 1}`
    const below = k === 1 ? 1 : k - 1
    yield {
      line: 3,
      action: 'mark',
      array: [n],
      ...frame(
        k === 1
          ? 'fact(1) 没有下一层可调用，就直接返回 1'
          : `fact(${k}) 等到下一层返回，拿到 y = ${below}`,
        frames.length - 1,
      ),
    }
    self.phase = 'done'
    self.sub = `return ${k * below}`
    yield {
      line: 4,
      action: 'set',
      array: [n],
      ...frame(`回代：fact(${k}) = ${k} × ${below} = ${k * below}`, frames.length - 1),
    }
    frames.pop()
    if (k < n) {
      const upper = frames[frames.length - 1]!
      upper.phase = 'call'
      upper.sub = `n=${k + 1} y=${k * below}`
    }
    yield {
      line: 4,
      action: 'done',
      array: [n],
      ...frame(
        k < n
          ? `fact(${k}) 的栈帧出栈，返回值 ${k * below} 交给下面一层的 fact(${k + 1})`
          : `fact(${k}) 的栈帧出栈，返回值 ${k * below} 交给主函数。调用栈空了`,
        frames.length - 1,
      ),
    }
  }

  const answer = Array.from({ length: n }, (_, i) => i + 1).reduce((x, y) => x * y, 1)
  yield {
    line: 4,
    action: 'done',
    array: [n],
    ...frame(`递归全部结束，fact(${n}) = ${answer}。递归的推进和回退，就是调用栈的压栈和出栈`),
  }
}

// ===========================================================================
// 注册表项
// ===========================================================================
export const stackMoreSpecs: AlgorithmSpec[] = [
  {
    id: 'stack-linked-push',
    name: '链栈进栈',
    category: 'stack',
    group: '链栈',
    summary: '链栈的入栈就是一次头插，栈顶永远是首结点',
    complexity: { time: 'O(1)', space: 'O(1)' },
    renderer: 'linked',
    codeLines: STACK_LINKED_PUSH_CODE.split('\n'),
    defaultData: () => [3, 7, 1, 9, 5],
    initList: initLinkedStackEmpty,
    initComment: (data) =>
      `链栈现在还是空的（头结点的 next = NULL）。下面把 [${data.join(', ')}] 依次进栈`,
    createRunner: stackLinkedPush,
  },
  {
    id: 'stack-linked-pop',
    name: '链栈出栈',
    category: 'stack',
    group: '链栈',
    summary: '摘下首结点，栈顶指针顺着 next 下移一格',
    complexity: { time: 'O(1)', space: 'O(1)' },
    renderer: 'linked',
    codeLines: STACK_LINKED_POP_CODE.split('\n'),
    defaultData: () => [3, 7, 1, 9, 5],
    initList: (data) => initLinkedStack(data),
    createRunner: stackLinkedPop,
  },
  {
    id: 'stack-shared',
    name: '共享栈',
    category: 'stack',
    group: '共享栈',
    summary: '两个栈共用一段数组，从两端往中间长，栈顶相遇才算满',
    complexity: { time: 'O(1)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: STACK_SHARED_CODE.split('\n'),
    capacity: SHARED_CAP,
    defaultData: () => [3, 7, 1, 9],
    initComment: () =>
      `共享栈：一段容量 ${SHARED_CAP} 的数组，栈1 从下标 0 往右长，栈2 从下标 ${SHARED_CAP - 1} 往左长`,
    initScene: () => ({ boards: [sharedBoard([], [], -1, SHARED_CAP)] }),
    createRunner: stackShared,
  },
  {
    id: 'bracket-match',
    name: '括号匹配',
    category: 'stack',
    group: '栈的应用',
    summary: '左括号进栈，右括号弹栈比对，最后栈空才算匹配',
    complexity: { time: 'O(n)', space: 'O(n)' },
    renderer: 'scene',
    codeLines: BRACKET_CODE.split('\n'),
    useFixedInput: true,
    // 输入必须是 number[]，所以把固定串的每个字符按 charCode 摊平进数组（内容本身固定）
    defaultData: () => BRACKETS.split('').map((c) => c.charCodeAt(0)),
    initComment: () => `固定输入串：${BRACKETS}，把它上面的字符从左往右扫一遍`,
    initScene: () => ({ boards: [bracketBoard([])], tapes: [bracketTape(0)] }),
    createRunner: bracketMatch,
  },
  {
    id: 'infix-to-postfix',
    name: '中缀转后缀',
    category: 'stack',
    group: '栈的应用',
    summary: '操作数直接输出，运算符按优先级进栈出栈，括号当分界',
    complexity: { time: 'O(n)', space: 'O(n)' },
    renderer: 'scene',
    codeLines: INFIX_TO_POSTFIX_CODE.split('\n'),
    useFixedInput: true,
    defaultData: () => INFIX.split('').map((c) => c.charCodeAt(0)),
    initComment: () => `固定表达式：${INFIX}，目标是把它转成等价的后缀表达式`,
    initScene: () => ({ boards: [opBoard([])], tapes: exprTape(0, '') }),
    createRunner: infixToPostfix,
  },
  {
    id: 'postfix-eval',
    name: '后缀表达式求值',
    category: 'stack',
    group: '栈的应用',
    summary: '遇数字进栈，遇运算符弹出两个数算完再压回',
    complexity: { time: 'O(n)', space: 'O(n)' },
    renderer: 'scene',
    codeLines: POSTFIX_EVAL_CODE.split('\n'),
    useFixedInput: true,
    defaultData: () => POSTFIX_EXPR.split('').map((c) => c.charCodeAt(0)),
    initComment: () => `固定后缀表达式：${POSTFIX_EXPR}，用操作数栈把它算出来`,
    initScene: () => ({
      boards: [evalBoard([])],
      tapes: [
        { label: '后缀表达式（高亮的是当前处理的符号）', items: [...evalTapeItems], pos: 0, tone: 'in' },
      ],
    }),
    createRunner: postfixEval,
  },
  {
    id: 'recursion-fact',
    name: '递归求阶乘',
    category: 'stack',
    group: '栈与递归',
    summary: '递归的推进与回退就是系统调用栈的压栈与出栈',
    complexity: { time: 'O(n)', space: 'O(n)' },
    renderer: 'scene',
    codeLines: FACT_RECURSION_CODE.split('\n'),
    useFixedInput: true,
    defaultData: () => [FACT_N],
    initComment: (data) => `固定输入 n = ${data[0] ?? FACT_N}，看 fact() 一层层把自己压进调用栈`,
    initScene: () => ({ boards: [callBoard([])] }),
    createRunner: factRecursion,
  },
]
