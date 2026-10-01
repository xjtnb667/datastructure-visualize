import type { AlgorithmSpec, AlgoRunner, RunnerContext } from '@/core/types'
import { SEQ_CAPACITY } from '@/core/config'

// ---------------------------------------------------------------------------
// 1. 插入
// ---------------------------------------------------------------------------
export const SEQ_INSERT_CODE = `const int MAX = 16;                            // 顺序表容量
bool listInsert(int a[], int &length, int pos, int x) {
    if (length >= MAX) return false;               // 表满，插入失败
    if (pos < 1 || pos > length + 1) return false; // 位序非法
    for (int i = length - 1; i >= pos - 1; i--) {
        a[i + 1] = a[i];                           // 从后往前逐个后移
    }
    a[pos - 1] = x;                                // 放入新元素
    length++;
    return true;
}`

/**
 * 顺序表插入步骤生成器。
 *   line 3 -> 判表满    line 4 -> 判位序合法
 *   line 6 -> 元素后移   line 8 -> 放入新元素
 *   line 9 -> 表长 +1    line 10 -> 插入成功
 */
export function* seqInsert(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const capacity = ctx.capacity ?? SEQ_CAPACITY
  const pos = ctx.pos ?? Math.max(1, Math.floor(a.length / 2))
  const x = ctx.value ?? 99
  let n = a.length
  const vars = () => ({ n, pos, x, capacity })

  yield {
    line: 3,
    action: 'mark',
    array: a,
    vars: vars(),
    comment: `表长 n = ${n}，容量 MAX = ${capacity}，表未满，可以插入`,
  }
  yield {
    line: 4,
    action: 'mark',
    array: a,
    vars: vars(),
    comment: `位序 pos = ${pos} 合法（合法范围是 1 ~ ${n + 1}）`,
  }

  for (let i = n - 1; i >= pos - 1; i--) {
    const moved = a[i]!
    a[i + 1] = moved
    yield {
      line: 6,
      action: 'set',
      array: a,
      indices: [i + 1],
      vars: vars(),
      comment: `把 a[${i}] = ${moved} 后移到 a[${i + 1}]，腾出空位`,
    }
  }

  a[pos - 1] = x
  n += 1
  yield {
    line: 8,
    action: 'set',
    array: a,
    indices: [pos - 1],
    vars: vars(),
    comment: `把新元素 x = ${x} 放到位序 ${pos}（下标 ${pos - 1}）`,
  }
  yield {
    line: 9,
    action: 'mark',
    array: a,
    indices: [pos - 1],
    vars: vars(),
    comment: `表长增加到 n = ${n}`,
  }
  yield {
    line: 10,
    action: 'done',
    array: a,
    indices: [pos - 1],
    vars: vars(),
    comment: `插入成功，返回 true；共移动了 ${n - pos} 个元素`,
  }
}

// ---------------------------------------------------------------------------
// 2. 删除
// ---------------------------------------------------------------------------
export const SEQ_DELETE_CODE = `bool listDelete(int a[], int &length, int pos, int &e) {
    if (pos < 1 || pos > length) return false;     // 位序非法
    e = a[pos - 1];                                // 保存被删元素
    for (int i = pos; i < length; i++) {
        a[i - 1] = a[i];                           // 从前往后逐个前移
    }
    length--;
    return true;
}`

/**
 * 顺序表删除步骤生成器。
 *   line 2 -> 判位序    line 3 -> 保存被删元素
 *   line 5 -> 元素前移   line 7 -> 表长 -1    line 8 -> 删除成功
 */
export function* seqDelete(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const capacity = ctx.capacity ?? SEQ_CAPACITY
  const pos = ctx.pos ?? Math.max(1, Math.floor(a.length / 2))
  let n = a.length
  const vars = () => ({ n, pos, capacity })

  yield {
    line: 2,
    action: 'mark',
    array: a,
    vars: vars(),
    comment: `位序 pos = ${pos} 合法（合法范围是 1 ~ ${n}）`,
  }

  const removed = a[pos - 1]!
  yield {
    line: 3,
    action: 'mark',
    array: a,
    indices: [pos - 1],
    vars: vars(),
    comment: `先把被删元素保存起来：e = a[${pos - 1}] = ${removed}`,
  }

  for (let i = pos; i < n; i++) {
    const moved = a[i]!
    a[i - 1] = moved
    yield {
      line: 5,
      action: 'set',
      array: a,
      indices: [i - 1],
      vars: vars(),
      comment: `把 a[${i}] = ${moved} 前移到 a[${i - 1}]，填补空位`,
    }
  }

  a.pop()
  n -= 1
  yield {
    line: 7,
    action: 'mark',
    array: a,
    vars: vars(),
    comment: `表长减少到 n = ${n}，被删除的元素是 ${removed}`,
  }
  yield {
    line: 8,
    action: 'done',
    array: a,
    vars: vars(),
    comment: `删除成功，返回 true`,
  }
}

// ---------------------------------------------------------------------------
// 3. 按值查找
// ---------------------------------------------------------------------------
export const SEQ_LOCATE_CODE = `int locateByValue(int a[], int length, int x) {
    for (int i = 0; i < length; i++) {
        if (a[i] == x) return i + 1;       // 返回位序（从 1 开始）
    }
    return 0;                              // 返回 0 表示没找到
}`

/**
 * 顺序表按值查找步骤生成器（时间复杂度 O(n)）。
 *   line 2 -> 逐个扫描    line 3 -> 比较    line 3 -> 命中返回位序    line 5 -> 没找到
 */
export function* seqLocate(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const n = a.length
  const x = ctx.target ?? a[0]!
  const vars = (i: number) => ({ n, x, i, capacity: SEQ_CAPACITY })

  for (let i = 0; i < n; i++) {
    yield {
      line: 2,
      action: 'mark',
      array: a,
      indices: [i],
      range: [i, n - 1],
      vars: vars(i),
      comment: `扫描到第 ${i + 1} 个元素（下标 ${i}）`,
    }
    yield {
      line: 3,
      action: 'compare',
      array: a,
      indices: [i],
      range: [i, n - 1],
      vars: vars(i),
      comment: `比较 a[${i}] = ${a[i]} 与 x = ${x}`,
    }
    if (a[i] === x) {
      yield {
        line: 3,
        action: 'done',
        array: a,
        indices: [i],
        range: [i, i],
        vars: vars(i),
        comment: `找到了！x = ${x} 的位序是 ${i + 1}（下标 ${i}）`,
      }
      return
    }
  }
  yield {
    line: 5,
    action: 'done',
    array: a,
    indices: [],
    range: [1, 0],
    vars: vars(n),
    comment: `扫完了整张表都没有 x = ${x}，返回 0 表示没找到`,
  }
}

// ---------------------------------------------------------------------------
// 4. 按位查找
// ---------------------------------------------------------------------------
export const SEQ_GET_CODE = `int getElem(int a[], int length, int pos) {
    if (pos < 1 || pos > length) return -1;    // 位序越界
    int e = a[pos - 1];                        // 直接按下标取，一步到位
    return e;
}`

/**
 * 顺序表按位查找步骤生成器。
 * 重点就一句话：顺序表是"随机存取"，给定下标直接算地址取出来，O(1)，不需要遍历。
 */
export function* seqGet(a: number[], ctx: RunnerContext = {}): AlgoRunner {
  const n = a.length
  const pos = ctx.pos ?? Math.max(1, Math.floor(n / 2))
  const vars = () => ({ n, pos, capacity: SEQ_CAPACITY })

  yield {
    line: 2,
    action: 'mark',
    array: a,
    vars: vars(),
    comment: `位序 pos = ${pos} 合法（合法范围是 1 ~ ${n}）`,
  }
  const e = a[pos - 1]!
  yield {
    line: 3,
    action: 'mark',
    array: a,
    indices: [pos - 1],
    vars: vars(),
    comment: `直接按下标取 a[${pos - 1}]，不需要从头遍历 —— 这就是顺序表的随机存取`,
  }
  yield {
    line: 4,
    action: 'done',
    array: a,
    indices: [pos - 1],
    vars: vars(),
    comment: `返回位序 ${pos} 处的元素 ${e}，时间复杂度 O(1)`,
  }
}

// ---------------------------------------------------------------------------
// 注册表项
// ---------------------------------------------------------------------------
const SEQ_PREPARE = (raw: number[]) => raw.slice(0, SEQ_CAPACITY - 4)

export const seqInsertSpec: AlgorithmSpec = {
  id: 'seq-insert',
  name: '插入',
  category: 'linear',
  group: '顺序表',
  summary: '腾位置后移，再放入新元素',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'seqlist',
  capacity: SEQ_CAPACITY,
  codeLines: SEQ_INSERT_CODE.split('\n'),
  defaultData: () => [12, 25, 37, 48, 59, 71],
  prepareData: SEQ_PREPARE,
  defaultValue: () => 99,
  defaultPos: (d) => Math.max(1, Math.min(d.length, 3)),
  createRunner: seqInsert,
}

export const seqDeleteSpec: AlgorithmSpec = {
  id: 'seq-delete',
  name: '删除',
  category: 'linear',
  group: '顺序表',
  summary: '前移填补空位，表长减一',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'seqlist',
  capacity: SEQ_CAPACITY,
  codeLines: SEQ_DELETE_CODE.split('\n'),
  defaultData: () => [12, 25, 37, 48, 59, 71],
  prepareData: SEQ_PREPARE,
  defaultPos: (d) => Math.max(1, Math.min(d.length, 3)),
  createRunner: seqDelete,
}

export const seqLocateSpec: AlgorithmSpec = {
  id: 'seq-locate',
  name: '按值查找',
  category: 'linear',
  group: '顺序表',
  summary: '从头逐个比对，返回位序',
  complexity: { time: 'O(n)', space: 'O(1)' },
  renderer: 'seqlist',
  capacity: SEQ_CAPACITY,
  codeLines: SEQ_LOCATE_CODE.split('\n'),
  defaultData: () => [12, 25, 37, 48, 59, 71],
  prepareData: SEQ_PREPARE,
  defaultTarget: (d) => d[Math.floor(Math.random() * d.length)]!,
  createRunner: seqLocate,
}

export const seqGetSpec: AlgorithmSpec = {
  id: 'seq-get',
  name: '按位查找',
  category: 'linear',
  group: '顺序表',
  summary: '按下标直接取，O(1)',
  complexity: { time: 'O(1)', space: 'O(1)' },
  renderer: 'seqlist',
  capacity: SEQ_CAPACITY,
  codeLines: SEQ_GET_CODE.split('\n'),
  defaultData: () => [12, 25, 37, 48, 59, 71],
  prepareData: SEQ_PREPARE,
  defaultPos: (d) => Math.max(1, Math.min(d.length, 4)),
  createRunner: seqGet,
}
