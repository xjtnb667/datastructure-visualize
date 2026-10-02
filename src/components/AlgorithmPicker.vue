<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAlgorithmStore } from '@/stores/algorithm'
import { useUserStore } from '@/stores/user'
import { CATEGORIES } from '@/core/categories'
import { getGroupedByCategory } from '@/algorithms'
import type { AlgoCategoryId, AlgorithmSpec } from '@/core/types'

const store = useAlgorithmStore()
const userStore = useUserStore()
const { algorithm } = storeToRefs(store)

const open = ref(false)
/** 右列正在展示哪个大类 —— 绿色勾就打在它身上 */
const shownCategory = ref<AlgoCategoryId>(algorithm.value.category)
/** 是否已锁定：点过大类之后悬停不再改变右列，再点一次同一个大类可以解锁 */
const locked = ref(false)

const rootEl = ref<HTMLDivElement | null>(null)
/** 右列（算法列表）—— 打开时要把它滚到"当前算法"那一行居中 */
const algosEl = ref<HTMLElement | null>(null)

/**
 * 只显示**上架**的算法。
 * 下架状态由管理员在后台改，前端从 `/api/algorithms` 拿；
 * 后端没启动 / 游客时元数据是空的，`isOnline` 一律返回 true，
 * 也就是"和以前完全一样，98 个全在"。
 *
 * 注意：**当前正在看的算法一定要留着**，否则切换器上会显示一个
 * 列表里根本不存在的名字，看起来像是坏了。
 */
function visible(spec: AlgorithmSpec): boolean {
  return userStore.isOnline(spec.id) || spec.id === algorithm.value.id
}

/** 各大类下剩几个算法（左列那个数字） */
function visibleCount(id: AlgoCategoryId): number {
  return getGroupedByCategory(id)
    .flatMap((group) => group.items)
    .filter(visible).length
}

/** 按子类分组；没有 group 的算法会合成一个空标题的组，模板里跳过标题即可 */
const groups = computed(() =>
  getGroupedByCategory(shownCategory.value)
    .map((group) => ({ group: group.group, items: group.items.filter(visible) }))
    .filter((group) => group.items.length > 0),
)

/** 左列：整个大类都被下架了就不显示这一项，免得点进去是一片空白 */
const categories = computed(() => CATEGORIES.filter((cat) => visibleCount(cat.id) > 0))

/**
 * 把右列滚到"当前选中的算法"那一行，并让它落在**列表中间**。
 * 大类有十几个算法时，不滚动的话当前算法常常在可视区外面，一眼看不到自己在哪。
 */
async function centerCurrent(): Promise<void> {
  // 两次对齐：面板刚展开时右列高度还在算（第一次量到的位置会偏一两行），
  // 等一帧再量一次才准。
  const align = (): void => {
    const el = algosEl.value
    if (!el) return
    const item = el.querySelector('.algo-item.on') as HTMLElement | null
    if (!item) return
    const er = el.getBoundingClientRect()
    const ir = item.getBoundingClientRect()
    const delta = ir.top + ir.height / 2 - (er.top + er.height / 2)
    el.scrollTop = Math.max(0, el.scrollTop + delta)
  }
  await nextTick()
  align()
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  align()
}

function toggle(): void {
  open.value = !open.value
  if (open.value) {
    // 没锁定时：每次打开回到"当前算法所属大类"，鼠标一放上去就能预览。
    // 已锁定时：保持原样 —— 关掉再打开还是那一列，直到手动解锁为止。
    if (!locked.value) shownCategory.value = algorithm.value.category
    void centerCurrent()
  }
}

function close(): void {
  open.value = false
}

/**
 * 悬停预览。
 * 一旦锁定就不再跟随 —— 这正是为了避免"鼠标移向右列算法时，
 * 途中扫到别的大类，右列被换掉、结果点错了算法"。
 */
function onHover(id: AlgoCategoryId): void {
  if (locked.value) return
  shownCategory.value = id
}

/**
 * 点击大类。
 *   第一次点 -> 锁定（绿色勾钉住，悬停不再改变右列）
 *   再点同一个 -> 取消锁定，回到"鼠标放上去就预览"的状态
 *   点另一个 -> 锁转移到新的大类
 */
function onPickCategory(id: AlgoCategoryId): void {
  if (locked.value && shownCategory.value === id) {
    locked.value = false
    return
  }
  shownCategory.value = id
  locked.value = true
}

function choose(id: string): void {
  store.selectAlgorithm(id)
  close()
}

// 左列切到"当前算法所属大类"时，也把右列滚到当前算法居中
watch(shownCategory, () => {
  if (open.value && shownCategory.value === algorithm.value.category) void centerCurrent()
})

function onDocPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const el = rootEl.value
  if (el && !el.contains(event.target as Node)) close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) close()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootEl" class="picker">
    <button class="trigger" :class="{ open }" @click="toggle">
      <span class="cat">{{ store.category.name }}</span>
      <span class="slash">/</span>
      <span class="name">{{ algorithm.name }}</span>
      <span class="caret">▾</span>
    </button>

    <div v-if="open" class="panel">
      <!-- 第一列：大类 -->
      <div class="cat-col">
        <ul class="cats">
          <li
            v-for="cat in categories"
            :key="cat.id"
            class="cat-item"
            :class="{ on: cat.id === shownCategory }"
            @mouseenter="onHover(cat.id)"
            @click="onPickCategory(cat.id)"
          >
            <span class="check">{{ cat.id === shownCategory ? '✓' : '' }}</span>
            <span class="cat-name">{{ cat.name }}</span>
            <span class="count">{{ visibleCount(cat.id) }}</span>
          </li>
        </ul>
        <p v-if="locked" class="lock-hint">已锁定，再次点击取消锁定</p>
      </div>

      <!-- 第二列：该大类下的算法（按子类分组） -->
      <div ref="algosEl" class="algos">
        <template v-for="g in groups" :key="g.group || '_'">
          <p v-if="g.group" class="group-title">{{ g.group }}</p>
          <ul class="algo-list">
            <li
              v-for="item in g.items"
              :key="item.id"
              class="algo-item"
              :class="{ on: item.id === algorithm.id }"
              @click="choose(item.id)"
            >
              <div class="algo-top">
                <span class="algo-name">{{ item.name }}</span>
                <span class="algo-time">{{ item.complexity.time }}</span>
              </div>
              <div class="algo-desc">{{ item.summary }}</div>
            </li>
          </ul>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
}

.trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  font-size: 13px;
  font-family: inherit;
  color: #e6edf3;
  background: #1b212b;
  border: 1px solid #2c3542;
  border-radius: 7px;
  cursor: pointer;
  transition: border-color 0.14s, background 0.14s;
}

.trigger:hover,
.trigger.open {
  border-color: #3c4757;
  background: #222a36;
}

.cat {
  color: #f5c518;
  font-weight: 600;
}

.slash {
  color: #4d5561;
}

.caret {
  color: #7d8694;
  font-size: 11px;
}

.panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 50;
  display: flex;
  background: #161b23;
  border: 1px solid #2c3542;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

/* ---------- 第一列：大类 ---------- */
.cat-col {
  display: flex;
  flex-direction: column;
  width: 164px;
  padding: 6px;
  background: #12161d;
  border-right: 1px solid #232a35;
}

.cats {
  list-style: none;
  margin: 0;
  padding: 0;
}

.cat-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 9px;
  font-size: 13px;
  color: #9aa4b2;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.cat-item:not(.on):hover {
  background: #1c222c;
  color: #e6edf3;
}

/* 绿色 = 当前选中的大类 */
.cat-item.on {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  font-weight: 600;
}

/* 勾的位置永远占住，出现时布局不跳 */
.check {
  width: 12px;
  flex: none;
  color: transparent;
  font-weight: 700;
  line-height: 1;
}

.cat-item.on .check {
  color: #10b981;
}

.cat-name {
  flex: 1;
}

.count {
  font-size: 11px;
  color: #5c6674;
}

.cat-item.on .count {
  color: #3f9d78;
}

.lock-hint {
  margin: 6px 2px 1px;
  padding: 5px 6px;
  font-size: 10.5px;
  line-height: 1.45;
  color: #3f9d78;
  background: rgba(16, 185, 129, 0.08);
  border-radius: 5px;
  text-align: center;
}

/* ---------- 第二列：算法 ---------- */
.algos {
  width: 248px;
  max-height: 340px;
  overflow-y: auto;
  padding: 6px;
}

/*
 * 小类标题（分组名）：白色 + 加粗 + 高亮。
 * 高亮用"左侧琥珀色竖条 + 极淡同色底"——颜色取自 palette 的 compare 色 (#f59e0b)，
 * 刻意和"当前选中的算法"（.algo-item.on 的蓝色底 + #79abff 名字）分开色系：
 * 标题是分组标识，一眼能扫到，但不会盖过选中项。
 * 左边距 8px + 3px 竖条 = 11px，和 .algo-item 的文字左边缘对齐。
 */
.group-title {
  margin: 8px 0 3px;
  padding: 3px 10px 3px 8px;
  font-size: 11.5px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 0.5px;
  background: rgba(245, 158, 11, 0.14);
  border-left: 3px solid #f59e0b;
  border-radius: 3px;
}

.group-title:first-child {
  margin-top: 2px;
}

.algo-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.algo-item {
  padding: 9px 11px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.12s;
}

.algo-item:hover {
  background: #1c222c;
}

.algo-item.on {
  background: rgba(63, 111, 216, 0.16);
}

.algo-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.algo-name {
  font-size: 13.5px;
  color: #e6edf3;
}

.algo-item.on .algo-name {
  color: #79abff;
}

.algo-time {
  font-size: 11px;
  font-family: Consolas, Monaco, monospace;
  color: #5c6674;
}

.algo-desc {
  margin-top: 3px;
  font-size: 11.5px;
  color: #7d8694;
}
</style>
