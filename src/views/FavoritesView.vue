<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { algorithmRegistry, getAlgorithm } from '@/algorithms'
import { getCategory } from '@/core/categories'
import type { AlgoCategoryId } from '@/core/types'
import { navigate } from '@/router'
import { useAlgorithmStore } from '@/stores/algorithm'
import { difficultyText, useUserStore } from '@/stores/user'

/**
 * 「我的收藏 + 学习记录」。
 *
 * 两个区块各自独立：
 *   我的收藏 —— 收藏过的算法，点一下回到主界面并选中它（地址栏也跟着变回 `#/`）
 *   学习记录 —— 每个算法一行：打开几次 / 最多看到第几步 / 一共几步，表头可以排序
 *
 * 数据全部来自 `useUserStore`：收藏是登录后拉下来的；学习记录既有拉下来的，
 * 也有这次浏览时**本地合并**进去的（所以刚看完的算法不用刷新就排在最前面）。
 */

const store = useUserStore()
const algoStore = useAlgorithmStore()

type Tab = 'favorites' | 'history'

/**
 * 进来时落在哪个区块。
 * 从顶栏点「学习记录」会带 `#/favorites?tab=history`，这里**在 setup 里**读一次
 * （不是 onMounted）：首屏渲染就已经是对的那个区块，不会先闪一下"我的收藏"。
 */
function initialTab(): Tab {
  if (typeof window === 'undefined') return 'favorites'
  const query = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('tab') === 'history' ? 'history' : 'favorites'
}

const tab = ref<Tab>(initialTab())

/** 排序：打开次数 / 看到第几步 / 进度百分比 / 最近打开。点表头切换，再点一次反向 */
type SortKey = 'views' | 'max_step' | 'percent' | 'updated_at'
const sortKey = ref<SortKey>('updated_at')
const desc = ref(true)

/** 算法名：注册表里查得到就用它的名字，查不到就退回后端元数据、再退回 key，绝不空着 */
function nameOf(key: string): string {
  const spec = algorithmRegistry.find((item) => item.id === key)
  if (spec) return spec.name
  return store.meta(key)?.name || key
}

/**
 * 后端返回的 category 是字符串；万一管理员写了个前端不认识的大类，
 * `getCategory` 自己会兜底成第一个大类，所以这里直接断言成前端的大类 id 就行。
 */
function categoryName(id: string): string {
  return getCategory(id as AlgoCategoryId).name
}

function categoryOf(key: string): string {
  const spec = algorithmRegistry.find((item) => item.id === key)
  if (spec) return categoryName(spec.category)
  const meta = store.meta(key)
  return meta ? categoryName(meta.category) : '其他'
}

function summaryOf(key: string): string {
  const spec = algorithmRegistry.find((item) => item.id === key)
  return spec?.summary ?? store.meta(key)?.summary ?? ''
}

function difficultyOf(key: string): string {
  const meta = store.meta(key)
  return meta ? difficultyText(meta.difficulty) : ''
}

/** 收藏列表：按收藏时间倒序（最近收藏的在最上面） */
const favoriteRows = computed(() =>
  [...store.favorites]
    .map((key) => ({ key, createdAt: store.favoriteAt(key) }))
    .sort((a, b) => b.createdAt - a.createdAt),
)

const historyRows = computed(() => {
  const factor = desc.value ? -1 : 1
  return [...store.history]
    .map((item) => {
      const percent =
        item.total_steps > 0
          ? Math.min(100, Math.round((item.max_step / item.total_steps) * 100))
          : 0
      return {
        key: item.algo_key,
        views: item.views,
        maxStep: item.max_step,
        total: item.total_steps,
        updatedAt: item.updated_at,
        percent,
      }
    })
    .sort((a, b) => factor * (sortValue(a) - sortValue(b)))
})

/** 当前排序键对应的数值 */
function sortValue(row: {
  views: number
  maxStep: number
  percent: number
  updatedAt: number
}): number {
  if (sortKey.value === 'views') return row.views
  if (sortKey.value === 'max_step') return row.maxStep
  if (sortKey.value === 'percent') return row.percent
  return row.updatedAt
}

/** 时间戳 -> "2026-02-14 20:31"（本地时区；不引任何日期库） */
function formatTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function onSort(key: SortKey): void {
  if (sortKey.value === key) desc.value = !desc.value
  else {
    sortKey.value = key
    desc.value = true
  }
}

function arrow(key: SortKey): string {
  if (sortKey.value !== key) return ''
  return desc.value ? ' ↓' : ' ↑'
}

/**
 * 回主界面并选中这个算法。
 * 算法可能已经下架 / 从注册表里删掉了，`getAlgorithm` 会退回默认算法 ——
 * 这时就别硬切了，免得用户点了半天看到的还是冒泡排序。
 */
function openAlgorithm(id: string): void {
  const spec = getAlgorithm(id)
  if (spec.id !== id) {
    tab.value = 'favorites'
    return
  }
  algoStore.selectAlgorithm(spec.id)
  navigate('/')
}

async function toggleFavorite(id: string): Promise<void> {
  await store.toggleFavorite(id)
}

onMounted(() => {
  // 页面可能在别处登录之后才进来，进来时补一次最新数据（静默失败）
  void store.refreshUserData()
})
</script>

<template>
  <section class="fav-view">
    <div class="fav-head">
      <h2>我的收藏与学习记录</h2>
      <div class="tabs">
        <button class="chip" :class="{ on: tab === 'favorites' }" @click="tab = 'favorites'">
          ★ 我的收藏（{{ store.favorites.size }}）
        </button>
        <button class="chip" :class="{ on: tab === 'history' }" @click="tab = 'history'">
          🕘 学习记录（{{ store.history.length }}）
        </button>
      </div>
      <button class="btn ghost back-btn" @click="navigate('/')">← 回到算法界面</button>
    </div>

    <!-- 没登录：说清楚为什么是空的，并给一个回主界面的入口 -->
    <div v-if="!store.isLoggedIn" class="empty">
      <p class="empty-title">还没有登录</p>
      <p class="empty-tip">登录之后，收藏的算法和看到第几步都会记在你的账号里，换台电脑也还在。</p>
      <button class="btn primary" @click="navigate('/')">去看算法</button>
    </div>

    <!-- 我的收藏 -->
    <div v-else-if="tab === 'favorites'" class="fav-body">
      <div v-if="favoriteRows.length === 0" class="empty">
        <p class="empty-title">还没有收藏任何算法</p>
        <p class="empty-tip">
          在算法界面点标题右边的 ☆（星标）就能收藏，下次直接从这儿点回来。
        </p>
        <button class="btn primary" @click="navigate('/')">去看算法</button>
      </div>

      <ul v-else class="fav-list">
        <li v-for="item in favoriteRows" :key="item.key" class="fav-card">
          <button class="fav-main" @click="openAlgorithm(item.key)">
            <span class="fav-name">{{ nameOf(item.key) }}</span>
            <span class="badge">{{ categoryOf(item.key) }}</span>
            <span v-if="difficultyOf(item.key)" class="badge difficulty">
              难度 {{ difficultyOf(item.key) }}
            </span>
          </button>
          <p class="fav-desc">{{ summaryOf(item.key) }}</p>
          <p class="fav-time">收藏于 {{ formatTime(item.createdAt) }}</p>
          <button class="fav-remove" title="取消收藏" @click="toggleFavorite(item.key)">★</button>
        </li>
      </ul>
    </div>

    <!-- 学习记录 -->
    <div v-else class="fav-body">
      <div v-if="historyRows.length === 0" class="empty">
        <p class="empty-title">还没有学习记录</p>
        <p class="empty-tip">打开任意一个算法看上几步，这里就会记下你看到哪儿了。</p>
        <button class="btn primary" @click="navigate('/')">去看算法</button>
      </div>

      <table v-else class="history-table">
        <thead>
          <tr>
            <th class="col-name">算法</th>
            <th class="sortable" @click="onSort('views')">打开次数{{ arrow('views') }}</th>
            <th class="sortable" @click="onSort('max_step')">
              最多看到第几步{{ arrow('max_step') }}
            </th>
            <th>总步数</th>
            <th class="sortable" @click="onSort('percent')">进度{{ arrow('percent') }}</th>
            <th class="sortable" @click="onSort('updated_at')">最近打开{{ arrow('updated_at') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in historyRows" :key="row.key">
            <td class="col-name">
              <span class="row-name">{{ nameOf(row.key) }}</span>
              <span class="row-cat">{{ categoryOf(row.key) }}</span>
            </td>
            <td>{{ row.views }} 次</td>
            <td>第 {{ row.maxStep }} 步</td>
            <td>{{ row.total }} 步</td>
            <td class="col-progress">
              <span class="progress-bar"><i :style="{ width: row.percent + '%' }"></i></span>
              <span class="percent">{{ row.percent }}%</span>
              <span v-if="row.percent >= 100" class="done-tag">已看完</span>
            </td>
            <td class="time">{{ formatTime(row.updatedAt) }}</td>
            <td class="col-go">
              <button class="btn ghost tiny" @click="openAlgorithm(row.key)">继续看</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
/*
 * 收藏 / 学习记录页。
 * 配色、圆角、间距一律沿用全局那套（面板 #12161d、边框 #232a35、蓝 #3f6fd8、
 * 琥珀 #f59e0b 当强调色），所以这一页看起来和算法界面是同一个产品。
 */
.fav-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #12161d;
  border: 1px solid #232a35;
  border-radius: 12px;
  overflow: hidden;
}

.fav-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 11px 16px;
  border-bottom: 1px solid #232a35;
}

.fav-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.tabs {
  display: inline-flex;
  gap: 6px;
}

/* 「回到算法界面」推到最右边 */
.back-btn {
  margin-left: auto;
}

.fav-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 20px;
}

/* ---------- 空状态 ---------- */
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 48px 16px;
  text-align: center;
}

.empty-title {
  margin: 0;
  font-size: 15px;
  color: #d6dee8;
}

.empty-tip {
  margin: 0;
  max-width: 420px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #8b949e;
}

/* ---------- 我的收藏 ---------- */
.fav-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
  gap: 12px;
}

.fav-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: #161b23;
  border: 1px solid #232a35;
  border-radius: 10px;
  transition: border-color 0.14s, background 0.14s;
}

.fav-card:hover {
  background: #191f28;
  border-color: #2f3947;
}

.fav-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 22px 0 0;
  font-family: inherit;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
}

.fav-name {
  font-size: 14px;
  font-weight: 600;
  color: #e6edf3;
}

.fav-main:hover .fav-name {
  color: #79abff;
}

.fav-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #7d8694;
}

.fav-time {
  margin: 0;
  font-size: 11.5px;
  color: #5c6674;
}

/* 取消收藏：就是那颗点亮的星，平时不抢眼 */
.fav-remove {
  position: absolute;
  top: 9px;
  right: 9px;
  width: 24px;
  height: 24px;
  font-size: 14px;
  line-height: 1;
  color: #f5c518;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.fav-remove:hover {
  background: rgba(245, 197, 24, 0.14);
}

/* ---------- 学习记录 ---------- */
.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.history-table th {
  padding: 8px 10px;
  font-size: 11.5px;
  font-weight: 600;
  color: #8b949e;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid #232a35;
}

.history-table td {
  padding: 9px 10px;
  color: #c3cddb;
  border-bottom: 1px solid #1b212b;
  white-space: nowrap;
}

.history-table tbody tr:hover {
  background: #161b23;
}

.sortable {
  cursor: pointer;
  user-select: none;
}

.sortable:hover {
  color: #e6edf3;
}

.col-name {
  min-width: 150px;
}

.row-name {
  display: block;
  font-size: 13px;
  color: #e6edf3;
}

.row-cat {
  font-size: 11px;
  color: #5c6674;
}

.col-progress {
  min-width: 168px;
}

.progress-bar {
  display: inline-block;
  width: 84px;
  height: 6px;
  vertical-align: middle;
  background: #1f2733;
  border-radius: 4px;
  overflow: hidden;
}

.progress-bar i {
  display: block;
  height: 100%;
  background: #3f6fd8;
}

.percent {
  margin-left: 8px;
  font-family: Consolas, Monaco, monospace;
  color: #8b949e;
}

.done-tag {
  margin-left: 8px;
  padding: 1px 7px;
  font-size: 10.5px;
  color: #10b981;
  background: rgba(16, 185, 129, 0.14);
  border: 1px solid rgba(16, 185, 129, 0.4);
  border-radius: 20px;
}

.time {
  font-family: Consolas, Monaco, monospace;
  font-size: 11.5px;
  color: #8b949e;
}

.btn.tiny {
  padding: 4px 10px;
  font-size: 12px;
}
</style>
