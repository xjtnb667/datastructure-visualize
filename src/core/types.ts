/**
 * 步骤序列字段规范。
 * 对应需求文档 5.1 StepSchema / 7.1「步骤序列数据规范」。
 */
export type StepAction = 'init' | 'mark' | 'compare' | 'swap' | 'set' | 'sorted' | 'done'

/** 可视化形式：决定右侧用哪个渲染器 */
export type RendererKind = 'array' | 'seqlist' | 'linked' | 'scene'

/** 格子 / 结点的配色语义 */
export type CellTone = 'base' | 'hot' | 'done' | 'mark' | 'dim'

/** 一块板子里的一个格子 */
export interface CellItem {
  /** 格子里显示的主文字（数字 / 字符 / 运算符 / 帧名） */
  text: string
  /** 右下角的小字（下标、行号、序号…） */
  sub?: string
  /** 配色；不填就是 base */
  tone?: CellTone
  /**
   * 元素"从哪一侧滑进来"。不填按布局取默认：竖排默认从上方、横排/折行默认从左侧。
   * 共享栈那种"从右端往左长"的栈要显式写 'right'，否则动画方向就反了。
   */
  slide?: 'left' | 'right' | 'top'
}

/**
 * 一块「格子板」。栈、队列、矩阵、压缩表全都靠它表达，只是布局不同：
 *   column = 竖着排（顺序栈、共享栈的两端、递归调用栈）
 *   row    = 横着排（数组、压缩后的一维表）
 *   grid   = 按 cols 折行（矩阵、三元组表）
 *   ring   = 环形（循环队列）
 */
export interface BoardView {
  /** 板子上方的小标题 */
  title: string
  layout: 'row' | 'column' | 'grid' | 'ring'
  /** grid 布局的列数 */
  cols?: number
  items: CellItem[]
  /** 命名指针：名字 -> 格子序号（grid 时是行优先序号）。画成指向格子的小标签 */
  pointers?: Record<string, number>
  /** 格子之间的指针连线（十字链表的 right / down 用），值为格子序号 */
  links?: Array<{ from: number; to: number; dir: 'right' | 'down' }>
  /** 板子下方的一句提示（比如循环队列的"队空 / 队满"） */
  note?: string
}

/** 一条横向「纸带」：一串字符 + 当前扫描位置（括号匹配、表达式求值、字符串匹配用） */
export interface TapeView {
  label: string
  items: string[]
  /** 当前扫描到第几个（画个游标） */
  pos?: number
  /** 输入串 / 输出串，配色不同 */
  tone?: 'in' | 'out'
  /**
   * 前面空出几格再开始。
   * 字符串模式匹配要把模式串**压在**主串对应位置下面，
   * 靠它把这一趟的偏移量做出来。
   */
  pad?: number
}

/** 链表里的一个结点快照 */
export interface ListNodeSnapshot {
  /** 稳定 id：值可能重复，id 不会，动画和箭头靠它定位 */
  id: string
  value: number
  /** 后继结点 id；null 表示链尾 */
  next: string | null
  /** 前驱结点 id（双链表用） */
  prev?: string | null
  /** 头结点（不存数据，为了统一插入/删除的第一个位置） */
  dummy?: boolean
}

/** 链表类算法的结构快照 */
export interface ListView {
  /** 全部结点（含头结点） */
  nodes: ListNodeSnapshot[]
  /** 渲染顺序：先放从头指针走得到的结点，再放还没接上链的游离结点 */
  order: string[]
  /** 从头指针真的能走到的结点（不含游离结点）。判断"链尾指向谁"只看这一串 */
  reachable: string[]
  /** 头指针指向谁 */
  head: string | null
  /** 本步要重点高亮的结点 id */
  hot: string[]
  /** 命名指针：变量名 -> 结点 id（画成指向结点的小标签，如 p / pre / r / slow / fast） */
  pointers: Record<string, string | null>
  /** 环的入口结点 id（已经找到时给） */
  cycleEntry?: string | null
  /** 是否已经判定存在环 */
  hasCycle?: boolean
}

export interface AlgoStep {
  /** 该步骤对应的源码行号，1-based，必须落在 codeLines 范围内 */
  line: number
  /** 语义动作，渲染层据此决定配色 */
  action: StepAction
  /**
   * 当前的数据值序列（逻辑顺序）。
   * 数组类：就是数组本身；顺序表：前 length 个有效；链表：沿 next 走出来的 data。
   * 必须是独立快照。
   */
  array: number[]
  /** 本步直接操作的下标（数组/顺序表用）；链表类为空 */
  indices: number[]
  /** 到此步为止已经确定就位（或查找命中）的位置。由 engine 累积 */
  sortedIndices: number[]
  /**
   * 仍然在候选范围内的下标区间 [from, to]（含端点）。
   * from > to 表示空区间。查找类算法用它把"已经排除掉的"画暗。
   */
  range?: [number, number]
  /** 链表类算法的结构快照 */
  list?: ListView
  /**
   * 通用场景板（栈 / 队列 / 矩阵类算法用）。
   * 一次可以摆好几块 —— 比如对称矩阵要同时显示原矩阵和压缩后的一维表。
   */
  boards?: BoardView[]
  /** 纸带（括号匹配、表达式求值用） */
  tapes?: TapeView[]
  /** 一句话解说，显示在底部解说栏 */
  comment: string
  /** 关键变量快照，例如 { i: 0, j: 2, target: 42 } */
  vars?: Record<string, number>
  /** 累计统计 */
  stats: { compares: number; swaps: number }
}

/**
 * 算法生成器 yield 出来的原始事件：只需要填它自己知道的字段，
 * indices / sortedIndices / stats 由 engine 补齐。
 */
export type AlgoEvent = Pick<AlgoStep, 'line' | 'action' | 'array'> &
  Partial<Pick<AlgoStep, 'indices' | 'comment' | 'vars' | 'range' | 'list' | 'boards' | 'tapes'>>

export type AlgoRunner = Generator<AlgoEvent, void, void>

/** 算法大类（SRS FR-03：算法按大类 → 子类组织，可继续扩展） */
export type AlgoCategoryId = 'sort' | 'search' | 'linear' | 'stack' | 'queue' | 'matrix' | 'string'

export interface LegendItem {
  color: string
  label: string
}

/** 大类的元信息。不同大类关注的"状态"不一样，所以图例也随大类切换 */
export interface CategoryMeta {
  id: AlgoCategoryId
  name: string
  summary: string
  legend: LegendItem[]
}

/**
 * 算法接入规范（SRS EF-09）：新算法只实现这个接口并注册到注册表，
 * 播放器 / 代码面板 / 渲染器都不需要改动。
 */
export interface AlgorithmSpec {
  id: string
  name: string
  /** 所属大类，决定它在两级选择器里出现在哪一列 */
  category: AlgoCategoryId
  /** 所属子类（同一大类下再分组显示，如"顺序表""单链表"）；不填就是平铺 */
  group?: string
  /** 一句话简介 */
  summary: string
  /** 复杂度。有些算法没有"稳定性"这个概念，所以 stable 是可选的 */
  complexity: { time: string; space: string; stable?: boolean }
  /** 用哪个渲染器画右侧 */
  renderer: RendererKind
  /** 展示给用户的源码（C++ 风格），按行拆分。行号 = 下标 + 1 */
  codeLines: string[]
  defaultData: () => number[]
  /**
   * 输入是**固定串**而不是随机数字（括号匹配、表达式求值）。
   * 打开后"随机数据 / 数据规模"就失去意义，界面会禁用它们。
   */
  useFixedInput?: boolean
  /**
   * 输入长度取**平方数**（特殊矩阵压缩存储）。
   * 这类算法把一维数据按 n = √len 还原成 n×n 矩阵，
   * 长度不是平方数的话会有一截数据用不上，界面上"数据规模"也只给平方数。
   */
  squareInput?: boolean
  /** 首帧解说词。首帧由 engine 造，想说得具体一点就填这里 */
  initComment?: (data: number[], ctx: RunnerContext) => string
  /**
   * 把随机/原始数据规整成算法要求的形式。
   * 例如折半查找必须先有序、顺序表不能超过容量。
   */
  prepareData?: (raw: number[]) => number[]
  /** 查找类算法需要的目标值，从（已规整的）数据里挑一个 */
  defaultTarget?: (data: number[]) => number
  /** 插入/删除类算法需要的"位置"参数（1-based 位序） */
  defaultPos?: (data: number[]) => number
  /** 插入/删除类算法需要的"元素值" */
  defaultValue?: (data: number[]) => number
  /** 顺序表的容量（渲染器要画多少个格子） */
  capacity?: number
  /**
   * 链表类算法的**首帧**结构快照。
   * 首帧是 engine 造的（用来统一"初始状态"），生成器管不到它，
   * 所以链表算法要把初始链表结构在这里提供给 engine，否则第一帧画不出东西。
   */
  initList?: (data: number[], ctx: RunnerContext) => ListView
  /**
   * 场景类算法（栈 / 队列 / 矩阵 / 字符串）的首帧画面。
   * 同样是因为首帧由 engine 造，不在这里提供的话第一帧画不出东西。
   * 板子和纸带**至少给一个** —— 字符串匹配就只用两条纸带。
   */
  initScene?: (data: number[], ctx: RunnerContext) => { boards?: BoardView[]; tapes?: TapeView[] }
  createRunner: (data: number[], ctx?: RunnerContext) => AlgoRunner
}

/** 算法运行时需要的额外参数（查找的目标值、插入的位置和值等） */
export interface RunnerContext {
  target?: number
  pos?: number
  value?: number
  capacity?: number
}
