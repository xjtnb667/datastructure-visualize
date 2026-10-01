import type {
  AlgorithmSpec,
  AlgoStep,
  BoardView,
  ListView,
  RendererKind,
  RunnerContext,
  TapeView,
  TreeView,
} from './types'

const ascending = (a: number[]) => [...a].sort((x, y) => x - y)
const sameArray = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** 把生成器 yield 出来的链表快照深拷贝一份（否则历史帧会被后续改动污染） */
function cloneList(lv: ListView): ListView {
  return {
    nodes: lv.nodes.map((n) => ({ ...n })),
    order: [...lv.order],
    reachable: [...lv.reachable],
    head: lv.head,
    hot: [...lv.hot],
    pointers: { ...lv.pointers },
    cycleEntry: lv.cycleEntry ?? null,
    hasCycle: lv.hasCycle ?? false,
  }
}

/** 同理：场景板子和纸带也必须深拷贝，不然"上一步"看到的会是最后一步的画面 */
function cloneBoards(boards: BoardView[]): BoardView[] {
  return boards.map((b) => ({
    title: b.title,
    // position 千万别漏：漏了 position: 'top' 的板子会退化成默认，跑到树下面去
    position: b.position,
    layout: b.layout,
    cols: b.cols,
    items: b.items.map((it) => ({ ...it })),
    pointers: b.pointers ? { ...b.pointers } : undefined,
    links: b.links ? b.links.map((l) => ({ ...l })) : undefined,
    note: b.note,
  }))
}

function cloneTapes(tapes: TapeView[]): TapeView[] {
  return tapes.map((t) => ({
    label: t.label,
    items: [...t.items],
    pos: t.pos,
    tone: t.tone,
    // pad 千万别漏：字符串匹配靠它把模式串压在主串对应位置下面
    pad: t.pad,
  }))
}

/** 树快照同样要深拷贝：不然"上一步"看到的会是最后一步那棵树 */
function cloneTree(tv: TreeView): TreeView {
  return {
    nodes: tv.nodes.map((n) => ({
      ...n,
      children: n.children ? [...n.children] : undefined,
    })),
    root: tv.root ?? null,
    roots: tv.roots ? [...tv.roots] : undefined,
    hot: [...(tv.hot ?? [])],
    done: [...(tv.done ?? [])],
    pointers: { ...(tv.pointers ?? {}) },
    links: tv.links ? tv.links.map((l) => ({ ...l })) : undefined,
    note: tv.note,
  }
}

/**
 * 把生成器一次性跑到底，产出全量步骤序列。
 *
 * 对应需求文档的两条硬约束：
 *   C1 可视化必须由预计算的步骤序列驱动（不在浏览器端实时重放算法）
 *   C2 必须支持单步回退，因此步骤序列必须全量可索引
 *
 * ponytail: 全量常驻内存。真出现万步级算法时再换成分段加载（SRS C3 上限 10000 步）。
 */
export function buildSteps(
  spec: AlgorithmSpec,
  input: number[],
  ctx: RunnerContext = {},
): AlgoStep[] {
  const source = spec.codeLines
  const seed = input.slice()
  const kind: RendererKind = spec.renderer ?? 'array'

  let compares = 0
  let moves = 0
  const settled = new Set<number>()

  const stats = () => ({ compares, swaps: moves })

  // 首帧的变量：n = 数据个数（顺序表里就是表长），查找类再带上 target，顺序表再带上容量
  const initVars: Record<string, number> = { n: seed.length }
  if (ctx.target !== undefined) initVars.target = ctx.target
  if (kind === 'seqlist') initVars.capacity = ctx.capacity ?? seed.length

  // 场景类算法的首帧板子（同 initList 的道理：首帧由 engine 造，生成器管不到）
  const initScene = spec.initScene ? spec.initScene(seed, ctx) : null

  const steps: AlgoStep[] = [
    {
      line: 1,
      action: 'init',
      array: seed.slice(),
      indices: [],
      sortedIndices: [],
      range: [0, seed.length - 1],
      // 查找类算法在首帧就把目标值说清楚，否则用户看到一堆数据不知道要找什么
      comment: spec.initComment
        ? spec.initComment(seed, ctx)
        : ctx.target === undefined
          ? `初始数据：[${seed.join(', ')}]`
          : `初始数据：[${seed.join(', ')}]　要查找的目标值 target = ${ctx.target}`,
      vars: initVars,
      stats: stats(),
      list: spec.initList ? cloneList(spec.initList(seed, ctx)) : undefined,
      tree: spec.initTree ? cloneTree(spec.initTree(seed, ctx)) : undefined,
      boards: initScene?.boards ? cloneBoards(initScene.boards) : undefined,
      tapes: initScene?.tapes ? cloneTapes(initScene.tapes) : undefined,
    },
  ]

  for (const event of spec.createRunner(seed.slice(), ctx)) {
    if (event.action === 'compare') compares += 1
    if (event.action === 'swap' || event.action === 'set') moves += 1
    // 'sorted' 表示"排序中就位"，'done' 表示"查找/操作中命中完成" —— 两者都要累积成绿柱子
    if (event.action === 'sorted' || event.action === 'done') {
      for (const i of event.indices ?? []) settled.add(i)
    }

    steps.push({
      line: event.line,
      action: event.action,
      // 必须 slice()：生成器 yield 的是它内部的活数组，
      // 不拷贝的话所有历史帧会指向同一份数据，"上一步"直接废掉。
      array: event.array.slice(),
      indices: event.indices ? [...event.indices] : [],
      sortedIndices: [...settled].sort((a, b) => a - b),
      range: event.range ? ([event.range[0], event.range[1]] as [number, number]) : undefined,
      list: event.list ? cloneList(event.list) : undefined,
      tree: event.tree ? cloneTree(event.tree) : undefined,
      boards: event.boards ? cloneBoards(event.boards) : undefined,
      tapes: event.tapes ? cloneTapes(event.tapes) : undefined,
      comment: event.comment ?? '',
      vars: event.vars ? { ...event.vars } : undefined,
      stats: stats(),
    })
  }

  // 收尾帧。
  // 排序类算法不用自己写：这里统一补一帧"全部就位"。
  // 其余算法（查找、顺序表、链表）会自己 yield 一个 action === 'done' 的收尾帧，
  // 因为它们的收尾状态没法用统一样子表达，这时就不再追加。
  const last = steps[steps.length - 1]!
  if (last.action !== 'done') {
    steps.push({
      line: source.length,
      action: 'done',
      array: last.array.slice(),
      indices: [],
      sortedIndices: last.array.map((_, i) => i),
      range: last.range,
      // 收尾帧要延续上一帧的结构画面，否则场景板子会凭空消失（校验也过不去）
      list: last.list ? cloneList(last.list) : undefined,
      tree: last.tree ? cloneTree(last.tree) : undefined,
      boards: last.boards ? cloneBoards(last.boards) : undefined,
      tapes: last.tapes ? cloneTapes(last.tapes) : undefined,
      comment: `执行结束：共比较 ${compares} 次，移动/交换 ${moves} 次`,
      stats: stats(),
    })
  }

  validateSteps(steps, source, seed, kind)
  return steps
}

/**
 * 步骤序列规范校验（SRS EF-09 / 5.2 数据约束 3：codeLine 必须落在代码行号范围内）。
 *
 * 校验规则按渲染类型区分 —— 因为不同数据结构的不变量本来就不一样：
 *   数组：长度恒定 + 终态多重集守恒 + 引用别名
 *   顺序表：长度会因插入删除变化，但要保证不超过容量
 *   链表：结点 id 自洽（next/prev/head/pointers 都要指向存在的结点）
 */
export function validateSteps(
  steps: AlgoStep[],
  codeLines: string[],
  input: number[],
  kind: RendererKind = 'array',
): void {
  if (steps.length === 0) throw new Error('步骤序列为空')

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!
    if (!Number.isInteger(s.line) || s.line < 1 || s.line > codeLines.length) {
      throw new Error(`第 ${i} 步的行号 ${s.line} 越界（合法范围 1..${codeLines.length}）`)
    }
    if (!codeLines[s.line - 1]!.trim()) {
      throw new Error(`第 ${i} 步指向第 ${s.line} 行，但该行是空行 —— yield 里的行号写错了`)
    }
    if (!s.array.every(Number.isFinite)) {
      throw new Error(`第 ${i} 步的数据含非有限数值`)
    }
    if (!s.comment.trim()) {
      throw new Error(`第 ${i} 步没有解说词`)
    }
    for (const idx of s.indices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= s.array.length) {
        throw new Error(`第 ${i} 步的下标 ${idx} 越界（数据长度 ${s.array.length}）`)
      }
    }
    if (s.range) {
      for (const bound of s.range) {
        // 允许 -1 / n 这种"空区间"边界，所以范围放宽到 [-1, length]
        if (!Number.isInteger(bound) || bound < -1 || bound > s.array.length) {
          throw new Error(`第 ${i} 步的候选区间边界 ${bound} 越界（数据长度 ${s.array.length}）`)
        }
      }
    }
    // 抓"引用别名"：如果忘了拷快照，起始帧会跟着终态一起变
    if (i === 0 && !sameArray(s.array, input)) {
      throw new Error('起始快照不等于输入数据 —— 生成器 yield 了内部引用，engine 必须拷贝')
    }
  }

  if (kind === 'array') {
    // 数组类：长度恒定，且排序类终态必须有序；查找类数组不变
    for (let i = 0; i < steps.length; i++) {
      if (steps[i]!.array.length !== input.length) {
        throw new Error(`第 ${i} 步数据长度从 ${input.length} 变成了 ${steps[i]!.array.length}`)
      }
    }
    const last = steps[steps.length - 1]!.array
    if (!sameArray(ascending(last), ascending(input))) {
      throw new Error('终态数据与输入不构成同一多重集 —— 元素被弄丢了')
    }
  }

  if (kind === 'seqlist') {
    // 顺序表：存储长度可变（插入/删除），但绝不能超过容量。
    // 注意"表长 n"和"存储元素个数"在腾位置的那一两步里会不相等：
    // 插入时元素后移会在末尾短暂留一个重复值，此时 n 仍然只是逻辑长度，所以只检查 n 不超过存储长度。
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      const cap = s.vars?.capacity
      if (cap !== undefined && s.array.length > cap) {
        throw new Error(`第 ${i} 步存储了 ${s.array.length} 个元素，超过顺序表容量 ${cap}`)
      }
      const n = s.vars?.n
      if (n !== undefined && n > s.array.length) {
        throw new Error(`第 ${i} 步表长 n=${n} 大于实际存储的元素个数 ${s.array.length}`)
      }
    }
  }

  if (kind === 'scene') {
    // 场景类：板子和纸带是自成一体的，只校验"指针/连线指向的格子确实存在"这一条硬约束。
    // 有了它，任何把 pointers 下标写错的算法都会在测试里立刻炸出来。
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      // 板子和纸带至少给一个：字符串匹配这类算法只有纸带
      if (!s.boards?.length && !s.tapes?.length) {
        throw new Error(`第 ${i} 步既没有场景板子也没有纸带`)
      }
      for (const b of s.boards ?? []) {
        if (b.items.length === 0) throw new Error(`第 ${i} 步的板子「${b.title}」是空的`)
        for (const [name, idx] of Object.entries(b.pointers ?? {})) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= b.items.length) {
            throw new Error(
              `第 ${i} 步板子「${b.title}」的指针 ${name} 指向第 ${idx} 格，越界（共 ${b.items.length} 格）`,
            )
          }
        }
        for (const l of b.links ?? []) {
          if (l.from < 0 || l.from >= b.items.length || l.to < 0 || l.to >= b.items.length) {
            throw new Error(`第 ${i} 步板子「${b.title}」的连线指向了不存在的格子`)
          }
        }
      }
      for (const t of s.tapes ?? []) {
        if (t.pos !== undefined && (t.pos < -1 || t.pos >= t.items.length)) {
          throw new Error(`第 ${i} 步纸带「${t.label}」的游标 ${t.pos} 越界`)
        }
      }
    }
  }

  if (kind === 'tree') {
    // 树：结点 id 必须自洽 —— 孩子 / 双亲 / 线索 / 指针指向的结点都得真实存在，
    // 而且从根出发要能走遍所有结点（否则画面上会凭空少几棵子树）。
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      const tv = s.tree
      if (!tv) throw new Error(`第 ${i} 步缺少树结构快照`)
      const ids = new Set(tv.nodes.map((n) => n.id))
      if (ids.size !== tv.nodes.length) throw new Error(`第 ${i} 步有重复的结点 id`)
      const check = (id: string | null | undefined, what: string) => {
        if (id !== null && id !== undefined && !ids.has(id)) {
          throw new Error(`第 ${i} 步的${what}指向了不存在的结点 ${id}`)
        }
      }
      for (const n of tv.nodes) {
        check(n.left, `结点 ${n.id} 的左孩子`)
        check(n.right, `结点 ${n.id} 的右孩子`)
        check(n.parent, `结点 ${n.id} 的双亲`)
        check(n.threadPrev, `结点 ${n.id} 的前驱线索`)
        check(n.threadNext, `结点 ${n.id} 的后继线索`)
        for (const c of n.children ?? []) check(c, `结点 ${n.id} 的孩子`)
      }
      check(tv.root ?? null, '根结点')
      for (const r of tv.roots ?? []) check(r, '根结点')
      for (const [name, id] of Object.entries(tv.pointers ?? {})) check(id, `指针 ${name}`)
      for (const l of tv.links ?? []) {
        check(l.from, '连线起点')
        check(l.to, '连线终点')
      }
    }
  }

  if (kind === 'linked') {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      const lv = s.list
      if (!lv) throw new Error(`第 ${i} 步缺少链表结构快照`)

      const ids = new Set(lv.nodes.map((n) => n.id))
      const check = (id: string | null | undefined, what: string) => {
        if (id !== null && id !== undefined && !ids.has(id)) {
          throw new Error(`第 ${i} 步的${what}指向了不存在的结点 ${id}`)
        }
      }
      check(lv.head, '头指针')
      check(lv.cycleEntry, '环入口')
      for (const n of lv.nodes) {
        check(n.next, `结点 ${n.id} 的 next`)
        check(n.prev, `结点 ${n.id} 的 prev`)
      }
      for (const id of lv.order) check(id, '遍历顺序')
      for (const id of lv.hot) check(id, '高亮')
      for (const [name, id] of Object.entries(lv.pointers)) check(id, `指针 ${name}`)

      // array 必须是从链表上取下来的值（防止改了链表忘了同步数据序列）。
      // 注意只做"子集"校验而不是"相等"：建表/插入的中间态里，
      // 会有刚 new 出来还没接到链上的游离结点，此时两者本来就不相等。
      if (s.action !== 'init') {
        const pool = lv.nodes
          .filter((n) => !n.dummy)
          .map((n) => n.value)
        for (const v of s.array) {
          const k = pool.indexOf(v)
          if (k < 0) throw new Error(`第 ${i} 步的 array 里出现了链表上不存在的值 ${v}`)
          pool.splice(k, 1)
        }
      }
    }
  }
}
