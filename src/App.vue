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
        <AlgorithmPicker />

        <label :class="{ off: algorithm.useFixedInput }">
          <span>数据规模</span>
          <select :value="store.dataSize" :disabled="algorithm.useFixedInput" @change="onSizeChange">
            <option v-for="n in store.sizes" :key="n" :value="n">{{ n }} 个</option>
          </select>
        </label>

        <button class="btn ghost" :disabled="algorithm.useFixedInput" @click="store.randomize()">
          🎲 随机数据
        </button>
        <!--
          手动输入数据：点开弹窗自己敲一串数字（5,2,9,1,7,3）。
          输入是**固定串**的算法（括号匹配 / 表达式求值）用不上，直接禁用并说明原因 ——
          禁用比"点了没反应"清楚。title 写在按钮上，鼠标一停就能看到为什么。
        -->
        <button
          class="btn ghost"
          :disabled="algorithm.useFixedInput"
          :title="
            algorithm.useFixedInput
              ? `「${algorithm.name}」的输入是固定的，不能用自定义数据`
              : '自己输入一串数字（2~12 个整数，用逗号或空格分开）'
          "
          @click="dataDialog?.open()"
        >
          ✏️ 手动输入
        </button>
        <button class="btn ghost" @click="store.restoreDefault()">示例数据</button>
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

      <!--
        学习笔记：整行排在"代码 / 动画"两块面板下面、步骤控制条上面。
        为什么放这里：
          - 笔记是**跟着当前算法**的（`:algo-key` 传的就是上面两块面板里那个算法），
            放在它们正下方，眼睛不用来回找；
          - 它是**整行**的，所以左栏 40% / 右栏 60% 的既有分栏一点没动 ——
            塞进左栏会挤掉代码、塞进右栏会挤掉动画（动画才是主角）；
          - 面板只有一个 `algoKey` 属性、登录框内嵌在它自己里面，挂上就能用，
            父组件不需要额外接线（未登录时它自己显示"登录 / 注册"并弹窗）。
      -->
      <div class="notes-wrap">
        <NotesPanel :algo-key="algorithm.id" />
      </div>

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

    <!-- 收藏失败之类的小提醒：贴在页面底部中间，自己会消失 -->
    <div v-if="notice" class="toast">{{ notice }}</div>

    <!-- 登录 / 注册弹窗（点收藏星标、点顶栏都能打开它） -->
    <AuthDialog ref="authDialog" />

    <!-- 「手动输入数据」弹窗（顶栏那个 ✏️ 按钮打开它） -->
    <DataInputDialog ref="dataDialog" />
  </div>
</template>
