import type { AlgorithmSpec, AlgoRunner, BoardView, RunnerContext } from '@/core/types'

/**
 * 顺序栈。约定采用教材上的写法：**top 指向栈顶元素，top == -1 表示空栈**。
 * 这样 top 的取值范围永远是 [-1, MAXSIZE-1]，直接把 top 当下标画成指针不会越界。
 */
const CAP = 8

function board(values: number[], top: number, hot = -1, extra?: Partial<BoardView>): BoardView {
  return {
    title: `顺序栈 data[0..${CAP - 1}]`,
    layout: 'column',
    items: Array.from({ length: CAP }, (_, i) => {
      const has = i < values.length
      const tone = i === hot ? 'hot' : has ? 'base' : 'dim'
      return { text: has ? String(values[i]!) : '', sub: String(i), tone }
    }),
    pointers: top >= 0 ? { top } : {},
    note:
      top < 0
        ? '空栈（top = -1）'
        : top === CAP - 1
          ? `top = ${top}　栈满`
          : `top = ${top}`,
    ...extra,
  }
}

const CODE_PUSH = [
  `#define MAXSIZE ${CAP}`,
  'typedef struct { int data[MAXSIZE]; int top; } SqStack;',
  '// 约定：top 指向栈顶元素，top == -1 表示空栈',
  'int push(SqStack &S, int x) {',
  '  if (S.top == MAXSIZE - 1) return 0;   // 栈满，进栈失败',
  '  S.top++;                              // 栈顶指针上移一格',
  '  S.data[S.top] = x;                    // 新元素放到新的栈顶',
  '  return 1;                             // 进栈成功',
  '}',
]

const CODE_POP = [
  `#define MAXSIZE ${CAP}`,
  'typedef struct { int data[MAXSIZE]; int top; } SqStack;',
  '// 约定：top 指向栈顶元素，top == -1 表示空栈',
  'int pop(SqStack &S, int &x) {',
  '  if (S.top == -1) return 0;            // 栈空，出栈失败',
  '  x = S.data[S.top];                    // 取出栈顶元素',
  '  S.top--;                              // 栈顶指针下移一格',
  '  return 1;                             // 出栈成功',
  '}',
]

function* runPush(data: number[], ctx: RunnerContext = {}): AlgoRunner {
  const cap = ctx.capacity ?? CAP
  const stack: number[] = []
  for (const x of data) {
    if (stack.length >= cap) {
      yield {
        line: 5,
        action: 'mark',
        array: [...stack],
        boards: [board(stack, stack.length - 1, stack.length - 1)],
        comment: `top = ${stack.length - 1} 已经等于 MAXSIZE - 1 = ${cap - 1}，栈满，进栈失败`,
      }
      break
    }
    yield {
      line: 5,
      action: 'mark',
      array: [...stack],
      boards: [board(stack, stack.length - 1)],
      comment: `判断栈满：top = ${stack.length - 1}，还没到 MAXSIZE - 1 = ${cap - 1}，可以进栈`,
    }
    yield {
      line: 6,
      action: 'mark',
      array: [...stack],
      boards: [board(stack, stack.length - 1)],
      comment: `栈顶指针上移一格：top 由 ${stack.length - 1} 变成 ${stack.length}`,
      vars: { top: stack.length },
    }
    stack.push(x)
    yield {
      line: 7,
      action: 'set',
      array: [...stack],
      boards: [board(stack, stack.length - 1, stack.length - 1)],
      comment: `${x} 入栈，放到 data[${stack.length - 1}] 这一格`,
      vars: { top: stack.length - 1 },
    }
    yield {
      line: 8,
      action: 'done',
      array: [...stack],
      boards: [board(stack, stack.length - 1, stack.length - 1)],
      comment: `进栈成功，现在 top = ${stack.length - 1}，栈里有 ${stack.length} 个元素`,
      vars: { top: stack.length - 1, n: stack.length },
    }
  }
}

function* runPop(data: number[], ctx: RunnerContext = {}): AlgoRunner {
  const cap = ctx.capacity ?? CAP
  const stack = data.slice(0, cap)
  /*
   * 注意：循环次数必须**先定下来**。
   * 如果写成 `i < stack.length`，每出一栈长度就少 1，条件会提前失败 ——
   * 结果是后面几个元素永远出不来，然后被收尾帧一次性清空，
   * 看上去就是"最后两个元素一起没了"。
   */
  const total = stack.length
  for (let i = 0; i < total; i++) {
    for (const line of [5, 6]) {
      yield {
        line,
        action: 'mark',
        array: [...stack],
        boards: [board(stack, stack.length - 1, stack.length - 1)],
        comment:
          line === 5
            ? `判断栈空：top = ${stack.length - 1}，不是 -1，可以出栈`
            : `栈顶元素是 data[${stack.length - 1}] = ${stack[stack.length - 1]}`,
      }
    }
    const top = stack[stack.length - 1]!
    yield {
      line: 7,
      action: 'mark',
      array: [...stack],
      boards: [board(stack, stack.length - 1, stack.length - 1)],
      comment: `取出栈顶元素 ${top}`,
      vars: { top: stack.length - 1 },
    }
    stack.pop()
    yield {
      line: 7,
      action: 'mark',
      array: [...stack],
      boards: [board(stack, stack.length - 1)],
      comment: `栈顶指针下移一格：top 变成 ${stack.length - 1}`,
      vars: { top: stack.length - 1 },
    }
    yield {
      line: 8,
      action: 'done',
      array: [...stack],
      boards: [board(stack, stack.length - 1)],
      comment: `出栈成功，取到 ${top}，栈里还剩 ${stack.length} 个元素`,
      vars: { top: stack.length - 1, n: stack.length },
    }
  }
  yield {
    line: 5,
    action: 'done',
    array: [],
    boards: [board([], -1)],
    comment: '所有元素都出栈了，top = -1。此时若再调用 pop，第 5 行会判空并 return 0 —— 这就是栈的"下溢"保护',
  }
}

export const stackSeqSpecs: AlgorithmSpec[] = [
  {
    id: 'stack-seq-push',
    name: '顺序栈进栈',
    category: 'stack',
    group: '顺序栈',
    summary: '栈顶指针上移，新元素放到新的栈顶',
    complexity: { time: 'O(1)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: CODE_PUSH,
    capacity: CAP,
    defaultData: () => [3, 7, 1, 9, 5],
    initScene: () => ({ boards: [board([], -1)] }),
    createRunner: runPush,
  },
  {
    id: 'stack-seq-pop',
    name: '顺序栈出栈',
    category: 'stack',
    group: '顺序栈',
    summary: '取出栈顶元素，栈顶指针下移',
    complexity: { time: 'O(1)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: CODE_POP,
    capacity: CAP,
    defaultData: () => [3, 7, 1, 9, 5],
    initScene: (data) => ({ boards: [board(data.slice(0, CAP), Math.min(data.length, CAP) - 1)] }),
    createRunner: runPop,
  },
]
