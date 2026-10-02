import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type {
  AlgorithmSpec,
  AlgoStep,
  GraphView,
  ListView,
  RendererKind,
  RunnerContext,
  TreeView,
} from '@/core/types'
import { buildSteps } from '@/core/engine'
import { getCategory } from '@/core/categories'
import { DEFAULT_ALGORITHM_ID, getAlgorithm, getAlgorithmsByCategory } from '@/algorithms'

export const SPEEDS = [0.5, 1, 2, 4] as const
/** 数据规模：奇偶都有（奇数能构造出"正中间那个元素"这类更直观的演示） */
export const SIZES = [5, 6, 7, 8, 9, 10, 11, 12] as const
/**
 * 矩阵类算法的数据规模一律用**平方数**。
 * 因为它们都是把一维数据按 n = √len 还原成 n×n 矩阵的 ——
 * 长度不是平方数的话，多出来的那几个数用不上（或缺的格子要补 0），
 * 画面上就会看到"输入了 12 个数、矩阵里只出现了 9 个"这种对不上的情况。
 */
export const SQUARE_SIZES = [4, 9, 16, 25] as const

/** 生成一份随机数据，数值范围 8~99，方便柱状图看得出高低差 */
function randomData(n: number): number[] {
  return Array.from({ length: n }, () => 8 + Math.floor(Math.random() * 92))
}

export const useAlgorithmStore = defineStore('algorithm', () => {
  // ---------- state ----------
  /**
   * 「当前算法」。
   *
   * ⚠️ **它一开始就装着默认算法（冒泡排序），但这不等于"用户选过"。**
   * 选没选看下面的 `hasSelection`。为什么让它一直是个合法算法：
   * 渲染器、图例、数据规模候选值、上/下一个算法的边界……全都在读 `algorithm`，
   * 让它永远非空就不必给每一处都加判空，改动风险最小。
   */
  const algorithm = shallowRef<AlgorithmSpec>(getAlgorithm(DEFAULT_ALGORITHM_ID))
  /**
   * 用户**主动选中过**算法了没有。界面是否显示算法、要不要上报学习记录，都看它。
   *
   * ⭐ 为什么绝不能"进页面就默认选中"：
   * 学习记录里的「打开次数」是按"用户切到某个算法"上报的（见 `stores/user.ts` 的上报 watch）。
   * 进页面就自动选中冒泡排序的话，这一次**自动**选中会被当成一次学习记进 `history` ——
   * 用户根本没看，记录里却多了一条"打开过冒泡排序"。
   * 所以：进 `#/learn` 时它一律是 `false`（界面显示空状态、一次都不上报），
   * 只有用户真的选了才由 `selectAlgorithm()` 置为 `true`。
   *
   * 谁算"用户真的选了"：点选择器 / 点上一下个算法 / 收藏页与报告页点"继续看" /
   * 带 `?algo=xxx` 的分享链接直达 —— 这些都是"用户要看这个算法"的明确意图；
   * 而页面刷新、首次进入、回车到 `#/learn` 都**不是**。
   */
  const hasSelection = ref(false)
  const codeLines = ref<string[]>([])
  const inputData = ref<number[]>([])
  /** 查找类算法的目标值 */
  const target = ref<number | null>(null)
  /** 插入/删除类算法的位序（1-based） */
  const pos = ref<number | null>(null)
  /** 插入类算法要插入的元素值 */
  const insertValue = ref<number | null>(null)
  /**
   * 全量步骤序列。用 shallowRef 而不是 ref：
   * 步骤上限 10000（SRS C3），ref 会递归代理每个步骤和它的数组，纯属白烧性能。
   * 我们只整体替换、绝不原地改，shallowRef 足够触发更新。
   */
  const steps = shallowRef<AlgoStep[]>([])
  /** 当前执行到第几步。这是**唯一可写的光标** */
  const currentStepIndex = ref(0)
  const speed = ref<number>(1)
  const playing = ref(false)
  const dataSize = ref<number>(6)

  let timer: number | undefined

  // ---------- getters ----------
  // currentLine 不设成独立 state，而是从 currentStepIndex 派生。
  // 需求里它是个 State，但那样就有两个能各写各的字段，必然能写歪。
  // 派生之后，"行号和步骤错位"在结构上无法发生。
  const currentStep = computed(() => steps.value[currentStepIndex.value])
  const currentLine = computed(() => currentStep.value?.line ?? 0)
  const currentArray = computed(() => currentStep.value?.array ?? [])
  const currentList = computed<ListView | null>(() => currentStep.value?.list ?? null)
  /** 当前这一帧的树结构（树 / 二叉树类算法用） */
  const currentTree = computed<TreeView | null>(() => currentStep.value?.tree ?? null)
  /** 当前这一帧的图结构（图类算法用） */
  const currentGraph = computed<GraphView | null>(() => currentStep.value?.graph ?? null)
  const currentAction = computed(() => currentStep.value?.action ?? 'init')
  const currentComment = computed(() => currentStep.value?.comment ?? '')
  const currentVars = computed(() => currentStep.value?.vars ?? {})
  const currentStats = computed(() => currentStep.value?.stats ?? { compares: 0, swaps: 0 })
  const sortedIndices = computed(() => currentStep.value?.sortedIndices ?? [])

  /** 用哪个渲染器画右侧 */
  const renderer = computed<RendererKind>(() => algorithm.value.renderer ?? 'array')
  /** 当前算法所属大类（决定选择器高亮哪一列、图例显示哪一套） */
  const category = computed(() => getCategory(algorithm.value.category))
  const isSearch = computed(() => algorithm.value.category === 'search')
  const isLinear = computed(() => algorithm.value.category === 'linear')

  const totalSteps = computed(() => steps.value.length)
  const canPrev = computed(() => currentStepIndex.value > 0)
  const canNext = computed(() => currentStepIndex.value < steps.value.length - 1)
  const maxValue = computed(() => Math.max(1, ...inputData.value))

  /**
   * "上一个 / 下一个算法"的边界**按大类划分**：
   * 只取当前大类下的算法（子类分组不参与），走到本大类的第一个/最后一个就到头了。
   */
  const categoryAlgorithms = computed(() => getAlgorithmsByCategory(algorithm.value.category))
  const categoryCount = computed(() => categoryAlgorithms.value.length)
  const algorithmIndex = computed(() =>
    categoryAlgorithms.value.findIndex((a) => a.id === algorithm.value.id),
  )
  const canPrevAlgorithm = computed(() => algorithmIndex.value > 0)
  const canNextAlgorithm = computed(
    () => algorithmIndex.value >= 0 && algorithmIndex.value < categoryCount.value - 1,
  )
  /**
   * 当前算法可选的"数据规模"。
   * 需要平方数输入的算法（特殊矩阵压缩存储）走平方数列表，其余走常规列表；
   * 当前值万一不在列表里也补进去，免得 <select> 匹配不到选项、显示成空白。
   */
  const sizes = computed<number[]>(() => {
    // 算法自己声明了合法规模就用它的 —— 形状定死的算法不该让用户选到画不出来的规模
    const own = algorithm.value.sizes
    const base: number[] = own?.length
      ? [...own]
      : algorithm.value.squareInput
        ? [...SQUARE_SIZES]
        : [...SIZES]
    if (!base.includes(dataSize.value)) base.push(dataSize.value)
    return base.sort((a, b) => a - b)
  })
  /** 本大类里的上一个 / 下一个算法（用于按钮上显示名字），到头了就是 null */
  const prevAlgorithmSpec = computed<AlgorithmSpec | null>(() => {
    const i = algorithmIndex.value
    return i > 0 ? (categoryAlgorithms.value[i - 1] ?? null) : null
  })
  const nextAlgorithmSpec = computed<AlgorithmSpec | null>(() => {
    const i = algorithmIndex.value
    return i >= 0 && i < categoryCount.value - 1
      ? (categoryAlgorithms.value[i + 1] ?? null)
      : null
  })

  /** 自动播放的间隔；倍速只改这个值，不改步骤序列 —— 所以倍速不可能造成失步 */
  const playInterval = computed(() => 560 / speed.value)
  /** 单步动画时长（毫秒） */
  const animDuration = computed(() => Math.min(320, Math.max(80, playInterval.value * 0.6)))

  // ---------- actions ----------
  function stopTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  /** 载入数据并预计算步骤序列，光标归零 */
  function load(data?: number[]): void {
    pause()
    const spec = algorithm.value
    const raw = data ?? spec.defaultData()
    // 折半查找要求输入有序、顺序表不能超过容量 —— prepareData 负责把数据规整好
    const seed = spec.prepareData ? spec.prepareData(raw) : raw

    codeLines.value = [...spec.codeLines]
    inputData.value = [...seed]
    // 让"数据规模"下拉框始终等于真实数据长度，避免出现"显示 12 个其实是 6 个"
    dataSize.value = seed.length
    target.value = spec.defaultTarget ? spec.defaultTarget(seed) : null
    pos.value = spec.defaultPos ? spec.defaultPos(seed) : null
    insertValue.value = spec.defaultValue ? spec.defaultValue(seed) : null

    const ctx: RunnerContext = {
      target: target.value ?? undefined,
      pos: pos.value ?? undefined,
      value: insertValue.value ?? undefined,
      capacity: spec.capacity,
    }
    steps.value = buildSteps(spec, seed, ctx)
    currentStepIndex.value = 0
  }

  function nextStep(): void {
    if (canNext.value) currentStepIndex.value += 1
  }

  function prevStep(): void {
    if (canPrev.value) currentStepIndex.value -= 1
  }

  /** 进度条拖拽 / 跳到任意步（FR-05.4）。O(1)，因为序列是全量可索引的 */
  function goToStep(index: number): void {
    if (steps.value.length === 0) return
    pause()
    currentStepIndex.value = Math.min(Math.max(index, 0), steps.value.length - 1)
  }

  function reset(): void {
    pause()
    currentStepIndex.value = 0
  }

  function tick(): void {
    stopTimer()
    if (!playing.value) return
    if (!canNext.value) {
      pause()
      return
    }
    nextStep()
    // 用全局 setTimeout 而不是 window.setTimeout，这样逻辑在 Node 里也能跑（单元测试）
    timer = setTimeout(tick, playInterval.value)
  }

  function play(): void {
    if (playing.value) return
    if (!canNext.value) currentStepIndex.value = 0 // 已经到末尾就从头再放
    playing.value = true
    tick()
  }

  function pause(): void {
    playing.value = false
    stopTimer()
  }

  function togglePlay(): void {
    if (playing.value) pause()
    else play()
  }

  function setSpeed(value: number): void {
    speed.value = value
  }

  /**
   * 选中一个算法。
   *
   * ⭐ **只有用户主动选才会走这里**（算法选择器 / 上一下个算法 / 收藏页和报告页的
   * "继续看" / 分享链接 `?algo=xxx`），所以它同时就是"用户选过"这个标志的**唯一来源** ——
   * 学习记录的上报只认它（见 `stores/user.ts`），自动选中不会经过这里。
   */
  function selectAlgorithm(id: string): void {
    const spec = getAlgorithm(id)
    // 先置标志、再比较 id：用户完全可能恰好选中"默认装着的那个"（冒泡排序），
    // 那种情况下面的早返回会跳过 load()，但"用户选过了"这件事必须照样记上。
    const firstPick = !hasSelection.value
    hasSelection.value = true
    if (spec.id === algorithm.value.id) {
      // 选的是同一个算法：平时什么都不用做（保留用户看到第几步）。
      // 但"从没选过"时它只是默认候选转正、步骤序列还没为它准备过，得补一次 load()。
      if (firstPick) load()
      return
    }
    algorithm.value = spec
    load()
  }

  /** 切到同一个大类里的上一个算法（到本大类第一个就停住） */
  function prevAlgorithm(): void {
    const i = algorithmIndex.value
    if (i > 0) selectAlgorithm(categoryAlgorithms.value[i - 1]!.id)
  }

  /** 切到同一个大类里的下一个算法（到本大类最后一个就停住） */
  function nextAlgorithm(): void {
    const i = algorithmIndex.value
    if (i >= 0 && i < categoryCount.value - 1) {
      selectAlgorithm(categoryAlgorithms.value[i + 1]!.id)
    }
  }

  function randomize(): void {
    // 输入是固定串的算法（括号匹配、表达式求值）没什么可随机的，保持原样
    if (algorithm.value.useFixedInput) return
    load(randomData(dataSize.value))
  }

  function setDataSize(n: number): void {
    if (algorithm.value.useFixedInput) return
    load(randomData(n))
  }

  function restoreDefault(): void {
    load()
  }

  return {
    // state
    algorithm,
    hasSelection,
    codeLines,
    inputData,
    target,
    pos,
    insertValue,
    steps,
    currentStepIndex,
    speed,
    playing,
    dataSize,
    // getters
    currentStep,
    currentLine,
    currentArray,
    currentList,
    currentTree,
    currentGraph,
    currentAction,
    currentComment,
    currentVars,
    currentStats,
    sortedIndices,
    renderer,
    category,
    isSearch,
    isLinear,
    totalSteps,
    canPrev,
    canNext,
    maxValue,
    categoryAlgorithms,
    categoryCount,
    algorithmIndex,
    canPrevAlgorithm,
    canNextAlgorithm,
    sizes,
    prevAlgorithmSpec,
    nextAlgorithmSpec,
    playInterval,
    animDuration,
    // actions
    load,
    nextStep,
    prevStep,
    goToStep,
    reset,
    play,
    pause,
    togglePlay,
    setSpeed,
    selectAlgorithm,
    prevAlgorithm,
    nextAlgorithm,
    randomize,
    setDataSize,
    restoreDefault,
  }
})
