<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import CodePanel from '@/components/CodePanel.vue'
import CanvasPanel from '@/components/CanvasPanel.vue'
import SeqListPanel from '@/components/SeqListPanel.vue'
import LinkedListPanel from '@/components/LinkedListPanel.vue'
import ScenePanel from '@/components/ScenePanel.vue'
import TreePanel from '@/components/TreePanel.vue'
import GraphPanel from '@/components/GraphPanel.vue'
import ControlPanel from '@/components/ControlPanel.vue'
import AlgorithmNav from '@/components/AlgorithmNav.vue'
import AlgorithmPicker from '@/components/AlgorithmPicker.vue'
import UserMenu from '@/components/UserMenu.vue'
import AuthDialog from '@/components/AuthDialog.vue'
import DataInputDialog from '@/components/DataInputDialog.vue'
import NotesPanel from '@/components/NotesPanel.vue'
import FavoritesView from '@/views/FavoritesView.vue'
import HomeView from '@/views/HomeView.vue'
import ReportView from '@/views/ReportView.vue'
import { useAlgorithmStore } from '@/stores/algorithm'
import { useUserStore, difficultyText } from '@/stores/user'
import { normalizeHash, navigate, useRoute } from '@/router'
import type { StepAction } from '@/core/types'
import logoUrl from '@/assets/logo.png'

/**
 * 管理员后台按需加载（`#/admin` 才会去取这个文件的代码）。
 * 用动态 import 有两个好处：
 *   1. 游客的首页不会白白下载后台的代码；
 *   2. 后台页面由另一位同学负责，这里只约定"文件放在 `src/views/AdminView.vue`"，
 *      我这边不需要它的任何内部细节。
 */
const AdminView = defineAsyncComponent(() => import('@/views/AdminView.vue'))

const store = useAlgorithmStore()
const userStore = useUserStore()
const { route } = useRoute()
const { algorithm, currentAction, currentComment, currentVars, currentStats, isSearch } =
  storeToRefs(store)

const authDialog = ref<InstanceType<typeof AuthDialog> | null>(null)
/** 「手动输入数据」弹窗（顶栏那个 ✏️ 按钮打开它） */
const dataDialog = ref<InstanceType<typeof DataInputDialog> | null>(null)
/**
 * 顶栏那个算法选择器。
 * 空状态里那颗「看看有哪些算法」按钮要**把它打开**，所以这里留一个引用
 * （组件用 `defineExpose({ openPanel })` 把打开面板的方法放出来）。
 */
const pickerRef = ref<InstanceType<typeof AlgorithmPicker> | null>(null)
/** 收藏失败时的提醒（比如后端没启动）。只在"点不动"的时候出现，2.6 秒后自己消失 */
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | undefined

const ACTION_LABEL: Record<StepAction, string> = {
  init: '初始',
  mark: '标记',
  compare: '比较',
  swap: '交换',
  set: '移动',
  sorted: '就位',
  done: '完成',
}

const varList = computed(() =>
  Object.entries(currentVars.value).map(([key, value]) => ({ key, value })),
)

/** 当前算法是否已收藏（收藏集合来自 store，登出后自动变空） */
const favorited = computed(() => userStore.isFavorite(algorithm.value.id))
/** 难度徽章：元数据没拿到（后端没启动）时后端就没有这条，返回 ''，模板里不渲染 */
const difficulty = computed(() => {
  const meta = userStore.meta(algorithm.value.id)
  return meta ? difficultyText(meta.difficulty) : ''
})

/**
 * 顶栏「数据」那一组（数据规模 / 随机数据 / 手动输入 / 示例数据）**为什么点不了**，
 * 返回空串表示能用：
 *   1. **还没选算法** —— 数据是喂给"当前算法"的，连算法都没有，点了也没意义；
 *   2. 输入是**固定串**的算法（括号匹配 / 表达式求值）—— 本来就改不了数据。
 * 同一个原因也拿去做按钮的 `title`，鼠标一停就知道为什么点不了（禁用比"点了没反应"清楚）。
 */
const dataDisabledReason = computed(() => {
  if (!store.hasSelection) return '先选一个算法'
  if (algorithm.value.useFixedInput) return `「${algorithm.value.name}」的输入是固定的`
  return ''
})

/** 能用时显示这句说明，不能用时前面拼上原因 */
function dataTitle(hint: string): string {
  return dataDisabledReason.value ? `${dataDisabledReason.value}，暂时用不了` : hint
}

function showNotice(text: string): void {
  notice.value = text
  if (noticeTimer !== undefined) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
    noticeTimer = undefined
  }, 2600)
}

/**
 * 点标题栏那颗星。
 * 未登录 -> 弹登录框（store 只回信号，弹窗由界面决定）；
 * 请求失败 -> 顶部给一句中文提示，状态已经回滚，不会骗人。
 */
async function onToggleFavorite(): Promise<void> {
  const result = await userStore.toggleFavorite(algorithm.value.id)
  if (result.status === 'login') authDialog.value?.open('login')
  else if (result.status === 'failed') showNotice(result.message)
}

function onSizeChange(event: Event): void {
  store.setDataSize(Number((event.target as HTMLSelectElement).value))
}

/** 键盘快捷键（SRS NFR-14）：空格播放/暂停，左右方向键单步 */
function onKeydown(event: KeyboardEvent): void {
  // 还没选算法（空状态）时没有步骤可播，快捷键一律不响应
  if (!store.hasSelection) return
  const tag = (event.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

  if (event.key === ' ') {
    event.preventDefault()
    store.togglePlay()
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    store.pause()
    store.nextStep()
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    store.pause()
    store.prevStep()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // 地址栏归位（空地址 / 写错的地址都纠正成首页 `#/`），再问服务器"我是谁"、拉算法元数据
  normalizeHash()
  void userStore.init()
  void userStore.loadAlgorithmMeta()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (noticeTimer !== undefined) clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="app">
    <!--
      顶栏（logo + 算法选择器 + 用户区）。
      首页（`#/`）**不显示顶栏** —— 落地页要干净，而且还没进算法界面，
      "算法 / 数据规模"这些选择器也没有意义。首页自己的右上角单独放了一个 `<UserMenu />`
      （见 HomeView.vue），所以两处**不会同时出现**。
    -->
    <header v-if="route !== 'home'" class="topbar">
      <div class="brand">
        <img class="logo" :src="logoUrl" alt="算法可视化平台" />
        <div>
          <h1>算法可视化平台</h1>
        </div>
      </div>

      <div class="pickers">
        <label class="picker-label">算法</label>
        <!-- 还没选算法时它显示「请选择算法」；空状态里那颗按钮也用它来打开面板 -->
        <AlgorithmPicker ref="pickerRef" />

        <label :class="{ off: dataDisabledReason !== '' }">
          <span>数据规模</span>
          <select
            :value="store.dataSize"
            :disabled="dataDisabledReason !== ''"
            :title="dataTitle('选一个数据规模')"
            @change="onSizeChange"
          >
            <option v-for="n in store.sizes" :key="n" :value="n">{{ n }} 个</option>
          </select>
        </label>

        <!--
          「数据」这一组（随机 / 手动 / 示例）在**没选算法**时一律 disabled，
          并用 title 说清原因：数据是喂给"当前算法"的，没有当前算法时点了没有意义。
          输入是固定串的算法（括号匹配 / 表达式求值）同样禁用并说明原因。
        -->
        <button
          class="btn ghost"
          :disabled="dataDisabledReason !== ''"
          :title="dataTitle('随机生成一组数据')"
          @click="store.randomize()"
        >
          🎲 随机数据
        </button>
        <button
          class="btn ghost"
          :disabled="dataDisabledReason !== ''"
          :title="dataTitle('自己输入一串数字（2~12 个整数，用逗号或空格分开）')"
          @click="dataDialog?.open()"
        >
          ✏️ 手动输入
        </button>
        <button
          class="btn ghost"
          :disabled="dataDisabledReason !== ''"
          :title="dataTitle('载入这个算法自带的示例数据')"
          @click="store.restoreDefault()"
        >
          示例数据
        </button>
      </div>

      <!-- 「我的学习报告」入口：顶栏右侧、用户区左边，和收藏一样是"我的"这类功能 -->
      <button class="btn ghost report-btn" title="我的学习报告" @click="navigate('/report')">
        📊<span class="report-btn-text"> 学习报告</span>
      </button>

      <UserMenu />
    </header>

    <!-- 首页（落地页）：大字标题 + 进入学习的按钮 -->
    <HomeView v-if="route === 'home'" />

    <!-- 学习记录 / 收藏 -->
    <FavoritesView v-else-if="route === 'favorites'" />

    <!-- 我的学习报告：把学习记录画成图（环形覆盖率 + 条形分布 + Top 10） -->
    <ReportView v-else-if="route === 'report'" />

    <!-- 管理员后台：按需加载，只有切到 #/admin 才会去取这段代码 -->
    <AdminView v-else-if="route === 'admin'" />

    <!-- 主界面：算法可视化（`#/learn`） -->
    <template v-else>
      <!--
        ⭐ 还没选算法 —— 只显示空状态，**一点算法界面都不出**（没有代码面板 / 动画 / 图例 /
        笔记面板 / 步骤控制条 / 收藏星标，也没有上一下个算法按钮）。
        为什么不默认选中冒泡排序：那次"自动选中"会被学习记录当成一次学习记进 `history`
        （用户根本没看，记录里却多一条）。详见 `stores/algorithm.ts` 的 `hasSelection`。
      -->
      <section v-if="!store.hasSelection" class="learn-empty">
        <p class="learn-empty-icon">🧭</p>
        <p class="learn-empty-title">先选一个算法开始学习吧</p>
        <p class="learn-empty-tip">
          从上方顶栏的选择器里挑一个：大类 → 子类 → 算法（也可以直接搜算法名）。
          选好之后，这里就会出现代码、动画和上一步 / 下一步这些控制。
        </p>
        <button class="btn primary" @click="pickerRef?.openPanel()">看看有哪些算法</button>
      </section>

      <!-- 用户选过算法了：完整的算法学习界面 -->
      <template v-else>
        <main class="stage">
          <section class="pane">
            <div class="pane-head">
              <h2>{{ algorithm.name }}</h2>
              <button
                class="fav-star"
                :class="{ on: favorited }"
                :title="favorited ? '取消收藏这个算法' : '收藏这个算法（登录后可用）'"
                @click="onToggleFavorite"
              >
                {{ favorited ? '★' : '☆' }}
              </button>
              <span class="badge">{{ store.category.name }}</span>
              <span v-if="algorithm.group" class="badge">{{ algorithm.group }}</span>
              <span v-if="difficulty" class="badge difficulty">难度 {{ difficulty }}</span>
              <span class="badge">时间 {{ algorithm.complexity.time }}</span>
              <span class="badge">空间 {{ algorithm.complexity.space }}</span>
              <span v-if="algorithm.complexity.stable !== undefined" class="badge">
                {{ algorithm.complexity.stable ? '稳定' : '不稳定' }}
              </span>
            </div>
            <div class="pane-body">
              <CodePanel />
            </div>

            <!--
              学习笔记：放在**左栏（代码框）里面**，所以宽度天然等于代码框。
              以前它是整行放在两个面板下面 —— 那样会从整页高度里切走一条，
              动画区跟着变矮。放进左栏之后，只有代码区让出高度，动画区一点不受影响。
              未登录时它自己显示"登录 / 注册"并弹窗，父组件不用接线。
              ⚠️ 它整块都在"用户选过算法"这一支里：没选算法时 `algorithm.id` 只是默认候选
              （冒泡排序）的 id，拿它查笔记会查到"用户没看过的算法"的笔记。
            -->
            <div class="notes-wrap">
              <NotesPanel :algo-key="algorithm.id" />
            </div>
          </section>

          <section class="pane">
            <div class="pane-head">
              <h2>{{ algorithm.name }}</h2>
              <span class="badge">{{ algorithm.summary }}</span>
            </div>

            <!-- 图例随大类切换：排序 / 查找 / 线性表关注的状态不一样 -->
            <div class="legend">
              <span v-for="item in store.category.legend" :key="item.label">
                <i :style="{ background: item.color }"></i>{{ item.label }}
              </span>
            </div>

            <div class="pane-body">
              <CanvasPanel v-if="store.renderer === 'array'" />
              <SeqListPanel v-else-if="store.renderer === 'seqlist'" />
              <LinkedListPanel v-else-if="store.renderer === 'linked'" />
              <TreePanel v-else-if="store.renderer === 'tree'" />
              <GraphPanel v-else-if="store.renderer === 'graph'" />
              <ScenePanel v-else />
            </div>
          </section>
        </main>
        <footer class="bottom">
          <div class="explain">
            <div class="explain-body">
              <div class="explain-head">
                <span class="action-tag" :data-action="currentAction">
                  {{ ACTION_LABEL[currentAction] }}
                </span>
                <p class="comment">{{ currentComment }}</p>
              </div>
              <div class="chips">
                <span v-for="item in varList" :key="item.key" class="chip-var">
                  {{ item.key }} = {{ item.value }}
                </span>
                <span class="chip-var stat">比较 {{ currentStats.compares }} 次</span>
                <span v-if="!isSearch" class="chip-var stat">
                  交换 / 移动 {{ currentStats.swaps }} 次
                </span>
              </div>
            </div>

            <!-- 「上一个 / 下一个算法」放在解说栏右边、单步控制左边的空闲区域里 -->
            <AlgorithmNav />
          </div>

          <ControlPanel />
        </footer>
      </template>
    </template>

    <!-- 收藏失败之类的小提醒：贴在页面底部中间，自己会消失 -->
    <div v-if="notice" class="toast">{{ notice }}</div>

    <!-- 登录 / 注册弹窗（点收藏星标、点顶栏都能打开它） -->
    <AuthDialog ref="authDialog" />

    <!-- 「手动输入数据」弹窗（顶栏那个 ✏️ 按钮打开它） -->
    <DataInputDialog ref="dataDialog" />
  </div>
</template>
