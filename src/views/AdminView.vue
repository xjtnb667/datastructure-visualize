<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { adminStats, type AdminStats } from '@/api/client'
import AlgoPanel from '@/components/admin/AlgoPanel.vue'
import UserPanel from '@/components/admin/UserPanel.vue'
import { navigate } from '@/router'
import { useUserStore } from '@/stores/user'

/**
 * 管理员后台（路由 `#/admin`，由 App.vue 按需加载）。
 *
 * 结构很简单：
 *   顶部一行统计卡片（`adminStats()`）→ 两个标签页（用户管理 / 算法管理）。
 * 两个标签页各自是一个独立组件，自己管自己的搜索、分页、弹窗和请求，
 * 这个页面只负责：**权限判断 + 统计 + 切标签 + 弹提示**。
 *
 * 权限：`role !== 'admin'` 时给一句中文说明 + "回首页"，绝不留白屏。
 * 但要清楚 —— **前端藏起来只是体验，真正的拦截在后端**（每个管理接口都会再查一次角色）。
 */

const store = useUserStore()

type Tab = 'users' | 'algos'
const tab = ref<Tab>('users')

const stats = ref<AdminStats | null>(null)
const statsLoading = ref(false)
const statsError = ref('')

const toast = ref('')
const toastKind = ref<'ok' | 'error'>('ok')
let toastTimer: ReturnType<typeof setTimeout> | undefined

const isAdmin = computed(() => store.user?.role === 'admin')

const cards = computed(() => [
  { label: '用户总数', value: stats.value?.users, hint: '所有注册账号' },
  { label: '算法总数', value: stats.value?.algorithms, hint: '上架 + 下架一起算' },
  { label: '收藏总数', value: stats.value?.favorites, hint: '所有用户的收藏次数' },
  { label: '今日新增用户', value: stats.value?.todayUsers, hint: '今天注册的账号' },
])

/** 底部的小提示：成功是绿色、失败是红色，2.4 秒后自己消失 */
function notify(text: string, kind: 'ok' | 'error' = 'ok'): void {
  toast.value = text
  toastKind.value = kind
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
    toastTimer = undefined
  }, 2400)
}

async function loadStats(): Promise<void> {
  statsLoading.value = true
  statsError.value = ''
  try {
    stats.value = await adminStats()
  } catch (err) {
    statsError.value = store.errorText(err)
  } finally {
    statsLoading.value = false
  }
}

/*
 * 登录态是异步确认的（`store.init()`），所以不能只在 onMounted 里判断一次：
 * 确认成"是管理员"的那一刻再拉统计。`immediate` 让"本来就已经登录"的情况也走一遍。
 */
watch(
  isAdmin,
  (ok) => {
    if (ok && stats.value === null && !statsLoading.value) void loadStats()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (toastTimer !== undefined) clearTimeout(toastTimer)
})
</script>

<template>
  <section class="admin-view">
    <div class="admin-head">
      <h2>后台管理</h2>
      <div class="tabs">
        <button class="chip" :class="{ on: tab === 'users' }" @click="tab = 'users'">
          👤 用户管理
        </button>
        <button class="chip" :class="{ on: tab === 'algos' }" @click="tab = 'algos'">
          📚 算法管理
        </button>
      </div>
      <button class="btn ghost back-btn" @click="navigate('/')">← 回首页</button>
    </div>

    <div class="admin-body">
      <!-- 还没问完服务器"我是谁"：先给个占位，别闪一下"没权限" -->
      <div v-if="!store.ready" class="admin-hint">
        <p class="admin-hint-title">正在确认登录状态…</p>
      </div>

      <!-- 不是管理员：说清楚原因，并给一个回首页的入口（不留白屏） -->
      <div v-else-if="!isAdmin" class="admin-hint">
        <p class="admin-hint-title">这个页面只有管理员才能打开</p>
        <p class="admin-hint-tip">
          {{
            store.isLoggedIn
              ? `当前登录的账号「${store.displayName}」不是管理员。请换成管理员账号登录，再从右上角头像菜单里点「后台管理」。`
              : '当前还没有登录。请先用管理员账号登录，再从右上角头像菜单里点「后台管理」。'
          }}
        </p>
        <button class="btn primary" @click="navigate('/')">回首页</button>
      </div>

      <template v-else>
        <!-- 顶部一行统计卡片 -->
        <div class="stat-row">
          <div v-for="card in cards" :key="card.label" class="stat-card">
            <p class="stat-label">{{ card.label }}</p>
            <p class="stat-value">{{ card.value ?? (statsLoading ? '…' : '—') }}</p>
            <p class="stat-hint">{{ card.hint }}</p>
          </div>
        </div>

        <p v-if="statsError" class="admin-error">
          {{ statsError }}
          <button class="btn ghost tiny" type="button" @click="loadStats">重试</button>
        </p>

        <UserPanel v-if="tab === 'users'" @notice="notify" @changed="loadStats" />
        <AlgoPanel v-else @notice="notify" @changed="loadStats" />
      </template>
    </div>

    <div v-if="toast" class="toast" :class="toastKind">{{ toast }}</div>
  </section>
</template>

<style scoped>
/*
 * 管理员后台。
 * 配色、圆角、间距全部沿用全局那套（面板 #12161d、边框 #232a35、蓝 #3f6fd8、
 * 琥珀 #f59e0b 当强调色），所以这一页和算法界面、收藏页看起来是同一个产品。
 */
.admin-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #12161d;
  border: 1px solid #232a35;
  border-radius: 12px;
  overflow: hidden;
}

.admin-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 11px 16px;
  border-bottom: 1px solid #232a35;
}

.admin-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.tabs {
  display: inline-flex;
  gap: 6px;
}

/* 「回首页」推到最右边 */
.back-btn {
  margin-left: auto;
}

.admin-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 20px;
}

/* ---------- 没有权限 / 正在确认登录态 ---------- */
.admin-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 56px 16px;
  text-align: center;
}

.admin-hint-title {
  margin: 0;
  font-size: 15px;
  color: #d6dee8;
}

.admin-hint-tip {
  margin: 0;
  max-width: 440px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #8b949e;
}

/* ---------- 统计卡片 ---------- */
.stat-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.stat-card {
  padding: 12px 14px;
  background: #161b23;
  border: 1px solid #232a35;
  border-radius: 10px;
}

.stat-label {
  margin: 0;
  font-size: 12px;
  color: #8b949e;
}

.stat-value {
  margin: 6px 0 4px;
  font-size: 24px;
  font-weight: 600;
  font-family: Consolas, Monaco, monospace;
  color: #e6edf3;
}

.stat-hint {
  margin: 0;
  font-size: 11px;
  color: #5c6674;
}

/* 统计拉不到（后端没起来 / 令牌过期）时的提示 */
.admin-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
  padding: 8px 11px;
  font-size: 12.5px;
  color: #ff9c9c;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 8px;
}

.btn.tiny {
  padding: 4px 10px;
  font-size: 12px;
}

/* 成功的提示换成绿色（`.toast` 全局那套是红色，给"出错了"用的） */
.toast.ok {
  color: #b7f5d8;
  background: #16241f;
  border-color: rgba(16, 185, 129, 0.5);
}

/* 窄屏：统计卡片两列，别挤成一条 */
@media (max-width: 900px) {
  .stat-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
