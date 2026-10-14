import type { AlgorithmSpec, AlgoRunner, BoardView, TapeView } from '@/core/types'

/**
 * 串 · 模式匹配：BF 暴力匹配、next / nextval 数组、KMP 匹配。
 *
 * 约定：位置一律用**教材上的 1 基编号**（p[1] 是第一个字符，p[0] 空着不用）。
 * next / nextval 的定义本身就是 1 基的，这样代码、数组、画面上的下标能一一对上，
 * 讲解时照着念不会错位。
 *
 * 例子用的是严蔚敏教材里那个经典串：主串 ABABCABCACBAB，模式串 ABCAC，
 * 匹配成功的位置是 6；next = [0,1,1,1,2]，nextval = [0,1,1,0,2]（第 4 位被优化掉了）。
 */
const TEXT = 'ABABCABCACBAB'
const PATTERN = 'ABCAC'

/** 转成 1 基的字符数组：下标 0 空着不用 */
function chars(str: string): string[] {
  return ['', ...str.split('')]
}

/** 展示给用户看的模式串板子：每格下面标 1 基位置，i / j 两个指针 */
function patBoard(p: string[], m: number, hot: number[], i: number, j: number): BoardView {
  const pointers: Record<string, number> = {}
  if (i >= 1 && i <= m) pointers.i = i - 1
  if (j >= 1 && j <= m) pointers.j = j - 1
  return {
    title: `模式串 p（长度 ${m}）`,
    layout: 'row',
    items: p.slice(1).map((ch, k) => ({
      text: ch,
      sub: String(k + 1),
      tone: hot.includes(k + 1) ? 'hot' : 'base',
    })),
    pointers,
  }
}

/** next / nextval 数组板子：还没求出来的格子画成暗色空格 */
function arrBoard(
  title: string,
  arr: Array<number | null>,
  hot: number[],
  note?: string,
): BoardView {
  return {
    title,
    layout: 'row',
    items: arr.slice(1).map((v, k) => ({
      text: v === null ? '' : String(v),
      sub: String(k + 1),
      tone: hot.includes(k + 1) ? 'hot' : v === null ? 'dim' : 'done',
    })),
    note,
  }
}

/**
 * 主串 / 模式串两条纸带：模式串用 pad 缩进，正好压在本趟起点下面，
 * 看上去就是"模式串在主串上滑动"。
 */
function matchTapes(s: string[], p: string[], shift: number, i: number, j: number): TapeView[] {
  return [
    { label: `主串 s（第 ${i} 个字符）`, items: s.slice(1), pos: i - 1 },
    { label: `模式串 p（第 ${j} 个字符）`, items: p.slice(1), pos: j - 1, pad: shift },
  ]
}

/* ============================ BF 暴力匹配 ============================ */

const CODE_BF = [
  'int bfMatch(char s[], int n, char p[], int m) {',
  '  int i = 1, j = 1;                    // 都从 1 开始（串按 1 基编号）',
  '  while (i <= n && j <= m) {',
  '    if (s[i] == p[j]) { i++; j++; }    // 这个字符对上了，两个指针一起往前走',
  '    else { i = i - j + 2; j = 1; }     // 失配：主串退回本趟起点的下一个，模式串从头来',
  '  }',
  '  if (j > m) return i - m;             // 模式串整个走完 = 匹配成功',
  '  return -1;                           // 主串扫完还没匹配上',
  '}',
]

function* runBf(): AlgoRunner {
  const s = chars(TEXT)
  const p = chars(PATTERN)
  const n = TEXT.length
  const m = PATTERN.length
  const tapes = (i: number, j: number) => matchTapes(s, p, i - j, i, j)

  yield {
    line: 2,
    action: 'init',
    array: [],
    tapes: tapes(1, 1),
    comment: `主串 s = ${TEXT}（长度 ${n}），模式串 p = ${PATTERN}（长度 ${m}）。两个指针都从第 1 个字符开始比`,
    vars: { i: 1, j: 1 },
  }

  let i = 1
  let j = 1
  let shift = 1
  while (i <= n && j <= m) {
    if (j === 1) shift = i
    yield {
      line: 3,
      action: 'mark',
      array: [],
      tapes: tapes(i, j),
      comment: `第 ${shift} 趟：s[${i}] = ${s[i]} 和 p[${j}] = ${p[j]} 比一下`,
      vars: { i, j, 趟: shift },
    }
    if (s[i] === p[j]) {
      yield {
        line: 4,
        action: 'done',
        array: [],
        tapes: tapes(i, j),
        comment: `s[${i}] 和 p[${j}] 相等，两个指针都往后走一格`,
        vars: { i, j },
      }
      i += 1
      j += 1
    } else {
      yield {
        line: 5,
        action: 'compare',
        array: [],
        tapes: tapes(i, j),
        comment: `s[${i}] = ${s[i]} 和 p[${j}] = ${p[j]} 不相等 —— 本趟作废，主串退回到第 ${i - j + 2} 个字符，模式串从头再来`,
        vars: { i, j },
      }
      i = i - j + 2
      j = 1
    }
  }

  const ok = j > m
  yield {
    line: ok ? 7 : 8,
    action: ok ? 'done' : 'compare',
    array: [],
    tapes: ok ? matchTapes(s, p, i - m, Math.min(i, n), m) : tapes(i, j),
    comment: ok
      ? `模式串整个走完了 —— 匹配成功，起始位置是第 ${i - m} 个字符`
      : `主串已经扫到末尾还没匹配上，返回 -1`,
    vars: ok ? { 位置: i - m } : {},
  }
}

/* ============================ 求 next 数组 ============================ */

const CODE_NEXT = [
  'void getNext(char p[], int m, int next[]) {',
  '  int i = 1, j = 0;',
  '  next[1] = 0;                         // 第 1 个位置失配，只能从头再来',
  '  while (i < m) {',
  '    if (j == 0 || p[i] == p[j]) {      // j 退到头 或 前后缀这个字符也对得上',
  '      i++; j++; next[i] = j;           // 前后缀又长了一格',
  '    } else j = next[j];                // 对不上，j 退到它自己的 next 处再试',
  '  }',
  '}',
]

function* runNext(): AlgoRunner {
  const p = chars(PATTERN)
  const m = PATTERN.length
  const next: Array<number | null> = Array.from({ length: m + 1 }, () => null)
  next[1] = 0
  const boards = (hot: number[], i: number, j: number): BoardView[] => [
    patBoard(p, m, hot, i, j),
    arrBoard('next 数组（1 基）', next, hot, 'next[j] = p[1..j-1] 里最长的"既是前缀又是后缀"的长度'),
  ]

  yield {
    line: 3,
    action: 'init',
    array: [],
    boards: boards([1], 1, 0),
    comment: `模式串 p = ${PATTERN}。next[1] 固定是 0 —— 第 1 个字符就失配，只能从头再来`,
    vars: { i: 1, j: 0 },
  }

  let i = 1
  let j = 0
  while (i < m) {
    if (j === 0 || p[i] === p[j]) {
      yield {
        line: 5,
        action: 'mark',
        array: [],
        boards: boards([i, j].filter((k) => k >= 1), i, j),
        comment:
          j === 0
            ? `j 已经退到 0，没法再退，直接让 i、j 一起往前走`
            : `p[${i}] = ${p[i]} 和 p[${j}] = ${p[j]} 相等 —— 前后缀又对上一格`,
        vars: { i, j },
      }
      i += 1
      j += 1
      next[i] = j
      yield {
        line: 6,
        action: 'set',
        array: [],
        boards: boards([i], i, j),
        comment: `i、j 都加 1，于是 next[${i}] = ${j} —— 意思是 p[1..${i}] 里最长的相等前后缀长度是 ${j}`,
        vars: { i, j },
      }
    } else {
      yield {
        line: 7,
        action: 'compare',
        array: [],
        boards: boards([i, j], i, j),
        comment: `p[${i}] = ${p[i]} 和 p[${j}] = ${p[j]} 不相等 —— j 不能停在这，退到 next[${j}] = ${next[j] ?? 0} 再试`,
        vars: { i, j },
      }
      j = next[j] ?? 0
    }
  }

  yield {
    line: 8,
    action: 'done',
    array: [],
    boards: boards([], i, j),
    comment: `next 数组求完了：${next.slice(1).map((v) => v ?? 0).join(' ')}。它的含义是"这个位置失配时，模式串该从第几个字符重新比"`,
    vars: {},
  }
}

/* ============================ 求 nextval 数组 ============================ */

const CODE_NEXTVAL = [
  'void getNextVal(char p[], int m, int nextval[]) {',
  '  int i = 1, j = 0;',
  '  nextval[1] = 0;',
  '  while (i < m) {',
  '    if (j == 0 || p[i] == p[j]) {',
  '      i++; j++;',
  '      if (p[i] != p[j]) nextval[i] = j;      // 退回后的字符不一样，就按 next 来',
  '      else nextval[i] = nextval[j];          // 退回后还是同一个字符，索性再往前退一步',
  '    } else j = nextval[j];',
  '  }',
  '}',
]

function* runNextval(): AlgoRunner {
  const p = chars(PATTERN)
  const m = PATTERN.length
  const nv: Array<number | null> = Array.from({ length: m + 1 }, () => null)
  nv[1] = 0
  const boards = (hot: number[], i: number, j: number): BoardView[] => [
    patBoard(p, m, hot, i, j),
    arrBoard(
      'nextval 数组（1 基）',
      nv,
      hot,
      '和 next 的区别：退回后如果还是同一个字符，就再往前退一步，省掉一次注定失败的比较',
    ),
  ]

  yield {
    line: 3,
    action: 'init',
    array: [],
    boards: boards([1], 1, 0),
    comment: `还是模式串 ${PATTERN}。nextval[1] 一样固定是 0`,
    vars: { i: 1, j: 0 },
  }

  let i = 1
  let j = 0
  while (i < m) {
    if (j === 0 || p[i] === p[j]) {
      yield {
        line: 5,
        action: 'mark',
        array: [],
        boards: boards([i, j].filter((k) => k >= 1), i, j),
        comment:
          j === 0 ? 'j 退到 0 了，直接让 i、j 一起往前走' : `p[${i}] = ${p[i]} 和 p[${j}] = ${p[j]} 相等`,
        vars: { i, j },
      }
      i += 1
      j += 1
      const same = p[i] === p[j]
      nv[i] = same ? (nv[j] ?? 0) : j
      yield {
        line: same ? 8 : 7,
        action: 'set',
        array: [],
        boards: boards([i], i, j),
        comment: same
          ? `注意：退回之后 p[${i}] 和 p[${j}] 还是同一个字符 '${p[i]}'，比了也白比 —— 所以 nextval[${i}] 直接取 nextval[${j}] = ${nv[i]}，再往前退一步`
          : `p[${i}] = ${p[i]} 和 p[${j}] = ${p[j]} 不一样，退回后能比，所以 nextval[${i}] = ${j}`,
        vars: { i, j },
      }
    } else {
      yield {
        line: 9,
        action: 'compare',
        array: [],
        boards: boards([i, j], i, j),
        comment: `p[${i}] 和 p[${j}] 不相等 —— j 退到 nextval[${j}] = ${nv[j] ?? 0} 再试`,
        vars: { i, j },
      }
      j = nv[j] ?? 0
    }
  }

  yield {
    line: 10,
    action: 'done',
    array: [],
    boards: boards([], i, j),
    comment: `nextval 求完了：${nv.slice(1).map((v) => v ?? 0).join(' ')}。和 next 比，能省掉若干次"注定失败"的字符比较`,
    vars: {},
  }
}

/* ============================ KMP 匹配 ============================ */

const CODE_KMP = [
  'int kmpMatch(char s[], int n, char p[], int m, int next[]) {',
  '  int i = 1, j = 1;',
  '  while (i <= n && j <= m) {',
  '    if (j == 0 || s[i] == p[j]) { i++; j++; }   // 对上了，两个指针一起走',
  '    else j = next[j];                            // 失配：主串指针**不动**，模式串按 next 往前滑',
  '  }',
  '  if (j > m) return i - m;                       // 模式串走完 = 匹配成功',
  '  return -1;',
  '}',
]

function* runKmp(): AlgoRunner {
  const s = chars(TEXT)
  const p = chars(PATTERN)
  const n = TEXT.length
  const m = PATTERN.length
  // next 数组（1 基），用上面那个算法同样的办法先算好
  const next: number[] = Array.from({ length: m + 1 }, () => 0)
  for (let i = 1, j = 0; i < m; ) {
    if (j === 0 || p[i] === p[j]) next[++i] = ++j
    else j = next[j]!
  }
  const boards = (hot: number[], i: number, j: number): BoardView[] => [
    arrBoard('next 数组（1 基）', next, hot, `KMP 匹配时 j 就按这张表往后滑：next = [${next.slice(1).join(' ')}]`),
    patBoard(p, m, hot, i, j),
  ]
  const tapes = (i: number, j: number) => matchTapes(s, p, Math.max(0, i - j), i, j)

  yield {
    line: 2,
    action: 'init',
    array: [],
    tapes: tapes(1, 1),
    boards: boards([], 1, 1),
    comment: `主串 s = ${TEXT}，模式串 p = ${PATTERN}，已经先算好 next = [${next.slice(1).join(' ')}]。i、j 都从 1 开始`,
    vars: { i: 1, j: 1 },
  }

  let i = 1
  let j = 1
  while (i <= n && j <= m) {
    yield {
      line: 3,
      action: 'mark',
      array: [],
      tapes: tapes(i, j),
      boards: boards([j], i, j),
      comment: `s[${i}] = ${s[i]} 和 p[${j}] = ${p[j]} 比一下`,
      vars: { i, j },
    }
    if (j === 0 || s[i] === p[j]) {
      yield {
        line: 4,
        action: 'done',
        array: [],
        tapes: tapes(i, j),
        boards: boards([j], i, j),
        comment: `相等，i、j 都往后走一格`,
        vars: { i, j },
      }
      i += 1
      j += 1
    } else {
      yield {
        line: 5,
        action: 'compare',
        array: [],
        tapes: tapes(i, j),
        boards: boards([j], i, j),
        comment: `不相等：KMP 的关键就在这里 —— 主串指针 i 停在 ${i} 不动，只把 j 退到 next[${j}] = ${next[j]}，等于让模式串"滑"过去`,
        vars: { i, j },
      }
      j = next[j]!
    }
  }

  const ok = j > m
  yield {
    line: ok ? 7 : 8,
    action: ok ? 'done' : 'compare',
    array: [],
    tapes: ok ? matchTapes(s, p, i - m, Math.min(i, n), m) : tapes(i, j),
    boards: boards([], i, Math.min(j, m)),
    comment: ok
      ? `j 走过模式串末尾 —— 匹配成功，起始位置是第 ${i - m} 个字符。全程 i 一次都没有回退`
      : `主串扫完还没匹配上，返回 -1`,
    vars: ok ? { 位置: i - m } : {},
  }
}

export const stringMatchSpecs: AlgorithmSpec[] = [
  {
    id: 'bf-match',
    name: 'BF 暴力匹配',
    category: 'string',
    group: '模式匹配',
    summary: '主串指针一趟一趟地回溯，最坏 O(n×m)',
    complexity: { time: 'O(n×m)', space: 'O(1)' },
    renderer: 'scene',
    codeLines: CODE_BF,
    useFixedInput: true,
    defaultData: () => TEXT.split('').map((c) => c.charCodeAt(0)),
    initComment: () => `固定输入：主串 s = ${TEXT}，模式串 p = ${PATTERN}`,
    initScene: () => ({
      tapes: matchTapes(chars(TEXT), chars(PATTERN), 0, 1, 1),
    }),
    createRunner: runBf,
  },
  {
    id: 'kmp-next',
    name: '求 next 数组',
    category: 'string',
    group: 'KMP算法匹配',
    summary: 'next[j] = 前缀 p[1..j-1] 里最长的"既是前缀又是后缀"的长度',
    complexity: { time: 'O(m)', space: 'O(m)' },
    renderer: 'scene',
    codeLines: CODE_NEXT,
    useFixedInput: true,
    defaultData: () => PATTERN.split('').map((c) => c.charCodeAt(0)),
    initComment: () => `固定输入：模式串 p = ${PATTERN}，下面一位一位地求它的 next 数组`,
    initScene: () => ({
      boards: [
        patBoard(chars(PATTERN), PATTERN.length, [1], 1, 0),
        arrBoard(
          'next 数组（1 基）',
          Array.from({ length: PATTERN.length + 1 }, (_, k) => (k === 1 ? 0 : null)),
          [1],
          'next[j] = p[1..j-1] 里最长的"既是前缀又是后缀"的长度',
        ),
      ],
    }),
    createRunner: runNext,
  },
  {
    id: 'kmp-nextval',
    name: '求 nextval 数组',
    category: 'string',
    group: 'KMP算法匹配',
    summary: '在 next 基础上再优化：退回后还是同一个字符就索性再退一步',
    complexity: { time: 'O(m)', space: 'O(m)' },
    renderer: 'scene',
    codeLines: CODE_NEXTVAL,
    useFixedInput: true,
    defaultData: () => PATTERN.split('').map((c) => c.charCodeAt(0)),
    initComment: () => `固定输入：模式串 p = ${PATTERN}，求它的 nextval 数组`,
    initScene: () => ({
      boards: [
        patBoard(chars(PATTERN), PATTERN.length, [1], 1, 0),
        arrBoard(
          'nextval 数组（1 基）',
          Array.from({ length: PATTERN.length + 1 }, (_, k) => (k === 1 ? 0 : null)),
          [1],
          '和 next 的区别：退回后如果还是同一个字符，就再往前退一步',
        ),
      ],
    }),
    createRunner: runNextval,
  },
  {
    id: 'kmp-match',
    name: 'KMP 算法',
    category: 'string',
    group: 'KMP算法匹配',
    summary: '主串指针永不回退，失配时按 next 让模式串往前滑，O(n+m)',
    complexity: { time: 'O(n+m)', space: 'O(m)' },
    renderer: 'scene',
    codeLines: CODE_KMP,
    useFixedInput: true,
    defaultData: () => TEXT.split('').map((c) => c.charCodeAt(0)),
    initComment: () => `固定输入：主串 s = ${TEXT}，模式串 p = ${PATTERN}，next 数组已先算好`,
    initScene: () => ({
      tapes: matchTapes(chars(TEXT), chars(PATTERN), 0, 1, 1),
    }),
    createRunner: runKmp,
  },
]
