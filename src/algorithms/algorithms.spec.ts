import { describe, expect, it } from 'vitest'
import { algorithmRegistry, getAlgorithm, getAlgorithmsByCategory, getGroupedByCategory } from './index'
import { buildSteps, validateSteps } from '@/core/engine'
import { CATEGORIES } from '@/core/categories'
import { SEQ_CAPACITY } from '@/core/config'
import type { AlgorithmSpec, RendererKind, RunnerContext } from '@/core/types'

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
    const kinds: RendererKind[] = ['array', 'seqlist', 'linked', 'scene', 'tree']
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
  for (const spec of getAlgorithmsByCategory('sort')) {
    it(`${spec.name}：终态有序，且元素守恒`, () => {
      const input = prepared(spec)
      const steps = buildSteps(spec, input, ctxOf(spec, input))
      expect(steps.at(-1)!.array).toEqual(ascending(input))
      expect(steps.at(-1)!.array).toHaveLength(input.length)
    })
  }
})

describe('查找类算法', () => {
  const searchSpecs = getAlgorithmsByCategory('search')

  it('至少实现了顺序查找与折半查找', () => {
    const ids = searchSpecs.map((s) => s.id)
    expect(ids).toContain('sequential-search')
    expect(ids).toContain('binary-search')
  })

  for (const spec of searchSpecs) {
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

    it(`${spec.name}：defaultTarget 一定取自数据本身`, () => {
      const input = prepared(spec)
      expect(spec.defaultTarget).toBeTruthy()
      for (let k = 0; k < 30; k++) expect(input).toContain(spec.defaultTarget!(input))
    })
  }

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

  it('排序和查找没有子类，就是一个空标题的组', () => {
    expect(getGroupedByCategory('sort')).toHaveLength(1)
    expect(getGroupedByCategory('sort')[0]!.group).toBe('')
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
