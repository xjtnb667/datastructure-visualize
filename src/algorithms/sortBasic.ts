import type { AlgorithmSpec, AlgoRunner, BoardView } from '@/core/types'

/**
 * 五个"进阶"排序算法：折半插入、希尔、快速、归并、计数。
 *
 * 和 bubbleSort / insertionSort 保持同一套写法：
 *   - 一个 yield = 一步；
 *   - 每帧给 `array`（当前数组快照）和 `indices`（本步真正在动的位置）；
 *   - `line` 对应下面那份"给人看的 C++ 代码"的物理行号，不指向空行；
 *   - `comment` 每一帧都有，说清这一步在干什么；
 *   - `vars` 里放 比较 / 交换（或移动）次数，和播放器里的统计对得上。
 *
 * 注意：engine 在 import 步骤时会对 `array` 做 slice()，所以这里
 * 直接 yield 活数组 `a` 也是安全的（和 bubbleSort 的写法一致）。
 */

// ---------------------------------------------------------------------------
// 1. 折半插入排序
// ---------------------------------------------------------------------------

const BIN_INSERT_CODE = `void binInsertSort(int a[], int n) {
    for (int i = 1; i < n; i++) {
        int key = a[i];
        int low = 0, high = i - 1;
        while (low <= high) {
            int mid = (low + high) / 2;
            if (a[mid] > key) high = mid - 1;
            else low = mid + 1;
        }
        for (int j = i - 1; j >= low; j--)
            a[j + 1] = a[j];
        a[low] = key;
    }
}`

export const BIN_INSERT_CODE_LINES = BIN_INSERT_CODE.split('\n')

/**
 * 折半插入排序步骤生成器。
 *   line 3 -> 取出待插入的 key
 *   line 7 -> 折半比较 a[mid] 与 key
 *   line 8 / 9 -> 缩小查找区间
 *   line 12 -> 元素后移（移动次数和直接插入排序一样多）
 *   line 13 -> key 落到 low 位置
 *   line 2 -> 本轮结束，前 i+1 个元素有序
 */
export function* binInsertSort(a: number[]): AlgoRunner {
  const n = a.length
  let compares = 0
  let moves = 0

  for (let i = 1; i < n; i++) {
    const key = a[i]!
    yield {
      line: 3,
      action: 'mark',
      array: a,
      indices: [i],
      vars: { i, key, n, compares, moves },
      comment: `取出 key = a[${i}] = ${key}；左边 a[0..${i - 1}] 已经有序，用折半查找给它找位置`,
    }

    let low = 0
    let high = i - 1
    let hit = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      const midVal = a[mid]!
      compares += 1
      if (midVal > key) {
        yield {
          line: 7,
          action: 'compare',
          array: a,
          indices: [mid],
          range: [low, high],
          vars: { i, low, mid, high, key, n, compares, moves },
          comment: `折半：mid = ${mid}，a[${mid}] = ${midVal} > key = ${key}，插入位置在左半边`,
        }
        high = mid - 1
        yield {
          line: 8,
          action: 'mark',
          array: a,
          indices: [mid],
          range: [low, high],
          vars: { i, low, mid, high, key, n, compares, moves },
          comment: `high = mid - 1 = ${high}，查找区间缩到 [${low}, ${high}]`,
        }
      } else {
        yield {
          line: 7,
          action: 'compare',
          array: a,
          indices: [mid],
          range: [low, high],
          vars: { i, low, mid, high, key, n, compares, moves },
          comment: `折半：mid = ${mid}，a[${mid}] = ${midVal} ≤ key = ${key}，插入位置在右半边`,
        }
        low = mid + 1
        yield {
          line: 9,
          action: 'mark',
          array: a,
          indices: [mid],
          range: [low, high],
          vars: { i, low, mid, high, key, n, compares, moves },
          comment: `low = mid + 1 = ${low}，查找区间缩到 [${low}, ${high}]`,
        }
      }
      hit = mid
    }

    if (hit < 0) {
      yield {
        line: 5,
        action: 'mark',
        array: a,
        indices: [i],
        vars: { i, low, high, key, n, compares, moves },
        comment: `左边只有 ${i} 个元素，折半区间一开始就是空的，位置直接定在 ${low}`,
      }
    }

    yield {
      line: 5,
      action: 'mark',
      array: a,
      indices: [low],
      range: [low, high],
      vars: { i, low, high, key, n, compares, moves },
      comment: `折半结束：low = ${low} 就是 key = ${key} 该插入的位置（折半只减少了比较，元素该移还得移）`,
    }

    for (let j = i - 1; j >= low; j--) {
      const v = a[j]!
      a[j + 1] = v
      moves += 1
      yield {
        line: 12,
        action: 'set',
        array: a,
        indices: [j + 1],
        vars: { i, low, j, key, n, compares, moves },
        comment: `把 a[${j}] = ${v} 后移到位置 ${j + 1}`,
      }
    }

    a[low] = key
    yield {
      line: 13,
      action: 'set',
      array: a,
      indices: [low],
      vars: { i, low, key, n, compares, moves },
      comment: `把 key = ${key} 放到位置 ${low}；本趟比较 ${compares} 次、移动 ${moves} 次`,
    }

    yield {
      line: 2,
      action: 'sorted',
      array: a,
      indices: Array.from({ length: i + 1 }, (_, k) => k),
      vars: { i, n, compares, moves },
      comment: `前 ${i + 1} 个元素已经有序`,
    }
  }
}

export const binInsertSortSpec: AlgorithmSpec = {
  id: 'sort-bin-insert',
  name: '折半插入排序',
  category: 'sort',
  group: '插入类排序',
  summary: '用折半查找定位插入点，比较次数降到 O(n log n)，移动次数仍是 O(n²)',
  complexity: { time: 'O(n²)', space: 'O(1)', stable: true },
  renderer: 'array',
  codeLines: BIN_INSERT_CODE_LINES,
  defaultData: () => [5, 2, 9, 1, 7, 3],
  createRunner: binInsertSort,
}

// ---------------------------------------------------------------------------
// 2. 希尔排序
// ---------------------------------------------------------------------------

const SHELL_CODE = `void shellSort(int a[], int n) {
    for (int gap = n / 2; gap > 0; gap = gap / 2) {
        for (int i = gap; i < n; i++) {
            int key = a[i];
            int j = i - gap;
            while (j >= 0 && a[j] > key) {
                a[j + gap] = a[j];
                j = j - gap;
            }
            a[j + gap] = key;
        }
    }
}`

export const SHELL_CODE_LINES = SHELL_CODE.split('\n')

/** 当前增量 gap 分出来的第 g 组都有哪些下标（画面靠它高亮"整组"） */
function shellGroup(n: number, gap: number, g: number): number[] {
  const out: number[] = []
  for (let k = g; k < n; k += gap) out.push(k)
  return out
}

/**
 * 希尔排序步骤生成器。
 *   line 2 -> 换一个增量
 *   line 4 -> 取出一组里待插入的 key
 *   line 6 -> 同组前后两个元素比较
 *   line 7 -> 同组元素后移 gap 位
 *   line 9 -> key 落到同组位置
 *   line 3 -> 本组处理完
 *
 * 画面约定：`indices` 给的是**当前 gap 下的整组下标**，
 * 所以横着看能直接看出"隔 gap 个是一组、组内自己排序"。
 */
export function* shellSort(a: number[]): AlgoRunner {
  const n = a.length
  let compares = 0
  let moves = 0

  for (let gap = n >> 1; gap > 0; gap = gap >> 1) {
    yield {
      line: 2,
      action: 'mark',
      array: a,
      indices: [],
      vars: { gap, n, compares, moves },
      comment: `增量 gap = ${gap}：把下标相差 ${gap} 的元素看成一组，一共 ${gap} 组，各组先各自直接插入排序`,
    }

    for (let i = gap; i < n; i++) {
      const g = i % gap
      const group = shellGroup(n, gap, g)
      const key = a[i]!
      yield {
        line: 4,
        action: 'mark',
        array: a,
        indices: group,
        vars: { gap, i, key, n, compares, moves },
        comment: `第 ${g + 1} 组（下标 ${group.join('、')}）里取出 key = a[${i}] = ${key}，准备在这一组里往前插`,
      }

      let j = i - gap
      while (j >= 0 && a[j]! > key) {
        const v = a[j]!
        compares += 1
        yield {
          line: 6,
          action: 'compare',
          array: a,
          indices: group,
          vars: { gap, i, j, key, n, compares, moves },
          comment: `同组比较：a[${j}] = ${v} > key = ${key}，a[${j}] 要往后挪 ${gap} 位`,
        }
        a[j + gap] = v
        moves += 1
        yield {
          line: 7,
          action: 'set',
          array: a,
          indices: group,
          vars: { gap, i, j, key, n, compares, moves },
          comment: `把 a[${j}] = ${v} 移到同组的下一个位置 ${j + gap}`,
        }
        j -= gap
      }

      if (j >= 0) {
        compares += 1
        yield {
          line: 6,
          action: 'compare',
          array: a,
          indices: group,
          vars: { gap, i, j, key, n, compares, moves },
          comment: `同组比较：a[${j}] = ${a[j]} ≤ key = ${key}，位置找到了，停止移动`,
        }
      }

      a[j + gap] = key
      yield {
        line: 9,
        action: 'set',
        array: a,
        indices: group,
        vars: { gap, i, key, n, compares, moves },
        comment: `把 key = ${key} 放到同组位置 ${j + gap}；第 ${g + 1} 组这一段已经有序`,
      }

      yield {
        line: 3,
        action: 'mark',
        array: a,
        indices: group,
        vars: { gap, i, n, compares, moves },
        comment: `i = ${i} 处理完，第 ${g + 1} 组在下标 ${group.join('、')} 上仍然保持有序`,
      }
    }
  }
}

export const shellSortSpec: AlgorithmSpec = {
  id: 'sort-shell',
  name: '希尔排序',
  category: 'sort',
  group: '插入类排序',
  summary: '按增量 gap 分组做插入排序，gap 逐步减到 1，整体基本有序后再收尾',
  complexity: { time: '约 O(n^1.3)', space: 'O(1)', stable: false },
  renderer: 'array',
  codeLines: SHELL_CODE_LINES,
  defaultData: () => [5, 2, 9, 1, 7, 3],
  createRunner: shellSort,
}

// ---------------------------------------------------------------------------
// 3. 快速排序
// ---------------------------------------------------------------------------

const QUICK_CODE = `void quickSort(int a[], int lo, int hi) {
    if (lo < hi) {
        int pivot = a[lo];
        swap(a[lo], a[hi]);
        int i = lo;
        for (int j = lo; j < hi; j++) {
            if (a[j] < pivot) { swap(a[i], a[j]); i++; }
        }
        swap(a[i], a[hi]);
        quickSort(a, lo, i - 1);
        quickSort(a, i + 1, hi);
    }
}`

export const QUICK_CODE_LINES = QUICK_CODE.split('\n')

/**
 * 快速排序步骤生成器。
 * 基准取区间第一个元素 a[lo]，但"左右指针互相扫"的写法里基准留在原地会被覆盖，
 * 所以先把基准换到区间末尾，划分完再换回它该在的位置 —— 逻辑等价，只是更好写、也不会错。
 *
 *   line 3 -> 选出本趟的基准 pivot
 *   line 4 -> 基准先挪到区间末尾（方便左右指针从 lo 开始扫）
 *   line 7 -> 逐个比较 a[j] 与 pivot
 *   line 8 -> a[j] < pivot 就换到左半边去（i 是"小半边"的右边界）
 *   line 10 -> 基准归位：a[lo..i-1] 都比它小、a[i+1..hi] 都比它大
 *   line 11 / line 12 -> 递归处理左右两个子区间
 *   line 2 -> 区间长度不足 2，直接返回
 *
 * 画面约定：`range` 永远标出"当前这一趟正在处理的区间 [lo, hi]"，
 * `indices` 里把 lo..hi 全部点亮表示区间边界，真正在比的那一格排在前面。
 */
function* quickSortRange(a: number[], lo: number, hi: number): AlgoRunner {
  if (lo >= hi) {
    yield {
      line: 2,
      action: 'mark',
      array: a,
      indices: lo === hi ? [lo] : [],
      range: [lo, hi],
      comment: `区间 [${lo}, ${hi}] 长度不足 2，这一段不用再排`,
    }
    return
  }

  const pivot = a[lo]!

  yield {
    line: 3,
    action: 'mark',
    array: a,
    indices: [lo],
    range: [lo, hi],
    vars: { lo, hi, pivot },
    comment: `本趟处理区间 [${lo}, ${hi}]，取区间第一个元素作基准 pivot = a[${lo}] = ${pivot}`,
  }

  const tail = a[hi]!
  a[lo] = tail
  a[hi] = pivot
  yield {
    line: 4,
    action: 'swap',
    array: a,
    indices: [lo, hi],
    range: [lo, hi],
    vars: { lo, hi, pivot },
    comment: `先把基准挪到区间末尾：交换 a[${lo}] 与 a[${hi}]，随后左右指针从 ${lo} 开始向右扫`,
  }

  let i = lo
  for (let j = lo; j < hi; j++) {
    const aj = a[j]!
    yield {
      line: 7,
      action: 'compare',
      array: a,
      indices: [j, hi],
      range: [lo, hi],
      vars: { lo, hi, i, j, pivot },
      comment: `比较 a[${j}] = ${aj} 与基准 pivot = ${pivot}`,
    }
    if (aj < pivot) {
      const left = a[i]!
      const t = a[i]!
      a[i] = aj
      a[j] = t
      i += 1
      yield {
        line: 8,
        action: 'swap',
        array: a,
        indices: [i - 1, j, hi],
        range: [lo, hi],
        vars: { lo, hi, i, j, pivot },
        comment: `${aj} < ${pivot}，把它换到左半边的 a[${i - 1}]（原来是 ${left}），小半边现在到 ${i - 1} 为止`,
      }
    }
  }

  const tailVal = a[hi]!
  a[hi] = a[i]!
  a[i] = pivot
  yield {
    line: 10,
    action: 'set',
    array: a,
    indices: [i, hi],
    range: [lo, hi],
    vars: { lo, hi, i, pivot },
    comment: `一趟划分结束：把基准 pivot = ${pivot} 换回位置 ${i}（a[${hi}] = ${tailVal} 挪到末尾），它左边 ${i - lo} 个都比它小、右边都比它大`,
  }

  yield {
    line: 10,
    action: 'sorted',
    array: a,
    indices: [i],
    range: [lo, hi],
    vars: { lo, hi, i, pivot },
    comment: `a[${i}] = ${pivot} 已经就位：它左边的都不大于它、右边的都不小于它`,
  }

  yield {
    line: 11,
    action: 'mark',
    array: a,
    indices: i - 1 >= lo ? [lo, i - 1] : [],
    range: [lo, i - 1],
    vars: { lo, hi, i, pivot },
    comment: `递归处理左子区间 [${lo}, ${i - 1}]`,
  }
  yield* quickSortRange(a, lo, i - 1)

  yield {
    line: 12,
    action: 'mark',
    array: a,
    indices: i + 1 <= hi ? [i + 1, hi] : [],
    range: [i + 1, hi],
    vars: { lo, hi, i, pivot },
    comment: `递归处理右子区间 [${i + 1}, ${hi}]`,
  }
  yield* quickSortRange(a, i + 1, hi)
}

export function* quickSort(a: number[]): AlgoRunner {
  yield* quickSortRange(a, 0, a.length - 1)
}

export const quickSortSpec: AlgorithmSpec = {
  id: 'sort-quick',
  name: '快速排序',
  category: 'sort',
  group: '交换类排序',
  summary: '取第一个元素作基准，左右指针向中间扫着换，一趟划分后基准归位',
  complexity: { time: 'O(n log n)', space: 'O(log n)', stable: false },
  renderer: 'array',
  codeLines: QUICK_CODE_LINES,
  defaultData: () => [5, 2, 9, 1, 7, 3],
  createRunner: quickSort,
}

// ---------------------------------------------------------------------------
// 4. 归并排序
// ---------------------------------------------------------------------------

const MERGE_CODE = `void mergeSort(int a[], int n) {
    int tmp[100];
    for (int len = 1; len < n; len = len * 2) {
        for (int lo = 0; lo < n; lo = lo + 2 * len) {
            int mid = lo + len - 1;
            int hi = min(lo + 2 * len - 1, n - 1);
            if (mid >= hi) continue;
            int i = lo, j = mid + 1, k = 0;
            while (i <= mid && j <= hi) {
                if (a[i] <= a[j]) tmp[k++] = a[i++];
                else tmp[k++] = a[j++];
            }
            while (i <= mid) tmp[k++] = a[i++];
            while (j <= hi) tmp[k++] = a[j++];
            for (int t = 0; t < k; t++) a[lo + t] = tmp[t];
        }
    }
}`

export const MERGE_CODE_LINES = MERGE_CODE.split('\n')

/**
 * 归并排序步骤生成器（自底向上：len = 1, 2, 4 ... 每趟把相邻两个长 len 的有序段并成一个）。
 *
 *   line 3 -> 开始新的一趟，段长翻倍
 *   line 5 / line 6 -> 算出左右两段的边界 mid / hi
 *   line 7 -> 右段是空的，这一段不用并
 *   line 9 -> 比较两个有序段的当前队首
 *   line 10 / line 11 -> 小的那个被取走放进临时区
 *   line 13 -> 左段剩下的直接搬
 *   line 14 -> 右段剩下的直接搬
 *   line 15 -> 临时区整体写回原数组（这一步之后两段才真正并成一段）
 *
 * 画面约定：`range` 给出正在合并的**两个区间** [lo, mid] 与 [mid+1, hi]，
 * 写成 [lo, hi] 的形式（分段点在解说词里点明），`indices` 高亮这一段。
 */
export function* mergeSort(a: number[]): AlgoRunner {
  const n = a.length
  let compares = 0
  let moves = 0

  for (let len = 1; len < n; len *= 2) {
    yield {
      line: 3,
      action: 'mark',
      array: a,
      indices: [],
      vars: { len, n, compares, moves },
      comment: `第 ${Math.round(Math.log2(len)) + 1} 趟：把长 ${len} 的相邻有序段两两合并成长 ${len * 2} 的有序段`,
    }

    for (let lo = 0; lo < n; lo += 2 * len) {
      const mid = Math.min(lo + len - 1, n - 1)
      const hi = Math.min(lo + 2 * len - 1, n - 1)
      const block = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)

      yield {
        line: 5,
        action: 'mark',
        array: a,
        indices: block,
        range: [lo, hi],
        vars: { len, lo, mid, hi, n, compares, moves },
        comment: `准备合并左段 [${lo}, ${mid}] 和右段 [${mid + 1}, ${hi}] 这两段已经各自有序的数据`,
      }

      if (mid >= hi) {
        yield {
          line: 7,
          action: 'mark',
          array: a,
          indices: block,
          range: [lo, hi],
          vars: { len, lo, mid, hi, n, compares, moves },
          comment: `右段是空的（${mid + 1} > ${hi}），这一段没有东西可并，跳过`,
        }
        continue
      }

      const tmp: number[] = []
      let i = lo
      let j = mid + 1
      while (i <= mid && j <= hi) {
        const av = a[i]!
        const bv = a[j]!
        compares += 1
        yield {
          line: 9,
          action: 'compare',
          array: a,
          indices: [i, j],
          range: [lo, hi],
          vars: { len, lo, mid, hi, i, j, n, compares, moves },
          comment: `比较两个有序段的队首：左段 a[${i}] = ${av}，右段 a[${j}] = ${bv}`,
        }
        if (av <= bv) {
          tmp.push(av)
          i += 1
          yield {
            line: 10,
            action: 'mark',
            array: a,
            indices: [i - 1],
            range: [lo, hi],
            vars: { len, lo, mid, hi, i, j, n, compares, moves },
            comment: `${av} ≤ ${bv}，取左段的 ${av} 放进临时区（临时区现在是 [${tmp.join(', ')}]）`,
          }
        } else {
          tmp.push(bv)
          j += 1
          yield {
            line: 11,
            action: 'mark',
            array: a,
            indices: [j - 1],
            range: [lo, hi],
            vars: { len, lo, mid, hi, i, j, n, compares, moves },
            comment: `${bv} < ${av}，取右段的 ${bv} 放进临时区（临时区现在是 [${tmp.join(', ')}]）`,
          }
        }
      }

      while (i <= mid) {
        const av = a[i]!
        tmp.push(av)
        i += 1
        yield {
          line: 13,
          action: 'mark',
          array: a,
          indices: [i - 1],
          range: [lo, hi],
          vars: { len, lo, mid, hi, i, j, n, compares, moves },
          comment: `右段取完了，左段剩下的 ${av} 直接搬进临时区（临时区现在是 [${tmp.join(', ')}]）`,
        }
      }

      while (j <= hi) {
        const bv = a[j]!
        tmp.push(bv)
        j += 1
        yield {
          line: 14,
          action: 'mark',
          array: a,
          indices: [j - 1],
          range: [lo, hi],
          vars: { len, lo, mid, hi, i, j, n, compares, moves },
          comment: `左段取完了，右段剩下的 ${bv} 直接搬进临时区（临时区现在是 [${tmp.join(', ')}]）`,
        }
      }

      for (let t = 0; t < tmp.length; t++) {
        a[lo + t] = tmp[t]!
        moves += 1
      }
      yield {
        line: 15,
        action: 'set',
        array: a,
        indices: block,
        range: [lo, hi],
        vars: { len, lo, mid, hi, n, compares, moves },
        comment: `把临时区写回 a[${lo}..${hi}]：[${tmp.join(', ')}] —— 两段并成了一段有序数据`,
      }
    }
  }
}

export const mergeSortSpec: AlgorithmSpec = {
  id: 'sort-merge',
  name: '归并排序',
  category: 'sort',
  group: '归并类排序',
  summary: '自底向上：相邻两个有序段两两归并，段长按 1、2、4 倍增',
  complexity: { time: 'O(n log n)', space: 'O(n)', stable: true },
  renderer: 'array',
  codeLines: MERGE_CODE_LINES,
  defaultData: () => [5, 2, 9, 1, 7, 3],
  createRunner: mergeSort,
}

// ---------------------------------------------------------------------------
// 5. 计数排序
// ---------------------------------------------------------------------------

const COUNT_CODE = `void countSort(int a[], int n) {
    int minV = a[0], maxV = a[0];
    for (int i = 1; i < n; i++) {
        if (a[i] < minV) minV = a[i];
        if (a[i] > maxV) maxV = a[i];
    }
    int k = maxV - minV + 1;
    int cnt[100] = {0};
    for (int i = 0; i < n; i++) cnt[a[i] - minV]++;
    for (int v = 1; v < k; v++) cnt[v] += cnt[v - 1];
    int out[100];
    for (int i = n - 1; i >= 0; i--) out[--cnt[a[i] - minV]] = a[i];
    for (int i = 0; i < n; i++) a[i] = out[i];
}`

export const COUNT_CODE_LINES = COUNT_CODE.split('\n')

/** 计数数组那块板子：下标 = 数值，格子正文 = 出现次数 */
function countBoard(minV: number, counts: number[], hot: number[]): BoardView {
  return {
    title: '计数数组 cnt（下标 = 数值，格子 = 出现次数）',
    layout: 'row',
    items: counts.map((c, v) => ({
      text: String(c),
      sub: String(minV + v),
      tone: hot.includes(v) ? 'hot' : c > 0 ? 'mark' : 'base',
    })),
    note:
      hot.length > 0
        ? `正在看数值 ${hot.map((v) => minV + v).join('、')} 这一格`
        : '统计阶段：扫到哪个数，哪个下标就加一',
  }
}

/** 输出数组那块板子 */
function outBoard(out: Array<number | null>, filled: number, hot: number[]): BoardView {
  return {
    title: '输出数组 out（按计数结果依次落位）',
    layout: 'row',
    items: out.map((v, i) => ({
      text: v === null ? '·' : String(v),
      sub: String(i),
      tone: v === null ? 'dim' : hot.includes(i) ? 'hot' : 'base',
    })),
    note: filled > 0 ? `已经落位 ${filled} 个元素` : '还没开始落位',
  }
}

/**
 * 计数排序步骤生成器（不比较，靠"数数"排序）。
 *
 *   line 3 / line 4 -> 统计最小值和最大值
 *   line 7 -> 开计数数组
 *   line 8 -> 每扫到一个元素，对应格子加一
 *   line 9 -> 计数前缀和，算每个值在输出里的结束位置
 *   line 11 -> 从后往前扫描，把元素放进输出数组（倒着扫是为了稳定）
 *   line 12 -> 输出数组整体写回原数组
 *
 * 画面约定：原数组由渲染器的柱子表示，另外用两块 `boards` 同时画出
 * ① 计数数组 cnt（下标 = 数值，格子 = 出现次数）② 输出数组 out。
 */
export function* countSort(a: number[]): AlgoRunner {
  const n = a.length
  let compares = 0
  let moves = 0

  let minV = a[0]!
  let maxV = a[0]!
  for (let i = 1; i < n; i++) {
    const v = a[i]!
    if (v < minV) minV = v
    if (v > maxV) maxV = v
    yield {
      line: 4,
      action: 'mark',
      array: a,
      indices: [i, 0],
      vars: { i, minV, maxV, n, compares, moves },
      comment: `扫描第 ${i} 个元素 a[${i}] = ${v}，目前最小值 minV = ${minV}、最大值 maxV = ${maxV}`,
    }
  }

  const k = maxV - minV + 1
  const counts = Array.from({ length: k }, () => 0)
  const out: Array<number | null> = Array.from({ length: n }, () => null)

  yield {
    line: 7,
    action: 'mark',
    array: a,
    indices: [],
    vars: { minV, maxV, k, n, compares, moves },
    comment: `数据范围是 ${minV}..${maxV}，所以开一个长度 ${k} 的计数数组 cnt，先全部清 0`,
    boards: [countBoard(minV, counts, []), outBoard(out, 0, [])],
  }

  for (let i = 0; i < n; i++) {
    const v = a[i]!
    counts[v - minV] = counts[v - minV]! + 1
    yield {
      line: 8,
      action: 'set',
      array: a,
      indices: [i],
      vars: { i, minV, maxV, k, n, compares, moves },
      comment: `a[${i}] = ${v}，于是 cnt[${v - minV}] 从 ${counts[v - minV]! - 1} 变成 ${counts[v - minV]!}`,
      boards: [countBoard(minV, counts, [v - minV]), outBoard(out, 0, [])],
    }
  }

  for (let v = 1; v < k; v++) {
    counts[v] = counts[v]! + counts[v - 1]!
    yield {
      line: 9,
      action: 'mark',
      array: a,
      indices: [],
      vars: { v, value: minV + v, k, n, compares, moves },
      comment: `前缀和：cnt[${v}] = ${counts[v]!}，表示数值 ${minV + v} 在结果里排到第 ${counts[v]!} 位（含自己）`,
      boards: [countBoard(minV, counts, [v]), outBoard(out, 0, [])],
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    const v = a[i]!
    const at = counts[v - minV]! - 1
    counts[v - minV] = at
    out[at] = v
    moves += 1
    yield {
      line: 11,
      action: 'set',
      array: a,
      indices: [i],
      vars: { i, value: v, at, minV, maxV, k, n, compares, moves },
      comment: `从后往前取 a[${i}] = ${v}，按 cnt 落到输出数组的第 ${at} 位；cnt[${v - minV}] 减到 ${at}（从后往前扫保证相同值的先后次序不变）`,
      boards: [countBoard(minV, counts, [v - minV]), outBoard(out, moves, [at])],
    }
  }

  for (let i = 0; i < n; i++) {
    a[i] = out[i]!
  }
  yield {
    line: 12,
    action: 'set',
    array: a,
    indices: Array.from({ length: n }, (_, i) => i),
    vars: { n, minV, maxV, k, compares, moves },
    comment: `把输出数组写回原数组：[${a.join(', ')}] —— 全程一次都没比较，只用了 ${moves} 次搬动`,
    boards: [countBoard(minV, counts, []), outBoard(out, n, [])],
  }
}

/** 计数排序的默认数据：故意让重复值多一点，不然看不出"计数"的意义 */
function countDefaultData(): number[] {
  return [4, 1, 4, 2, 7, 2, 4, 1]
}

/** 首帧也要把两块板子画出来，否则第一帧只有柱子、看不到计数数组 */
function countInitScene(data: number[]): { boards: BoardView[] } {
  const k = data.length > 0 ? Math.max(...data) - Math.min(...data) + 1 : 1
  const minV = data.length > 0 ? Math.min(...data) : 0
  return {
    boards: [
      countBoard(minV, Array.from({ length: k }, () => 0), []),
      outBoard(Array.from({ length: data.length }, () => null), 0, []),
    ],
  }
}

export const countSortSpec: AlgorithmSpec = {
  id: 'sort-count',
  name: '计数排序',
  category: 'sort',
  group: '分配类排序',
  summary: '不比较元素，先统计每个值出现几次，再按计数直接写进输出数组',
  complexity: { time: 'O(n + k)', space: 'O(n + k)', stable: true },
  renderer: 'array',
  codeLines: COUNT_CODE_LINES,
  defaultData: countDefaultData,
  initScene: countInitScene,
  createRunner: countSort,
}

// ---------------------------------------------------------------------------
// 导出：注册表按这个数组的顺序显示（注册由 index.ts 负责）
// ---------------------------------------------------------------------------

export const sortBasicSpecs: AlgorithmSpec[] = [
  binInsertSortSpec,
  shellSortSpec,
  quickSortSpec,
  mergeSortSpec,
  countSortSpec,
]
