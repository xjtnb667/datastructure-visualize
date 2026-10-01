import type {
  AlgorithmSpec,
  AlgoRunner,
  BoardView,
  CellItem,
  TreeNodeSnapshot,
  TreeView,
} from '@/core/types'

/**
 * 排序大类的第二批算法：堆排序、基数排序，以及**外部排序**那四条
 * （多趟归并、败者树、置换-选择、最佳归并树）。
 *
 * 写法与 bubbleSort 保持一致的三条约定（engine 会逐帧校验，写错就抛错）：
 *   一个 yield = 一步；`line` 必须指向下面那份"给人看的 C++ 代码"的**非空**行；
 *   每帧都有中文 `comment`，`array` 交给 engine 拷贝成独立快照。
 *
 * 渲染器的分工：
 *   array —— 堆排序、基数排序（柱状图就是那条序列本身）；
 *   scene —— 多趟归并、置换-选择（"内存窗口 + 外存上的段"只能靠格子板表达）；
 *   tree  —— 败者树、最佳归并树（结构本身就是一棵树）。
 *
 * 注意：`renderer: 'scene'` / `'tree'` 的首帧是 engine 造的，所以必须写
 * initScene / initTree，否则第一帧是空画面；而且**每一帧**都要给 boards 或 tree。
 */

/* ============================================================================
 * 公共小工具：几块反复要用的格子板
 * ========================================================================== */

/**
 * 一段数值画成一行格子（下标写在小字里）。
 * 用于"外存上还没读入的记录""各段剩余的记录"这类一眼要看完的序列。
 */
function rowBoard(
  a: Array<number | string>,
  title: string,
  note: string,
  opts: { hot?: number[]; subFrom?: number; emptyText?: string } = {},
): BoardView {
  const hot = new Set(opts.hot ?? [])
  const items: CellItem[] = a.length
    ? a.map((v, i) => ({
        text: String(v),
        sub: String((opts.subFrom ?? 0) + i),
        tone: hot.has(i) ? ('hot' as const) : ('base' as const),
      }))
    : [{ text: opts.emptyText ?? '（空）', tone: 'dim' as const }]
  return { title, layout: 'row', items, note }
}

/**
 * 归并段列表：**一行一段**（grid 的第 c 列就是段内第 c 个记录），行首格子的小字写"第 i 段"。
 * 外部排序和置换-选择都用它画"外存上现在的段"。
 * toneOf 决定配色：多趟归并把写好的段都画绿，置换-选择里"当前正在写的段"画紫。
 */
function runsBoard(
  runs: number[][],
  title: string,
  note: string,
  toneOf: (run: number, col: number) => CellItem['tone'] = () => 'done',
  pointer?: { name: string; run: number; col: number },
): BoardView {
  if (!runs.length || runs.every((r) => r.length === 0)) {
    return { title, layout: 'row', items: [{ text: '（外存上还没有归并段）', tone: 'dim' }], note }
  }
  const cols = Math.max(1, ...runs.map((r) => r.length))
  const items: CellItem[] = []
  for (let r = 0; r < runs.length; r++) {
    for (let c = 0; c < cols; c++) {
      const v = runs[r]![c]
      items.push({
        text: v === undefined ? '' : String(v),
        sub: c === 0 ? `第${r}段` : '',
        tone: v === undefined ? 'dim' : toneOf(r, c),
      })
    }
  }
  const pointers: Record<string, number> = {}
  if (pointer) pointers[pointer.name] = pointer.run * cols + pointer.col
  return { title, layout: 'grid', cols, items, pointers, note }
}

/**
 * 内存缓冲区：**固定 k 个槽位**，空槽画成虚线格。
 * 置换-选择里冻结的记录画红（tone = mark），当前选中的最小记录画紫（tone = hot）。
 */
function memBoard(
  slots: Array<number | undefined>,
  title: string,
  note: string,
  opts: { frozen?: boolean[]; hot?: number } = {},
): BoardView {
  const items: CellItem[] = slots.map((v, i) => {
    if (v === undefined) return { text: '', sub: `槽${i}·空`, tone: 'dim' as const }
    if (opts.frozen?.[i]) return { text: String(v), sub: `槽${i}·冻结`, tone: 'mark' as const }
    return {
      text: String(v),
      sub: `槽${i}`,
      tone: i === opts.hot ? ('hot' as const) : ('base' as const),
    }
  })
  const pointers: Record<string, number> = {}
  if (opts.hot !== undefined && opts.hot >= 0 && opts.hot < slots.length) {
    pointers['最小'] = opts.hot
  }
  return { title, layout: 'row', items, pointers, note }
}

/* ============================================================================
 * 一、堆排序（renderer: 'array'，完整流程）
 * ========================================================================== */

const HEAP_SORT_CODE = `void heapSort(int a[], int n) {
  for (int i = n / 2 - 1; i >= 0; i--)      // ① 建堆：从最后一个非叶结点往前
    siftDown(a, n, i);                      // ② 每个结点都做一次向下调整
  for (int end = n - 1; end > 0; end--) {   // ③ 每轮把堆顶（最大值）换到堆尾
    swap(a[0], a[end]);                     // ④ 最大值就位，堆外多一个排好的
    siftDown(a, end, 0);                    // ⑤ 堆缩小到 a[0..end-1]，再调整堆顶
  }
}
void siftDown(int a[], int n, int i) {
  while (2 * i + 1 < n) {                   // ⑥ 还有孩子就继续往下
    int c = 2 * i + 1;                      // ⑦ 先假定较大的孩子是左孩子
    if (c + 1 < n && a[c + 1] > a[c]) c++;  // ⑧ 右孩子更大就换成右孩子
    if (a[i] >= a[c]) break;                // ⑨ 父 >= 较大的孩子，满足大根堆，停
    swap(a[i], a[c]);                       // ⑩ 换完继续往下看
    i = c;
  }
}`

export const HEAP_SORT_CODE_LINES = HEAP_SORT_CODE.split('\n')

/**
 * 向下调整（筛选）：只动以 i0 为根的子树，堆的有效范围是 [0, size-1]。
 * 行号对应的就是上面 siftDown 那一段（⑥~⑩）。
 */
function* heapSift(
  a: number[],
  size: number,
  i0: number,
  heapRange: [number, number],
): AlgoRunner {
  let i = i0
  while (2 * i + 1 < size) {
    const left = 2 * i + 1
    const right = 2 * i + 2
    const hasRight = right < size
    const big = hasRight && a[right]! > a[left]! ? right : left

    yield {
      line: 12,
      action: 'compare',
      array: a.slice(),
      indices: hasRight ? [i, left, right] : [i, left],
      range: heapRange,
      vars: { i, 堆大小: size, 较大的孩子: big },
      comment: hasRight
        ? `⑦⑧ a[${i}] = ${a[i]} 的左孩子 a[${left}] = ${a[left]}、右孩子 a[${right}] = ${a[right]}：两个孩子里较大的是 a[${big}] = ${a[big]}。向下调整只和**较大的**孩子比，和小的孩子无关`
        : `⑦ a[${i}] = ${a[i]} 只有左孩子 a[${left}] = ${a[left]}（2i+2 = ${right} 已经超出堆大小 ${size}），它就是"较大的孩子"`,
    }

    if (a[i]! >= a[big]!) {
      yield {
        line: 13,
        action: 'mark',
        array: a.slice(),
        indices: [i, big],
        range: heapRange,
        vars: { i, 堆大小: size, 较大的孩子: big },
        comment: `⑨ 父结点 a[${i}] = ${a[i]} >= 较大的孩子 a[${big}] = ${a[big]}，以 a[${i}] 为根的子树已经满足大根堆，这一支调整结束`,
      }
      return
    }

    const pv = a[i]!
    const cv = a[big]!
    const parent = i
    a[i] = cv
    a[big] = pv
    i = big
    yield {
      line: 14,
      action: 'swap',
      array: a.slice(),
      indices: [parent, big],
      range: heapRange,
      vars: { i: big, 堆大小: size, 换下来的: pv },
      comment: `⑩ 父结点 ${pv} < 较大的孩子 ${cv}，交换它们：a[${parent}] = ${cv}、被换下来的 ${pv} 落到 ${big}`,
    }
    yield {
      line: 15,
      action: 'set',
      array: a.slice(),
      indices: [big],
      range: heapRange,
      vars: { i: big, 堆大小: size },
      comment: `⑩ i = ${big}：${pv} 还可能比它自己的孩子小，所以继续从这个位置往下看`,
    }
  }
  yield {
    line: 10,
    action: 'mark',
    array: a.slice(),
    indices: [i],
    range: heapRange,
    vars: { i, 堆大小: size },
    comment: `⑥ a[${i}] 已经没有孩子（2i+1 = ${2 * i + 1} 不小于堆大小 ${size}），这一支调整到底了`,
  }
}

/**
 * 堆排序的完整流程：
 *   ① 自下而上建大根堆（从最后一个非叶结点往前逐个向下调整）；
 *   ② 反复"堆顶和堆尾交换 → 堆长度减一 → 对堆顶向下调整"，堆外那一段就是已排好的升序部分。
 * range 始终标着"当前堆的范围"，堆外的柱子会被画暗、画绿。
 */
export function* heapSortRun(data: number[]): AlgoRunner {
  const a = data.slice()
  const n = a.length
  if (n === 0) {
    yield {
      line: 1,
      action: 'init',
      array: [],
      range: [-1, -1],
      comment: '没有数据，堆排序无事可做',
      vars: { n: 0 },
    }
    return
  }
  const full: [number, number] = [0, n - 1]

  yield {
    line: 1,
    action: 'init',
    array: a.slice(),
    range: full,
    comment: `要排序的数据共 ${n} 个：[${a.join(', ')}]。堆排序分两大步：**先把它整理成大根堆**，再反复"堆顶和堆尾交换 → 堆缩小一格 → 重新调整堆顶"。堆就存在数组里：结点 i 的左孩子是 2i+1、右孩子是 2i+2`,
    vars: { n },
  }

  // ---------- 第一步：建大根堆 ----------
  for (let i0 = Math.floor(n / 2) - 1; i0 >= 0; i0--) {
    yield {
      line: 2,
      action: 'mark',
      array: a.slice(),
      indices: [i0],
      range: full,
      vars: { i: i0, n, 堆大小: n },
      comment: `① 建堆：从最后一个非叶结点 n/2-1 = ${i0} 往前。现在轮到 a[${i0}] = ${a[i0]}，以它为根的子树要做一次向下调整`,
    }
    yield* heapSift(a, n, i0, full)
  }
  yield {
    line: 3,
    action: 'mark',
    array: a.slice(),
    range: full,
    vars: { n, 堆顶: a[0]! },
    comment: `② 建堆完成：数组 [${a.join(', ')}] 现在是大根堆，每个结点都不小于它的两个孩子，a[0] = ${a[0]} 是整个数组的最大值`,
  }

  // ---------- 第二步：反复取堆顶，堆外的部分依次就位 ----------
  for (let end = n - 1; end > 0; end--) {
    const heapRange: [number, number] = [0, end - 1]
    const maxV = a[0]!
    const tailV = a[end]!
    a[0] = tailV
    a[end] = maxV

    yield {
      line: 5,
      action: 'swap',
      array: a.slice(),
      indices: [0, end],
      range: heapRange,
      vars: { end, 堆大小: end, 已就位: n - end },
      comment: `④ 当前堆是 a[0..${end}]，堆顶 a[0] = ${maxV} 是这 ${end + 1} 个元素里最大的，把它和堆尾 a[${end}] = ${tailV} 交换：${maxV} 落到它的最终位置 ${end}`,
    }
    yield {
      line: 4,
      action: 'sorted',
      array: a.slice(),
      indices: [end],
      range: heapRange,
      vars: { end, 堆大小: end, 已就位: n - end },
      comment: `③④ 交换完，a[${end}] = ${maxV} 就位了：堆外的 a[${end}..${n - 1}] 都是排好的（比堆里任何一个都大），接下来只看 a[0..${end - 1}]`,
    }
    yield {
      line: 6,
      action: 'mark',
      array: a.slice(),
      indices: [0],
      range: heapRange,
      vars: { end, 堆大小: end, i: 0 },
      comment: `⑤ 堆缩小一格：现在堆是 a[0..${end - 1}]，堆顶换成了刚被换过来的 ${tailV}，它可能比孩子小，所以要对堆顶做一次向下调整`,
    }
    yield* heapSift(a, end, 0, heapRange)
  }

  yield {
    line: 5,
    action: 'sorted',
    array: a.slice(),
    indices: [0],
    range: [0, 0],
    vars: { n },
    comment: `堆里只剩一个元素，不用再换。整条序列已经升序：[${a.join(', ')}]`,
  }
}

export const heapSortSpec: AlgorithmSpec = {
  id: 'sort-heap',
  name: '堆排序',
  category: 'sort',
  group: '选择类排序',
  summary: '先建成大根堆，再反复把堆顶换到堆尾并重新调整，整体 O(n log n)',
  complexity: { time: 'O(n log n)', space: 'O(1)', stable: false },
  renderer: 'array',
  codeLines: HEAP_SORT_CODE_LINES,
  defaultData: () => [4, 10, 3, 5, 1, 2, 9, 7, 8],
  createRunner: heapSortRun,
}

/* ============================================================================
 * 二、基数排序（renderer: 'array' + 10 个桶的板子）
 * ========================================================================== */

const RADIX_CODE = `void radixSort(int a[], int n) {
  for (int exp = 1; exp <= 最大数; exp = exp * 10) {   // ① 个位 -> 十位 -> 百位
    int cnt[10] = {0};                                 // ② 先把 10 个桶清空
    for (int i = 0; i < n; i++)                        // ③ 按第 exp 位把元素分到桶里
      bucket[(a[i] / exp) % 10][cnt[(a[i] / exp) % 10]++] = a[i];
    int k = 0;                                         // ④ 按 0~9 号桶的顺序收回来
    for (int d = 0; d < 10; d++)
      for (int j = 0; j < cnt[d]; j++)
        a[k++] = bucket[d][j];
  }
}`

export const RADIX_CODE_LINES = RADIX_CODE.split('\n')

const RADIX_PLACES = ['个位', '十位', '百位', '千位', '万位']

/**
 * 10 个桶画成一块 10 列的格子板：**第 d 列就是 d 号桶**，桶里的元素从上往下按放入顺序摞。
 * 第一行的小字写着桶号，空桶画成虚线格。
 */
function radixBucketBoard(
  buckets: number[][],
  opts: { title: string; note: string; hotBucket?: number; hotFrom?: number },
): BoardView {
  const rows = Math.max(1, ...buckets.map((b) => b.length))
  const items: CellItem[] = []
  for (let r = 0; r < rows; r++) {
    for (let d = 0; d < 10; d++) {
      const v = buckets[d]![r]
      const justIn = opts.hotBucket === d && r >= (opts.hotFrom ?? 0)
      items.push({
        text: v === undefined ? '' : String(v),
        sub: r === 0 ? `${d}号` : '',
        tone: v === undefined ? 'dim' : justIn ? 'hot' : 'base',
      })
    }
  }
  const pointers: Record<string, number> = {}
  if (opts.hotBucket !== undefined) pointers['当前桶'] = opts.hotBucket
  return { title: opts.title, layout: 'grid', cols: 10, items, pointers, note: opts.note }
}

/** 全部清空的 10 个桶 */
function emptyBuckets(): number[][] {
  return Array.from({ length: 10 }, () => [])
}

/**
 * 基数排序（LSD，低位优先）：每一轮只看一位 —— 先按这一位把元素**分到 10 个桶**里，
 * 再按 0 号桶到 9 号桶的顺序**依次收回**到数组里。位数从个位开始，逐轮往高位走，
 * 几轮之后数组自然有序（低位排好序是高位排序的前提）。
 *
 * 数据只有 1 位时只跑一轮；有 3 位就跑三轮（个位 → 十位 → 百位）。
 */
export function* radixSortRun(data: number[]): AlgoRunner {
  const a = data.slice()
  const n = a.length
  const maxv = n ? Math.max(0, ...a) : 0
  const digits = Math.max(1, String(maxv).length)

  yield {
    line: 1,
    action: 'init',
    array: a.slice(),
    comment: `要排序的数据共 ${n} 个：[${a.join(', ')}]。基数排序不看数值大小，而是**一位一位地排队**：LSD 从最低位（个位）开始，把元素分到 0~9 号桶里再依次收回来；每收一轮，这一位就有序了`,
    vars: { n, 轮数: digits, 基数: 10 },
    boards: [
      // 与 initScene 保持一致：第一帧也是"桶全空"
      rowBoard(a, '数组本身（每一轮结束都会被整体倒回）', '基数排序不改数值，只改元素的位置'),
      radixBucketBoard(emptyBuckets(), {
        title: '10 个桶（0 号 ~ 9 号）',
        note: '还没有开始分桶，10 个桶都是空的',
      }),
    ],
  }

  for (let d = 0; d < digits; d++) {
    const exp = 10 ** d
    const place = RADIX_PLACES[d] ?? `第 ${d + 1} 位`
    const buckets = emptyBuckets()

    yield {
      line: 3,
      action: 'mark',
      array: a.slice(),
      comment: `② 第 ${d + 1} 轮：这一轮只看**${place}**（位权 exp = ${exp}）。先把 10 个桶清空，再按 ${place} 把每个元素放进对应的桶`,
      vars: { n, 第几轮: d + 1, 位权: exp, 基数: 10 },
      boards: [
        radixBucketBoard(buckets, {
          title: `第 ${d + 1} 轮：10 个桶（准备按${place}分桶）`,
          note: `判断规则：(元素 / ${exp}) % 10 —— 算出来的数字是几，就进几号桶`,
        }),
      ],
    }

    // ---------- 分桶 ----------
    for (let i = 0; i < n; i++) {
      const v = a[i]!
      const digit = Math.abs(Math.floor(v / exp) % 10)
      buckets[digit]!.push(v)
      yield {
        line: 5,
        action: 'set',
        array: a.slice(),
        indices: [i],
        comment: `③ a[${i}] = ${v} 的${place}是 ${digit}（(${v} / ${exp}) % 10 = ${digit}），放进 ${digit} 号桶`,
        vars: { n, 第几轮: d + 1, 位权: exp, 元素下标: i, 桶号: digit },
        boards: [
          radixBucketBoard(buckets, {
            title: `第 ${d + 1} 轮：分桶（按${place}）`,
            note: `${digit} 号桶现在有 ${buckets[digit]!.length} 个元素：${buckets[digit]!.join(', ')}`,
            hotBucket: digit,
            hotFrom: buckets[digit]!.length - 1,
          }),
        ],
      }
    }

    // ---------- 收桶 ----------
    let writen = 0
    for (let dd = 0; dd < 10; dd++) {
      const b = buckets[dd]!
      if (!b.length) continue
      const from = writen
      for (const v of b) a[writen++] = v
      yield {
        line: 8,
        action: 'set',
        array: a.slice(),
        indices: Array.from({ length: b.length }, (_, t) => from + t),
        comment: `④ ${dd} 号桶里有 [${b.join(', ')}]，把它们按放入顺序倒回数组的 a[${from}..${writen - 1}]。桶内保持"先进先出"，所以这一位就有序了`,
        vars: { n, 第几轮: d + 1, 位权: exp, 桶号: dd, 已收回: writen },
        boards: [
          radixBucketBoard(buckets, {
            title: `第 ${d + 1} 轮：收桶（正在倒 ${dd} 号桶）`,
            note: '按 0 号桶 → 9 号桶的顺序倒回去；桶内先进先出，这一位就有序了',
            hotBucket: dd,
          }),
        ],
      }
    }
  }

  yield {
    line: 11,
    action: 'done',
    array: a.slice(),
    comment: `所有位都过了一遍，数组已经升序：[${a.join(', ')}]。基数排序每一位都要"分一遍、收一遍"，共 ${digits} 轮，所以时间约 O(d·(n + 10))，d 是最大数的位数`,
    vars: { n, 轮数: digits },
    boards: [
      rowBoard(a, '数组本身（每一轮结束都会被整体倒回）', `最终结果：[${a.join(', ')}]`),
      radixBucketBoard(emptyBuckets(), {
        title: '10 个桶（排序结束，桶都空了）',
        note: `每一轮都"分一遍、收一遍"，${digits} 轮之后整条序列有序`,
      }),
    ],
  }
}

export const radixSortSpec: AlgorithmSpec = {
  id: 'sort-radix',
  name: '基数排序',
  category: 'sort',
  group: '分配类排序',
  summary: 'LSD 低位优先：按个位、十位、百位逐位分到 10 个桶里再收回来',
  complexity: { time: 'O(d(n + 10))，d 是最大数的位数', space: 'O(n + 10)', stable: true },
  /*
   * 注意（重要）：按需求这里用 'array'（柱状图看"分桶 / 收桶"对序列的影响）。
   * 但 `renderer: 'array'` 时 App.vue 只挂 CanvasPanel，**boards 不会显示**；
   * 所以本文件同时也每帧都给 boards、并提供 initScene —— 只要把下面这一行改成
   * 'scene'，10 个桶立刻就能画出来，别的什么都不用改。
   */
  renderer: 'array',
  codeLines: RADIX_CODE_LINES,
  defaultData: () => [170, 45, 75, 90, 2, 24, 802, 66],
  initScene: (data) => {
    const a = data.slice()
    return {
      boards: [
        rowBoard(a, '初始数据', '基数排序不比较数值大小，只看每一位上的数字'),
        radixBucketBoard(emptyBuckets(), {
          title: '10 个桶（0 号 ~ 9 号）',
          note: '还没有开始分桶，10 个桶都是空的',
        }),
      ],
    }
  },
  createRunner: radixSortRun,
}

/* ============================================================================
 * 三、外部排序（多趟归并，renderer: 'scene'）
 * ========================================================================== */

const EXT_CODE = `void externalSort(Record file[], int n, int k) {
  int seg = 0;                                    // ① 初始归并段的段数
  for (int i = 0; i < n; i += k) {                // ② 一批一批地读进内存
    read(file, i, min(i + k, n));                 // ③ 读满内存缓冲区
    sortInMemory();                               // ④ 在内存里排好序
    writeRun(seg++, i);                           // ⑤ 写回外存，得到一个初始归并段
  }
  for (int len = k; len < n; len *= 2) {          // ⑥ 每趟把相邻两段归并成一段
    for (int i = 0; i < seg; i += 2) {            // ⑦ 两两成对
      readHead(i); readHead(i + 1);               // ⑧ 只把两段的段头读进内存
      mergeAndWrite(len * 2);                     // ⑨ 边比边写，段数减半
    }
    seg = (seg + 1) / 2;                          // ⑩ 段数减半（向上取整）
  }
}`

export const EXT_CODE_LINES = EXT_CODE.split('\n')

/** 内存一次能装下的记录数：2 个单元放两段的段头、1 个单元放归并输出 */
const EXT_MEM = 3

/** 两路归并（从两段有序序列并成一段有序序列），顺便记下比较次数 */
function mergeTwo(left: number[], right: number[]): { merged: number[]; cmps: number } {
  const merged: number[] = []
  let i = 0
  let j = 0
  let cmps = 0
  while (i < left.length && j < right.length) {
    cmps++
    if (left[i]! <= right[j]!) merged.push(left[i++]!)
    else merged.push(right[j++]!)
  }
  while (i < left.length) merged.push(left[i++]!)
  while (j < right.length) merged.push(right[j++]!)
  return { merged, cmps }
}

/**
 * 外部排序（多趟两路归并）。
 *
 * 为什么要分趟：整份文件**内存装不下**。设内存一次只能装 k 个记录，
 * 那么先把文件按 k 个一批读进来、在内存里排好序、再写回外存，就得到若干"初始归并段"（段内有序）；
 * 之后每一趟把相邻两段归并成一段（只把两段的段头读进内存），段数每趟减半，直到只剩一段。
 */
export function* externalSortRun(data: number[]): AlgoRunner {
  const file = data.slice()
  const n = file.length
  const k = Math.max(1, Math.min(EXT_MEM, n))
  const runs: number[][] = []
  const memory: Array<number | undefined> = new Array<number | undefined>(k).fill(undefined)
  let ptr = 0
  let pass = 1
  let len = k

  /** 外存上现在的文件内容：写好的归并段 + 还没读入的尾巴 */
  const fileNow = (): number[] => [...runs.flat(), ...file.slice(ptr)]
  const unread = (): number[] => file.slice(ptr)

  const memSlot = {
    title: `内存缓冲区（只有 k = ${k} 个单元）`,
    note: '内存装不下整份文件，所以一次只处理得了一小段：先装 k 个记录排好序写回去',
  }

  if (n === 0) {
    yield {
      line: 2,
      action: 'init',
      array: [],
      comment: '外存上没有记录，不需要排序',
      vars: { n: 0, k },
      boards: [
        memBoard(memory, memSlot.title, memSlot.note),
        rowBoard([], '外存：还没读入的记录', '外存是空的'),
        runsBoard(runs, '外存上的归并段（每行一段）', '还没有生成任何归并段'),
      ],
    }
    return
  }

  yield {
    line: 2,
    action: 'init',
    array: file.slice(),
    comment: `外存上有 ${n} 个记录：[${file.join(', ')}]。内存一次只能装 k = ${k} 个记录，装不下整份文件，所以要**分趟**：先把每 ${k} 个记录读进内存排好序写回去，得到 ${Math.ceil(n / k)} 个初始归并段；再一趟一趟地把相邻的段两两归并`,
    vars: { n, k, 初始段数: Math.ceil(n / k) },
    boards: [
      memBoard(memory, memSlot.title, memSlot.note),
      rowBoard(unread(), '外存：还没读入的记录', `一共 ${n} 个记录等着被一批一批读进内存`),
      runsBoard(runs, '外存上的归并段（每行一段）', '还没有生成任何归并段'),
    ],
  }

  // ---------- 第一步：一批一批过内存，生成初始归并段 ----------
  const batches = Math.ceil(n / k)
  for (let b = 0; b < batches; b++) {
    const start = b * k
    const block = file.slice(start, Math.min(start + k, n))
    for (let i = 0; i < k; i++) memory[i] = block[i]
    ptr = Math.min(start + k, n)

    yield {
      line: 4,
      action: 'set',
      array: fileNow(),
      comment: `③ 第 ${b + 1} 批：把外存上的 ${block.length} 个记录 [${block.join(', ')}] 读进内存缓冲区（内存就装得下这么多）`,
      vars: { n, k, 批次: b + 1, 已读入: ptr },
      boards: [
        memBoard(memory, memSlot.title, `刚从外存读入第 ${b + 1} 批：${block.join(', ')}`),
        rowBoard(unread(), '外存：还没读入的记录', `还剩 ${unread().length} 个记录没读过`),
        runsBoard(runs, '外存上的归并段（每行一段）', `已经有 ${runs.length} 个初始归并段`),
      ],
    }

    const sorted = block.slice().sort((x, y) => x - y)
    for (let i = 0; i < k; i++) memory[i] = sorted[i]
    runs.push(sorted)

    yield {
      line: 6,
      action: 'sorted',
      array: fileNow(),
      comment: `④⑤ 在内存里把这 ${block.length} 个记录排好序，写回外存：得到第 ${runs.length - 1} 个初始归并段 [${sorted.join(', ')}]（**归并段内部必须有序**，这是"归并"能进行的前提）`,
      vars: { n, k, 段数: runs.length, 本段长度: sorted.length },
      boards: [
        memBoard(memory, memSlot.title, `本批在内存里排好序：${sorted.join(', ')}`),
        rowBoard(unread(), '外存：还没读入的记录', `还剩 ${unread().length} 个记录没读过`),
        runsBoard(
          runs,
          '外存上的归并段（每行一段）',
          `第 ${runs.length - 1} 个归并段写好了，长度 ${sorted.length}（≤ k = ${k}）`,
        ),
      ],
    }
  }

  for (let i = 0; i < k; i++) memory[i] = undefined
  yield {
    line: 7,
    action: 'mark',
    array: fileNow(),
    comment: `① 整份文件过了一遍内存：外存上现在有 ${runs.length} 个初始归并段，每段内部有序、长度都不超过 k = ${k}。但 ${runs.length} 段还不算排好，要用"多趟归并"合成一段 —— 这就是**外部排序**：数据在内外存之间来回搬，时间主要花在读写上`,
    vars: { n, k, 段数: runs.length },
    boards: [
      memBoard(memory, memSlot.title, '内存已经被清空，等着装下一趟要归并的段头'),
      rowBoard(unread(), '外存：还没读入的记录', '全部读过了'),
      runsBoard(runs, '外存上的归并段（每行一段）', `${runs.length} 个初始归并段，每段内部有序`),
    ],
  }

  // ---------- 第二步：一趟一趟地两两归并 ----------
  while (runs.length > 1) {
    const before = runs.length
    yield {
      line: 8,
      action: 'mark',
      array: runs.flat(),
      comment: `⑥ 第 ${pass} 趟归并开始：外存上有 ${before} 个段（每段长度 ≤ ${len}）。内存只有 k = ${k} 个单元，装不下两整段，所以**只把两段的段头读进内存**，边比边往外写`,
      vars: { n, k, 趟: pass, 段数: before, 段长上限: len },
      boards: [
        memBoard(memory, memSlot.title, '这一趟要反复用内存装"两段的段头"'),
        runsBoard(runs, `第 ${pass} 趟：外存上的 ${before} 个段`, `两两成对，把相邻两段并成一段`),
      ],
    }

    const next: number[][] = []
    for (let i = 0; i < runs.length; i += 2) {
      const left = runs[i]!
      const right = runs[i + 1]
      if (!right) {
        next.push(left)
        continue
      }
      memory[0] = left[0]
      memory[1] = right[0]
      memory[2] = undefined
      yield {
        line: 10,
        action: 'compare',
        array: runs.flat(),
        comment: `⑧ 把第 ${i} 段和第 ${i + 1} 段的段头读进内存：${left[0]} 和 ${right[0]}。内存里 2 个单元放段头、1 个单元放归并输出，刚好够两路归并用`,
        vars: { n, k, 趟: pass, 左段: i, 右段: i + 1, 左段头: left[0]!, 右段头: right[0]! },
        boards: [
          memBoard(memory, memSlot.title, `内存里现在装着两段的段头：${left[0]} 和 ${right[0]}`),
          runsBoard(
            runs,
            `第 ${pass} 趟：正在归并第 ${i} 段和第 ${i + 1} 段`,
            `第 ${i} 段 [${left.join(', ')}]　第 ${i + 1} 段 [${right.join(', ')}]`,
            (r) => (r === i || r === i + 1 ? 'hot' : 'done'),
            { name: '读入', run: i, col: 0 },
          ),
        ],
      }

      const { merged, cmps } = mergeTwo(left, right)
      next.push(merged)
      yield {
        line: 11,
        action: 'set',
        array: runs.flat(),
        comment: `⑨ 两段边比边写：[${left.join(', ')}] 和 [${right.join(', ')}] 并成 [${merged.join(', ')}]，共 ${merged.length} 个记录，只比了 ${cmps} 次。归并一次就要把这段记录**读一遍、写一遍**`,
        vars: { n, k, 趟: pass, 归并后长度: merged.length, 比较次数: cmps },
        boards: [
          memBoard(memory, memSlot.title, `两段的段头一个一个小下去，写出的新段长度 ${merged.length}`),
          runsBoard(
            runs,
            `第 ${pass} 趟：第 ${i}、${i + 1} 段已并成一段`,
            `新段 [${merged.join(', ')}] 写在外存上，下一趟它就当成一段用`,
            (r) => (r === i || r === i + 1 ? 'hot' : 'done'),
          ),
        ],
      }
    }

    runs.length = 0
    runs.push(...next)
    len *= 2
    yield {
      line: 13,
      action: 'sorted',
      array: runs.flat(),
      comment: `⑩ 第 ${pass} 趟做完：段数从 ${before} 降到 ${runs.length}（每趟大约减半）${before % 2 === 1 ? '，最后那个落单的段没人配对，原样留到下一趟' : ''}，每段长度变成不超过 ${len}`,
      vars: { n, k, 趟: pass, 段数: runs.length, 段长上限: len },
      boards: [
        memBoard(memory, memSlot.title, '内存空着，等下一趟'),
        runsBoard(runs, `第 ${pass} 趟结束：外存上有 ${runs.length} 个段`, `每段长度不超过 ${len}`),
      ],
    }
    pass++
  }

  yield {
    line: 15,
    action: 'done',
    array: runs[0]!.slice(),
    comment: `归并结束：外存上只剩 1 个段，整份文件有序了：[${runs[0]!.join(', ')}]。一共 ${pass - 1} 趟归并（外加生成初始段那 1 遍），每趟都要把整份文件的记录读一遍写一遍 —— 这就是外部排序的代价，也正因如此才要**尽量把初始归并段做长、把趟数做少**`,
    vars: { n, k, 归并趟数: pass - 1 },
    boards: [
      memBoard(memory, memSlot.title, '内存已经用完了'),
      runsBoard(runs, '外存上只剩 1 个段（整份文件有序）', `最终结果：[${runs[0]!.join(', ')}]`),
    ],
  }
}

export const externalSortSpec: AlgorithmSpec = {
  id: 'sort-external',
  name: '外部排序（多趟归并）',
  category: 'sort',
  group: '外部排序',
  summary: '内存装不下就分趟：先做初始归并段，再每趟把相邻两段归并成一段',
  complexity: { time: 'O(n log₂m)，m 是初始归并段个数（还要乘上读写外存的代价）', space: 'O(k)，k 是内存能装的记录数' },
  renderer: 'scene',
  codeLines: EXT_CODE_LINES,
  defaultData: () => [5, 3, 8, 1, 7, 2, 9, 4, 11, 6, 12, 10],
  sizes: [12],
  initScene: (data) => {
    const k = Math.max(1, Math.min(EXT_MEM, data.length))
    return {
      boards: [
        memBoard(new Array<number | undefined>(k).fill(undefined), `内存缓冲区（只有 k = ${k} 个单元）`, '内存装不下整份文件，一次只处理得了一小段'),
        rowBoard(data.slice(), '外存：还没读入的记录', `一共 ${data.length} 个记录等着被一批一批读进内存`),
        runsBoard([], '外存上的归并段（每行一段）', '还没有生成任何归并段'),
      ],
    }
  },
  createRunner: externalSortRun,
}

/* ============================================================================
 * 四、多路平衡归并与败者树（renderer: 'tree'）
 * ========================================================================== */

const LOSER_CODE = `// k 路归并：用败者树从 k 个段头里挑最小的（这里 k = 4）
void loserTree(int k, int head[]) {
  for (int i = 0; i < k; i++)                  // ① 把 k 个段头当选手放进败者树
    adjust(i);                                 // ② 每个选手都从叶子往上比一次
  while (true) {
    int win = ls[0];                           // ③ 冠军就是当前最小的段头
    if (head[win] == INF) break;               // ④ k 个段都读空了，整个文件归并完
    output(head[win]);                         // ⑤ 输出冠军那一格的记录
    head[win] = next(win);                     // ⑥ 该段读入下一个记录，段头上移
    adjust(win);                               // ⑦ 只有冠军这条路要重赛 log k 次
  }
}
void adjust(int s) {                           // 把选手 s 从叶子一路调整到树根
  for (int p = (k + s) / 2; p > 0; p /= 2) {   // ⑧ 从 s 的双亲一路走到根
    if (head[s] > head[ls[p]]) {               // ⑨ 比不过这一层原来记着的选手
      int t = s; s = ls[p]; ls[p] = t;         // ⑩ 败者留在这一层，胜者继续往上
    }
  }
  ls[0] = s;                                   // ⑪ 一路赢到底的就是冠军
}`

export const LOSER_CODE_LINES = LOSER_CODE.split('\n')

/** 归并段个数（选手数）：k = 4 */
const LOSER_K = 4
/** 败者树的固定结构：4 个叶子 + 3 个内部结点（存败者）+ 1 个冠军结点（存胜者） */
const LS_CHAMP = 'C'
const LS_TOP = 'I1'
const LS_LEFT = 'I2'
const LS_RIGHT = 'I3'

interface LoserState {
  /** 每个内部结点里记着的**败者**段号；undefined = 这一层还没比过 */
  l2?: number
  l3?: number
  l1?: number
  /** 冠军（胜者）段号 */
  champ?: number
  /** 到这一层为止比较了几次 */
  cmps: number
}

/**
 * 用当前的段头值把树算一遍（从下往上）：
 * 每一层让两个"胜者"比一次，**败者留在这一层的内部结点里**，胜者继续往上，
 * 最后一路赢到底的那个就是冠军。
 * upto = 已经比到第几层（1 = 下层左边比完、2 = 下层都比完、3 = 树根也比完）。
 */
function loserState(heads: Array<number | undefined>, upto: number): LoserState {
  const st: LoserState = { cmps: 0 }
  const pick = (i: number, j: number): number => (heads[i]! <= heads[j]! ? i : j)
  let win2: number | undefined
  let win3: number | undefined
  if (upto >= 1) {
    win2 = pick(0, 1)
    st.l2 = win2 === 0 ? 1 : 0
    st.cmps = 1
  }
  if (upto >= 2) {
    win3 = pick(2, 3)
    st.l3 = win3 === 2 ? 3 : 2
    st.cmps = 2
  }
  if (upto >= 3 && win2 !== undefined && win3 !== undefined) {
    st.champ = pick(win2, win3)
    st.l1 = st.champ === win2 ? win3 : win2
    st.cmps = 3
  }
  return st
}

/** 段头值的显示形式：读空了的段用 ∞ 表示（它永远不会再赢） */
function headText(v: number | undefined): string {
  return v === undefined || v === Infinity ? '∞' : String(v)
}

/** 败者树的树形快照：叶子是各段的段头，内部结点存败者，树顶上面挂一个"冠军"结点 */
function loserView(
  heads: Array<number | undefined>,
  st: LoserState,
  opts: { hot?: string[]; done?: string[]; note: string },
): TreeView {
  const hv = (i: number): number | undefined => heads[i]
  const inner = (id: string, lose: number | undefined, kids: string[]): TreeNodeSnapshot => ({
    id,
    value: lose === undefined ? '—' : `第${lose}段`,
    sub: lose === undefined ? '还没比' : `败者 ${headText(hv(lose))}`,
    children: kids,
  })
  const leaf = (i: number): TreeNodeSnapshot => ({
    id: `L${i}`,
    value: headText(hv(i)),
    sub: `第${i}段`,
  })
  const nodes: TreeNodeSnapshot[] = [
    {
      id: LS_CHAMP,
      value: st.champ === undefined ? '—' : headText(hv(st.champ)),
      sub: st.champ === undefined ? '冠军未定' : `冠军 第${st.champ}段`,
      children: [LS_TOP],
    },
    inner(LS_TOP, st.l1, [LS_LEFT, LS_RIGHT]),
    inner(LS_LEFT, st.l2, ['L0', 'L1']),
    inner(LS_RIGHT, st.l3, ['L2', 'L3']),
    leaf(0),
    leaf(1),
    leaf(2),
    leaf(3),
  ]
  return {
    nodes,
    root: LS_CHAMP,
    hot: opts.hot ?? [],
    done: opts.done ?? [],
    note: opts.note,
  }
}

/**
 * 把数据均分成 k 段，每段内部排好序 —— 这就是 k 路归并的 k 个初始归并段。
 * 段长尽量平均（12 个记录、4 段就是每段 3 个）。
 */
function splitSorted(data: number[], k: number): number[][] {
  const n = data.length
  const parts: number[][] = []
  let start = 0
  for (let i = 0; i < k; i++) {
    const end = i === k - 1 ? n : Math.min(n, start + Math.ceil((n - start) / (k - i)))
    parts.push(data.slice(start, end).sort((x, y) => x - y))
    start = end
  }
  return parts
}

/**
 * 多路平衡归并与败者树。
 *
 * 问题：k 路归并时，"从 k 个段头里挑最小的"如果每次都从头扫一遍，要比较 k-1 次；
 * 每输出一个记录就要选一次，代价就上去了。
 * 败者树的做法：把 k 个段头做成 k 个叶子，每个内部结点记下**这一层的败者**，
 * 胜者继续往上比，冠军存在树顶。于是**只有冠军那一条路上的 log k 层需要重赛**。
 * k = 4 时：直接扫一遍要 3 次比较，败者树每次只要 2 次（= log₂4）。
 */
export function* loserTreeRun(data: number[]): AlgoRunner {
  const n = data.length
  const k = Math.max(1, Math.min(LOSER_K, n))
  const segs = splitSorted(data, k)
  const ptr = segs.map(() => 0)
  const output: number[] = []

  const heads = (): Array<number | undefined> =>
    segs.map((s, i) => (ptr[i]! < s.length ? s[ptr[i]!] : Infinity))
  /** 各段"剩下的记录"（段头在最左边） */
  const remainingBoards = (win: number, headHot: boolean): BoardView[] => {
    const rows = segs.map((s, i) => s.slice(ptr[i]!))
    const cols = Math.max(1, ...rows.map((r) => r.length))
    const items: CellItem[] = []
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols; c++) {
        const v = rows[r]![c]
        items.push({
          text: v === undefined ? '' : String(v),
          sub: c === 0 ? `第${r}段` : '',
          tone: v === undefined ? 'dim' : c === 0 && headHot && r === win ? 'hot' : 'base',
        })
      }
    }
    const pointers: Record<string, number> = headHot ? { 冠军段头: win * cols } : {}
    return [
      {
        title: `内存里只有 ${k} 个段头（真正的记录还在外存上）`,
        layout: 'row',
        items: heads().map((v, i) => ({
          text: headText(v),
          sub: `第${i}段`,
          tone: i === win && v !== Infinity ? ('hot' as const) : v === Infinity ? ('dim' as const) : ('base' as const),
        })),
        pointers: headText(heads()[win]) === '∞' ? {} : { 冠军: win },
        note: '败者树里存的就是这 k 个值，树不变、值在变',
      },
      {
        title: `各段剩下的记录（每行一段，最左边是段头）`,
        layout: 'grid',
        cols,
        items,
        pointers,
        note: '输出一个记录之后，只有冠军那一段的段头往后移一格',
      },
    ]
  }

  const h0 = heads()
  yield {
    line: 2,
    action: 'init',
    array: output.slice(),
    tree: loserView(h0, loserState(h0, 0), {
      note: `${n} 个记录被分成 ${k} 个归并段（段内有序），内存里只放 ${k} 个段头。败者树还没开始比`,
    }),
    boards: remainingBoards(0, false),
    comment: `外存上有 ${k} 个初始归并段：${segs.map((s, i) => `第${i}段[${s.join(', ')}]`).join('　')}。要做的 k 路归并就是：反复从 ${k} 个段头里挑最小的输出。下面用**败者树**来做这件事`,
    vars: { n, k, 段头比较次数上限: k - 1, 败者树每次: Math.log2(k) },
  }

  // ---------- 建树：4 个段头当选手，从下往上比出来 ----------
  yield {
    line: 3,
    action: 'mark',
    array: output.slice(),
    tree: loserView(h0, loserState(h0, 0), {
      note: `① 把 ${k} 个段头放到败者树的 ${k} 个叶子上：${h0.map((v, i) => `第${i}段 ${headText(v)}`).join('、')}`,
    }),
    boards: remainingBoards(0, false),
    comment: `① 先把 ${k} 个段头当成 ${k} 个选手放到败者树的叶子上：${h0.map((v, i) => `第${i}段的段头 ${headText(v)}`).join('、')}。接着让他们两两比赛，**败者留在这一层的内部结点里**，胜者往上走`,
    vars: { n, k },
  }

  for (let upto = 1; upto <= 3; upto++) {
    const st = loserState(h0, upto)
    const atLeft = upto === 1
    const atRight = upto === 2
    const loser = atLeft ? st.l2! : atRight ? st.l3! : st.l1!
    const nodeName = atLeft ? '下面左边那个内部结点' : atRight ? '下面右边那个内部结点' : '树顶那个内部结点'
    const pair = atLeft
      ? `第0段 ${headText(h0[0])} 和 第1段 ${headText(h0[1])}`
      : atRight
        ? `第2段 ${headText(h0[2])} 和 第3段 ${headText(h0[3])}`
        : `左边那层的胜者和右边那层的胜者`
    const win = atLeft
      ? (st.l2 === 0 ? 1 : 0)
      : atRight
        ? (st.l3 === 2 ? 3 : 2)
        : st.champ!
    yield {
      line: 15,
      action: 'compare',
      array: output.slice(),
      tree: loserView(h0, st, {
        hot: [atLeft ? LS_LEFT : atRight ? LS_RIGHT : LS_TOP, `L${loser}`, `L${win}`],
        note: `${pair} 比一次：第${loser}段输了，留在${nodeName}里；第${win}段继续往上`,
      }),
      boards: remainingBoards(win, true),
      comment: `② ${pair} 比一次：小的那个（第${win}段 ${headText(h0[win])}）继续往上，大的那个（第${loser}段 ${headText(h0[loser])}）就被**记在${nodeName}里**，它就是这个结点的"败者"`,
      vars: { k, 比较次数: st.cmps },
    }
  }

  const built = loserState(heads(), 3)
  yield {
    line: 16,
    action: 'mark',
    array: output.slice(),
    tree: loserView(heads(), built, {
      hot: [LS_CHAMP, `L${built.champ!}`],
      note: `树建好了：树顶那个结点记着冠军 —— 第${built.champ}段，段头 ${headText(heads()[built.champ!])}`,
    }),
    boards: remainingBoards(built.champ!, true),
    comment: `③ 树建好了，冠军是第${built.champ}段的段头 ${headText(heads()[built.champ!])}（最小的那个）。建树一共比了 ${built.cmps} 次 —— 和直接扫一遍 ${k} 个段头一样是 ${k - 1} 次。**真正的便宜在后面**：每输出一个记录，只有冠军这一条路要重赛，只要 log₂${k} = ${Math.log2(k)} 次`,
    vars: { k, 建树比较次数: built.cmps, 直接扫描: k - 1 },
  }

  // ---------- 归并：反复"输出冠军 -> 段头上移 -> 沿路重赛" ----------
  let round = 0
  for (;;) {
    const hs = heads()
    const st = loserState(hs, 3)
    const win = st.champ!
    if (hs[win] === Infinity) break

    const v = hs[win]!
    output.push(v)
    round++
    yield {
      line: 8,
      action: 'set',
      array: output.slice(),
      tree: loserView(hs, st, {
        hot: [LS_CHAMP, `L${win}`],
        note: `⑤ 输出冠军：第${win}段的段头 ${v}（它是 ${k} 个段头里最小的），写进归并结果`,
      }),
      boards: remainingBoards(win, true),
      comment: `⑤ 输出冠军：第${win}段的段头 ${v} 是当前 ${k} 个段头里最小的，把它写到归并结果里（已输出 ${round} 个：${output.join(', ')}）`,
      vars: { k, 已输出: round, 冠军段: win, 值: v },
    }

    ptr[win]!++
    const nh = heads()
    const nst = loserState(nh, 3)
    const pathCmps = nst.cmps
    const nextWin = nst.champ!
    yield {
      line: 10,
      action: 'compare',
      array: output.slice(),
      tree: loserView(nh, nst, {
        hot: [LS_TOP, LS_LEFT, LS_RIGHT, LS_CHAMP, `L${win}`],
        done: segs.map((_, i) => i).filter((i) => ptr[i]! >= segs[i]!.length).map((i) => `L${i}`),
        note: `第${win}段的段头换成 ${headText(nh[win])}，沿着它到树顶这条路重赛 ${pathCmps} 次，新冠军是第${nextWin}段的 ${headText(nh[nextWin])}`,
      }),
      boards: remainingBoards(nextWin, true),
      comment: `⑥⑦ 第${win}段读入下一个记录，段头变成 ${headText(nh[win])}；只需沿"叶子 → 树顶"这条**路**重赛 ${pathCmps} 次，就得到新冠军：第${nextWin}段的 ${headText(nh[nextWin])}。若每输出一个记录都从头扫一遍 ${k} 个段头，要 ${k - 1} 次 —— 这正是败者树把比较次数从 k-1 降到 log k 的地方`,
      vars: { k, 已输出: round, 本次重赛: pathCmps, 直接扫描: k - 1 },
    }
  }

  const final = heads()
  const finalSt = loserState(final, 3)
  yield {
    line: 12,
    action: 'done',
    array: output.slice(),
    tree: loserView(final, finalSt, {
      done: segs.map((_, i) => `L${i}`),
      note: `${k} 个段都读空了（段头都是 ∞），归并结束`,
    }),
    boards: remainingBoards(0, false),
    comment: `${k} 个段的段头都变成了 ∞，说明外存上的记录全输出完了。归并结果：[${output.join(', ')}]，共 ${output.length} 个记录。败者树一共比较了约 ${(k - 1) + output.length * Math.log2(k)} 次；如果每输出一个记录都从头扫一遍 ${k} 个段头，光输出这一阶段就要 ${output.length} × ${k - 1} = ${output.length * (k - 1)} 次`,
    vars: {
      n,
      k,
      输出记录数: output.length,
      败者树比较次数: (k - 1) + output.length * Math.log2(k),
      直接比较次数: output.length * (k - 1),
    },
  }
}

export const loserTreeSpec: AlgorithmSpec = {
  id: 'sort-loser-tree',
  name: '多路平衡归并与败者树',
  category: 'sort',
  group: '外部排序',
  summary: '内部结点记败者、树顶记冠军，每输出一个记录只重赛 log k 次',
  complexity: { time: 'O(n log₂k)，k 是归并路数', space: 'O(k)' },
  renderer: 'tree',
  codeLines: LOSER_CODE_LINES,
  defaultData: () => [3, 9, 14, 5, 8, 20, 1, 12, 13, 7, 10, 15],
  sizes: [12],
  initTree: (data) => {
    const k = Math.max(1, Math.min(LOSER_K, data.length))
    const segs = splitSorted(data, k)
    const heads = segs.map((s) => (s.length ? s[0] : Infinity))
    return loserView(heads, loserState(heads, 0), {
      note: `${k} 个归并段，败者树还没开始比（内部结点里是"—"）`,
    })
  },
  initScene: (data) => {
    const k = Math.max(1, Math.min(LOSER_K, data.length))
    const segs = splitSorted(data, k)
    const rows = segs.map((s) => s.slice())
    const cols = Math.max(1, ...rows.map((r) => r.length))
    const items: CellItem[] = []
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols; c++) {
        const v = rows[r]![c]
        items.push({
          text: v === undefined ? '' : String(v),
          sub: c === 0 ? `第${r}段` : '',
          tone: v === undefined ? 'dim' : 'base',
        })
      }
    }
    return {
      boards: [
        {
          title: `内存里只有 ${k} 个段头（真正的记录还在外存上）`,
          layout: 'row',
          items: segs.map((s, i) => ({ text: String(s[0] ?? '∞'), sub: `第${i}段`, tone: 'base' as const })),
          note: '败者树里存的就是这 k 个值，树不变、值在变',
        },
        {
          title: '各段剩下的记录（每行一段，最左边是段头）',
          layout: 'grid',
          cols,
          items,
          note: '输出一个记录之后，只有冠军那一段的段头往后移一格',
        },
      ],
    }
  },
  createRunner: loserTreeRun,
}

/* ============================================================================
 * 五、置换-选择排序（生成初始归并段，renderer: 'scene'）
 * ========================================================================== */

const REPLACE_CODE = `// 置换-选择排序：用一个很小的内存窗口，生成尽量长的初始归并段
void replaceSelect(int n, int k) {                 // k = 内存窗口能装的记录数
  for (int i = 0; i < k; i++) w[i] = readNext();   // ① 先把窗口读满
  int seg = 1;
  while (还有记录没输出) {
    int m = 窗口里 >= lastOut 的最小记录;            // ② 只能在"不小于上次输出"的记录里挑
    if (m == NONE) {                                // ③ 窗口里剩下的记录全被冻住了
      seg++;                                        // ④ 当前段到此结束，开下一段
      lastOut = -INF;                               // ⑤ 解冻：冻结的记录都参加新段
    } else {
      output(w[m]);                                 // ⑥ 输出它，追加到当前归并段
      lastOut = w[m];
      w[m] = readNext();                            // ⑦ 从外存补一个记录进窗口
      if (w[m] < lastOut) frozen[m] = true;         // ⑧ 补进来的更小 -> 冻结到下一段
    }
  }
}`

export const REPLACE_CODE_LINES = REPLACE_CODE.split('\n')

/** 内存窗口能装的记录数 */
const REPLACE_K = 3

/**
 * 置换-选择排序：**生成初始归并段**的办法。
 *
 * 内存里只有 k 个记录的工作窗口。每一步选出窗口里"不小于上次输出值"的最小记录输出，
 * 再从外存补一个记录进来；如果补进来的比刚输出的小，就把它**冻结**（这一轮不再参选，
 * 留到下一段）。等到窗口里的记录全被冻住，当前段就结束，解冻后开始新的一段。
 *
 * 好处：段内自然有序，而且段比"每 k 个排一段"要长得多 —— 段越长，后面归并的趟数越少。
 */
export function* replaceSelectRun(data: number[]): AlgoRunner {
  const file = data.slice()
  const n = file.length
  const k = Math.max(1, Math.min(REPLACE_K, n))
  const memory: Array<number | undefined> = new Array<number | undefined>(k).fill(undefined)
  const frozen = new Array<boolean>(k).fill(false)
  const runs: number[][] = [[]]
  let ptr = 0
  let lastOut = -Infinity
  let outCount = 0

  const windowTitle = `内存工作区（窗口容量 k = ${k}）`
  const runsTitle = '已经输出的初始归并段（每行一段，段内有序）'
  /** 当前段的行号 */
  const curRun = (): number => runs.length - 1
  const boardsFor = (memNote: string, runsNote: string, hot = -1): BoardView[] => [
    memBoard(memory, windowTitle, memNote, { frozen, hot }),
    rowBoard(file.slice(ptr), '外存：还没读入的记录', `还剩 ${n - ptr} 个记录没读进过内存`, {
      subFrom: ptr,
      emptyText: '（已全部读入）',
    }),
    runsBoard(
      runs,
      runsTitle,
      runsNote,
      (r) => (r === curRun() ? 'hot' : 'done'),
      memory.some((v) => v !== undefined) && runs[curRun()]!.length
        ? { name: '刚输出', run: curRun(), col: runs[curRun()]!.length - 1 }
        : undefined,
    ),
  ]

  if (n === 0) {
    yield {
      line: 2,
      action: 'init',
      array: [],
      comment: '外存上没有记录，生成不出归并段',
      vars: { n: 0, k },
      boards: boardsFor('窗口是空的', '还没有输出任何段'),
    }
    return
  }

  // ① 先把窗口读满
  for (let i = 0; i < k; i++) {
    memory[i] = file[ptr]
    ptr++
  }
  yield {
    line: 3,
    action: 'init',
    array: file.slice(),
    comment: `外存上有 ${n} 个记录：[${file.join(', ')}]。内存只给得出 k = ${k} 个记录的工作窗口。先把窗口读满：[${memory.join(', ')}]。接下来每一步都是"从窗口里挑最小的输出，再从外存补一个进来"，靠这个办法把初始归并段做得尽可能长`,
    vars: { n, k, 已读入: ptr },
    boards: boardsFor(`刚从外存读入 ${k} 个记录把窗口填满：${memory.join(', ')}`, '还没有输出任何段'),
  }

  for (;;) {
    // ② 在"没被冻结"的记录里找最小的
    let m = -1
    for (let i = 0; i < k; i++) {
      const v = memory[i]
      if (v === undefined || frozen[i]) continue
      if (m < 0 || v < memory[m]!) m = i
    }
    const anyLeft = memory.some((v) => v !== undefined)

    if (m < 0) {
      if (!anyLeft) break
      // ③④⑤ 窗口里的记录全被冻住了：本段结束，解冻后开新段
      const stuck = memory.filter((v) => v !== undefined).join('、')
      const prevOut = lastOut
      const finished = runs[curRun()]!
      frozen.fill(false)
      lastOut = -Infinity
      runs.push([])
      yield {
        line: 9,
        action: 'swap',
        array: runs.flat(),
        comment: `③④⑤ 窗口里剩下的记录（${stuck}）都比上次输出的 ${prevOut} 小，全被冻住了，当前段没法再长：第 ${curRun() - 1} 段到此结束，长度 ${finished.length}。把窗口**解冻**（lastOut 重置成 -∞），这些记录用来开第 ${curRun()} 段 —— 段就是这么一段一段"挤"出来的`,
        vars: { n, k, 段号: curRun(), 上一段长度: finished.length, 上一段最后输出: prevOut },
        boards: boardsFor(
          '窗口解除冻结：所有记录重新参选，lastOut 重置为 -∞',
          `第 ${curRun() - 1} 段结束（长度 ${finished.length}，段内有序），现在开始写第 ${curRun()} 段`,
        ),
      }
      continue
    }

    const v = memory[m]!
    yield {
      line: 6,
      action: 'compare',
      array: runs.flat(),
      comment: `② 在窗口里挑"不小于上次输出 ${lastOut === -Infinity ? '-∞（刚开始，什么都能选）' : lastOut}"的最小记录：槽 ${m} 里的 ${v}${frozen.some(Boolean) ? `（槽 ${frozen.map((f, i) => (f ? i : -1)).filter((i) => i >= 0).join('、')} 里的记录已经被冻结，不参选）` : ''}`,
      vars: { n, k, 槽位: m, 选中的值: v, 上次输出: lastOut === -Infinity ? -1 : lastOut },
      boards: boardsFor(`这次要输出槽 ${m} 里的 ${v}`, `它会被追加到第 ${curRun()} 段的末尾`, m),
    }

    runs[curRun()]!.push(v)
    outCount++
    lastOut = v
    const filled = ptr < n
    if (filled) {
      memory[m] = file[ptr]!
      ptr++
      if (memory[m]! < lastOut) frozen[m] = true
    } else {
      memory[m] = undefined
    }

    const justFrozen = filled && frozen[m] === true
    const outLine = !filled ? 12 : justFrozen ? 14 : 13
    yield {
      line: outLine,
      action: 'set',
      array: runs.flat(),
      comment: !filled
        ? `⑥⑦ 输出 ${v} 到第 ${curRun()} 段；外存已经读空了，槽 ${m} 空出来（已输出 ${outCount}/${n} 个）`
        : justFrozen
          ? `⑥⑦⑧ 输出 ${v} 到第 ${curRun()} 段，再从外存补一个 ${memory[m]} 进槽 ${m}：它比刚输出的 ${v} 小，所以**冻结**它 —— 插在这一段后面就破坏了段内有序，只能留给下一段，这正是"置换-选择"能把段做长的关键`
          : `⑥⑦ 输出 ${v} 到第 ${curRun()} 段，再从外存补一个 ${memory[m]} 进槽 ${m}：它不比刚输出的 ${v} 小，还能接着参加当前段`,
      vars: { n, k, 已输出: outCount, 段号: curRun(), 冻结数: frozen.filter(Boolean).length },
      boards: boardsFor(
        justFrozen ? `槽 ${m} 的 ${memory[m]} 被冻结，当前段不再选它` : '窗口更新完成',
        `第 ${curRun()} 段现在是 [${runs[curRun()]!.join(', ')}]`,
      ),
    }
  }

  yield {
    line: 17,
    action: 'done',
    array: runs.flat(),
    comment: `记录全部输出完了，一共生成 ${runs.length} 个初始归并段：${runs.map((r, i) => `第${i}段[${r.join(', ')}]`).join('　')}（长度 ${runs.map((r) => r.length).join('、')}）。如果只是"每 k = ${k} 个记录排一段"，同样 ${n} 个记录要 ${Math.ceil(n / k)} 段；置换-选择把段做得更长，后面归并的趟数就跟着少 —— 这就是它的价值`,
    vars: { n, k, 段数: runs.length, 朴素分段数: Math.ceil(n / k), 输出记录数: outCount },
    boards: boardsFor('窗口已经空了', `${runs.length} 个初始归并段，段内都有序`),
  }
}

export const replaceSelectSpec: AlgorithmSpec = {
  id: 'sort-replace-select',
  name: '置换-选择排序',
  category: 'sort',
  group: '外部排序',
  summary: '用一个小内存窗口生成尽量长的初始归并段：选最小输出、补一个进来，更小的就冻结',
  complexity: { time: 'O(n log k)，k 是内存窗口大小', space: 'O(k)' },
  renderer: 'scene',
  codeLines: REPLACE_CODE_LINES,
  defaultData: () => [15, 8, 22, 3, 19, 11, 26, 7, 14, 30, 5, 20],
  sizes: [12],
  initScene: (data) => {
    const k = Math.max(1, Math.min(REPLACE_K, data.length))
    return {
      boards: [
        memBoard(
          new Array<number | undefined>(k).fill(undefined),
          `内存工作区（窗口容量 k = ${k}）`,
          '窗口还没读入记录',
        ),
        rowBoard(data.slice(), '外存：还没读入的记录', `还剩 ${data.length} 个记录没读进过内存`),
        runsBoard([[]], '已经输出的初始归并段（每行一段，段内有序）', '还没有输出任何记录'),
      ],
    }
  },
  createRunner: replaceSelectRun,
}

/* ============================================================================
 * 六、最佳归并树（renderer: 'tree'）
 * ========================================================================== */

const OPT_CODE = `// 最佳归并树：每次合并最短的 k 段，总读写记录数最小（这里 k = 3）
void optimalMergeTree(int len[], int n, int k) {
  int m = n;
  while ((m - 1) % (k - 1) != 0) len[m++] = 0;   // ① 补长度为 0 的虚段，凑成严格 k 叉树
  while (m > 1) {
    选出当前最短的 k 段;                           // ② 最短的先合并：它的路径最长，代价最小
    新段 = 这 k 段长度之和;                         // ③ 新段的长度就是这 k 段之和
    把选中的 k 段删掉，把新段放回集合;
    m = m - k + 1;                                // ④ 段数每次少 k - 1 段
  }
  WPL = 每个叶子的长度 × 它到根的层数 求和;         // ⑤ 归并过程的总读写记录数
}`

export const OPT_CODE_LINES = OPT_CODE.split('\n')

/** 归并的路数（3 路归并，才会出现"补虚段"这件教材里的经典事） */
const OPT_K = 3

interface OptNode {
  id: string
  /** 这个段（结点）的长度 */
  w: number
  children: string[]
  /** 长度 0 的虚段 */
  virtual?: boolean
  /** 叶子对应的原始段号 */
  leaf?: number
}

/** 归并树的树形快照：森林里的每一棵都用 roots 列出来（多叉用 children） */
function optView(
  nodes: OptNode[],
  pool: string[],
  opts: { hot?: string[]; done?: string[]; note: string; pointers?: Record<string, string | null> },
): TreeView {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const live = new Set<string>()
  const walk = (id: string): void => {
    if (live.has(id)) return
    const nd = byId.get(id)
    if (!nd) return
    live.add(id)
    for (const c of nd.children) walk(c)
  }
  for (const r of pool) walk(r)
  const views: TreeNodeSnapshot[] = nodes
    .filter((nd) => live.has(nd.id))
    .map((nd) => ({
      id: nd.id,
      value: nd.w,
      sub:
        nd.children.length === 0
          ? nd.virtual
            ? '虚段·长度0'
            : `第${nd.leaf}段`
          : nd.virtual
            ? '虚段'
            : `${nd.children.map((c) => byId.get(c)!.w).join('+')}`,
      children: [...nd.children],
      color: nd.virtual ? '#4b5563' : undefined,
    }))
  const ids = new Set(views.map((v) => v.id))
  const pointers = Object.fromEntries(
    Object.entries(opts.pointers ?? {}).filter(([, v]) => !v || ids.has(v)),
  )
  return { nodes: views, roots: [...pool], hot: opts.hot ?? [], done: opts.done ?? [], pointers, note: opts.note }
}

/** 还没合并的段板子：按长度从小到大排队，等价于"每次取最短的 k 个" */
function optPoolBoard(nodes: OptNode[], pool: string[], hot: string[], note: string): BoardView {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const sorted = [...pool].sort((a, b) => byId.get(a)!.w - byId.get(b)!.w)
  const hotSet = new Set(hot)
  return {
    title: `还没合并的段（共 ${pool.length} 个，按长度从短到长排队）`,
    position: 'top',
    layout: 'grid',
    cols: Math.max(1, sorted.length),
    items: sorted.map((id) => {
      const nd = byId.get(id)!
      return {
        text: String(nd.w),
        sub: nd.virtual ? '虚段' : nd.children.length ? '合并来的' : `第${nd.leaf}段`,
        tone: hotSet.has(id) ? ('hot' as const) : nd.virtual ? ('dim' as const) : ('base' as const),
      }
    }),
    note,
  }
}

/**
 * 最佳归并树（k = 3 路归并）。
 *
 * 各初始归并段的长度不一样，**归并的先后顺序**会决定总读写量：
 * 一个记录每往外并一层，就要被读一遍、写一遍，所以"长度大的段应该尽量靠近树根（层数少）"。
 * 按哈夫曼的思路每次合并**最短的 k 段**，得到的就是带权路径长度最小的归并树。
 *
 * 还有一个教材里的经典细节：严格 k 叉树要求 (叶子数 - 1) % (k - 1) == 0，
 * 不满足就要**补长度 0 的虚段**，否则最后会凑不齐 k 段一起合并。
 */
export function* optimalMergeRun(data: number[]): AlgoRunner {
  const lens = data.slice()
  const n = lens.length
  const k = OPT_K
  const nodes: OptNode[] = lens.map((w, i) => ({
    id: `s${i}`,
    w: Math.max(0, Math.round(w)),
    children: [],
    leaf: i,
  }))
  const byId = new Map(nodes.map((x) => [x.id, x]))
  let pool = nodes.map((x) => x.id)
  let next = 0

  const sorted = (ids: string[]): string[] => [...ids].sort((a, b) => byId.get(a)!.w - byId.get(b)!.w)
  const total = lens.reduce((s, w) => s + Math.max(0, Math.round(w)), 0)

  yield {
    line: 2,
    action: 'init',
    array: lens.slice(),
    tree: optView(nodes, pool, {
      note: `${n} 个初始归并段，长度分别是 ${lens.join('、')}。长度不同的段，合并的先后顺序会影响总读写量`,
    }),
    boards: [
      optPoolBoard(nodes, pool, [], `一共 ${n} 个段，长度之和 = ${total}（每个记录都要被读一遍写一遍，总读写量至少是 2 × ${total}）`),
    ],
    comment: `有 ${n} 个初始归并段，长度分别是 [${lens.join(', ')}]，一共 ${total} 个记录。归并时要"每次从当前所有段里挑 ${k} 段合并成一段"：一个记录每往上并一层就要读写一遍，所以**短的段应该多并几层、长的段少并几层**才划算`,
    vars: { n, k, 记录总数: total },
  }

  // ① 补虚段：凑成严格 k 叉树
  let virtualCount = 0
  while ((pool.length - 1) % (k - 1) !== 0) {
    const id = `v${virtualCount}`
    nodes.push({ id, w: 0, children: [], virtual: true })
    byId.set(id, nodes[nodes.length - 1]!)
    pool = [...pool, id]
    virtualCount++
  }
  if (virtualCount > 0) {
    yield {
      line: 4,
      action: 'mark',
      array: lens.slice(),
      tree: optView(nodes, sorted(pool), {
        hot: nodes.filter((x) => x.virtual).map((x) => x.id),
        note: `补了 ${virtualCount} 个长度为 0 的虚段`,
      }),
      boards: [
        optPoolBoard(
          nodes,
          sorted(pool),
          nodes.filter((x) => x.virtual).map((x) => x.id),
          `严格 ${k} 叉树要求 (叶子数 - 1) 能被 (k - 1) = ${k - 1} 整除，现在 ${n} 个叶子不满足，所以要补虚段`,
        ),
      ],
      comment: `① 严格 ${k} 叉树要求"(叶子数 - 1) % (k - 1) = 0"：这里是 (${n} - 1) % ${k - 1} = ${(n - 1) % (k - 1)} ≠ 0，直接合并的话最后会剩下不足 ${k} 个段凑不成一次合并。所以补 **${virtualCount} 个长度为 0 的虚段**（画成灰色的"虚段"结点，真段下方的小字是"第 i 段"）—— 虚段不占记录，只用来把树补成严格的 ${k} 叉树`,
      vars: { n, k, 虚段个数: virtualCount, 叶子数: pool.length },
    }
  } else {
    yield {
      line: 4,
      action: 'mark',
      array: lens.slice(),
      tree: optView(nodes, sorted(pool), {
        note: `(${n} - 1) % ${k - 1} = 0，刚好能凑成严格的 ${k} 叉树，不用补虚段`,
      }),
      boards: [
        optPoolBoard(nodes, sorted(pool), [], `(${n} - 1) % ${k - 1} = 0，不用补虚段`),
      ],
      comment: `① (${n} - 1) % (k - 1) = ${(n - 1) % (k - 1)} = 0，${n} 个段刚好能凑成严格的 ${k} 叉树，不用补虚段`,
      vars: { n, k, 虚段个数: 0 },
    }
  }

  // ②③④ 反复取最短的 k 段合并
  let round = 0
  while (pool.length > 1) {
    round++
    const picked = sorted(pool).slice(0, k)
    const pickedW = picked.map((id) => byId.get(id)!.w)
    yield {
      line: 6,
      action: 'compare',
      array: lens.slice(),
      tree: optView(nodes, sorted(pool), {
        hot: picked,
        pointers: Object.fromEntries(picked.map((id, i) => [`第${i + 1}短`, id])),
        note: `第 ${round} 次合并：挑出最短的 ${k} 段 —— ${pickedW.join('、')}`,
      }),
      boards: [optPoolBoard(nodes, sorted(pool), picked, `最短的 ${k} 个是 ${pickedW.join('、')}，这次合并它们`)],
      comment: `② 第 ${round} 次合并：从 ${pool.length} 个段里挑出**最短的 ${k} 段**：${pickedW.map((w, i) => `${w}（${picked[i]!.startsWith('v') ? '虚段' : `第${picked[i]!.slice(1)}段`}）`).join('、')}。挑最短的先并，它们的层数最多、代价最小`,
      vars: { n, k, 第几次: round, 合并前段数: pool.length, 权值之和: pickedW.reduce((s, w) => s + w, 0) },
    }

    const sum = pickedW.reduce((s, w) => s + w, 0)
    yield {
      line: 7,
      action: 'mark',
      array: lens.slice(),
      tree: optView(nodes, sorted(pool), {
        hot: picked,
        note: `新段的长度 = ${pickedW.join(' + ')} = ${sum}`,
      }),
      boards: [
        optPoolBoard(nodes, sorted(pool), picked, `新段长度 = ${pickedW.join(' + ')} = ${sum}`),
      ],
      comment: `③ 合并出来的新段长度 = ${pickedW.join(' + ')} = ${sum}。这次合并要把这 ${sum} 个记录读一遍写一遍；并出来的新段接着当一段参加后面的合并`,
      vars: { n, k, 第几次: round, 新段长度: sum },
    }

    const id = `m${next++}`
    nodes.push({ id, w: sum, children: picked })
    byId.set(id, nodes[nodes.length - 1]!)
    pool = [...pool.filter((x) => !picked.includes(x)), id]

    yield {
      line: 9,
      action: 'swap',
      array: lens.slice(),
      tree: optView(nodes, sorted(pool), {
        hot: [id],
        pointers: { 新段: id },
        note: `新段 ${sum} 挂进森林，段数从 ${pool.length + k - 1} 变成 ${pool.length}`,
      }),
      boards: [optPoolBoard(nodes, sorted(pool), [id], `段数少了 ${k - 1} 个，现在是 ${pool.length} 段`)],
      comment: `④ 把被选中的 ${k} 段从集合里删掉、新段 ${sum} 放回去：段数从 ${pool.length + k - 1} 变成 ${pool.length}（每次少 ${k - 1} 段）`,
      vars: { n, k, 第几次: round, 段数: pool.length, 新段长度: sum },
    }
  }

  // ⑤ 算带权路径长度
  const root = pool[0]!
  const depth = new Map<string, number>()
  const walkDepth = (id: string, d: number): void => {
    depth.set(id, d)
    for (const c of byId.get(id)!.children) walkDepth(c, d + 1)
  }
  walkDepth(root, 0)
  const realLeaves = nodes.filter((x) => x.children.length === 0 && !x.virtual)
  let wpl = 0
  for (const leaf of realLeaves) wpl += leaf.w * (depth.get(leaf.id) ?? 0)
  const totalIO = 2 * wpl

  yield {
    line: 12,
    action: 'done',
    array: lens.slice(),
    tree: optView(nodes, [root], {
      hot: [root],
      done: realLeaves.map((x) => x.id),
      note: `归并树建好了，树根 = 全部记录数 = ${byId.get(root)!.w}；带权路径长度 WPL = ${wpl}`,
    }),
    boards: [
      optPoolBoard(nodes, [root], [], `只剩一棵树了，树根的权值就是记录总数 ${byId.get(root)!.w}`),
      rowBoard(
        realLeaves.map((x) => `${x.w}×${depth.get(x.id) ?? 0}`),
        '带权路径长度 WPL = Σ(段长 × 层数)',
        `${realLeaves.map((x) => `${x.w}×${depth.get(x.id) ?? 0}`).join(' + ')} = ${wpl}`,
      ),
    ],
    comment: `⑤ 归并树建好了：树根 = ${byId.get(root)!.w}（就是全部记录数）。带权路径长度 WPL = Σ(每段长度 × 它到根的层数) = ${realLeaves.map((x) => `${x.w}×${depth.get(x.id) ?? 0}`).join(' + ')} = ${wpl}。它的含义是：每个记录平均要在归并过程中被"搬"上去若干层，每搬一层要读一遍、写一遍，所以**总读写记录数 = 2 × WPL = ${totalIO}**（读 ${wpl} 次、写 ${wpl} 次）。${virtualCount > 0 ? `注意那 ${virtualCount} 个长度为 0 的虚段：它们不贡献记录，只把树补成严格的 ${k} 叉树，所以不参与 WPL 的求和。` : ''}每次合并最短的 ${k} 段，正是让 WPL 最小的做法 —— 这也是哈夫曼树的思想`,
    vars: { n, k, 带权路径长度: wpl, 总读写记录数: totalIO, 虚段个数: virtualCount },
  }
}

export const optimalMergeSpec: AlgorithmSpec = {
  id: 'sort-optimal-merge',
  name: '最佳归并树',
  category: 'sort',
  group: '外部排序',
  summary: '按哈夫曼思路每次合并最短的 k 段，段数不足时补长度 0 的虚段',
  complexity: { time: 'O(n log n)', space: 'O(n)' },
  renderer: 'tree',
  codeLines: OPT_CODE_LINES,
  defaultData: () => [9, 30, 12, 18, 3, 17, 2, 6],
  sizes: [5, 6, 7, 8, 9],
  initTree: (data) =>
    optView(
      data.map((w, i) => ({ id: `s${i}`, w: Math.max(0, Math.round(w)), children: [], leaf: i })),
      data.map((_, i) => `s${i}`),
      { note: `${data.length} 个初始归并段，长度各不相同；每次合并最短的 ${OPT_K} 段` },
    ),
  initScene: (data) => {
    const nodes: OptNode[] = data.map((w, i) => ({
      id: `s${i}`,
      w: Math.max(0, Math.round(w)),
      children: [],
      leaf: i,
    }))
    return {
      boards: [
        optPoolBoard(nodes, nodes.map((x) => x.id), [], `一共 ${data.length} 个段，长度之和 = ${data.reduce((s, w) => s + w, 0)}`),
      ],
    }
  },
  createRunner: optimalMergeRun,
}

/* ============================================================================
 * 注册：本文件里的 spec 由 src/algorithms/index.ts 按子类登记
 *（堆排序 + heapSpecs 组「选择类排序」、基数排序组「分配类排序」、
 *  其余四个组「外部排序」）。顺序以 index.ts 为准，这里不提供聚合数组。
 * ========================================================================== */
