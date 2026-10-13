import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALGORITHM_ID,
  algorithmRegistry,
  getAlgorithm,
  getAlgorithmsByCategory,
  getGroupedByCategory,
} from './index'
import { buildSteps, validateSteps } from '@/core/engine'
import { runBstDelete } from './treeSearch'
import { CATEGORIES } from '@/core/categories'
import { SEQ_CAPACITY } from '@/core/config'
import type {
  AlgoCategoryId,
  AlgorithmSpec,
  AlgoStep,
  RendererKind,
  RunnerContext,
  StepAction,
} from '@/core/types'

const ascending = (a: number[]) => [...a].sort((x, y) => x - y)

/** 通用测试用确定性的参数（中间那个元素），避免 defaultTarget 的随机性影响断言 */
function ctxOf(spec: AlgorithmSpec, input: number[], target?: number): RunnerContext {
  const t =
    target ?? (spec.defaultTarget ? input[Math.floor(input.length / 2)] : undefined)
  return {
    target: t,
    pos: spec.defaultPos?.(input),
    value: spec.defaultValue?.(input),
    capacity: spec.capacity,
  }
}

function prepared(spec: AlgorithmSpec): number[] {
  const raw = spec.defaultData()
  return spec.prepareData ? spec.prepareData(raw) : raw
}

/** 某一帧的树快照 */
type TreeSnapshot = NonNullable<AlgoStep['tree']>

/**
 * 把一棵树快照按左右孩子递归走一遍，返回：
 *   inorder —— 中序序列（二叉排序树 / AVL 里必须**严格升序**，旋转、插入、删除写错都会在这里露出来）
 *   bfs     —— 每个结点的平衡因子（子树高之差，当场按结构现算，不看画面上的小字）
 * 这是树结构算法自己的判据：它们命中的是"结点"，没有数组下标可用。
 */
function walkTree(view: TreeSnapshot): {
  inorder: number[]
  bfs: Array<{ value: number | string; bf: number }>
} {
  const byId = new Map(view.nodes.map((n) => [n.id, n]))
  const inorder: number[] = []
  const bfs: Array<{ value: number | string; bf: number }> = []

  const heightOf = (id: string | null | undefined): number => {
    if (!id) return 0
    const node = byId.get(id)
    if (!node) return 0
    const lh = heightOf(node.left)
    const rh = heightOf(node.right)
    bfs.push({ value: node.value, bf: lh - rh })
    return Math.max(lh, rh) + 1
  }
  const inorderOf = (id: string | null | undefined): void => {
    if (!id) return
    const node = byId.get(id)
    if (!node) return
    inorderOf(node.left)
    inorder.push(Number(node.value))
    inorderOf(node.right)
  }

  heightOf(view.root)
  inorderOf(view.root)
  return { inorder, bfs }
}

/**
 * 多路树（B 树 / B+ 树）的快照没法用 left / right 走：一个结点里装着 keys 数组，
 * 孩子走 children（n 个关键字把范围切成 n+1 段，所以正好 n+1 个孩子）。这里按 children 递归，返回：
 *   leaves  —— 叶子结点（按从左到右的顺序）
 *   depths  —— 结点 id -> 层号（根是第 1 层），用来验证"所有叶子都在同一层"
 *   inorder —— 中序关键字序列（B 树的关键字全树只存一份，这个序列必须严格升序）
 */
function walkMultiway(view: TreeSnapshot): {
  leaves: TreeSnapshot['nodes']
  depths: Map<string, number>
  inorder: number[]
} {
  const byId = new Map(view.nodes.map((n) => [n.id, n]))
  const leaves: TreeSnapshot['nodes'] = []
  const depths = new Map<string, number>()
  const inorder: number[] = []

  const walk = (id: string | null | undefined, depth: number): void => {
    if (!id) return
    const node = byId.get(id)
    if (!node || depths.has(node.id)) return // 自环 / 重复挂同一个孩子时立刻停，别转死
    depths.set(node.id, depth)
    const kids = node.children ?? []
    const keys = (node.keys ?? []).map(Number)
    if (!kids.length) {
      leaves.push(node)
      inorder.push(...keys)
      return
    }
    for (let i = 0; i < keys.length; i++) {
      walk(kids[i], depth + 1)
      inorder.push(keys[i]!)
    }
    walk(kids[keys.length], depth + 1)
  }

  walk(view.root, 1)
  return { leaves, depths, inorder }
}

/** 大根堆判定（下标 0 开始）：每个结点都不小于它的两个孩子 */
function isMaxHeap(a: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const l = 2 * i + 1
    const r = 2 * i + 2
    if (l < a.length && a[i]! < a[l]!) return false
    if (r < a.length && a[i]! < a[r]!) return false
  }
  return true
}

/**
 * 对注册表里每一个算法都跑一遍规范校验。
 * 新增算法时只要行号写错、忘了拷快照、漏写解说，这里立刻会红。
 */
describe('所有已注册算法（步骤序列规范）', () => {
  it('注册表非空、id 唯一、大类都在 CATEGORIES 里', () => {
    expect(algorithmRegistry.length).toBeGreaterThan(0)
    const ids = algorithmRegistry.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)

    const catIds = CATEGORIES.map((c) => c.id)
    for (const spec of algorithmRegistry) expect(catIds).toContain(spec.category)
  })

  it('每个大类都至少有一个算法（否则选择器会点出一个空列）', () => {
    for (const cat of CATEGORIES) {
      expect(getAlgorithmsByCategory(cat.id).length).toBeGreaterThan(0)
    }
  })

  it('每个算法都声明了渲染器，且取值合法', () => {
    const kinds: RendererKind[] = ['array', 'seqlist', 'linked', 'scene', 'tree', 'graph']
    for (const spec of algorithmRegistry) expect(kinds).toContain(spec.renderer)
  })

  for (const spec of algorithmRegistry) {
    describe(`${spec.name}`, () => {
      const input = prepared(spec)
      const steps = buildSteps(spec, input, ctxOf(spec, input))

      it('首帧等于输入，收尾帧是 done', () => {
        expect(steps[0]!.action).toBe('init')
        expect(steps[0]!.array).toEqual(input) // 快照别名的话这里会变
        expect(steps.at(-1)!.action).toBe('done')
      })

      it('每一步都是独立快照对象', () => {
        expect(new Set(steps.map((s) => s.array)).size).toBe(steps.length)
      })

      it('每一步都有解说（SRS 7.1 要求 comment 非空）', () => {
        for (const s of steps) expect(s.comment.trim().length).toBeGreaterThan(0)
      })

      it('高亮行都真实落在非空代码行上', () => {
        for (const s of steps) expect(spec.codeLines[s.line - 1]!.trim()).toBeTruthy()
      })

      it('累计比较次数单调不减', () => {
        let prev = -1
        for (const s of steps) {
          expect(s.stats.compares).toBeGreaterThanOrEqual(prev)
          prev = s.stats.compares
        }
      })

      it('下标都在数据范围内', () => {
        for (const s of steps) {
          for (const i of s.indices) {
            expect(i).toBeGreaterThanOrEqual(0)
            expect(i).toBeLessThan(s.array.length)
          }
        }
      })
    })
  }
})

describe('排序类算法', () => {
  const sortSpecs = getAlgorithmsByCategory('sort')
  /*
   * 排序大类下住着三拨东西，它们的"有序"不是一回事，断言必须分开：
   *   ① 数组类排序（renderer === 'array'）：整条序列就是一个数组，终态必然**整体升序**
   *      （直接插入 / 折半插入 / 希尔 / 冒泡 / 快速 / 选择 / 堆排序 / 归并 / 计数 / 基数都在这一拨）；
   *   ② 堆（group === '选择类排序' 且 renderer === 'scene'，也就是建堆 / 堆调整这两个结构演示）：
   *      数组是堆的层序存储，只保证"父 ≥ 子"这个**偏序**，
   *      大根堆 [10, 8, 9, 7, ...] 本身并不是升序的 —— 之前就是拿"升序"去卡堆才红的；
   *   ③ 外部排序类（group === '外部排序'，renderer 是 scene / tree）：演的是"内存在外存之间倒腾记录"，
   *      画面主体是归并段 / 败者树 / 归并树，不能拿"整条序列升序"去卡它（置换-选择排序的终态就是几段拼起来的）。
   */
  const arraySorts = sortSpecs.filter((s) => s.renderer === 'array')
  const heapSpecs = sortSpecs.filter((s) => s.group === '选择类排序' && s.renderer === 'scene')
  const externalSorts = sortSpecs.filter((s) => s.group === '外部排序')

  it('数组类排序、堆、外部排序三拨都非空，且排序大类里没有算法落在筛选条件之外', () => {
    // 这条守的是"筛选条件写错导致下面几组变成空跑"：三拨都得有货，且合起来正好是整个大类
    // （既不能漏算法，也不能有算法同时落进两拨 —— 那样条数就对不上了）
    expect(arraySorts.length).toBeGreaterThan(0)
    expect(heapSpecs.length).toBeGreaterThan(0)
    expect(externalSorts.length).toBeGreaterThan(0)
    for (const spec of sortSpecs) {
      expect(
        arraySorts.includes(spec) || heapSpecs.includes(spec) || externalSorts.includes(spec),
        `${spec.name} 既不是数组类排序，也不在「堆」/「外部排序」子类里 —— 下面几组用例都会漏掉它`,
      ).toBe(true)
    }
    expect(
      arraySorts.length + heapSpecs.length + externalSorts.length,
      '三拨加起来和排序大类的算法数对不上：要么漏了算法，要么有算法被两拨同时收进去了',
    ).toBe(sortSpecs.length)
  })

  for (const spec of arraySorts) {
    it(`${spec.name}：终态升序有序，且元素守恒`, () => {
      const input = prepared(spec)
      const steps = buildSteps(spec, input, ctxOf(spec, input))
      expect(steps.at(-1)!.array).toEqual(ascending(input))
      expect(steps.at(-1)!.array).toHaveLength(input.length)
    })
  }

  for (const spec of heapSpecs) {
    it(`${spec.name}：终态是合法的大根堆（父 ≥ 子），堆顶是最大值，且元素守恒`, () => {
      const input = prepared(spec)
      const final = buildSteps(spec, input, ctxOf(spec, input)).at(-1)!.array

      // 堆的"有序"是偏序：每个结点 ≥ 它的两个孩子。整体升序在堆上根本不成立
      expect(isMaxHeap(final), `终态 [${final.join(', ')}] 里存在比孩子还小的双亲`).toBe(true)
      expect(final[0], '大根堆的堆顶必须是整个数组的最大值').toBe(Math.max(...input))
      expect([...final].sort((x, y) => x - y), '堆只换位置，不能多出 / 少掉元素').toEqual(
        ascending(input),
      )
      expect(final).toHaveLength(input.length)
    })
  }

  for (const spec of externalSorts) {
    it(`${spec.name}：归并来归并去，记录一个不多一个不少（外部排序只搬数据，不造数据）`, () => {
      const input = prepared(spec)
      const final = buildSteps(spec, input, ctxOf(spec, input)).at(-1)!.array

      /*
       * 外部排序的产物是"若干有序归并段"（置换-选择排序的终态就是几段拼起来的，本身并不整体升序），
       * 但不管怎么分趟、怎么选段、怎么建归并树，记录的总数必须守恒：
       * 少一条 = 某一趟归并漏读了，多一条 = 段被重复并进去了。
       */
      expect(ascending(final), `终态 [${final.join(', ')}] 和输入的元素对不上`).toEqual(
        ascending(input),
      )
      expect(final).toHaveLength(input.length)
    })
  }
})

describe('查找类算法', () => {
  const searchSpecs = getAlgorithmsByCategory('search')
  /*
   * 查找大类下住着三拨东西，验收方式完全不同，不能再混用一套断言：
   *   ① 数组上的查找（renderer === 'array' 且有 defaultTarget）：命中的是**一个下标**，
   *      所以能用 indices / sortedIndices / "命中"解说词来判；
   *   ② 树上的查找（BST / AVL / 红黑树 / B 树 / B+ 树，renderer === 'tree'）：命中的是**一个结点**，
   *      它们没有数组下标可用（bst-insert / bst-delete / AVL 四条旋转压根没有目标值），
   *      要按树自己的性质验收；
   *   ③ 场景上的查找（renderer === 'scene'，哈希表）：画面主体是"桶 + 链"的板子，
   *      连数组下标都不画，index / indices 那一套同样套不上。
   */
  const targetSearches = searchSpecs.filter((s) => !!s.defaultTarget)
  const arraySearches = targetSearches.filter((s) => s.renderer === 'array')
  const treeSearches = searchSpecs.filter((s) => s.renderer === 'tree')
  const sceneSearches = searchSpecs.filter((s) => s.renderer === 'scene')

  it('至少实现了顺序查找与折半查找', () => {
    const ids = searchSpecs.map((s) => s.id)
    expect(ids).toContain('sequential-search')
    expect(ids).toContain('binary-search')
  })

  it('数组查找、树查找、场景查找三拨都非空，且查找大类里没有算法落在筛选条件之外', () => {
    // 同上：防"筛选条件写错 -> 下面几组空跑"
    expect(arraySearches.length).toBeGreaterThan(0)
    expect(treeSearches.length).toBeGreaterThan(0)
    expect(sceneSearches.length).toBeGreaterThan(0)
    for (const spec of searchSpecs) {
      expect(
        arraySearches.includes(spec) || treeSearches.includes(spec) || sceneSearches.includes(spec),
        `${spec.name} 既不是数组上的查找，也不是树上的 / 场景上的查找 —— 下面几组用例都会漏掉它`,
      ).toBe(true)
    }
    expect(
      arraySearches.length + treeSearches.length + sceneSearches.length,
      '三拨加起来和查找大类的算法数对不上：要么漏了算法，要么有算法被两拨同时收进去了',
    ).toBe(searchSpecs.length)
  })

  for (const spec of arraySearches) {
    it(`${spec.name}：对首/中/尾三个目标值都能命中到正确的下标`, () => {
      const input = prepared(spec)
      for (const idx of [0, Math.floor(input.length / 2), input.length - 1]) {
        const target = input[idx]!
        const steps = buildSteps(spec, input, ctxOf(spec, input, target))
        const hit = steps.at(-1)!
        expect(hit.action).toBe('done')
        expect(hit.indices).toEqual([idx])
        expect(hit.array[idx]).toBe(target)
        expect(hit.comment).toContain('命中')
        expect(hit.sortedIndices).toEqual([idx]) // 只有命中那一格是绿的
      }
    })
  }

  // defaultTarget 是"首帧就替用户选好的目标值"：树上的查找也有（bst-search），
  // 所以这里按"有没有 defaultTarget"筛，而不是按大类筛
  for (const spec of targetSearches) {
    it(`${spec.name}：defaultTarget 一定取自数据本身`, () => {
      const input = prepared(spec)
      expect(spec.defaultTarget).toBeTruthy()
      for (let k = 0; k < 30; k++) expect(input).toContain(spec.defaultTarget!(input))
    })
  }

  // ---- 场景上的查找（哈希表）：画面是"桶 + 链"的板子，只验"算桶 -> 顺链比 -> 命中"这条链 ----
  for (const spec of sceneSearches) {
    it(`${spec.name}：目标值取自数据本身时，终态必须落在"命中"那一支`, () => {
      const input = prepared(spec)
      const target = input[Math.floor(input.length / 2)]! // 取自数据本身 -> 必定命中
      expect(input, '自检：用来查找的目标值一定在数据里').toContain(target)

      const last = buildSteps(spec, input, ctxOf(spec, input, target)).at(-1)!
      expect(last.action).toBe('done')
      expect(last.comment, `${spec.name} 的终态没有说明命中`).toContain('命中')
      // 场景查找没有"命中下标"这一说：链表法里命中项可能挂在桶的链上，哪一格都不是数组下标
      expect(last.boards?.length ?? 0, '场景查找的终态连一块板子都没有').toBeGreaterThan(0)
    })
  }

  /*
   * ---- 树上的查找：先按**结构**分成两拨，再各用各的性质验收 ----
   *   二叉：结点里有 left / right（BST / AVL / 红黑树）——"中序严格升序"是它们的判据；
   *   多路：结点里是 keys 数组、孩子走 children（B 树 / B+ 树）——它们**不是二叉树**，
   *        一个结点装多个关键字、B+ 树的内部结点里还全是叶子关键字的副本，
   *        硬套"中序严格升序 + 无重复键"必然红，所以要另立判据。
   * 这里按末帧的真实结构分类（不写死 id），漏掉 / 新增算法都会在下面的守卫里露出来。
   */
  const lastTreeViewOf = (spec: AlgorithmSpec): TreeSnapshot =>
    buildSteps(spec, prepared(spec), ctxOf(spec, prepared(spec))).at(-1)!.tree!
  const treeShapes = new Map(
    treeSearches.map((spec) => {
      const view = lastTreeViewOf(spec)
      return [
        spec.id,
        {
          // 二叉树的结点一定有 left / right（哪怕是 null）
          binary: view.nodes.some((n) => n.left !== undefined || n.right !== undefined),
          // B+ 树的叶子上挂着 next 指针，画成叶子之间那条虚线链；B 树没有
          leafChain: (view.links ?? []).length > 0,
        },
      ] as const
    }),
  )
  const binaryTreeSearches = treeSearches.filter((s) => treeShapes.get(s.id)!.binary)
  const multiwayTreeSearches = treeSearches.filter((s) => !treeShapes.get(s.id)!.binary)
  const leafChainSearches = multiwayTreeSearches.filter((s) => treeShapes.get(s.id)!.leafChain)
  const plainMultiwaySearches = multiwayTreeSearches.filter((s) => !treeShapes.get(s.id)!.leafChain)

  it('二叉排序树 / 多路平衡查找树两拨都非空，且树上的查找没有落在两拨之外的', () => {
    // 防"结构判断写错 -> 下面的二叉组或多路组变成空跑"
    expect(binaryTreeSearches.length).toBeGreaterThan(0)
    expect(multiwayTreeSearches.length).toBeGreaterThan(0)
    expect(
      binaryTreeSearches.length + multiwayTreeSearches.length,
      '两拨加起来和树上的查找对不上',
    ).toBe(treeSearches.length)
    // 多路树内部还要再分：有叶子链表的是 B+ 树，没有的是 B 树，两边都得有货
    expect(leafChainSearches.length).toBeGreaterThan(0)
    expect(plainMultiwaySearches.length).toBeGreaterThan(0)
  })

  for (const spec of binaryTreeSearches) {
    it(`${spec.name}：终态是一棵合法的二叉排序树（中序严格升序，且逻辑序列与树结构一致）`, () => {
      const input = prepared(spec)
      const last = buildSteps(spec, input, ctxOf(spec, input)).at(-1)!
      expect(last.action).toBe('done')

      const { inorder } = walkTree(last.tree!)
      expect(inorder.length, '末帧树上一个结点都没有').toBeGreaterThan(0)
      // BST 的判据：中序序列必须严格升序；旋转 / 删除写错时这里一定会露出来
      expect(inorder).toEqual(ascending(inorder))
      expect(new Set(inorder).size, '树上出现了重复的关键字').toBe(inorder.length)

      /*
       * array 字段是数据栏的"逻辑顺序"，它和树上的键必须对得上。
       *   BST / AVL：数据栏就是中序序列，逐位都要相等；
       *   红黑树：数据栏故意按**插入顺序**排（插入顺序决定它最后长什么样，
       *           [10,20,30,40,35,50,45] 本身就不升序），所以只要求键的集合一致。
       */
      expect([...last.array].sort((x, y) => x - y), '数据栏的键和树上的键对不上').toEqual(inorder)
      const coloredPanel = last.tree!.nodes.some((n) => n.color !== undefined) // 结点带颜色 = 红黑树
      if (!coloredPanel) {
        expect(last.array, '数据栏本来就该是中序序列').toEqual(inorder)
      }
    })
  }

  for (const spec of multiwayTreeSearches) {
    it(`${spec.name}：终态是一棵合法的多路平衡查找树（结点内关键字有序、孩子数自洽、所有叶子同层）`, () => {
      const input = prepared(spec)
      const last = buildSteps(spec, input, ctxOf(spec, input)).at(-1)!
      expect(last.action).toBe('done')
      const view = last.tree!
      const { leaves, depths, inorder } = walkMultiway(view)

      // ① 结点内关键字必须严格升序：一个结点里乱序 / 塞重复关键字，查找时的"顺序比较"就不成立了
      for (const n of view.nodes) {
        const keys = (n.keys ?? []).map(Number)
        expect(keys.length, `结点 ${n.id} 里一个关键字都没有`).toBeGreaterThan(0)
        expect(keys, `结点 ${n.id} 的关键字 [${keys.join(', ')}] 没按升序排`).toEqual(ascending(keys))
        expect(
          new Set(keys).size,
          `结点 ${n.id} 里出现了重复的关键字 [${keys.join(', ')}]`,
        ).toBe(keys.length)

        // n 个关键字把关键字范围切成 n+1 段 -> 内部结点必须正好 n+1 个孩子
        const kids = n.children ?? []
        if (kids.length) {
          expect(
            kids.length,
            `结点 ${n.id} 有 ${keys.length} 个关键字，却有 ${kids.length} 个孩子`,
          ).toBe(keys.length + 1)
        }
      }

      // ② 所有叶子都在同一层 —— B 树 / B+ 树说的"平衡"就是这一条（每条从根到叶的路一样长）
      expect(leaves.length, '一个叶子都没有').toBeGreaterThan(0)
      const levels = [...new Set(leaves.map((n) => depths.get(n.id)))]
      expect(levels, `叶子不在同一层（分别落在第 ${levels.join(' / ')} 层）`).toHaveLength(1)
      // 每个结点都得从根走得到，否则就是 children 指针断了一棵子树（画面上会凭空少一块）
      expect(depths.size, '有结点从根走不到（children 指针断了）').toBe(view.nodes.length)

      if (plainMultiwaySearches.includes(spec)) {
        // ③ B 树的关键字全树只存一份：中序序列就是全部关键字的升序序列，条数也该正好对上
        const all = view.nodes.flatMap((n) => (n.keys ?? []).map(Number))
        const distinct = [...new Set(input)].sort((a, b) => a - b)
        expect(inorder, 'B 树的中序序列不是升序的').toEqual(ascending(inorder))
        expect(inorder, 'B 树上的关键字和数据对不上（多了 / 少了 / 顺序不对）').toEqual(distinct)
        expect(all.length, 'B 树里同一个关键字存了不止一份').toBe(distinct.length)
        // array 字段是"逻辑顺序"，B 树里它就是全部关键字的升序序列
        expect(last.array).toEqual(distinct)
      }
    })
  }

  for (const spec of leafChainSearches) {
    it(`${spec.name}：关键字全在叶子层、叶子从左到右整体有序，且叶子链表真的把它们串起来了`, () => {
      const input = prepared(spec)
      const last = buildSteps(spec, input, ctxOf(spec, input)).at(-1)!
      const view = last.tree!
      const { leaves } = walkMultiway(view)
      const distinct = [...new Set(input)].sort((a, b) => a - b)

      // ① 关键字必须全部落在叶子层：叶子上的关键字去重后就是数据全集（缺一个 = 数据丢在索引里了）
      const leafKeys = leaves.flatMap((n) => (n.keys ?? []).map(Number))
      expect(
        [...new Set(leafKeys)].sort((a, b) => a - b),
        '有关键字不在叶子层（B+ 树的内部结点只是索引副本，不能当成数据存放的地方）',
      ).toEqual(distinct)
      expect(leafKeys.length, '叶子层出现了重复的关键字（每个关键字只该有一份真身）').toBe(
        distinct.length,
      )

      // ② 叶子从左到右整体有序：把叶子上的关键字首尾接起来必须是严格升序
      expect(leafKeys, '叶子层从左到右的关键字没有整体升序').toEqual(ascending(leafKeys))
      expect(new Set(leafKeys).size).toBe(leafKeys.length)

      // ③ 叶子之间的 next 指针必须一条链串到底、顺序和叶子的左右顺序一致
      //    （链断了 / 指回头 / 指到索引结点上，范围查找就会走丢）
      const nextOf = new Map((view.links ?? []).map((l) => [l.from, l.to] as const))
      const ordered = leaves.map((n) => n.id)
      const byChain: string[] = [ordered[0]!]
      while (byChain.length <= ordered.length) {
        const nxt = nextOf.get(byChain[byChain.length - 1]!)
        if (nxt === undefined) break
        byChain.push(nxt)
      }
      expect(byChain, '顺着叶子的 next 指针走，出来的不是"叶子从左到右"这一串').toEqual(ordered)
      expect(view.links?.length ?? 0, '叶子链表的链数不对（除了最后一片叶子，每片都该有一条链）').toBe(
        ordered.length - 1,
      )

      // ④ 内部结点里的索引必须是"它右边那棵子树的最小关键字"的副本 —— 这是 B+ 树索引的定义
      const byId = new Map(view.nodes.map((n) => [n.id, n]))
      const minOf = (id: string): number => {
        const n = byId.get(id)!
        const kids = n.children ?? []
        // 最左边那棵子树里装着整棵子树的最小关键字
        return kids.length ? minOf(kids[0]!) : Math.min(...(n.keys ?? []).map(Number))
      }
      let checkedIndexes = 0
      for (const n of view.nodes) {
        const kids = n.children ?? []
        if (!kids.length) continue // 叶子层没有索引
        const keys = (n.keys ?? []).map(Number)
        for (let i = 0; i < keys.length; i++) {
          expect(
            keys[i],
            `索引结点 ${n.id} 里第 ${i + 1} 个索引 ${keys[i]} 不是"右子树最小关键字"的副本`,
          ).toBe(minOf(kids[i + 1]!))
          checkedIndexes++
        }
      }
      expect(checkedIndexes, 'B+ 树里一个索引都没有，这棵树根本没长高 —— 这条断言等于没跑').toBeGreaterThan(0)

      // ⑤ 逻辑序列（array）= 叶子层从左到右的关键字 = 数据全集
      expect(last.array).toEqual(leafKeys)
      expect(last.array).toEqual(distinct)
    })
  }

  for (const spec of searchSpecs.filter((s) => s.group === '二叉排序树')) {
    it(`${spec.name}：树上的关键字全部来自数据本身`, () => {
      const input = prepared(spec)
      const last = buildSteps(spec, input, ctxOf(spec, input)).at(-1)!
      const { inorder } = walkTree(last.tree!)
      expect(inorder.length).toBeGreaterThan(0)
      for (const v of inorder) expect(input, `树上出现了数据里没有的关键字 ${v}`).toContain(v)
    })
  }

  /*
   * AVL 四种旋转和红黑树现在同属「平衡二叉树」**一个**子类（选择器里只画一个标题），
   * 所以这里只能用 id 前缀把四种旋转挑出来 —— 红黑树没有平衡因子 bf，混进来会误判。
   */
  const avlRotations = searchSpecs.filter((s) => s.id.startsWith('avl-'))

  it('AVL 四种旋转一个都不少（过滤条件写歪的话，下面那批用例会一条都不跑）', () => {
    expect(avlRotations.map((s) => s.id)).toEqual(['avl-ll', 'avl-rr', 'avl-lr', 'avl-rl'])
  })

  for (const spec of avlRotations) {
    it(`${spec.name}：旋转之后每个结点的 |平衡因子| 都 ≤ 1（旋转真的做完了）`, () => {
      const input = prepared(spec)
      const last = buildSteps(spec, input, ctxOf(spec, input)).at(-1)!
      const { inorder, bfs } = walkTree(last.tree!)

      expect(bfs.length, '有结点没算到平衡因子').toBe(inorder.length)
      for (const n of bfs) {
        expect(Math.abs(n.bf), `结点 ${n.value} 的平衡因子是 ${n.bf}`).toBeLessThanOrEqual(1)
      }
      // 旋转只调结构、不丢结点：失衡前 5 个 + 新插入的 1 个 = sizes 里声明的规模
      expect(inorder).toHaveLength(spec.sizes![0]!)
    })
  }

  it('二叉排序树·查找：命中是在树上标绿那个结点，落空是一路走到 NULL', () => {
    const spec = getAlgorithm('bst-search')
    const input = prepared(spec)
    const target = input[Math.floor(input.length / 2)]! // 中间的键一定在树里
    const steps = buildSteps(spec, input, ctxOf(spec, input, target))

    // 「只标绿一个结点」的帧就是命中帧（收尾帧是把整棵树都标绿的那一帧，不算）
    const hitFrame = steps.find((s) => (s.tree?.done ?? []).length === 1)
    expect(hitFrame, '全程都没有出现"只标绿一个结点"的命中帧').toBeTruthy()
    const hitId = hitFrame!.tree!.done![0]!
    const hitNode = hitFrame!.tree!.nodes.find((n) => n.id === hitId)!
    expect(hitNode.value).toBe(target)
    expect(hitFrame!.comment).toContain('查找成功')
    expect(hitFrame!.tree!.note, '命中帧应该点明"绿色 = 命中的结点"').toContain('命中')

    const missFrame = steps.find((s) => s.tree?.pointers?.p === null)
    expect(missFrame, '只演了命中，没演"走到 NULL"的落空分支').toBeTruthy()
    expect(missFrame!.comment).toContain('NULL')
  })

  it('折半查找：候选区间单调收窄，且明显快于顺序查找', () => {
    const spec = getAlgorithm('binary-search')
    const input = prepared(spec)
    const target = input[6]!
    const steps = buildSteps(spec, input, ctxOf(spec, input, target))

    const widths = steps
      .map((s) => (s.range ? s.range[1] - s.range[0] : null))
      .filter((w): w is number => w !== null)
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThanOrEqual(widths[i - 1]!)
    }
    expect(widths.at(-1)!).toBeLessThan(widths[0]!)
    expect(steps.at(-1)!.stats.compares).toBeLessThanOrEqual(4)
  })

  it('折半查找会把无序输入先规整成有序', () => {
    expect(getAlgorithm('binary-search').prepareData!([9, 1, 7, 3, 5, 2, 8, 4])).toEqual([
      1, 2, 3, 4, 5, 7, 8, 9,
    ])
  })
})

describe('线性表 · 顺序表', () => {
  const seqSpecs = getAlgorithmsByCategory('linear').filter((s) => s.group === '顺序表')

  it('四个基本操作都在（插入 / 删除 / 按值查找 / 按位查找）', () => {
    const ids = seqSpecs.map((s) => s.id)
    expect(ids).toEqual(
      expect.arrayContaining(['seq-insert', 'seq-delete', 'seq-locate', 'seq-get']),
    )
  })

  it('都声明了容量，且渲染器是 seqlist', () => {
    for (const spec of seqSpecs) {
      expect(spec.renderer).toBe('seqlist')
      expect(spec.capacity).toBe(SEQ_CAPACITY)
    }
  })

  it('插入：表长 +1，新元素落在指定位序上，其余元素顺序不变', () => {
    const spec = getAlgorithm('seq-insert')
    const input = prepared(spec)
    const pos = spec.defaultPos!(input)
    const x = spec.defaultValue!(input)
    const steps = buildSteps(spec, input, ctxOf(spec, input))
    const final = steps.at(-1)!.array

    expect(final).toHaveLength(input.length + 1)
    expect(final[pos - 1]).toBe(x)
    // 位序 pos 之前不动，之后是原来的元素整体后移
    expect(final.slice(0, pos - 1)).toEqual(input.slice(0, pos - 1))
    expect(final.slice(pos)).toEqual(input.slice(pos - 1))
  })

  it('删除：表长 -1，被删元素消失，其余元素顺序不变', () => {
    const spec = getAlgorithm('seq-delete')
    const input = prepared(spec)
    const pos = spec.defaultPos!(input)
    const removed = input[pos - 1]
    const steps = buildSteps(spec, input, ctxOf(spec, input))
    const final = steps.at(-1)!.array

    expect(final).toHaveLength(input.length - 1)
    expect(final).toEqual([...input.slice(0, pos - 1), ...input.slice(pos)])
    expect(final.filter((v) => v === removed).length).toBe(
      input.filter((v) => v === removed).length - 1,
    )
  })

  it('按值查找：命中位序正确；找不到时返回 0', () => {
    const spec = getAlgorithm('seq-locate')
    const input = prepared(spec)

    const idx = 2
    const hit = buildSteps(spec, input, ctxOf(spec, input, input[idx]!)).at(-1)!
    expect(hit.indices).toEqual([idx])
    expect(hit.comment).toContain(`位序是 ${idx + 1}`)

    // 换一个一定不存在的值，应当走"没找到"分支
    const missing = Math.max(...input) + 1000
    const miss = buildSteps(spec, input, ctxOf(spec, input, missing)).at(-1)!
    expect(miss.indices).toEqual([])
    expect(miss.comment).toContain('没找到')
  })

  it('按位查找：一步到位，不遍历（O(1)）', () => {
    const spec = getAlgorithm('seq-get')
    const input = prepared(spec)
    const pos = spec.defaultPos!(input)
    const steps = buildSteps(spec, input, ctxOf(spec, input))
    const last = steps.at(-1)!

    expect(last.array).toEqual(input) // 不改数据
    expect(last.indices).toEqual([pos - 1])
    expect(last.comment).toContain(String(input[pos - 1]))
    // 步数极少 —— 这就是"随机存取"，而链表按位查找必须从头走
    expect(steps.length).toBeLessThanOrEqual(5)
  })

  it('顺序表：任一时刻都不会超过容量', () => {
    for (const spec of seqSpecs) {
      const input = prepared(spec)
      for (const s of buildSteps(spec, input, ctxOf(spec, input))) {
        expect(s.array.length).toBeLessThanOrEqual(SEQ_CAPACITY)
      }
    }
  })
})

describe('步骤序列校验器', () => {
  const makeSpec = (line: number): AlgorithmSpec => ({
    id: 'bad',
    name: 'bad',
    category: 'sort',
    summary: '',
    complexity: { time: '-', space: '-' },
    renderer: 'array',
    codeLines: ['a', 'b', 'c'],
    defaultData: () => [1],
    createRunner: function* () {
      yield { line, action: 'compare', array: [1], comment: 'x' }
    },
  })

  it('行号越界时抛错', () => {
    expect(() => buildSteps(makeSpec(99), [1])).toThrow(/越界/)
  })

  it('行号指向空行时抛错', () => {
    const spec = makeSpec(2)
    spec.codeLines = ['a', '', 'c']
    expect(() => buildSteps(spec, [1])).toThrow(/空行/)
  })

  it('忘了写解说时抛错', () => {
    const spec = makeSpec(1)
    spec.createRunner = function* () {
      yield { line: 1, action: 'compare', array: [1] }
    }
    expect(() => buildSteps(spec, [1])).toThrow(/解说/)
  })

  it('起始快照被就地修改时抛错（防引用别名）', () => {
    const steps = [
      {
        line: 1,
        action: 'compare' as const,
        array: [2, 1],
        indices: [],
        sortedIndices: [],
        comment: 'x',
        stats: { compares: 0, swaps: 0 },
      },
    ]
    expect(() => validateSteps(steps, ['a'], [1, 2])).toThrow(/起始快照/)
  })

  it('顺序表超过容量时抛错', () => {
    const steps = [
      {
        line: 1,
        action: 'init' as const,
        array: [1, 2, 3],
        indices: [],
        sortedIndices: [],
        comment: 'x',
        vars: { n: 3, capacity: 2 },
        stats: { compares: 0, swaps: 0 },
      },
    ]
    expect(() => validateSteps(steps, ['a'], [1, 2, 3], 'seqlist')).toThrow(/容量/)
  })
})

describe('线性表 · 链表', () => {
  const linkedSpecs = getAlgorithmsByCategory('linear').filter((s) => s.group !== '顺序表')
  const run = (spec: AlgorithmSpec) => {
    const input = prepared(spec)
    return { input, steps: buildSteps(spec, input, ctxOf(spec, input)) }
  }

  it('链表类算法都声明了首帧结构，否则第一步画不出东西', () => {
    for (const spec of linkedSpecs) {
      expect(spec.renderer).toBe('linked')
      expect(spec.initList, `${spec.name} 缺少 initList`).toBeTruthy()
      const { steps } = run(spec)
      for (const s of steps) expect(s.list, `${spec.name} 有步骤缺 list`).toBeTruthy()
    }
  })

  it('头插法和尾插法的结果顺序正好相反', () => {
    const head = getAlgorithm('sll-create-head')
    const tail = getAlgorithm('sll-create-tail')
    const input = prepared(head)
    expect(buildSteps(head, input, {}).at(-1)!.array).toEqual([...input].reverse())
    expect(buildSteps(tail, input, {}).at(-1)!.array).toEqual(input)
  })

  it('单链表按序号查找：能找到正确的结点，越界时返回 NULL', () => {
    const spec = getAlgorithm('sll-get')
    const input = prepared(spec)
    const hit = buildSteps(spec, input, { ...ctxOf(spec, input), pos: 3 }).at(-1)!
    expect(hit.comment).toContain(String(input[2]))

    const miss = buildSteps(spec, input, { ...ctxOf(spec, input), pos: input.length + 1 }).at(-1)!
    expect(miss.list!.pointers.p).toBeNull()
    expect(miss.comment).toContain('不存在')
  })

  it('单链表插入：新结点落在指定位序上，其余顺序不变', () => {
    const spec = getAlgorithm('sll-insert')
    const input = prepared(spec)
    const pos = spec.defaultPos!(input)
    const x = spec.defaultValue!(input)
    const final = buildSteps(spec, input, ctxOf(spec, input)).at(-1)!.array
    expect(final).toHaveLength(input.length + 1)
    expect(final[pos - 1]).toBe(x)
    expect([...final.slice(0, pos - 1), ...final.slice(pos)]).toEqual(input)
  })

  it('单链表删除：目标结点从链上消失，其余顺序不变', () => {
    const spec = getAlgorithm('sll-delete')
    const input = prepared(spec)
    const pos = spec.defaultPos!(input)
    const final = buildSteps(spec, input, ctxOf(spec, input)).at(-1)!.array
    expect(final).toEqual([...input.slice(0, pos - 1), ...input.slice(pos)])
  })

  it('双链表插入 / 删除：收尾时两个方向的指针完全自洽', () => {
    // 注意只校验**收尾帧**：
    // 双链表要改 2~4 根指针，而指针更新不可能是原子的，
    // 所以中间帧一定会短暂地出现"前驱的 next 指着 A、A 的 prev 却指着别人"的状态 ——
    // 这正是双链表插入/删除教学里"顺序不能乱"的由来，不是 bug。
    for (const id of ['dll-insert', 'dll-delete']) {
      const spec = getAlgorithm(id)
      const { input, steps } = run(spec)
      const lv = steps.at(-1)!.list!
      const byId = new Map(lv.nodes.map((n) => [n.id, n]))

      for (const n of lv.nodes) {
        if (n.next) expect(byId.get(n.next)!.prev).toBe(n.id)
        if (n.prev) expect(byId.get(n.prev)!.next).toBe(n.id)
      }
      // 头结点没有前驱，尾结点没有后继
      expect(lv.nodes.find((n) => n.dummy)!.prev).toBeNull()
      const lastInOrder = byId.get(lv.order[lv.order.length - 1]!)!
      expect(lastInOrder.next).toBeNull()

      const final = steps.at(-1)!.array
      expect(final).toHaveLength(id === 'dll-insert' ? input.length + 1 : input.length - 1)
    }
  })

  it('判断有环：快慢指针能判定出这条链有环', () => {
    const spec = getAlgorithm('cycle-detect')
    const { steps } = run(spec)
    const last = steps.at(-1)!
    expect(last.list!.hasCycle).toBe(true)
    expect(last.comment).toContain('有环')
    // 快慢指针最终必须停在同一个结点上
    expect(last.list!.pointers.slow).toBe(last.list!.pointers.fast)
  })

  it('找环入口：找到的入口就是当初接回去的那个结点', () => {
    const spec = getAlgorithm('cycle-entry')
    const { input, steps } = run(spec)
    const last = steps.at(-1)!
    const lv = last.list!
    expect(lv.cycleEntry).toBeTruthy()

    // 独立算一遍真正的入口：尾结点的 next 指向谁，谁就是入口
    const byId = new Map(lv.nodes.map((n) => [n.id, n]))
    const tail = lv.nodes.find((n) => lv.order[lv.order.length - 1] === n.id)!
    const trueEntry = byId.get(tail.next!)!
    expect(lv.cycleEntry).toBe(trueEntry.id)
    expect(trueEntry.value).toBe(input[2])

    // 第二阶段结束时两个指针必须在入口处相遇
    expect(lv.pointers.slow).toBe(lv.cycleEntry)
    expect(lv.pointers.fast).toBe(lv.cycleEntry)
  })
})

describe('两级选择器的分组数据', () => {
  it('线性表大类下的算法按子类分组，注册顺序被保留', () => {
    const groups = getGroupedByCategory('linear')
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) expect(g.items.length).toBeGreaterThan(0)

    const flat = groups.flatMap((g) => g.items.map((i) => i.id))
    expect(flat).toEqual(getAlgorithmsByCategory('linear').map((i) => i.id))
  })

  it('每个大类的子类分组都聚合正确：组不空、组内同 group、拼起来就是整个大类', () => {
    for (const cat of CATEGORIES) {
      const all = getAlgorithmsByCategory(cat.id)
      const groups = getGroupedByCategory(cat.id)

      expect(groups.length, `${cat.name} 一组都没有`).toBeGreaterThan(0)
      for (const g of groups) {
        expect(g.items.length, `子类「${g.group || '（无子类）'}」是空的`).toBeGreaterThan(0)
        // 组里的每一项都必须真的是这个子类的成员，否则选择器会把它挂到别的标题下面
        for (const item of g.items) expect(item.group ?? '').toBe(g.group)
      }
      // 分完组再拉平，顺序必须和注册顺序一模一样（选择器第二列就按这个顺序排）
      expect(groups.flatMap((g) => g.items.map((s) => s.id))).toEqual(all.map((s) => s.id))
    }
  })

  it('排序和查找的子类标题按实际情况精确匹配（注册顺序变了这里就红）', () => {
    /** 组名 + 组内算法 id：既反映界面上画几个小标题，也盯住注册表里的相邻关系 */
    const grouped = (cat: AlgoCategoryId) =>
      getGroupedByCategory(cat).map((g) => [g.group, g.items.map((i) => i.id)])

    /*
     * getGroupedByCategory 只把**相邻**的同 group 合并成一组，所以下面这份清单就是
     * "选择器第二列会画出哪些小标题、每个标题下面挂着谁"。两条硬要求：
     *   ① 组名互不重复 —— 同名组一旦被别的子类隔开，界面上就会冒出两个同名标题
     *      （「计数排序 → 堆排序 → 基数排序」当年就是把「分配类排序」裂成了两组）；
     *   ② 组内相邻 —— 就是这份清单本身：算法插错位置、group 写错，这里立刻红。
     */
    expect(grouped('sort')).toEqual([
      ['插入类排序', ['insertion-sort', 'sort-bin-insert', 'sort-shell']],
      ['交换类排序', ['bubble-sort', 'sort-quick']],
      ['选择类排序', ['selection-sort', 'sort-heap', 'heap-build', 'heap-sift']],
      ['归并类排序', ['sort-merge']],
      ['分配类排序', ['sort-count', 'sort-radix']],
      ['外部排序', ['sort-external', 'sort-loser-tree', 'sort-replace-select', 'sort-optimal-merge']],
    ])
    expect(grouped('search')).toEqual([
      ['线性表的查找', ['sequential-search', 'binary-search', 'search-block']],
      ['二叉排序树', ['bst-insert', 'bst-search', 'bst-delete']],
      ['平衡二叉树', ['avl-ll', 'avl-rr', 'avl-lr', 'avl-rl', 'rb-tree']],
      ['多路平衡查找树', ['b-tree', 'b-plus-tree']],
      ['散列表', ['search-hash']],
    ])

    // 子类标题不是摆设：组名不重复、没有空标题的组、每个组里都真的装着算法
    for (const cat of ['sort', 'search'] as const) {
      const groups = getGroupedByCategory(cat)
      const names = groups.map((g) => g.group)
      expect(new Set(names).size, `${cat} 大类的子类标题重名了：${names.join(' / ')}`).toBe(
        names.length,
      )
      for (const g of groups) {
        // 空 group 的组在选择器里不画标题，排序 / 查找这两块不该有这种组
        expect(g.group, `${cat} 大类里出现了空标题的组`).not.toBe('')
        expect(g.items.length, `子类「${g.group}」空着`).toBeGreaterThan(0)
      }
    }
  })
})

describe('默认算法与注册表顺序', () => {
  it('默认算法是显式指定的，不随大类顺序 / 注册表顺序变化', () => {
    /*
     * 大类顺序调成"线性表在最上、排序在最下"之后，注册表第一条不再是排序算法。
     * 默认算法必须是**写死**的冒泡排序，认不出的 id 也退回它 —— 否则"打开页面看到哪个
     * 算法"这件事就悄悄由数组顺序决定了（当年 sort 在最前面时刚好蒙对）。
     */
    expect(DEFAULT_ALGORITHM_ID).toBe('bubble-sort')
    expect(getAlgorithm(DEFAULT_ALGORITHM_ID).name).toBe('冒泡排序')
    expect(getAlgorithm('这个 id 不存在').id).toBe(DEFAULT_ALGORITHM_ID)
  })

  it('大类顺序就是用户看到的左列顺序', () => {
    expect(CATEGORIES.map((c) => c.name)).toEqual([
      '线性表',
      '栈',
      '队列',
      '数组与矩阵',
      '串',
      '树与二叉树',
      '图',
      '动态规划',
      '查找',
      '排序',
    ])
  })
})

describe('栈：进出栈的步骤粒度', () => {
  it('链栈进栈：首帧必须是空栈，元素一个个压进去', () => {
    /*
     * 这条守的是首帧结构：进栈演示若把 initList 写成"已经装好全部元素"，
     * 首帧就是满的，生成器却从空栈开始压 —— 画面会在第 2 帧凭空清空一次。
     */
    const spec = getAlgorithm('stack-linked-push')
    const input = spec.defaultData()
    const steps = buildSteps(spec, input, {})
    const counts = steps.map((s) => s.list!.nodes.filter((n) => !n.dummy).length)

    expect(counts[0]).toBe(0)
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]! - counts[i - 1]!, `第 ${i + 1} 步结点数从 ${counts[i - 1]} 变成 ${counts[i]}`)
        .toBeLessThanOrEqual(1)
    }
    expect(counts.at(-1)).toBe(input.length)
  })

  it('顺序栈出栈：每个元素各出栈一次，终态为空栈', () => {
    const spec = getAlgorithm('stack-seq-pop')
    const input = spec.defaultData()
    const steps = buildSteps(spec, input, { capacity: spec.capacity })

    expect(steps.at(-1)!.array).toEqual([])

    // 每个元素都要有属于自己的一帧"取出栈顶元素"，且顺序是后进先出
    const taken = steps
      .map((s) => s.comment.match(/取出栈顶元素 (\S+)/)?.[1])
      .filter((v): v is string => !!v)
    expect(taken).toEqual([...input].reverse().map(String))
  })

  it('栈里的元素数只能一格一格减少，不能一帧消失好几个', () => {
    /*
     * 这条守的是一个很隐蔽的写法错误：循环边界写成 `i < stack.length`。
     * 每出一栈长度就少 1，条件会提前失败 —— 剩下的元素永远出不掉，
     * 再被收尾帧一次性清空，看上去就是"最后几个元素一起没了"。
     */
    for (const id of ['stack-seq-pop', 'stack-linked-pop']) {
      const spec = getAlgorithm(id)
      const steps = buildSteps(spec, spec.defaultData(), { capacity: spec.capacity })
      const counts = steps.map((s) => s.array.length)
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1]! - counts[i]!,
          `${id} 第 ${i + 1} 步：元素数从 ${counts[i - 1]} 直接掉到 ${counts[i]}`,
        ).toBeLessThanOrEqual(1)
      }
      expect(counts.at(-1)).toBe(0)
    }
  })
})

describe('线索二叉树：线索不能一帧有一帧没有', () => {
  it('中序线索化：线索条数只增不减（累积性的东西不能被漏掉一帧）', () => {
    const spec = getAlgorithm('thread-inorder')
    const steps = buildSteps(spec, spec.defaultData(), {})
    const counts = steps.slice(1).map((s) => s.tree?.links?.length ?? 0)
    for (let i = 1; i < counts.length; i++) {
      expect(
        counts[i]!,
        `第 ${i + 1} 步线索从 ${counts[i - 1]} 条掉到 ${counts[i]} 条 —— 有帧漏传了 links`,
      ).toBeGreaterThanOrEqual(counts[i - 1]!)
    }
    expect(counts.at(-1)).toBeGreaterThan(0)
  })

  it('线索二叉树的遍历：每一帧都能看到线索', () => {
    const spec = getAlgorithm('thread-traverse')
    const steps = buildSteps(spec, spec.defaultData(), {})
    for (let i = 1; i < steps.length; i++) {
      expect(
        steps[i]!.tree?.links?.length ?? 0,
        `第 ${i + 1} 步一条线索都没有`,
      ).toBeGreaterThan(0)
    }
  })
})

describe('孩子表示法：画出来的链表顺序必须和代码的头插法一致', () => {
  it('链头是最后插入的那个孩子（不是最先插入的）', () => {
    const spec = getAlgorithm('tree-child-repr')
    const steps = buildSteps(spec, spec.defaultData(), {})
    const last = steps.at(-1)!
    const board = last.boards!.find((b) => b.title.includes('孩子'))!
    const cols = board.cols!
    const nodes = last.tree!.nodes
    let checked = 0
    for (let i = 0; i < nodes.length; i++) {
      const inserted = (nodes[i]!.children ?? []).map((c) => Number(c.slice(1)))
      if (!inserted.length) continue
      // 该行第 1..len 格就是这条孩子链表
      const shown = inserted.map((_, k) => board.items[i * cols + 1 + k]!.text)
      const expected = inserted
        .slice()
        .reverse()
        .map((j) => String(j))
      expect(shown, `下标 ${i} 的孩子链表顺序不对（头插法应该是 ${expected.join('→')}）`).toEqual(expected)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe('串 · 模式匹配', () => {  // 例子：主串 ABABCABCACBAB，模式串 ABCAC —— 匹配成功位置是第 6 个字符
  const arrOf = (id: string, title: string): string[] => {
    const spec = getAlgorithm(id)
    const steps = buildSteps(spec, spec.defaultData(), {})
    const board = steps.at(-1)!.boards!.find((b) => b.title.includes(title))!
    return board.items.map((it) => it.text)
  }

  it('BF 和 KMP 都找到"第 6 个字符"', () => {
    for (const id of ['bf-match', 'kmp-match']) {
      const spec = getAlgorithm(id)
      const steps = buildSteps(spec, spec.defaultData(), {})
      expect(steps.at(-1)!.comment, id).toContain('第 6 个字符')
    }
  })

  it('next 数组求对了：0 1 1 1 2', () => {
    expect(arrOf('kmp-next', 'next 数组')).toEqual(['0', '1', '1', '1', '2'])
  })

  it('nextval 数组求对了：0 1 1 0 2（第 4 位比 next 更优）', () => {
    expect(arrOf('kmp-nextval', 'nextval 数组')).toEqual(['0', '1', '1', '0', '2'])
  })

  it('KMP 的主串指针 i 全程不回退 —— 这正是它比 BF 快的原因', () => {
    const spec = getAlgorithm('kmp-match')
    const steps = buildSteps(spec, spec.defaultData(), {})
    const is = steps.map((s) => s.vars?.i).filter((v): v is number => v !== undefined)
    expect(is.length).toBeGreaterThan(3)
    for (let k = 1; k < is.length; k++) {
      expect(is[k]!, `第 ${k} 步 i 从 ${is[k - 1]} 退回了 ${is[k]}`).toBeGreaterThanOrEqual(is[k - 1]!)
    }
  })

  it('BF 的主串指针确实会回退 —— 和 KMP 形成对照', () => {
    const spec = getAlgorithm('bf-match')
    const steps = buildSteps(spec, spec.defaultData(), {})
    const is = steps.map((s) => s.vars?.i).filter((v): v is number => v !== undefined)
    const back = is.some((v, k) => k > 0 && v < is[k - 1]!)
    expect(back).toBe(true)
  })
})

describe('稀疏矩阵：数据规模按"最接近矩形"的整数边长摆', () => {
  // 数据有几个非零元，矩阵就摆多大 —— 不硬取平方根，
  // 否则长度不是平方数时会丢掉一截数据、或者补一堆空格。
  const cases: Array<[number, number, number]> = [
    [4, 2, 2],
    [5, 1, 5],
    [6, 2, 3],
    [7, 1, 7],
    [8, 2, 4],
    [9, 3, 3],
    [10, 2, 5],
    [11, 1, 11],
    [12, 3, 4],
  ]

  for (const [len, rows, cols] of cases) {
    it(`${len} 个数 -> ${rows}×${cols}`, () => {
      const data = Array.from({ length: len }, (_, i) => i + 1)
      for (const id of ['sparse-triple', 'sparse-cross']) {
        const spec = getAlgorithm(id)
        const steps = buildSteps(spec, data, {})
        const board = steps[0]!.boards![0]!
        expect(board.cols, `${id} 的列数`).toBe(cols)
        expect(board.items.length, `${id} 的格子数`).toBe(rows * cols)
        expect(board.items.length, `${id} 不能丢掉数据`).toBe(len)
      }
    })
  }
})

describe('场景类渲染器的校验规则', () => {
  const code = ['void f() {', '  x();', '}']
  const base = {
    line: 1,
    action: 'init' as const,
    array: [1],
    indices: [],
    sortedIndices: [],
    comment: '第一帧',
    stats: { compares: 0, swaps: 0 },
  }

  it('指针越界会被抓出来', () => {
    const steps = [
      { ...base, boards: [{ title: '栈', layout: 'column' as const, items: [{ text: '1' }], pointers: { top: 3 } }] },
    ]
    expect(() => validateSteps(steps, code, [1], 'scene')).toThrow(/指针 top/)
  })

  it('连线指向不存在的格子会被抓出来', () => {
    const steps = [
      {
        ...base,
        boards: [
          {
            title: '十字链表',
            layout: 'grid' as const,
            cols: 2,
            items: [{ text: '1' }, { text: '0' }],
            links: [{ from: 0, to: 7, dir: 'right' as const }],
          },
        ],
      },
    ]
    expect(() => validateSteps(steps, code, [1], 'scene')).toThrow(/连线/)
  })

  it('纸带游标越界会被抓出来', () => {
    const steps = [
      {
        ...base,
        boards: [{ title: '栈', layout: 'column' as const, items: [{ text: '1' }] }],
        tapes: [{ label: '表达式', items: ['A', '+'], pos: 5 }],
      },
    ]
    expect(() => validateSteps(steps, code, [1], 'scene')).toThrow(/游标/)
  })

  it('既没有板子也没有纸带的帧会被抓出来', () => {
    const steps = [{ ...base }]
    expect(() => validateSteps(steps, code, [1], 'scene')).toThrow(/既没有场景板子也没有纸带/)
  })

  it('只有纸带、没有板子的帧是合法的（字符串匹配就是两条纸带）', () => {
    const steps = [
      { ...base, tapes: [{ label: '主串', items: ['A', 'B'], pos: 0 }] },
    ]
    expect(() => validateSteps(steps, code, [1], 'scene')).not.toThrow()
  })

  it('合法的场景帧能通过', () => {
    const steps = [
      {
        ...base,
        boards: [{ title: '栈', layout: 'column' as const, items: [{ text: '1' }], pointers: { top: 0 } }],
        tapes: [{ label: '表达式', items: ['A', '+'], pos: 1 }],
      },
    ]
    expect(() => validateSteps(steps, code, [1], 'scene')).not.toThrow()
  })
})

/**
 * 拓扑排序的「入度表」板子。
 *
 * 这块板子每个顶点固定占一格，所以"某一步把谁的入度减了 1"就是"某一格里的数字掉了 1"，
 * 一眼能看见；顶点旁的黄标签是**同一个值的另一种呈现**。于是它有两件必须守住的事：
 *   ① 每帧都在、格子数永远等于顶点数（它是"每帧都给"的常驻板子，不能有一帧少一块）；
 *   ② 表里的数字和同一帧的黄标签**逐个一致** —— 一旦有人写了两套计算，这里当场就能抓出来。
 * 规模 5..9 全跑一遍，不是只看默认那一档。
 */
describe('拓扑排序：入度表板子', () => {
  const spec = getAlgorithm('graph-topo')
  const sizes = spec.sizes ?? [7]
  const dataOf = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
  const V = (i: number) => `V${i}`

  /**
   * 测试里**自己**按"主链 V1->…->Vn + 4 条跨层边"的规则数一遍初始入度，
   * 不引用被测代码的实现：实现万一把边改错了（比如最后那条写成 V(n-3)->Vn），这里立刻对不上。
   */
  const expectedInitIndeg = (n: number): Record<string, number> => {
    const edges: Array<[string, string]> = []
    for (let i = 2; i <= n; i++) edges.push([V(i - 1), V(i)])
    edges.push([V(1), V(3)], [V(2), V(4)], [V(1), V(4)], [V(n - 2), V(n)])
    const indeg: Record<string, number> = {}
    for (let i = 1; i <= n; i++) indeg[V(i)] = 0
    for (const [, to] of edges) indeg[to] = (indeg[to] ?? 0) + 1
    return indeg
  }

  /** 这一帧的「入度表」板子（找不到返回 undefined，断言里会当场报出来） */
  const indegBoardOf = (step: AlgoStep) =>
    (step.boards ?? []).find((b) => b.title.startsWith('入度表'))

  /** 把入度表读成 顶点名 -> 入度（**格子的正文是顶点名，下面的小字才是入度**） */
  const tableOf = (step: AlgoStep): Record<string, number> => {
    const board = indegBoardOf(step)
    if (!board) throw new Error('这一帧没有「入度表」板子')
    return Object.fromEntries(
      board.items.map((it) => [it.text, Number(it.sub)] as [string, number]),
    )
  }

  /** 把顶点旁的黄标签读成 顶点名 -> 入度（标签形如 `入度1`，把"入度"两个字剥掉） */
  const badgesOf = (step: AlgoStep): Record<string, number> =>
    Object.fromEntries(
      Object.entries(step.graph?.badges ?? {}).map(
        ([v, text]) => [v, Number(text.replace(/^入度/, ''))] as [string, number],
      ),
    )

  /** 这一帧已经输出过的顶点（「已输出」板子上的格子就是答案本身） */
  const outOf = (step: AlgoStep): string[] =>
    (step.boards ?? [])
      .find((b) => b.title.startsWith('已输出'))
      ?.items.map((it) => it.text) ?? []

  it('每一帧都挂着三块板子：入度表 / 已输出 / 队列', () => {
    let frames = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, dataOf(n), {})
      // 守卫：帧数太少说明这个规模根本没跑起来，下面的循环会静默空跑
      // （实际帧数 1 + 1 + 1 + Σ(3 + 出度) + 1：n=5 是 27 帧、n=9 是 43 帧）
      expect(steps.length, `${n} 个顶点的帧数`).toBeGreaterThan(20)
      for (const [i, step] of steps.entries()) {
        const titles = (step.boards ?? []).map((b) => b.title)
        expect(titles.length, `${n} 个顶点第 ${i} 帧的板子数`).toBe(3)
        expect(titles[0], `${n} 个顶点第 ${i} 帧第 1 块板子`).toMatch(/^入度表/)
        expect(titles[1], `${n} 个顶点第 ${i} 帧第 2 块板子`).toMatch(/^已输出/)
        expect(titles[2], `${n} 个顶点第 ${i} 帧第 3 块板子`).toMatch(/^队列/)
        frames += 1
      }
    }
    expect(frames, '总共核对过的帧数').toBeGreaterThan(150)
  })

  it('入度表每一帧都恰好 n 格，顶点名一个不多一个不少', () => {
    let checked = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, dataOf(n), {})
      for (const [i, step] of steps.entries()) {
        const board = indegBoardOf(step)
        expect(board, `${n} 个顶点第 ${i} 帧要有入度表`).toBeTruthy()
        expect(board!.layout, `${n} 个顶点第 ${i} 帧的布局`).toBe('row')
        expect(board!.items.length, `${n} 个顶点第 ${i} 帧的格子数`).toBe(n)
        expect(
          board!.items.map((it) => it.text),
          `${n} 个顶点第 ${i} 帧的顶点名（顺序也该是 V1..Vn）`,
        ).toEqual(Array.from({ length: n }, (_, k) => V(k + 1)))
        checked += 1
      }
    }
    expect(checked, '总共核对过的入度表张数').toBeGreaterThan(150)
  })

  it('入度表里的数字和同一帧的黄标签逐个一致（同一份数据派生）', () => {
    let pairs = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, dataOf(n), {})
      for (const [i, step] of steps.entries()) {
        const table = tableOf(step)
        const badges = badgesOf(step)
        // 黄标签只挂在**还没被删掉**的顶点上，所以按标签的 key 逐个比（表是全顶点的）
        for (const [v, d] of Object.entries(badges)) {
          expect(table[v], `${n} 个顶点第 ${i} 帧 ${v}：表里 ${table[v]}，标签写 ${d}`).toBe(d)
          pairs += 1
        }
      }
    }
    // 守卫：一对都没比过就说明 badges 全是空的，上面那条断言等于没跑
    expect(pairs, '总共比对过的 (帧, 顶点) 对数').toBeGreaterThan(300)
  })

  it('入度永远不为负（也不会超过 n-1）', () => {
    for (const n of sizes) {
      const steps = buildSteps(spec, dataOf(n), {})
      for (const [i, step] of steps.entries()) {
        const table = tableOf(step)
        const badges = badgesOf(step)
        for (const [v, d] of [...Object.entries(table), ...Object.entries(badges)]) {
          expect(d, `${n} 个顶点第 ${i} 帧 ${v} 的入度`).toBeGreaterThanOrEqual(0)
          expect(d, `${n} 个顶点第 ${i} 帧 ${v} 的入度`).toBeLessThanOrEqual(n - 1)
        }
      }
    }
  })

  it('已经输出过的顶点在表里必须是 0，而且要淡成 done', () => {
    let checked = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, dataOf(n), {})
      for (const [i, step] of steps.entries()) {
        const table = tableOf(step)
        const toneOf = new Map(indegBoardOf(step)!.items.map((it) => [it.text, it.tone]))
        for (const v of outOf(step)) {
          expect(table[v], `${n} 个顶点第 ${i} 帧：${v} 已经输出了，表里该是 0`).toBe(0)
          expect(toneOf.get(v), `${n} 个顶点第 ${i} 帧：${v} 已经输出了，该淡成 done`).toBe('done')
          checked += 1
        }
      }
      // 守卫：收尾帧必须**每个顶点都输出过**，否则上面那个内层循环可能一次都没进
      const last = steps[steps.length - 1]!
      expect(outOf(last).length, `${n} 个顶点的收尾帧输出个数`).toBe(n)
    }
    expect(checked, '总共核对过的"已输出顶点"个数').toBeGreaterThan(200)
  })

  it('首帧（含 engine 造的那一帧）的入度表就是这张图的初始入度', () => {
    for (const n of sizes) {
      const steps = buildSteps(spec, dataOf(n), {})
      const expected = expectedInitIndeg(n)
      // steps[0] 由 engine 从 initScene 造，steps[1] 是生成器的第一帧 —— 两帧都得对
      for (const i of [0, 1]) {
        const step = steps[i]!
        expect(tableOf(step), `${n} 个顶点第 ${i} 帧的入度表`).toEqual(expected)
        // 首帧的黄标签是同一份数（只是被"入度"两个字包着）
        expect(badgesOf(step), `${n} 个顶点第 ${i} 帧的黄标签`).toEqual(expected)
        // note 把初始入度原样报一遍，用户不用自己一个个数格子
        expect(indegBoardOf(step)!.note, `${n} 个顶点第 ${i} 帧入度表的 note`).toContain('初始入度：V1=0')
      }
    }
  })

  it('入度表的 note 写的就是表上掉下去的那个数字', () => {
    const steps = buildSteps(spec, dataOf(9), {})
    let drops = 0
    for (let i = 1; i < steps.length; i++) {
      const before = tableOf(steps[i - 1]!)
      const now = tableOf(steps[i]!)
      const note = indegBoardOf(steps[i]!)!.note ?? ''
      // 生成器的第一帧没有"上一帧"可比，note 是"初始入度：…"（上面那条用例已经管了）
      if (i === 1) {
        expect(note, '生成器首帧的 note').toContain('初始入度：')
        expect(now, '生成器首帧和 engine 首帧的入度表该一模一样').toEqual(before)
        continue
      }
      const changed = Object.keys(now).filter((v) => now[v] !== before[v])
      if (!changed.length) {
        expect(note, `第 ${i} 帧入度没变，note 却写了`).toBe('这一步入度没有变化')
        continue
      }
      for (const v of changed) {
        expect(note, `第 ${i} 帧 ${v} 的入度 ${before[v]} -> ${now[v]} 该写在 note 里`).toContain(
          `${v} 的入度 ${before[v]} -> ${now[v]}`,
        )
        drops += 1
      }
    }
    // 默认 9 个顶点有 12 条边 -> 入度正好掉 12 次；写死这个数，note 少写一次就露馅
    expect(drops, '核对过的"入度掉了 1"次数').toBe(12)
  })
})

describe('二叉排序树·删除：中序序列板子', () => {
  const spec = getAlgorithm('bst-delete')
  const sizes = spec.sizes ?? [7]

  /** 这一帧的「中序序列」板子（找不到返回 undefined，断言里会当场报出来） */
  const inorderBoardOf = (step: AlgoStep) =>
    (step.boards ?? []).find((b) => b.title.startsWith('中序序列'))

  /** 把板子读成一串关键字（**格子的正文就是关键字**，小字是它在序列里的位序） */
  const seqOf = (step: AlgoStep): number[] => {
    const board = inorderBoardOf(step)
    if (!board) throw new Error('这一帧没有「中序序列」板子')
    return board.items.map((it) => Number(it.text))
  }

  /**
   * ⭐ 这块板子是这次改动的核心：树类算法的 `array` 在界面上**根本不会渲染**
   * （全项目只有 CanvasPanel 读 `step.array`，而它是 `v-if="renderer === 'array'"`），
   * 所以中序序列必须挂在 `boards` 上才看得见。这条用例把"每帧都有、且它就是当前树的中序序列"钉死。
   */
  it('每一帧都挂着「中序序列」板子，格子数等于当前树的结点数', () => {
    let frames = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, prepared(spec).slice(0, n), {})
      expect(steps.length, `${n} 个关键字删除的帧数`).toBeGreaterThan(8)
      for (const [i, step] of steps.entries()) {
        const board = inorderBoardOf(step)
        expect(board, `${n} 个关键字第 ${i} 帧要有「中序序列」板子`).toBeTruthy()
        expect(board!.layout, `${n} 个关键字第 ${i} 帧的板子布局`).toBe('row')
        expect(board!.position, `${n} 个关键字第 ${i} 帧的板子位置`).toBe('bottom')
        // 树上的结点数和板子格子数必须一帧一帧地对得上：删掉一个结点，板子当场少一格
        expect(board!.items.length, `${n} 个关键字第 ${i} 帧的格子数`).toBe(step.tree!.nodes.length)
        frames += 1
      }
    }
    // 守卫：一帧都没核对到就说明上面的循环静默空跑了
    // （5..12 个关键字 × 十来帧，实测 434 帧）
    expect(frames, '总共核对过的帧数').toBeGreaterThan(150)
  })

  /**
   * ⭐⭐ 最值钱的一条：BST 的**中序序列一定是升序**。
   * 值覆盖那一步会让树里短暂出现两个相同的值（板子上相邻两格），删完之后必须立刻回到**严格**升序
   * —— 值覆盖写错（比如写成搬结点、或者改错了哪个结点的值）会在这里立刻露出来。
   */
  it('板子里的序列必须是升序，而且等于当前树的中序序列', () => {
    let checked = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, prepared(spec).slice(0, n), {})
      for (const [i, step] of steps.entries()) {
        const seq = seqOf(step)
        const treeInorder = walkTree(step.tree!).inorder
        expect(seq, `${n} 个关键字第 ${i} 帧：板子该是树的中序序列`).toEqual(treeInorder)
        // 注意：值覆盖那一步会让树里**短暂**出现两个相同的值（板子上相邻两格），
        // 所以这里只能要求"非递减"；严格升序留给下面那条"删完之后"的用例。
        expect(seq, `${n} 个关键字第 ${i} 帧：中序序列必须非递减`).toEqual(ascending(seq))
        checked += 1
      }
    }
    expect(checked, '总共核对过的板子张数').toBeGreaterThan(150)
  })

  /**
   * ⭐⭐ 收尾的不变量：三次删除**做完之后**，板子必须是**严格升序、没有重复**的。
   * 值覆盖那一步故意让树里出现过两个相同的值（那是动画的中间态），所以"唯一性"只能在这一条里查
   * —— 如果值覆盖之后忘了把多出来的那个结点摘掉，这里会立刻红。
   */
  it('三次删除做完之后，板子严格升序而且没有重复值', () => {
    let checked = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, prepared(spec).slice(0, n), {})
      const last = steps[steps.length - 1]!
      const seq = seqOf(last)
      expect(seq, `${n} 个关键字：收尾的中序序列必须严格升序`).toEqual(
        [...seq].sort((a, b) => a - b),
      )
      expect(new Set(seq).size, `${n} 个关键字：收尾的中序序列不该有重复值`).toBe(seq.length)
      checked += 1
    }
    expect(checked, '核对过的收尾帧数').toBe(8)
  })

  /**
   * 板子和 `array` 是同一份数据派生的，不该各说各话。
   * （`array` 现在界面上看不见，但它仍是这块算法的"真值"，将来若接了别的渲染器必须还对得上。）
   */
  it('板子里的序列和同一帧的 array 一模一样', () => {
    let pairs = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, prepared(spec).slice(0, n), {})
      for (const [i, step] of steps.entries()) {
        expect(seqOf(step), `${n} 个关键字第 ${i} 帧：板子和 array`).toEqual(step.array)
        pairs += 1
      }
    }
    expect(pairs, '总共比对过的 (帧, array) 对数').toBeGreaterThan(150)
  })

  it('板子上的指针下标必须落在格子范围内', () => {
    let pointers = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, prepared(spec).slice(0, n), {})
      for (const [i, step] of steps.entries()) {
        const board = inorderBoardOf(step)!
        for (const [name, at] of Object.entries(board.pointers ?? {})) {
          expect(at, `${n} 个关键字第 ${i} 帧指针 ${name} 的下标`).toBeGreaterThanOrEqual(0)
          expect(at, `${n} 个关键字第 ${i} 帧指针 ${name} 的下标`).toBeLessThan(board.items.length)
          pointers += 1
        }
      }
    }
    expect(pointers, '总共核对过的指针个数').toBeGreaterThan(100)
  })

  it('每删掉一个结点，板子就少一格（删的是"当前树的中序序列"，不是历史记录）', () => {
    const steps = buildSteps(spec, prepared(spec), {})
    // 默认 7 个关键字要删 3 个 -> 板子从 7 格一路缩到 4 格
    expect(seqOf(steps[0]!), '首帧的板子').toHaveLength(7)
    expect(seqOf(steps[steps.length - 1]!), '末帧的板子').toHaveLength(4)
    let shrinks = 0
    for (let i = 1; i < steps.length; i++) {
      const before = seqOf(steps[i - 1]!)
      const now = seqOf(steps[i]!)
      if (now.length === before.length) continue
      // 板子只会因为"删掉一个结点"而变短，永远不该变长
      expect(now.length, `第 ${i} 帧：板子从 ${before.length} 格变成 ${now.length} 格`).toBe(
        before.length - 1,
      )
      shrinks += 1
    }
    expect(shrinks, '核对过的"板子少了 1 格"次数').toBe(3)
  })
})

describe('二叉排序树·删除：有两个孩子的结点', () => {
  const spec = getAlgorithm('bst-delete')
  const sizes = spec.sizes ?? [7]

  const frameOf = (line: number, action: StepAction, text: string) => (s: AlgoStep) =>
    s.line === line && s.action === action && s.comment.includes(text)

  /** 板子上某一位现在写着谁（板子 = 当前树的中序序列） */
  const seqOf = (step: AlgoStep): number[] =>
    ((step.boards ?? []).find((b) => b.title.startsWith('中序序列'))?.items ?? []).map((it) =>
      Number(it.text),
    )

  /** 树上所有关键字的多重集合（值覆盖那一步会让它短暂地变成 4 个值） */
  const multiset = (step: AlgoStep): number[] => [...walkTree(step.tree!).inorder].sort((a, b) => a - b)

  /**
   * 按**多重集合**做差，返回 `after` 比 `before` 多出来的那些值。
   * 不能用 `!before.includes(v)` —— 值覆盖恰恰会让 after 里多出一个**before 里已经有的**值
   * （树里出现两个相同的值），那样写会得到空数组，把自己坑了。
   */
  const multisetAdd = (before: number[], after: number[]): number[] => {
    const rest = [...before]
    const added: number[] = []
    for (const v of after) {
      const at = rest.indexOf(v)
      if (at >= 0) rest.splice(at, 1)
      else added.push(v)
    }
    return added
  }
  const multisetRemove = (before: number[], after: number[]): number[] => multisetAdd(after, before)

  /**
   * ⭐ "值覆盖"必须是**一步单独的一帧**，而且那一帧要明说"这是值覆盖，不是把结点搬过去"。
   * 这是学生最容易搞混的地方，所以这里既查"帧在不在"，也查"话说到没说到"。
   */
  it('值覆盖单独成帧，而且明说"不是把结点搬过去"', () => {
    let covers = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, prepared(spec).slice(0, n), {})
      for (const [i, step] of steps.entries()) {
        if (!step.comment.includes('值覆盖')) continue
        expect(step.action, `${n} 个关键字第 ${i} 帧（值覆盖）的 action`).toBe('set')
        expect(step.comment, `${n} 个关键字第 ${i} 帧（值覆盖）该点破"不是把结点搬过去"`).toContain(
          '不是把',
        )
        expect(step.comment, `${n} 个关键字第 ${i} 帧（值覆盖）该说"只改值不改结构"`).toContain(
          '一个都没动',
        )
        covers += 1
      }
    }
    // 守卫：一次都没查到就说明"值覆盖"这个词根本没写进 comment
    expect(covers, '带「值覆盖」说明的帧数').toBeGreaterThan(5)
  })

  /**
   * ⭐ 值覆盖的**实质**：不只看注释，而是看树本身。
   * 覆盖那一帧，树上关键字的多重集合恰好是"去掉被删的旧值、多出一个后继的值"——
   * 多出来的那个值就是**紧跟在旧值后面**的那个数（中序后继的定义）。
   */
  it('覆盖那一帧：旧值没了、新值正好是多出来的那一个，而且它紧跟在旧值后面', () => {
    let covers = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, prepared(spec).slice(0, n), {})
      for (let i = 1; i < steps.length; i++) {
        const prev = steps[i - 1]!
        const step = steps[i]!
        if (!step.comment.includes('值覆盖')) continue

        const before = multiset(prev)
        const after = multiset(step)
        expect(after.length, `${n} 个关键字第 ${i} 帧（值覆盖）结点数不该变`).toBe(before.length)

        const added = multisetAdd(before, after)
        const removed = multisetRemove(before, after)
        expect(added, `${n} 个关键字第 ${i} 帧（值覆盖）：该多出一个值`).toHaveLength(1)
        expect(removed, `${n} 个关键字第 ${i} 帧（值覆盖）：该少掉一个值`).toHaveLength(1)
        expect(step.action, `${n} 个关键字第 ${i} 帧（值覆盖）的 action`).toBe('set')

        const sv = added[0]!
        const tv = removed[0]!
        expect(sv, `${n} 个关键字第 ${i} 帧：后继必须比被删的 ${tv} 大`).toBeGreaterThan(tv)
        // "后继 = 比被删结点大的数里最小的那个"：删之前的序列里，sv 就该紧跟在 tv 后面
        const inorderBefore = walkTree(prev.tree!).inorder
        expect(
          inorderBefore[inorderBefore.indexOf(tv) + 1],
          `${n} 个关键字第 ${i} 帧：删之前 ${sv} 该紧跟在 ${tv} 后面（中序后继的定义）`,
        ).toBe(sv)
        // 覆盖只改了一个值：树里因此出现两个 sv，中序序列这时**还是升序**（两个相等的值挨在一起）
        expect(seqOf(step), `${n} 个关键字第 ${i} 帧：值覆盖后中序序列仍该是升序`).toEqual(
          ascending(seqOf(step)),
        )
        covers += 1
      }
    }
    expect(covers, '核对过实质的"值覆盖"帧数').toBeGreaterThan(5)
  })

  /**
   * ⭐ 要求 4："两个孩子的难题被化简成了一个孩子的难题"必须**看得见**。
   * 摘掉后继那一帧要说明后继**为什么**顶多只有一个孩子（它一路向左到底，所以一定没有左孩子），
   * 并且说明它退化成情况①还是情况②。
   */
  it('摘掉后继那一帧：说清后继一定没有左孩子，并且退化成了情况①/②', () => {
    let checked = 0
    for (const n of sizes) {
      const steps = buildSteps(spec, prepared(spec).slice(0, n), {})
      for (const [i, step] of steps.entries()) {
        if (!step.comment.includes('化简成')) continue
        expect(step.comment, `${n} 个关键字第 ${i} 帧：该点出后继"一定没有左孩子"`).toContain(
          '一定没有左孩子',
        )
        expect(step.comment, `${n} 个关键字第 ${i} 帧：该说明退化成情况①还是②`).toMatch(
          /退化成情况[①②]/,
        )
        expect(step.tree!.nodes.length, `${n} 个关键字第 ${i} 帧：这一帧结点数该少一个`).toBe(
          steps[i - 1]!.tree!.nodes.length - 1,
        )
        checked += 1
      }
    }
    expect(checked, '核对过的"化简"帧数').toBeGreaterThan(5)
  })

  /**
   * 要求 2："一路向左走到底"必须**每走一步都有一帧**。
   * 帧数随规模变化，所以量出所有规模走出来的步数总和，卡一个下限：
   * 步数掉到 1 就意味着实现又变回"一步到位"了（那正是这次要修掉的问题）。
   */
  it('找后继时每往左走一步都单独成帧', () => {
    let steps = 0
    let sizesWithWalk = 0
    for (const n of sizes) {
      const runner = buildSteps(spec, prepared(spec).slice(0, n), {})
      let local = 0
      for (const step of runner) {
        if (!step.comment.includes('再往左走一步')) continue
        expect(step.action, `${n} 个关键字：往左走一步该是 compare`).toBe('compare')
        expect(step.tree!.pointers?.s, `${n} 个关键字：这一帧该看得见 s 指到哪`).toBeTruthy()
        expect(step.tree!.pointers?.sp, `${n} 个关键字：这一帧该看得见 s 的父结点`).toBeTruthy()
        local += 1
      }
      if (local > 0) sizesWithWalk += 1
      steps += local
    }
    // 5..12 个关键字一共走出了 9 步"往左走"（见下面的守卫）；掉到 2 步以下说明动画没在走
    expect(steps, '所有规模加起来"往左走一步"的帧数').toBeGreaterThan(2)
    expect(sizesWithWalk, '出现过"往左走"动画的规模数').toBeGreaterThan(0)
  })

  /**
   * 要求 1 + 3 + 5：情况③ 的推理链一帧不缺 ——
   * 说明为什么不能直接摘 → 从右孩子出发 → 一路向左 → 说明后继是谁 → 值覆盖（必须紧挨着摘除帧前面）
   * → 摘掉后继 → 结果帧给出新的中序序列。
   * 同时守卫帧数：掉回改之前的 3 帧就说明动画被改没了。
   */
  it('情况③ 的推理链一帧不缺，而且帧数够多（不能一步到位）', () => {
    for (const n of sizes) {
      const all = buildSteps(spec, prepared(spec).slice(0, n), {})
      const start = all.findIndex(frameOf(7, 'mark', '有两个孩子，不能直接摘'))
      if (start < 0) continue // 这个规模下 planDeletes 没排出情况③，跳过
      const rest = all.slice(start)
      const end = rest.findIndex(frameOf(11, 'done', '情况③ 删除完成'))
      expect(end, `${n} 个关键字：情况③ 该有一个"删除完成"的结果帧`).toBeGreaterThan(0)
      const phase = rest.slice(0, end + 1)

      // ① 为什么不能直接摘
      expect(phase.some(frameOf(7, 'mark', '不能直接摘')), `${n} 个关键字：缺"为什么不能直接摘"`).toBe(
        true,
      )
      // ② 从 p 的右孩子出发
      expect(phase.some(frameOf(8, 'mark', '一路向左走到底')), `${n} 个关键字：缺"从右孩子出发"`).toBe(
        true,
      )
      // ③ 后继是谁（"比 p 大的数里最小的那个"）
      expect(phase.some(frameOf(9, 'mark', '比')), `${n} 个关键字：缺"后继是谁"`).toBe(true)
      // ④ 值覆盖单独一帧，而且**紧挨着**摘掉后继那一帧（两帧之间没有别的动作）
      const coverIdx = phase.findIndex((s) => s.comment.includes('值覆盖'))
      expect(coverIdx, `${n} 个关键字：情况③ 里缺"值覆盖"帧`).toBeGreaterThan(0)
      const cover = phase[coverIdx]!
      const next = phase[coverIdx + 1]!
      expect(next.action, `${n} 个关键字：值覆盖的下一帧`).toBe('set')
      expect(next.comment, `${n} 个关键字：值覆盖之后该立刻摘掉后继`).toContain('化简成')
      // 值覆盖**之前**那一帧板子上还是旧值 —— 这样"值覆盖"才真的是单独一步
      const coverAdded = multisetAdd(multiset(phase[coverIdx - 1]!), multiset(cover))
      expect(coverAdded.length, `${n} 个关键字：值覆盖那一帧该正好新出现一个值`).toBe(1)
      // ⑤ 结果帧：新序列仍然升序，而且比删之前少一个值
      expect(seqOf(phase[end]!), `${n} 个关键字：结果帧的中序序列`).toEqual(ascending(seqOf(phase[end]!)))
      expect(seqOf(phase[end]!).length, `${n} 个关键字：情况③ 删完该少一个值`).toBe(
        seqOf(phase[0]!).length - 1,
      )
      // 守卫：改之前情况③ 只有 3 帧（发现 → 搬值 → 摘掉），现在必须明显多出来
      expect(phase.length, `${n} 个关键字：情况③ 的帧数`).toBeGreaterThan(6)
    }
  })

  /**
   * 补一条**最少帧数**的硬守卫：单看默认数据，情况③ 里从"发现有两个孩子"到"删除完成"
   * 之间的帧数是确定的（实测 8 帧）。这个数字是可读的、且远大于 3，改回去就红。
   */
  it('默认数据下情况③ 的帧数是 8 帧（改之前是 3 帧）', () => {
    const all = buildSteps(spec, prepared(spec), {})
    const start = all.findIndex(frameOf(7, 'mark', '有两个孩子，不能直接摘'))
    expect(start, '该能找到情况③ 的起始帧').toBeGreaterThan(0)
    const rest = all.slice(start)
    const end = rest.findIndex(frameOf(11, 'done', '情况③ 删除完成'))
    expect(end, '该能找到情况③ 的结果帧').toBeGreaterThan(0)
    expect(end + 1, '情况③ 的帧数').toBe(8)
  })
})

describe('二叉排序树·删除：runBstDelete 直接跑（不经过 registry）', () => {
  /** 一整段动画压成"每一帧干了什么"的清单，方便按顺序核对 */
  const traceOf = (input: number[]) => {
    const out: Array<{ line: number; action: string; comment: string }> = []
    for (const ev of runBstDelete(input, {})) {
      out.push({ line: ev.line ?? -1, action: ev.action, comment: ev.comment ?? '' })
    }
    return out
  }

  const findAt = (trace: Array<{ line: number; comment: string }>, line: number, text: string) =>
    trace.findIndex((f) => f.line === line && f.comment.includes(text))

  /**
   * 直接驱动 runner，把情况③ 的推理链**按顺序**核一遍：
   * 发现两个孩子(7) → 从右孩子出发(8) → 一路向左(9, 可能多帧) → 后继是谁(9)
   * → 准备顶替(10) → ⭐值覆盖(10) → 摘掉后继(11) → 结果(11)。
   * 这些帧号必须**严格递增**，任何一步被合并掉都会在这里露出来。
   */
  it('情况③ 八个阶段的帧号严格递增（一帧都不许少）', () => {
    const trace = traceOf([10, 20, 30, 40, 50, 60, 70])
    expect(trace.length, 'runBstDelete 直接跑出来的帧数').toBeGreaterThan(12)

    const found = findAt(trace, 7, '有两个孩子，不能直接摘')
    const fromRight = findAt(trace, 8, '一路向左走到底')
    const stop = trace.findIndex((f) => f.line === 9 && f.comment.includes('向左走不动'))
    const cover = findAt(trace, 10, '值覆盖')
    const detach = findAt(trace, 11, '化简成')
    const result = findAt(trace, 11, '情况③ 删除完成')

    for (const [name, at] of Object.entries({ found, fromRight, stop, cover, detach, result })) {
      expect(at, `缺了"${name}"那一帧`).toBeGreaterThan(-1)
    }
    expect(fromRight, '从右孩子出发该在"发现有两个孩子"之后').toBeGreaterThan(found)
    expect(stop, '后继停下该在从右孩子出发之后').toBeGreaterThan(fromRight)
    expect(cover, '值覆盖该在后继确定之后').toBeGreaterThan(stop)
    expect(detach, '摘掉后继该紧跟值覆盖').toBe(cover + 1)
    expect(result, '结果帧该在摘掉后继之后').toBe(detach + 1)

    // 收尾帧（line 14）只该有一帧，而且就是整段动画的最后一帧
    const endings = trace.filter((f) => f.line === 14)
    expect(endings.length, 'line 14 的收尾帧个数').toBe(1)
    expect(trace[trace.length - 1]!.line, '最后一帧该是收尾帧').toBe(14)
    // 每一帧都要有话说（engine 通用用例也查这个，这里直接把 runner 自己再钉一遍）
    expect(trace.every((f) => f.comment.trim().length > 0), '每一帧都该有 comment').toBe(true)
  })

  /**
   * 直接跑时也逐帧看一眼注释：line 9 必须出现过、line 10 必须同时有"准备顶替"和"值覆盖"两帧
   * —— 这两帧挨在一起正是这次改动的重点（先把 s 摘出来，再单独一帧讲值覆盖）。
   */
  it('line 10 上有两个连续帧：先"准备顶替"、再"值覆盖"', () => {
    const trace = traceOf([10, 20, 30, 40, 50, 60, 70])
    const prep = findAt(trace, 10, '准备顶替')
    const cover = findAt(trace, 10, '值覆盖')
    expect(prep, '缺"准备顶替"帧').toBeGreaterThan(-1)
    expect(cover, '缺"值覆盖"帧').toBeGreaterThan(-1)
    expect(cover, '值覆盖该紧跟在准备顶替后面').toBe(prep + 1)
    expect(trace[prep]!.action, '"准备顶替"的 action').toBe('set')
    expect(trace[cover]!.action, '"值覆盖"的 action').toBe('set')
  })
})
