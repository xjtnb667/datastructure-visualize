<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { algorithmRegistry, getAlgorithm } from '@/algorithms'
import {
  COMPLETE_N,
  RECENT_N,
  TOP_N,
  categoryColor,
  computeReport,
  formatReportTime,
  relativeTime,
  ringGeometry,
} from '@/core/report'
import { navigate } from '@/router'
import { useAlgorithmStore } from '@/stores/algorithm'
import { useUserStore } from '@/stores/user'

/**
 * 「我的学习报告」（`#/report`）。
 *
 * 这一页**不产生新数据**，只是把已经躺在数据库里的学习记录变成图：
 * 数据源就是 `userStore.history`（= `GET /api/history`，每个算法一条：
 * 打开次数 `views` / 最多看到第几步 `max_step` / 总步数 `total_steps` / 最近打开 `updated_at`），
 * 再配上前端注册表算出"总共几个算法"，于是就能算出覆盖率、分布、排行、完成度。
 *
 * ⚠️ **零图表库**：环形进度是自己写的 SVG（`<circle stroke-dasharray>`），
 * 条形图是纯 CSS（`<div style="width: x%">`）。所以这一页不加任何依赖，
 * 深色主题也和其它页面共用同一套颜色（面板 #12161d / 主色 #3f6fd8 / 强调 #f59e0b）。
 *
 * 所有数字都由 `computeReport()` 算出来（见 `src/core/report.ts`），这里只负责画。
 */

const store = useUserStore()
const algoStore = useAlgorithmStore()

/** 报告的全部数字（history 一变自动重算） */
const report = computed(() => computeReport(store.history, (key) => store.meta(key)?.name ?? ''))

/**
 * 环形进度的几何值。
 * 半径 54 / 线宽 12 是这一页定下的尺寸，周长由半径算出来，**不写死**。
 */
const RING_RADIUS = 54
const RING_WIDTH = 12
const ring = computed(() => ringGeometry(report.value.coveragePercent, RING_RADIUS))

/** 学过的算法数 / 总算法数 —— 环形图正中间那行小字 */
const coverageLabel = computed(
  () => `${report.value.studiedAlgorithms} / ${report.value.totalAlgorithms} 个算法`,
)

/** 条形图里最长的那个条归一化到 100%，其余按比例，这样 Top 10 的高低差看得清 */
const maxViews = computed(() =>
  Math.max(1, ...report.value.topViews.map((row) => row.views)),
)

function barWidth(value: number, max: number): string {
  return `${Math.max(value > 0 ? 3 : 0, Math.round((value / Math.max(1, max)) * 100))}%`
}

/**
 * 从报告里点回算法界面。
 * 算法可能已经从注册表里删掉了（`getAlgorithm` 会退回默认算法），
 * 那时就别硬跳 —— 点了「继续看」看到的却是冒泡排序，比不给点更让人困惑。
 */
function canOpen(key: string): boolean {
  return algorithmRegistry.some((spec) => spec.id === key)
}

function openAlgorithm(key: string): void {
  if (!canOpen(key)) return
  algoStore.selectAlgorithm(getAlgorithm(key).id)
  // 算法界面在 `#/learn`（`#/` 是首页）
  navigate('/learn')
}

onMounted(() => {
  // 可能是登录之后才进这一页的，进来补一次最新记录（静默失败，后端没起也不报错）
  void store.refreshUserData()
})
</script>

<template>
  <section class="report-view">
    <div class="report-head">
      <h2>我的学习报告</h2>
      <span class="report-sub">{{ store.displayName || '游客' }}</span>
      <div class="report-actions">
        <button class="btn ghost" @click="navigate('/favorites?tab=history')">学习记录明细</button>
        <button class="btn ghost" @click="navigate('/learn')">← 回到算法界面</button>
      </div>
    </div>

    <div class="report-body">
      <!-- ① 没登录：说清楚报告从哪来，并给一个入口 -->
      <div v-if="!store.isLoggedIn" class="empty">
        <p class="empty-title">还没有登录</p>
        <p class="empty-tip">
          学习报告是你自己的学习记录（打开过哪些算法、看到第几步）算出来的。
          登录之后这些记录会记在账号里，换台电脑打开也还在。
        </p>
        <button class="btn primary" @click="navigate('/learn')">去看算法</button>
      </div>

      <!-- ② 登录了但一条记录都没有 -->
      <div v-else-if="store.history.length === 0" class="empty">
        <p class="empty-title">还没有学习记录，去看几个算法吧</p>
        <p class="empty-tip">
          打开任意一个算法、往下走几步，这里就会画出你的覆盖率、各大类分布和最常看的算法。
        </p>
        <button class="btn primary" @click="navigate('/learn')">去看算法</button>
      </div>

      <!-- ③ 有数据：一整页图 -->
      <div v-else class="cards">
        <!-- 概览三个数字 -->
        <div class="card stat-card">
          <p class="stat-label">打开过的算法</p>
          <p class="stat-value">
            {{ report.openedAlgorithms }}<span class="stat-unit">个</span>
          </p>
          <p class="stat-foot">（打开过就算，不一定看完了）</p>
        </div>
        <div class="card stat-card">
          <p class="stat-label">学习次数</p>
          <p class="stat-value">
            {{ report.totalViews }}<span class="stat-unit">次</span>
          </p>
          <p class="stat-foot">所有算法加起来</p>
        </div>
        <div class="card stat-card">
          <p class="stat-label">学过的算法</p>
          <p class="stat-value">
            {{ report.studiedAlgorithms }}<span class="stat-unit">个</span>
          </p>
          <p class="stat-foot">至少往下看过一步</p>
        </div>

        <!-- 环形进度：算法覆盖率（SVG 手绘，无图表库） -->
        <div class="card ring-card">
          <h3 class="card-title">算法覆盖率</h3>
          <div class="ring-wrap">
            <svg
              class="ring"
              :viewBox="`0 0 ${(RING_RADIUS + RING_WIDTH) * 2} ${(RING_RADIUS + RING_WIDTH) * 2}`"
              role="img"
              :aria-label="`算法覆盖率 ${report.coveragePercent}%`"
            >
              <g :transform="`rotate(-90 ${RING_RADIUS + RING_WIDTH} ${RING_RADIUS + RING_WIDTH})`">
                <!-- 底环 -->
                <circle
                  class="ring-track"
                  :cx="RING_RADIUS + RING_WIDTH"
                  :cy="RING_RADIUS + RING_WIDTH"
                  :r="RING_RADIUS"
                  :stroke-width="RING_WIDTH"
                />
                <!-- 进度环：stroke-dasharray = "画出来的长度 剩下不画的长度" -->
                <circle
                  class="ring-value"
                  :cx="RING_RADIUS + RING_WIDTH"
                  :cy="RING_RADIUS + RING_WIDTH"
                  :r="RING_RADIUS"
                  :stroke-width="RING_WIDTH"
                  stroke-linecap="round"
                  :stroke-dasharray="`${ring.dash} ${ring.circumference - ring.dash}`"
                />
              </g>
            </svg>
            <div class="ring-center">
              <span class="ring-percent">{{ report.coveragePercent }}%</span>
              <span class="ring-note">{{ coverageLabel }}</span>
            </div>
          </div>
          <p class="card-foot">全部 {{ report.totalAlgorithms }} 个算法里，你学过 {{ report.studiedAlgorithms }} 个</p>
        </div>

        <!-- 按大类分布：纯 CSS 宽度百分比 -->
        <div class="card wide-card">
          <h3 class="card-title">按大类分布（9 个大类各学了几个）</h3>
          <ul class="bars">
            <li v-for="cat in report.categories" :key="cat.id" class="bar-row">
              <span class="bar-name">{{ cat.name }}</span>
              <span class="bar-track">
                <i :style="{ width: cat.percent + '%', background: cat.color }"></i>
              </span>
              <span class="bar-value">{{ cat.studied }} / {{ cat.total }}</span>
            </li>
          </ul>
        </div>

        <!-- 最常看的算法 Top 10 -->
        <div class="card wide-card">
          <h3 class="card-title">最常看的算法 Top {{ TOP_N }}</h3>
          <p v-if="report.topViews.length === 0" class="card-foot">还没有记录</p>
          <ul v-else class="bars">
            <li v-for="row in report.topViews" :key="row.key" class="bar-row">
              <button class="bar-name link" :disabled="!canOpen(row.key)" @click="openAlgorithm(row.key)">
                {{ row.name }}
              </button>
              <span class="bar-track">
                <i :style="{ width: barWidth(row.views, maxViews), background: categoryColor(row.category) }"></i>
              </span>
              <span class="bar-value">{{ row.views }} 次</span>
            </li>
          </ul>
        </div>

        <!-- 看得最完整的几个 -->
        <div class="card">
          <h3 class="card-title">看得最完整的 {{ COMPLETE_N }} 个</h3>
          <p v-if="report.mostComplete.length === 0" class="card-foot">
            还没有往下看过的算法（打开后至少走到第 2 步才会算进来）
          </p>
          <ul v-else class="rows">
            <li v-for="row in report.mostComplete" :key="row.key" class="row">
              <div class="row-main">
                <span class="row-name">{{ row.name }}</span>
                <span v-if="row.group" class="row-group">{{ row.group }}</span>
              </div>
              <span class="row-track">
                <i :style="{ width: row.percent + '%' }"></i>
              </span>
              <span class="row-value">
                第 {{ row.maxStep }} / {{ row.total }} 步 · {{ row.percent }}%
              </span>
            </li>
          </ul>
        </div>

        <!-- 最近学习 -->
        <div class="card">
          <h3 class="card-title">最近学习（最近 {{ RECENT_N }} 条）</h3>
          <ul class="rows">
            <li v-for="row in report.recent" :key="row.key" class="row recent-row">
              <div class="row-main">
                <span class="row-name">{{ row.name }}</span>
                <span class="row-cat">{{ row.categoryName }}</span>
              </div>
              <span class="row-time" :title="formatReportTime(row.updatedAt)">
                {{ relativeTime(row.updatedAt) }}
              </span>
              <button class="btn ghost tiny" :disabled="!canOpen(row.key)" @click="openAlgorithm(row.key)">
                继续看
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * 学习报告页。
 * 底色 / 边框 / 圆角一律沿用全局那套（面板 #12161d、边框 #232a35、卡片 #161b23、
 * 主色 #3f6fd8、琥珀 #f59e0b），所以它和算法界面、收藏页看起来是同一个产品。
 * 窄屏靠 grid 的 auto-fit + minmax 自己堆成一列，不用写 media query。
 */
.report-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #12161d;
  border: 1px solid #232a35;
  border-radius: 12px;
  overflow: hidden;
}

.report-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 11px 16px;
  border-bottom: 1px solid #232a35;
}

.report-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.report-sub {
  padding: 2px 9px;
  font-size: 11.5px;
  color: #9aa4b2;
  background: #1b212b;
  border: 1px solid #2c3542;
  border-radius: 20px;
}

/* 两个按钮推到最右边 */
.report-actions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}

.report-actions .btn {
  padding: 6px 12px;
  font-size: 12.5px;
}

.report-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 20px;
}

/* ---------- 空状态（和收藏页同一个长相） ---------- */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 52px 16px;
  text-align: center;
}

.empty-title {
  margin: 0;
  font-size: 15px;
  color: #d6dee8;
}

.empty-tip {
  margin: 0;
  max-width: 460px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #8b949e;
}

/* ---------- 卡片网格 ---------- */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(268px, 1fr));
  gap: 12px;
  align-items: start;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  background: #161b23;
  border: 1px solid #232a35;
  border-radius: 10px;
}

/* 条形图那两张卡片尽量占满一整行（窄屏时 auto-fit 自己会让它变一列） */
.wide-card {
  grid-column: 1 / -1;
}

.card-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #e6edf3;
}

.card-foot {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: #7d8694;
}

/* ---------- 概览数字 ---------- */
.stat-card {
  gap: 4px;
}

.stat-label {
  margin: 0;
  font-size: 12px;
  color: #8b949e;
}

.stat-value {
  margin: 0;
  font-family: Consolas, Monaco, monospace;
  font-size: 30px;
  line-height: 1.15;
  color: #79abff;
}

.stat-unit {
  margin-left: 4px;
  font-size: 13px;
  color: #8b949e;
}

.stat-foot {
  margin: 0;
  font-size: 11px;
  color: #5c6674;
}

/* ---------- 环形进度（SVG，零图表库） ---------- */
.ring-card {
  align-items: center;
}

.ring-card .card-title {
  align-self: flex-start;
}

.ring-wrap {
  position: relative;
  width: min(190px, 58vw);
  aspect-ratio: 1 / 1;
}

.ring {
  display: block;
  width: 100%;
  height: 100%;
}

.ring-track {
  fill: none;
  stroke: #1f2733;
}

.ring-value {
  fill: none;
  /* 进度环就用平台主色 #3f6fd8，和"进入学习"按钮、收藏页进度条同一支颜色 */
  stroke: #3f6fd8;
  transition: stroke-dasharray 0.4s ease;
}

/* 正中间那两行字（绝对定位在环里，不参与 SVG 布局） */
.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  pointer-events: none;
}

.ring-percent {
  font-family: Consolas, Monaco, monospace;
  font-size: 30px;
  font-weight: 600;
  color: #e6edf3;
}

.ring-note {
  font-size: 11.5px;
  color: #8b949e;
}

/* ---------- 横向条形图（纯 CSS 宽度百分比） ---------- */
.bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.bar-row {
  display: grid;
  /* 名字列固定宽度，条形和数字才能上下对齐 */
  grid-template-columns: 104px 1fr 66px;
  align-items: center;
  gap: 10px;
}

.bar-name {
  padding: 0;
  font-family: inherit;
  font-size: 12.5px;
  color: #c3cddb;
  text-align: left;
  background: transparent;
  border: none;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.bar-name.link {
  cursor: pointer;
}

.bar-name.link:hover:not(:disabled) {
  color: #79abff;
  text-decoration: underline;
}

.bar-name:disabled {
  color: #7d8694;
  cursor: default;
}

.bar-track {
  height: 12px;
  background: #1b212b;
  border-radius: 6px;
  overflow: hidden;
}

.bar-track i {
  display: block;
  height: 100%;
  min-width: 0;
  border-radius: 6px;
  transition: width 0.4s ease;
}

.bar-value {
  font-family: Consolas, Monaco, monospace;
  font-size: 11.5px;
  color: #8b949e;
  text-align: right;
  white-space: nowrap;
}

/* ---------- 明细行（完成度 / 最近学习） ---------- */
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.row {
  display: grid;
  grid-template-columns: minmax(96px, 1fr) 96px auto;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid #1b212b;
}

.row:last-child {
  border-bottom: none;
}

.row-main {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.row-name {
  font-size: 12.5px;
  color: #e6edf3;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.row-group,
.row-cat {
  flex: none;
  font-size: 11px;
  color: #5c6674;
}

.row-track {
  height: 8px;
  background: #1b212b;
  border-radius: 4px;
  overflow: hidden;
}

.row-track i {
  display: block;
  height: 100%;
  background: #3f6fd8;
  border-radius: 4px;
  transition: width 0.4s ease;
}

.row-value,
.row-time {
  font-family: Consolas, Monaco, monospace;
  font-size: 11.5px;
  color: #8b949e;
  text-align: right;
  white-space: nowrap;
}

.recent-row {
  grid-template-columns: minmax(96px, 1fr) 78px auto;
}

.row .btn.tiny {
  padding: 3px 9px;
  font-size: 11.5px;
}

/* 窄屏：条形图的名字列收窄一点，别把条形挤没了 */
@media (max-width: 560px) {
  .bar-row {
    grid-template-columns: 78px 1fr 56px;
    gap: 8px;
  }

  .row,
  .recent-row {
    grid-template-columns: minmax(80px, 1fr) auto;
  }

  /* 窄屏时完成度那条进度条藏掉，只留"第 x / y 步 · z%" */
  .row-track {
    display: none;
  }
}
</style>
