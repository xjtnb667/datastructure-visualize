import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  addFavorite,
  listAlgorithms,
  listFavorites,
  listHistory,
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  register as apiRegister,
  removeFavorite,
  reportHistory,
  updateMe as apiUpdateMe,
  type AlgoMeta,
  type HistoryItem,
  type User,
} from '@/api/client'
import { useAlgorithmStore } from '@/stores/algorithm'

/** 难度编号 -> 中文（和数据库里的 difficulty 字段一一对应） */
export const DIFFICULTY_LABEL: Record<number, string> = {
  1: '入门',
  2: '中等',
  3: '较难',
}

export function difficultyText(level: number | undefined): string {
  return DIFFICULTY_LABEL[level ?? 2] ?? '中等'
}

/**
 * `toggleFavorite()` 的结果。
 *   ok       —— 收藏成功了（`favorited` 是收藏后的状态）
 *   login    —— 还没登录：**store 只回信号，弹窗由界面负责**
 *   failed   —— 请求失败（比如后端没启动），`message` 是可以直接给用户看的中文
 *
 * `toggleFavorite` 只在"登录态已失效"这一种失败下回 `login`，网络错误回 `failed` ——
 * 否则后端一停，用户点收藏就被反复弹登录框，比报错更让人困惑。
 */
export type FavoriteResult =
  | { status: 'ok'; favorited: boolean }
  | { status: 'login' }
  | { status: 'failed'; message: string }

/** 步骤上报的节流参数（见 `reportView`） */
export const REPORT_INTERVAL_MS = 2000
export const REPORT_STEP_GAP = 5

export const useUserStore = defineStore('user', () => {
  // ---------- state ----------
  /** 当前登录的用户；没登录就是 null */
  const user = ref<User | null>(null)
  /** 启动时问过服务器"我是谁"了没有。没问完之前不显示"未登录"，免得顶栏闪一下 */
  const ready = ref(false)
  /** 收藏的算法 key 集合（Set 查起来是 O(1)，收藏多也不影响渲染） */
  const favorites = ref<Set<string>>(new Set())
  /** 每个收藏是什么时候加的（收藏页按它倒序；`algo_key -> created_at`） */
  const favoriteTimes = ref<Map<string, number>>(new Map())
  /** 学习记录（每个算法一条） */
  const history = ref<HistoryItem[]>([])
  /** 算法元数据：algo_key -> 元数据（难度、上架状态） */
  const algorithmMeta = ref<Map<string, AlgoMeta>>(new Map())
  /** 正在等接口返回（按钮转圈 / 禁用用） */
  const busy = ref(false)

  /**
   * 算法 store 的引用：学习记录的上报完全跟着"当前算法"走。
   * 它在下面的 `reportView` 里也要用（判断"用户到底选过算法没有"），所以放在最前面。
   */
  const algoStore = useAlgorithmStore()

  /** 每次接口调用自增。用来丢掉"过期的返回"：先发的请求后回来时不该覆盖新状态 */
  let callSeq = 0

  // ---------- getters ----------
  const isLoggedIn = computed(() => user.value !== null)
  const isAdmin = computed(() => user.value?.role === 'admin')
  /** 昵称拿不到就退回用户名，顶栏永远有东西显示 */
  const displayName = computed(() => user.value?.nickname || user.value?.username || '')
  /** 顶栏头像用：昵称第一个字（**没有自定义头像时**的圆形占位） */
  const avatarText = computed(() => displayName.value.slice(0, 1) || '游')
  /** 自定义头像的 data URL；没设置就是空串（界面按"显示首字占位"处理） */
  const avatarUrl = computed(() => user.value?.avatar ?? '')
  /** 有没有自定义头像 —— 顶栏和后台列表都靠它决定"显示图片还是显示首字" */
  const hasAvatar = computed(() => avatarUrl.value.length > 0)
  const favoriteKeys = computed<string[]>(() => [...favorites.value])
  /** 按算法 key 索引学习记录，方便视图里 O(1) 取 */
  const historyMap = computed(
    () => new Map(history.value.map((item) => [item.algo_key, item] as const)),
  )
  /** 学习记录按"最近更新"排好序（刚看过的排最前） */
  const historySorted = computed(() =>
    [...history.value].sort((a, b) => b.updated_at - a.updated_at),
  )

  /**
   * 拿某个算法的元数据。
   * **后端没启动时元数据是空的**，这里返回 undefined ——
   * 界面上一律按"没有额外信息"处理（不显示难度徽章），而不是显示 0 或空白。
   */
  function meta(algoKey: string): AlgoMeta | undefined {
    return algorithmMeta.value.get(algoKey)
  }

  /** 算法是否上架。元数据没拿到（游客 / 后端没开）时一律当作上架，保证功能与从前完全一致 */
  function isOnline(algoKey: string): boolean {
    const item = algorithmMeta.value.get(algoKey)
    return item ? item.online === 1 : true
  }

  function isFavorite(algoKey: string): boolean {
    return favorites.value.has(algoKey)
  }

  /** 什么时候收藏的（收藏页排序用）；后端没给过这个时间就回 0 */
  function favoriteAt(algoKey: string): number {
    return favoriteTimes.value.get(algoKey) ?? 0
  }

  // ---------- 拉数据 ----------
  /** 拉收藏和学习记录。**静默失败**：后端没起来也不该在界面上弹错误 */
  async function refreshUserData(): Promise<void> {
    if (!isLoggedIn.value) return
    const seq = ++callSeq
    try {
      const [favs, his] = await Promise.all([listFavorites(), listHistory()])
      if (seq !== callSeq) return
      favorites.value = new Set(favs.map((item) => item.algo_key))
      favoriteTimes.value = new Map(
        favs.map((item) => [item.algo_key, item.created_at] as const),
      )
      history.value = his
    } catch {
      // 后端不可用 / 令牌过期都走这里。保持现状即可，不打断用户看动画
    }
  }

  /**
   * 启动时调一次：问服务器"我是谁"，已登录就顺手把收藏和学习记录拉下来。
   * 全程静默失败（`me()` 未登录返回 null 而不是抛错）。
   */
  async function init(): Promise<void> {
    try {
      const current = await apiMe()
      user.value = current
      if (current) await refreshUserData()
    } catch {
      user.value = null
    } finally {
      ready.value = true
    }
  }

  /** 拉算法元数据（公开接口，游客也能拿）。失败就保持空 Map，界面不许崩 */
  async function loadAlgorithmMeta(): Promise<void> {
    try {
      const list = await listAlgorithms()
      algorithmMeta.value = new Map(
        list.map((item: AlgoMeta) => [item.algo_key, item] as const),
      )
    } catch {
      algorithmMeta.value = new Map()
    }
  }

  // ---------- 登录 / 注册 / 退出 ----------
  /** 登录成功返回 true；失败抛 Error（message 是后端给的中文说明） */
  async function login(username: string, password: string): Promise<boolean> {
    busy.value = true
    try {
      user.value = await apiLogin(username, password)
      await refreshUserData()
      return true
    } finally {
      busy.value = false
    }
  }

  async function register(username: string, nickname: string, password: string): Promise<boolean> {
    busy.value = true
    try {
      user.value = await apiRegister(username, nickname, password)
      await refreshUserData()
      return true
    } finally {
      busy.value = false
    }
  }

  /**
   * 退出登录。
   * 后端的令牌作废失败（比如后端已经关了）**也照样清本地状态** ——
   * 用户点了"退出登录"就必须退出去，不能因为网络问题退不掉。
   */
  async function logout(): Promise<void> {
    try {
      await apiLogout()
    } catch {
      // 忽略：本地状态照清
    } finally {
      user.value = null
      favorites.value = new Set()
      favoriteTimes.value = new Map()
      history.value = []
      callSeq++ // 丢掉可能在飞的旧请求
    }
  }

  // ---------- 自定义头像 ----------
  /**
   * 设置 / 清除自定义头像。
   *
   * `avatar` 传 data URL 字符串表示设置，传 `null` 表示**恢复默认**（清除）。
   * ⚠️ 传进来的字符串必须是**前端已经压到 128×128 的 JPEG**（见 `AvatarDialog.vue`），
   * 否则几 MB 的原图会直接进数据库（服务端另有 200KB 上限兜底）。
   *
   * 成功后用**后端返回的用户对象**整体刷新 store，顶栏、后台列表立刻跟着变；
   * 失败抛 Error，`error.message` 就是后端给的中文说明（界面直接显示）。
   */
  async function updateAvatar(avatar: string | null): Promise<void> {
    busy.value = true
    try {
      user.value = await apiUpdateMe({ avatar })
    } finally {
      busy.value = false
    }
  }

  // ---------- 收藏 ----------
  /**
   * 切换收藏状态。
   * 本地先改（乐观更新）+ 失败回滚，按钮点下去立刻有反应。
   * ⚠️ **未登录时返回 `{status:'login'}` 而不是自己弹窗** —— store 保持纯净，
   * 弹窗由界面决定（同一个信号在顶栏和算法面板标题栏各弹各的）。
   */
  async function toggleFavorite(algoKey: string): Promise<FavoriteResult> {
    if (!isLoggedIn.value) return { status: 'login' }

    const had = favorites.value.has(algoKey)
    const before = favoriteTimes.value.get(algoKey) ?? 0
    const next = new Set(favorites.value)
    const nextTimes = new Map(favoriteTimes.value)
    if (had) {
      next.delete(algoKey)
      nextTimes.delete(algoKey)
    } else {
      next.add(algoKey)
      nextTimes.set(algoKey, Date.now())
    }
    favorites.value = next
    favoriteTimes.value = nextTimes

    try {
      if (had) await removeFavorite(algoKey)
      else await addFavorite(algoKey)
      return { status: 'ok', favorited: !had }
    } catch (error) {
      // 回滚：以服务器为准，不能让用户以为收藏成功了
      const rollback = new Set(favorites.value)
      const rollbackTimes = new Map(favoriteTimes.value)
      if (had) {
        rollback.add(algoKey)
        rollbackTimes.set(algoKey, before)
      } else {
        rollback.delete(algoKey)
        rollbackTimes.delete(algoKey)
      }
      favorites.value = rollback
      favoriteTimes.value = rollbackTimes
      return { status: 'failed', message: errorText(error) }
    }
  }

  // ---------- 学习记录（节流上报） ----------
  /*
   * 上报分两种，正好对应数据库里那个表的两列：
   *   views  —— **打开一次算一次**：切换算法时立刻报一次（见下面的 watch）。
   *   max_step —— 看到第几步：步骤前进时**节流上报**。
   *
   * 一个算法的步骤可能有几百步，每一步都发请求会把浏览器和后端一起拖垮，
   * 所以同一个算法内按"每 2 秒 或 每 5 步"合并成一次请求，
   * 并且**每一步都记下最大步数**，攒到该发的时候按最大值发 ——
   * 这样"最多看到第几步"和一步步上报的精度是一样的。
   */
  let reportedAlgoKey: string | null = null
  let reportedMaxStep = 0
  let reportedTotal = 0
  let lastReportAt = 0
  let stepsSinceReport = 0
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * 换算法之后**是否真的已经发出去过一次**。
   * 不能用 `lastReportAt !== 0` 判断：切换算法时报的是第 1 步，
   * 定时器到点时如果用户还没点下一步，`max_step` 还是 0、请求不会真发出去，
   * 可 `lastReportAt` 已经被改掉了 —— 之后第一步就会白等 2 秒。这里单独记一个标志位。
   */
  let hasReportedSinceSwitch = false
  /**
   * **当前这个算法已经发出去过**的最大步数。
   *
   * 换算法时靠它判断"上一个算法还有没有没发出去的进度"：只有
   * `reportedMaxStep > sentMaxStep`（= 攒了新的、还没报过的进度）才值得补发一次。
   * 少了它的话，"选 A → 等 2 秒报过 → 再选 B"会把 A 已经报过的那份**原样再报一遍**，
   * A 的打开次数就多加了一次 —— 和"默认进入算一次学习"是同一类多记。
   */
  let sentMaxStep = 0

  function clearFlushTimer(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
  }

  /** 真正发请求，并把结果并回本地的学习记录（列表页立刻能看到） */
  function sendReport(): void {
    const key = reportedAlgoKey
    if (key === null || !isLoggedIn.value) return
    if (reportedMaxStep <= 0) return

    lastReportAt = Date.now()
    stepsSinceReport = 0
    hasReportedSinceSwitch = true
    clearFlushTimer()

    const step = reportedMaxStep
    const total = reportedTotal
    sentMaxStep = step
    void Promise.resolve(reportHistory(key, step, total)).catch(() => {
      // 静默失败：学习记录是附属功能，丢了也不该打断看动画
    })
    mergeHistory(key, step, total)
  }

  /** 把这次上报并进本地 history（不发请求），让"学习记录"页立刻是最新的 */
  function mergeHistory(algoKey: string, step: number, totalSteps: number): void {
    const index = history.value.findIndex((item) => item.algo_key === algoKey)
    const now = Date.now()
    if (index >= 0) {
      const before = history.value[index]!
      const next = [...history.value]
      next[index] = {
        ...before,
        max_step: Math.max(before.max_step, step),
        total_steps: totalSteps || before.total_steps,
        updated_at: now,
      }
      history.value = next
    } else {
      history.value = [
        ...history.value,
        { algo_key: algoKey, views: 1, max_step: step, total_steps: totalSteps, updated_at: now },
      ]
    }
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined) return
    const wait = Math.max(0, REPORT_INTERVAL_MS - (Date.now() - lastReportAt))
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      sendReport()
    }, wait)
  }

  /**
   * 上报学习进度。`step` 用**1-based**（和界面上"第 N / M 步"一致，
   * 数据库里 max_step 也是这个口径）。
   * 换算法后的第一次会**合并成一条请求**发出去（= 打开次数 +1），
   * 之后同一个算法内按"每 2 秒 或 每 5 步"节流。
   */
  function reportView(algoKey: string, step: number, totalSteps: number): void {
    if (!isLoggedIn.value) return
    // ⭐ 用户还没选算法 = 还没开始学：任何情况都**不发上报请求**。
    // 上面的 watch 已经不会在没选算法时调进来，这里再挡一层，
    // 保证"直接调 reportView"也不会把一次默认进入记成一次学习。
    if (!algoStore.hasSelection) return
    if (algoKey !== reportedAlgoKey) {
      // 换了算法：把上一个算法**还没发出去**的那点进度补发掉，再重置计数。
      // ⚠️ 判据是 `reportedMaxStep > sentMaxStep`（攒了新的、没报过的进度），
      // 不是 `reportedMaxStep > 0` —— 后者的意思是"报过一次就够本了"，
      // 会在"已经报过、进度又没再变"时把上一个算法的打开次数**多加一次**。
      if (reportedAlgoKey !== null && reportedMaxStep > sentMaxStep) sendReport()
      clearFlushTimer()
      reportedAlgoKey = algoKey
      reportedMaxStep = 0
      sentMaxStep = 0
      reportedTotal = totalSteps
      lastReportAt = 0
      stepsSinceReport = 0
      hasReportedSinceSwitch = false
    }

    reportedMaxStep = Math.max(reportedMaxStep, Math.max(0, step))
    reportedTotal = totalSteps

    // 换算法后的第一次：先攒一下再发 ——
    // 这样"打开算法 + 立刻拖到最后一步"只发一条请求，而且报的就是最后那一步
    if (!hasReportedSinceSwitch) {
      scheduleFlush()
      return
    }
    if (Date.now() - lastReportAt >= REPORT_INTERVAL_MS) {
      sendReport()
      return
    }
    stepsSinceReport += 1
    if (stepsSinceReport >= REPORT_STEP_GAP) sendReport()
    else scheduleFlush()
  }

  /**
   * 当前**用户真正在看**的算法 id；用户还没选算法时就是 `null`。
   *
   * ⭐ 上报只看它，不看 `algorithm.id`：`algorithm` 一进页面就装着默认算法（冒泡排序），
   * 直接盯 `algorithm.id` 的话，进 `#/learn` 这一次"默认进入"会被算成一次学习
   * （`history` 里多一条"打开过冒泡排序"，用户根本没看）。
   * 换成 `hasSelection ? id : null` 之后：
   *   - 刷新 / 首次进入 / 从首页点「进入学习」—— `hasSelection` 是 false，值是 null，**一次都不报**；
   *   - 用户点选择器 / 上一下个算法 / 收藏页"继续看" / `?algo=xxx` 直达 ——
   *     `selectAlgorithm()` 把 `hasSelection` 置 true，值从 null 变成那个 id，**恰好报一次**。
   */
  const activeAlgoId = computed<string | null>(() =>
    algoStore.hasSelection ? algoStore.algorithm.id : null,
  )

  /**
   * 盯着"用户选中的算法"：变了就上报一次（= 打开次数 +1）。
   * 放在 store 里而不是组件里，是为了保证**不管从哪儿选中算法**
   * （选择器 / 上一个算法 / 收藏页点回来 / 分享链接）都记得上。
   * 注意没有 `immediate` 也无所谓 —— 初值只可能是 null（没选算法），本来就不该报。
   */
  watch(activeAlgoId, (id) => {
    if (id === null) return
    reportView(id, 1, Math.max(algoStore.totalSteps, 1))
  })

  /**
   * 登录状态一变就把攒着的进度处理掉。
   * 退出登录：丢掉攒的计数，别再发请求。
   * 登录：**当前确实有用户选中的算法时**才补报一次 —— 打开页面时如果还没登录 /
   * 还没确认登录态，上面那个 watch 的那一次上报会被跳过；等登录完成后不补这一次的话，
   * "打开过这个算法"就永远少记一次（用户还会以为记录坏了）。
   * 没选算法（`activeAlgoId` 是 null）时**什么都不做**：那只是"默认进入"，不算学习。
   */
  watch(isLoggedIn, (logged) => {
    if (!logged) {
      reportedAlgoKey = null
      reportedMaxStep = 0
      sentMaxStep = 0
      clearFlushTimer()
      return
    }
    const id = activeAlgoId.value
    if (id === null) return
    reportView(id, 1, Math.max(algoStore.totalSteps, 1))
  })

  function errorText(error: unknown): string {
    return error instanceof Error && error.message ? error.message : '操作失败，请稍后重试'
  }

  return {
    // state
    user,
    ready,
    favorites,
    favoriteTimes,
    history,
    algorithmMeta,
    busy,
    // getters
    isLoggedIn,
    isAdmin,
    displayName,
    avatarText,
    avatarUrl,
    hasAvatar,
    favoriteKeys,
    historyMap,
    historySorted,
    // 查询
    meta,
    isOnline,
    isFavorite,
    favoriteAt,
    // actions
    init,
    loadAlgorithmMeta,
    refreshUserData,
    login,
    register,
    logout,
    updateAvatar,
    toggleFavorite,
    reportView,
    errorText,
  }
})

/**
 * 顺手把客户端的几个类型再导出一次，视图里 `import ... from '@/stores/user'` 就行，
 * 不用每个组件都去 import `@/api/client`。
 */
export type { AlgoMeta, FavItem, HistoryItem, User } from '@/api/client'
