import type { AlgorithmSpec, AlgoRunner, BoardView, CellItem, CellTone, RunnerContext } from '@/core/types'

/**
 * 查找 · 进阶两种：分块查找（索引顺序查找）和哈希表查找。
 *
 *   search-block  renderer: 'array'  —— 数组本体画成柱子（顺序表），
 *                                      另外用 boards 画「索引表」和「块」的划分；
 *   search-hash   renderer: 'scene'  —— 哈希表不是线性序列，靠 boards 画桶。
 *
 * 两个算法都保证「目标值一定在数据里」，所以演示一定走到命中那一支。
 */

/* ==================================================================
 * 1. 分块查找（索引顺序查找）
 * ================================================================== */

const CODE_BLOCK = [
  '// 分块查找：数据分块，块内无序、块间有序（前一块最大值 < 后一块最小值）',
  'typedef struct { int max, start; } Index;   // 索引项：本块最大值 + 本块起始下标',
  'Index idx[b]; int blockNum;                 // 索引表（b = 块数）',
  'int blockSearch(int a[], int n, int target) {',
  '  int k = -1;',
  '  for (int i = 0; i < blockNum; i++)        // 第一步：在索引表里顺序查，',
  '    if (idx[i].max >= target) { k = i; break; }   // 找到"最大值 >= target"的那一块',
  '  if (k < 0) return -1;                     // 所有块的最大值都比 target 小 -> 整个表里没有',
  '  for (int j = idx[k].start; j < idx[k].start + blockLen; j++)   // 第二步：只在这一块里顺序查',
  '    if (a[j] == target) return j;           // 命中，返回真实下标',
  '  return -1;',
  '}',
  '// 索引表里最多比 b 次，块内最多比"块长"次 -> 平均查找长度介于顺序查找和折半查找之间',
]

/** 数据的总块数（同时也是块长：defaultData 正好 9 个 -> 3 块 × 3 个） */
const BLOCK_NUM = 3

/** 实际用的块长：n / BLOCK_NUM（n 必须是 BLOCK_NUM 的整数倍，sizes 只给 9 就是这个原因） */
function blockLenOf(n: number): number {
  return Math.max(1, Math.floor(n / BLOCK_NUM))
}

/** 块的最大值（原数据里块内是乱的，要自己扫出来） */
function blockMax(a: number[], i: number, len: number): number {
  return Math.max(...a.slice(i * len, Math.min((i + 1) * len, a.length)))
}

/**
 * 索引表板：每块一行四格 —— 块号 / 本块最大值 / 起始下标 / 本块数据范围。
 * hot = 当前正在看的那一块；stored = 已经建好索引的块；found = 索引表查出来的目标块。
 * len 必须和生成器里用的是同一个值，否则画面上的分块会和算法算的对不上。
 */
function indexBoard(
  a: number[],
  len: number,
  opts: { hot?: number[]; stored?: number[]; found?: number } = {},
): BoardView {
  const hot = new Set(opts.hot ?? [])
  const stored = new Set(opts.stored ?? [])
  // 块数必须和生成器算的完全一致：n / len 向下取整（最后不足一块的零头并进最后一块）
  const blocks = Math.max(1, Math.floor(a.length / len))
  const items: CellItem[] = []
  for (let i = 0; i < blocks; i++) {
    const tone: CellTone = hot.has(i) ? 'hot' : i === opts.found ? 'mark' : stored.has(i) ? 'done' : 'dim'
    items.push({ text: String(i), sub: '块号', tone })
    items.push({ text: String(blockMax(a, i, len)), sub: '最大值', tone })
    items.push({ text: String(i * len), sub: '起始', tone })
    items.push({
      text: a.slice(i * len, (i + 1) * len).join(' '),
      sub: `第${i}块`,
      tone,
    })
  }
  // 表头行：纯说明用
  items.push({ text: 'i', sub: '', tone: 'dim' })
  items.push({ text: 'idx[i].max', sub: '', tone: 'dim' })
  items.push({ text: 'idx[i].start', sub: '', tone: 'dim' })
  items.push({ text: '块内元素（无序）', sub: '', tone: 'dim' })
  return {
    title: `索引表 idx[0..${blocks - 1}]　共 ${blocks} 块 × 每块 ${len} 个`,
    layout: 'grid',
    cols: 4,
    items,
    note: '每块两件事：最大值 max、起始下标 start。块间有序：上一块 max < 下一块最小值',
  }
}

/** 目标一定取数据里真实存在的值 */
function pickBlockTarget(data: number[]): number {
  return data[Math.floor(Math.random() * data.length)]!
}

/**
 * 分块查找步骤生成器。
 *   line 2 / 3 -> 先建索引表（每块一个索引项）
 *   line 6     -> 在索引表里比较 idx[i].max 与 target（第一次比较）
 *   line 7     -> 找到"最大值 >= target"的块
 *   line 8     -> 所有块都比完了还没找到：整个表里没有
 *   line 9     -> 进到那一块里顺序比较（第二次比较）
 *   line 10    -> 命中
 *   line 11    -> 块里也没有
 *
 * 平均查找长度 ASL = 索引表里的比较次数 + 块内比较次数，
 * 索引表顺序查是 (b+1)/2，块内是 (s+1)/2，合起来介于顺序查找的 (n+1)/2 和折半查找的 log2(n+1)-1 之间。
 */
export function* blockSearch(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const n = a.length
  const target = ctx.target ?? a[0]!
  const len = blockLenOf(n)
  const blocks = Math.max(1, Math.ceil(n / len))
  const maxOf = (i: number) => Math.max(...a.slice(i * len, Math.min((i + 1) * len, n)))

  let indexCompares = 0
  let inBlockCompares = 0

  // 第 1 步：算出每块的最大值 —— 块内无序，所以只能一个块一个块地扫
  yield {
    line: 2,
    action: 'mark',
    array: a,
    indices: [0, len - 1],
    range: [0, n - 1],
    boards: [indexBoard(a, len)],
    vars: { n, target, blocks, blockLen: len },
    comment: `分块查找第一步是建索引表：数据切成 ${blocks} 块，每块 ${len} 个；索引项记两件事 —— 本块最大值 max 和本块起始下标 start`,
  }

  // 第 2 步：说清"块内无序、块间有序"为什么能把范围缩到一块
  yield {
    line: 3,
    action: 'mark',
    array: a,
    indices: [],
    range: [0, n - 1],
    boards: [indexBoard(a, len, { stored: Array.from({ length: blocks }, (_, i) => i) })],
    vars: { n, target, blocks, blockLen: len },
    comment: `要查的是 target = ${target}：因为块间有序（第 ${0} 块最大 ${maxOf(0)} < 第 ${1} 块最小），只要确定它在哪一块，另外那些块就不用看了`,
  }

  // 第 3 步：只看索引表也能说清哪块装哪些值，先不看原数组
  yield {
    line: 6,
    action: 'mark',
    array: a,
    indices: [],
    range: [0, n - 1],
    boards: [indexBoard(a, len, { stored: Array.from({ length: blocks }, (_, i) => i) })],
    vars: { n, target, blocks, blockLen: len },
    comment: `索引表里 ${blocks} 行就是 ${blocks} 块的全貌：块 0 是 a[0..${len - 1}]（最大 ${maxOf(0)}）、块 1 是 a[${len}..${2 * len - 1}]（最大 ${maxOf(1)}）…… 现在开始在索引表里找 target`,
  }

  // 第一步查找：索引表里的顺序（折半）比较
  let k = -1
  const scanned: number[] = []
  for (let i = 0; i < blocks; i++) {
    indexCompares += 1
    scanned.push(i)
    yield {
      line: 6,
      action: 'compare',
      array: a,
      indices: [],
      range: [i * len, Math.min((i + 1) * len, n) - 1],
      boards: [indexBoard(a, len, { hot: [i], stored: Array.from({ length: blocks }, (_, t) => t) })],
      vars: { n, target, i, 索引比较: indexCompares, 块内比较: inBlockCompares },
      comment: `索引表第 ${indexCompares} 次比较：idx[${i}].max = ${maxOf(i)} 与 target = ${target} 比 —— 这是第一次比较（在索引表里）`,
    }
    if (maxOf(i) >= target) {
      k = i
      break
    }
  }

  if (k < 0) {
    yield {
      line: 8,
      action: 'done',
      array: a,
      indices: [],
      range: [1, 0],
      boards: [indexBoard(a, len, { stored: scanned })],
      vars: { n, target, 索引比较: indexCompares, 块内比较: inBlockCompares, 总比较: indexCompares },
      comment: `查找失败：${blocks} 块的最大值全都小于 target = ${target}，它比整个表里最大的数还大，原数组一个字都不用看`,
    }
    return
  }

  const from = k * len
  const to = Math.min((k + 1) * len, n) - 1
  yield {
    line: 7,
    action: 'mark',
    array: a,
    indices: [],
    range: [from, to],
    boards: [indexBoard(a, len, { found: k, stored: scanned })],
    vars: { n, target, k, 索引比较: indexCompares, 块内比较: inBlockCompares },
    comment: `索引表查出结果：idx[${k}].max = ${maxOf(k)} >= ${target}，target 只可能落在第 ${k} 块，也就是 a[${from}..${to}] —— 索引表里一共比了 ${indexCompares} 次`,
  }

  // 第二步查找：在那一块里顺序查
  let hit = -1
  for (let j = from; j <= to; j++) {
    inBlockCompares += 1
    yield {
      line: 9,
      action: 'compare',
      array: a,
      indices: [j],
      range: [from, to],
      boards: [indexBoard(a, len, { found: k, stored: scanned })],
      vars: { n, target, j, 索引比较: indexCompares, 块内比较: inBlockCompares },
      comment: `进块内顺序查第 ${inBlockCompares} 次：a[${j}] = ${a[j]} 与 target = ${target} 比 —— 这是第二次比较（在块里）`,
    }
    if (a[j] === target) {
      hit = j
      break
    }
  }

  if (hit < 0) {
    yield {
      line: 11,
      action: 'done',
      array: a,
      indices: [],
      range: [from, to],
      boards: [indexBoard(a, len, { found: k, stored: scanned })],
      vars: {
        n,
        target,
        索引比较: indexCompares,
        块内比较: inBlockCompares,
        总比较: indexCompares + inBlockCompares,
      },
      comment: `查找失败：target = ${target} 落在第 ${k} 块的值域里，但这一块 ${len} 个元素全比过了都没有它，所以整个表里不存在`,
    }
    return
  }

  yield {
    line: 10,
    action: 'done',
    array: a,
    indices: [hit],
    range: [hit, hit],
    boards: [indexBoard(a, len, { found: k, stored: scanned })],
    vars: {
      n,
      target,
      索引比较: indexCompares,
      块内比较: inBlockCompares,
      总比较: indexCompares + inBlockCompares,
    },
    comment: `命中！target = ${target} 在下标 ${hit}（第 ${k} 块的第 ${hit - from + 1} 个）。一共只比了 ${indexCompares} + ${inBlockCompares} = ${indexCompares + inBlockCompares} 次：索引表 ${indexCompares} 次 + 块内 ${inBlockCompares} 次`,
  }
}

/** 分块查找的首帧：索引表一定先摆出来，否则第一帧看不到"块"的概念 */
function blockInitScene(data: number[]): { boards: BoardView[] } {
  return { boards: [indexBoard(data, blockLenOf(data.length))] }
}

/** 首帧解说词：把"平均查找长度介于两者之间"这件事在第一句就点出来 */
function blockInitComment(data: number[], ctx: RunnerContext): string {
  const n = data.length
  const target = ctx.target ?? data[0]!
  const len = blockLenOf(n)
  const blocks = Math.max(1, Math.ceil(n / len))
  const maxs = Array.from({ length: blocks }, (_, i) =>
    Math.max(...data.slice(i * len, Math.min((i + 1) * len, n))),
  )
  return `初始数据：[${data.join(', ')}]　要查找的目标值 target = ${target}　切成 ${blocks} 块、每块 ${len} 个，索引表为 [${maxs.join(', ')}]；块内无序、块间有序（前一块最大值 < 后一块最小值）。顺序查找平均要比 (n+1)/2 = ${((n + 1) / 2).toFixed(1)} 次，折半查找约 log2(n+1)-1 = ${(Math.log2(n + 1) - 1).toFixed(1)} 次，分块查找介于两者之间`
}

export const blockSearchSpec: AlgorithmSpec = {
  id: 'search-block',
  name: '分块查找',
  category: 'search',
  group: '线性表的查找',
  summary: '先查索引表定块，再在块内顺序查',
  complexity: { time: 'O(√n)（索引 (b+1)/2 + 块内 (s+1)/2）', space: 'O(b) 的索引表' },
  renderer: 'array',
  codeLines: CODE_BLOCK,
  // 只有 9 个（3 块 × 3 个）时演示才成立：块长和块数都比 1 大，索引表才看得出层次
  sizes: [9],
  defaultData: () => [22, 8, 26, 31, 40, 35, 52, 60, 48],
  defaultTarget: pickBlockTarget,
  initComment: blockInitComment,
  initScene: blockInitScene,
  createRunner: blockSearch,
}

/* ==================================================================
 * 2. 哈希表（除留余数法 + 链地址法）
 * ================================================================== */

/** 桶的个数。取小一点（7）才能让 8 个关键字撞出真实的冲突 */
const HASH_M = 7

const CODE_HASH = [
  '// 哈希表：除留余数法定桶号 + 链地址法解决冲突',
  'int hash(int key) { return key % M; }        // M = 7，桶号 = 关键字 % 7',
  'typedef struct Node { int key; struct Node *next; } Node;',
  'Node *ht[M];                                 // M 个桶，每个桶是一条单链表（拉链）',
  'void insert(int key) {                       // 插入：先算桶号，再看桶里有没有冲突',
  '  Node *p = ht[hash(key)];                   // p 顺着这条链走一遍',
  '  while (p != NULL) p = p->next;             // 走到链尾（拉链用尾插，链上顺序 = 插入顺序）',
  '  Node *s = new Node; s->key = key; s->next = NULL;    // 冲突了就挂到这条链后面',
  '  if (p == NULL) ht[hash(key)] = s; else last->next = s;',
  '  n++;                                       // 元素个数加一：装填因子 alpha = n / M',
  '}',
  'int find(int key) {',
  '  Node *p = ht[hash(key)];                   // 先算出桶号 hash(key)，再只在这个桶里找',
  '  while (p != NULL) { if (p->key == key) return p->key; p = p->next; }',
  '  return -1;                                 // 桶里没有 -> 这个 key 不在表里',
  '}',
  '// 平均时间是 O(1)（直接算桶号，不用一个个比），但桶里的链长了就会退化，所以要解决冲突',
]

/**
 * 哈希桶板：一个桶占 2 格 —— 上面一格是桶号，下面一格是桶里那条链。
 * 链上的值用 '-' 连起来，按插入顺序显示（这样"后来者接在后面"一眼可见）。
 * hot = 正在盯着看的桶；found = 桶里的这个值就是答案；collide = 这个桶上刚发生过冲突。
 */
function hashBoard(
  buckets: number[][],
  opts: { hot?: number; found?: number; collide?: number[]; note?: string } = {},
): BoardView {
  const collide = new Set(opts.collide ?? [])
  const items: CellItem[] = []
  for (let i = 0; i < HASH_M; i++) {
    const chain = buckets[i] ?? []
    const hasFound = chain.includes(opts.found ?? -1)
    const tone: CellTone =
      opts.hot === i ? 'hot' : hasFound ? 'done' : collide.has(i) ? 'mark' : 'base'
    items.push({ text: String(i), sub: '桶', tone })
    items.push({
      text: chain.length ? chain.join('-') : '',
      sub: chain.length ? `${chain.length} 个` : '空',
      tone: chain.length ? tone : 'dim',
    })
  }
  return {
    title: `哈希表 ht[0..${HASH_M - 1}]　除留余数法 key % ${HASH_M} + 链地址法，桶里挂单链表`,
    layout: 'grid',
    cols: HASH_M,
    items,
    note: opts.note ?? '每桶两格：上面是桶号，下面是桶里那条链（- 连接的顺序就是插入顺序）',
  }
}

/** 冲突过的桶号（mark 红格子用），由生成器边插边记 */
type HashState = { buckets: number[][]; collided: number[]; collisions: number; n: number }

/**
 * 关键字列表：桶数只有 7，8 个关键字必然撞桶 ——
 * 默认数据 [15, 8, 23, 4, 11, 29, 18, 7] 会分出 15/8/29 同一个桶、4/11/18 同一个桶，共 4 次冲突。
 */
function hashKeys(data: number[]): number[] {
  return data.slice(0, Math.max(1, Math.min(data.length, HASH_M + 1)))
}

/** 目标一定取哈希表里真实存着的关键字 */
function pickHashTarget(data: number[]): number {
  const keys = hashKeys(data)
  return keys[Math.floor(Math.random() * keys.length)]!
}

/** 哈希表首帧：7 个空桶先摆出来（不然第一帧是空白） */
function hashInitScene(data: number[]): { boards: BoardView[] } {
  const keys = hashKeys(data)
  return {
    boards: [
      hashBoard(
        Array.from({ length: HASH_M }, () => [] as number[]),
        { note: `${keys.length} 个关键字等着往里插，${HASH_M} 个桶现在是空的` },
      ),
    ],
  }
}

function hashInitComment(data: number[], ctx: RunnerContext): string {
  const keys = hashKeys(data)
  const target = ctx.target ?? keys[0]!
  return `初始数据：[${data.join(', ')}]　要把 ${keys.length} 个关键字 [${keys.join(', ')}] 依次插进 ${HASH_M} 个桶，散列函数是 key % ${HASH_M}，冲突用链地址法（同一个桶挂一条链）。装填因子 alpha = n / M = 0 / ${HASH_M} = 0.00；待会要查找的目标是 target = ${target}`
}

/**
 * 哈希表步骤生成器（除留余数法 + 链地址法）。
 *   line 2      -> 算桶号 hash(key) = key % M
 *   line 6      -> 顺着桶里那条链走，看有没有冲突
 *   line 8 / 9  -> 有冲突就挂到链后面（没冲突就直接占这个桶）
 *   line 10     -> 元素个数加一，装填因子变了
 *   line 13     -> 查找：先算桶号，再只在这个桶里找
 *   line 14     -> 顺着链比关键字：命中或继续往后
 *   line 15     -> 桶里没有，查找失败
 *
 * 散列查找的平均时间是 O(1)：桶号是算出来的，不用像顺序/折半查找那样一个个比。
 * 但前提是冲突处理得好 —— 桶里链一长，O(1) 就退化成 O(链长) 了。
 */
export function* hashSearch(data: number[], ctx: RunnerContext = {}): AlgoRunner {
  const keys = hashKeys(data)
  const n = keys.length
  const target = ctx.target ?? keys[0]!
  const state: HashState = { buckets: Array.from({ length: HASH_M }, () => [] as number[]), collided: [], collisions: 0, n: 0 }
  const board = (opts: { hot?: number; found?: number; note?: string } = {}) =>
    hashBoard(state.buckets, { ...opts, collide: state.collided })

  yield {
    line: 2,
    action: 'init',
    array: [...data],
    indices: [],
    boards: [board({ note: '空表：7 个桶都是空链，alpha = 0 / 7 = 0.00' })],
    vars: { n: 0, M: HASH_M, 冲突次数: 0, 装填因子: 0, target },
    comment: `哈希表开 ${HASH_M} 个桶，散列函数 h(key) = key % ${HASH_M}：桶号是算出来的，不是比出来的 —— 这就是它平均 O(1) 的原因。冲突用链地址法，落在同一个桶的关键字挂成一条单链表`,
  }

  /* ---------------- 依次插入 ---------------- */
  for (const key of keys) {
    const h = ((key % HASH_M) + HASH_M) % HASH_M
    const chain = state.buckets[h]!
    const occupied = chain.length > 0

    yield {
      line: 2,
      action: 'mark',
      array: [...data],
      indices: [],
      boards: [board({ hot: h, note: `关键字 ${key} -> 桶号 ${h} = ${key} % ${HASH_M}` })],
      vars: { key, h, n: state.n, M: HASH_M, 冲突次数: state.collisions, 装填因子: state.n / HASH_M },
      comment: `插入关键字 ${key}：先算 h(${key}) = ${key} % ${HASH_M} = ${h}，直接定位到第 ${h} 个桶 —— 一次比较都不用`,
    }

    yield {
      line: 6,
      action: occupied ? 'compare' : 'mark',
      array: [...data],
      indices: [],
      boards: [board({ hot: h, note: `桶 ${h} 里现有 [${chain.join(', ')}]` })],
      vars: { key, h, n: state.n, M: HASH_M, 冲突次数: state.collisions, 装填因子: state.n / HASH_M },
      comment: occupied
        ? `顺着第 ${h} 个桶的链走一遍：桶里已经有 [${chain.join(', ')}] —— 关键字 ${key} 和别人落到了同一个桶，这就是冲突！`
        : `第 ${h} 个桶是空链，没有冲突，关键字 ${key} 直接放进去`,
    }

    if (occupied) {
      state.collisions += 1
      state.collided.push(h)
    }
    chain.push(key)
    state.n += 1

    yield {
      line: occupied ? 8 : 9,
      action: 'set',
      array: [...data],
      indices: [],
      boards: [board({ hot: h, note: `桶 ${h} 现在是 [${chain.join(', ')}]（链地址法：同桶的挂成一条链）` })],
      vars: {
        key,
        h,
        n: state.n,
        M: HASH_M,
        冲突次数: state.collisions,
        装填因子: state.n / HASH_M,
      },
      comment: occupied
        ? `解决冲突：关键字 ${key} 接到第 ${h} 个桶那条链的后面，桶 ${h} 变成 [${chain.join(', ')}]。链地址法不用找别的空位，桶里挂几条都行`
        : `关键字 ${key} 占住第 ${h} 个桶，桶 ${h} 变成 [${chain.join(', ')}]`,
    }

    yield {
      line: 10,
      action: 'mark',
      array: [...data],
      indices: [],
      boards: [board({ hot: h, note: `已插入 ${state.n} / ${n} 个关键字（M = ${HASH_M} 不变，表容量永远是 ${HASH_M}）` })],
      vars: {
        key,
        h,
        n: state.n,
        M: HASH_M,
        冲突次数: state.collisions,
        装填因子: state.n / HASH_M,
      },
      comment: `元素个数 n 变成 ${state.n}，装填因子 alpha = n / M = ${state.n} / ${HASH_M} = ${(state.n / HASH_M).toFixed(2)}。装填因子越大，桶里的链越长，查找就越慢`,
    }
  }

  yield {
    line: 16,
    action: 'mark',
    array: [...data],
    indices: [],
    boards: [board({ note: `插入完毕：${n} 个关键字 / ${HASH_M} 个桶，alpha = ${(n / HASH_M).toFixed(2)}` })],
    vars: { n, M: HASH_M, 冲突次数: state.collisions, 装填因子: n / HASH_M, target },
    comment: `插入完毕：${n} 个关键字进了 ${HASH_M} 个桶，一共发生了 ${state.collisions} 次冲突（红色桶就是撞过的桶），装填因子 alpha = ${n} / ${HASH_M} = ${(n / HASH_M).toFixed(2)} > 1 —— 链地址法允许 alpha 超过 1，桶里挂长一点就行`,
  }

  /* ---------------- 查找一个关键字 ---------------- */
  const th = ((target % HASH_M) + HASH_M) % HASH_M
  const tchain = state.buckets[th]!

  yield {
    line: 13,
    action: 'mark',
    array: [...data],
    indices: [],
    boards: [board({ hot: th, note: `查找 ${target}：h(${target}) = ${target} % ${HASH_M} = ${th}` })],
    vars: { target, h: th, n, M: HASH_M, 冲突次数: state.collisions, 装填因子: n / HASH_M, 查找比较: 0 },
    comment: `开始查找 target = ${target}：先算桶号 h(${target}) = ${target} % ${HASH_M} = ${th}，只去第 ${th} 个桶里找 —— 别的 ${HASH_M - 1} 个桶连看都不用看`,
  }

  let probes = 0
  let found = false
  for (const v of tchain) {
    probes += 1
    yield {
      line: 14,
      action: 'compare',
      array: [...data],
      indices: [],
      boards: [board({ hot: th, note: `在第 ${th} 个桶的链 [${tchain.join(', ')}] 上找 ${target}` })],
      vars: {
        target,
        h: th,
        n,
        M: HASH_M,
        冲突次数: state.collisions,
        装填因子: n / HASH_M,
        查找比较: probes,
      },
      comment: `第 ${th} 个桶里第 ${probes} 次比较：链上的 ${v} 与 target = ${target} ${v === target ? '相等' : '不等，顺链往后走'} —— 桶里一共只有 ${tchain.length} 个，比顺序查找的 ${n} 个少多了`,
    }
    if (v === target) {
      found = true
      break
    }
  }

  if (found) {
    yield {
      line: 14,
      action: 'done',
      array: [...data],
      indices: [],
      boards: [board({ hot: th, found: target, note: `命中：${target} 在第 ${th} 个桶的链上` })],
      vars: {
        target,
        h: th,
        n,
        M: HASH_M,
        冲突次数: state.collisions,
        装填因子: n / HASH_M,
        查找比较: probes,
      },
      comment: `命中！target = ${target} 就在第 ${th} 个桶的链上，一共只比了 ${probes} 次：算桶号 1 次 + 桶内比较 ${probes} 次。散列查找的平均时间是 O(1)，正是因为它不用像顺序查找那样一个个扫`,
    }
    return
  }

  yield {
    line: 15,
    action: 'done',
    array: [...data],
    indices: [],
    boards: [board({ hot: th, note: `第 ${th} 个桶里没有 ${target}，查找失败` })],
    vars: {
      target,
      h: th,
      n,
      M: HASH_M,
      冲突次数: state.collisions,
      装填因子: n / HASH_M,
      查找比较: probes,
    },
    comment: `查找失败：第 ${th} 个桶的链上（[${tchain.join(', ')}]）没有 target = ${target}，走完整条链就能断定它不在表里 —— 别的桶不用查`,
  }
}

export const hashSearchSpec: AlgorithmSpec = {
  id: 'search-hash',
  name: '哈希表查找',
  category: 'search',
  group: '散列表',
  summary: '算桶号直接定位，冲突用链地址法挂在同一个桶上',
  complexity: { time: 'O(1) 平均（冲突多时 O(1 + α)）', space: 'O(n + M)' },
  renderer: 'scene',
  codeLines: CODE_HASH,
  // 桶数是 7：关键字个数只留 6~8 个，太多桶里的链会长到看不清
  sizes: [6, 7, 8],
  defaultData: () => [15, 8, 23, 4, 11, 29, 18, 7],
  defaultTarget: pickHashTarget,
  initComment: hashInitComment,
  initScene: hashInitScene,
  createRunner: hashSearch,
}

/*
 * 注册：分块查找属于「线性表的查找」（和顺序 / 折半查找连着写），
 * 哈希表单独一组「散列表」。顺序以 src/algorithms/index.ts 为准。
 */
