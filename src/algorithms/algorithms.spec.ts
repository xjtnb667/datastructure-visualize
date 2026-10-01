import { describe, expect, it } from 'vitest'
import { algorithmRegistry, getAlgorithm, getAlgorithmsByCategory, getGroupedByCategory } from './index'
import { buildSteps, validateSteps } from '@/core/engine'
import { CATEGORIES } from '@/core/categories'
import { SEQ_CAPACITY } from '@/core/config'
import type {
  AlgoCategoryId,
  AlgorithmSpec,
  AlgoStep,
  RendererKind,
  RunnerContext,
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
   *      （折半插入 / 希尔 / 快速 / 归并 / 计数 / 堆排序 / 基数排序都在这一拨）；
   *   ② 堆（group === '堆'，renderer === 'scene'）：数组是堆的层序存储，只保证"父 ≥ 子"这个**偏序**，
   *      大根堆 [10, 8, 9, 7, ...] 本身并不是升序的 —— 之前就是拿"升序"去卡堆才红的；
   *   ③ 外部排序类（group === '外部排序'，renderer 是 scene / tree）：演的是"内存在外存之间倒腾记录"，
   *      画面主体是归并段 / 败者树 / 归并树，不能拿"整条序列升序"去卡它（置换-选择排序的终态就是几段拼起来的）。
   */
  const arraySorts = sortSpecs.filter((s) => s.renderer === 'array')
  const heapSpecs = sortSpecs.filter((s) => s.group === '堆')
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

  for (const spec of searchSpecs.filter((s) => s.group === '平衡二叉树 AVL')) {
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
    const groupsOf = (cat: AlgoCategoryId) => getGroupedByCategory(cat).map((g) => g.group)
    /*
     * 注意 getGroupedByCategory 只把**相邻**的同 group 合并，所以「分配类排序」会出现两次：
     * 计数排序（分配类）之后插了堆排序（选择类），基数排序（分配类）又把它接了回去。
     * 这是注册顺序决定的，不是 bug，这里照实写 —— 顺序一变（新增算法插错位置）这条就会红。
     */
    expect(groupsOf('sort')).toEqual([
      '', // 冒泡 / 选择 / 直接插入
      '堆', // 建堆 / 堆调整
      '插入类排序', // 折半插入 / 希尔
      '交换类排序', // 快速
      '归并类排序', // 归并
      '分配类排序', // 计数
      '选择类排序', // 堆排序
      '分配类排序', // 基数（注册顺序不连续，所以又开了一组）
      '外部排序', // 外部排序 / 败者树 / 置换-选择 / 最佳归并树
    ])
    expect(groupsOf('search')).toEqual([
      '', // 顺序查找 / 折半查找
      '二叉排序树', // 插入 / 查找 / 删除
      '平衡二叉树 AVL', // LL / RR / LR / RL
      '平衡二叉树', // 红黑树
      '多路平衡查找树', // B 树 / B+ 树
      '索引查找', // 分块查找 / 哈希表
    ])

    // 子类标题不是摆设：这两个大类里带名字的子类都得真的装着算法
    for (const cat of ['sort', 'search'] as const) {
      const named = getGroupedByCategory(cat).filter((g) => g.group !== '')
      expect(named.length, `${cat} 大类的子类不见了`).toBeGreaterThan(0)
      for (const g of named) expect(g.items.length, `子类「${g.group}」空着`).toBeGreaterThan(0)
    }
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
