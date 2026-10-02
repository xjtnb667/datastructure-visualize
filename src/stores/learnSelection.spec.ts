import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSSRApp, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import * as api from '@/api/client'
import { REPORT_INTERVAL_MS, useUserStore } from '@/stores/user'
import { useAlgorithmStore } from '@/stores/algorithm'
import { useRoute } from '@/router'
import App from '@/App.vue'

/**
 * 回归测试：**「进 #/learn 不默认选中算法、默认进入不算一次学习」**。
 *
 * 守的是用户实际报过的一个 bug：以前进 `#/learn` 会默认显示冒泡排序，
 * 而"当前算法"一进页面就已经是冒泡排序了，上报逻辑盯着它，于是**这一次默认进入
 * 被记成了一次学习**（学习记录里凭空多一条"打开过冒泡排序"，用户根本没看）。
 *
 * 修法（`75d8e4b`）是这么几层，下面六条用例把它们全罩住了（括号里是主要盯住它的用例）：
 *   1. `algorithm` store 加 `hasSelection` 标志，**没选算法就不显示任何算法界面**（①）；
 *   2. 上报判据从 `algorithm.id` 换成 `activeAlgoId = hasSelection ? id : null`（②③④）；
 *   3. `watch(activeAlgoId)` **去掉 `immediate`**，初值 null 本来就不该报（②）；
 *   4. `reportView()` 里再加一道 `hasSelection` 兜底，直接调用也不许发（②）；
 *   5. 登录态变化时的补报也只认"确实有用户选中的算法"（⑤⑥）。
 *
 * 为什么这几条必须常驻：这个 bug 的形态是"**多发了一条看不见的记录**"，
 * 界面上没有任何异常、点开动画一切正常，只有数据库里多一行 ——
 * 光靠肉眼看界面永远发现不了，只有断言能拦住它复发。
 *
 * 手法上刻意分成两类，互补：
 *   - **真渲染**（`vue/server-renderer`）：证明"用户眼前看到的东西"确实变了（①③）；
 *   - **纯 store 断言 + spy 记账**：证明"发出去的请求条数"精确到 1 条（②④⑤⑥）。
 */

/** 把 `reportHistory` 换成 spy 记账，用来数"到底发出去了几条上报请求" */
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    me: vi.fn(async () => ({
      id: 1,
      username: 'tester',
      nickname: '测试员',
      role: 'user',
      disabled: 0,
      created_at: 0,
      avatar: null,
    })),
    listFavorites: vi.fn(async () => []),
    listHistory: vi.fn(async () => []),
    listAlgorithms: vi.fn(async () => []),
    reportHistory: vi.fn(async () => ({ ok: true })),
  }
})

/** 上报请求的记账本 */
const spy = () => vi.mocked(api.reportHistory)

/** dev 模式下 SSR 会把模板里的注释一起输出，断言"看得见的东西"之前先去掉注释 */
const textOf = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '')

beforeEach(() => {
  vi.clearAllMocks()
})

/** 建一套新 store（模拟"刚打开页面"） */
function makeStores() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const algo = useAlgorithmStore(pinia)
  const user = useUserStore(pinia)
  useRoute().route.value = 'learn'
  return { pinia, algo, user }
}

/** 真渲染一遍整个 App，返回"用户实际看得见"的文本 */
async function renderLearn(pinia: ReturnType<typeof createPinia>): Promise<string> {
  useRoute().route.value = 'learn'
  const app = createSSRApp(App)
  app.use(pinia)
  return textOf(await renderToString(app))
}

describe('进入 #/learn 的空状态与学习记录上报', () => {
  it('① 刚进 #/learn、没选算法：只有空状态，没有任何算法界面', async () => {
    const { pinia } = makeStores()
    const text = await renderLearn(pinia)

    // 有引导提示，而不是甩给用户一个"默认算法"
    expect(text).toContain('先选一个算法开始学习吧')
    expect(text).toContain('看看有哪些算法')
    // 选择器显示「请选择算法」，不是「排序 / 冒泡排序」
    expect(text).toContain('请选择算法')
    expect(text).not.toContain('冒泡排序')

    // 算法界面的一整套零件一个都不该在
    expect(text).not.toContain('class="stage"')
    expect(text).not.toContain('notes-wrap')
    expect(text).not.toContain('◀ 上一步')
    expect(text).not.toContain('下一步 ▶')
    expect(text).not.toContain('▶ 播放')
    expect(text).not.toContain('class="progress"')
    expect(text).not.toContain('fav-star')
    expect(text).not.toContain('上一个算法')

    // 顶栏那组"数据规模 / 数据"控件是禁用的（没算法可喂数据）
    expect(text).toContain('先选一个算法，暂时用不了')
    expect(text).toContain('<select value="6" disabled')
  })

  it('② 已经登录的用户进 #/learn 但没选算法：一次上报请求都不发', async () => {
    vi.useFakeTimers()
    const { algo, user } = makeStores()
    await user.init()
    expect(user.isLoggedIn).toBe(true)

    // ⭐ 这一条就是原 bug 的正面防线：
    // 以前 watch 带 immediate、判据又是 algorithm.id（一进页面就是 bubble-sort），
    // 于是 init 完这里就已经是 1 次了。
    expect(spy()).toHaveBeenCalledTimes(0)

    // 把任何可能被排上队的定时上报都放出来
    await nextTick()
    vi.advanceTimersByTime(60_000)
    await nextTick()
    expect(spy()).toHaveBeenCalledTimes(0)
    expect(user.history).toHaveLength(0)

    // 兜底那一层：就算有人直接调 reportView，也不许发
    user.reportView('bubble-sort', 5, 40)
    vi.advanceTimersByTime(60_000)
    await nextTick()
    expect(spy()).toHaveBeenCalledTimes(0)
    expect(user.history).toHaveLength(0)
    expect(algo.hasSelection).toBe(false)
    vi.useRealTimers()
  })

  it('③ 用户选中一个算法：界面出现，并且恰好上报 1 次', async () => {
    vi.useFakeTimers()
    const { pinia, algo, user } = makeStores()
    await user.init()
    expect(spy()).toHaveBeenCalledTimes(0)

    algo.selectAlgorithm('bubble-sort') // 用户主动选（默认候选恰好也是它）
    expect(algo.hasSelection).toBe(true)
    await nextTick()
    vi.advanceTimersByTime(1)
    await nextTick()

    // 恰好 1 次 —— 不是 0 次（漏记）、也不是 2 次（默认那次 + 这次）
    expect(spy()).toHaveBeenCalledTimes(1)
    expect(spy().mock.calls[0]![0]).toBe('bubble-sort')

    // 选完之后界面该有的才出现（反过来证明 ① 的"没有"不是渲染失败导致的）
    const text = await renderLearn(pinia)
    expect(text).toContain('冒泡排序')
    expect(text).toContain('class="stage"')
    expect(text).toContain('notes-wrap')
    expect(text).toContain('◀ 上一步')
    expect(text).not.toContain('先选一个算法开始学习吧')
    vi.useRealTimers()
  })

  it('④ 再选另一个算法：再上报 1 次（共 2 次）；同一算法内翻步骤按节流合并', async () => {
    vi.useFakeTimers()
    const { algo, user } = makeStores()
    await user.init()

    algo.selectAlgorithm('bubble-sort')
    await nextTick()
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(spy()).toHaveBeenCalledTimes(1)

    // 换算法 = 又打开一次，打开次数该 +1
    algo.selectAlgorithm('selection-sort')
    await nextTick()
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(spy()).toHaveBeenCalledTimes(2)
    expect(spy().mock.calls.map((c) => c[0])).toEqual(['bubble-sort', 'selection-sort'])

    // 同一个算法内连翻 4 步：节流把这几步合并成一条，不该每步发一次
    for (const step of [2, 3, 4, 5]) user.reportView('selection-sort', step, algo.totalSteps)
    expect(spy()).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(REPORT_INTERVAL_MS)
    await nextTick()
    expect(spy()).toHaveBeenCalledTimes(3)
    expect(spy().mock.calls[2]![0]).toBe('selection-sort')
    expect(spy().mock.calls[2]![1]).toBe(5) // 报的是这段窗口里看到的最大步数
    vi.useRealTimers()
  })

  it('⑤ 没登录时选中算法不报；登录后因为"确实有用户选中的算法"才补报一次', async () => {
    vi.useFakeTimers()
    vi.mocked(api.me).mockResolvedValueOnce(null)
    const { algo, user } = makeStores()
    await user.init()
    expect(user.isLoggedIn).toBe(false)

    // 游客看动画不算学习记录，这是老行为，别改坏
    algo.selectAlgorithm('bubble-sort')
    await nextTick()
    vi.advanceTimersByTime(60_000)
    await nextTick()
    expect(spy()).toHaveBeenCalledTimes(0)

    // 登录（补报那一条 watch）—— 这一次是**该报的**，不能因为上面加了兜底就把它一起挡掉
    vi.mocked(api.me).mockResolvedValueOnce({
      id: 1,
      username: 'tester',
      nickname: '测试员',
      role: 'user',
      disabled: 0,
      created_at: 0,
      avatar: null,
    })
    await user.init()
    await nextTick()
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(spy()).toHaveBeenCalledTimes(1)
    expect(spy().mock.calls[0]![0]).toBe('bubble-sort')
    vi.useRealTimers()
  })

  it('⑥ 反过来：没选算法时登录态变化，不补报', async () => {
    vi.useFakeTimers()
    vi.mocked(api.me).mockResolvedValueOnce(null)
    const { user } = makeStores()
    await user.init()

    // 只登录、不选算法 —— 补报那条 watch 看的是 activeAlgoId（null），应该什么都不做
    vi.mocked(api.me).mockResolvedValueOnce({
      id: 1,
      username: 'tester',
      nickname: '测试员',
      role: 'user',
      disabled: 0,
      created_at: 0,
      avatar: null,
    })
    await user.init()
    await nextTick()
    vi.advanceTimersByTime(60_000)
    await nextTick()
    expect(spy()).toHaveBeenCalledTimes(0)
    vi.useRealTimers()
  })
})
