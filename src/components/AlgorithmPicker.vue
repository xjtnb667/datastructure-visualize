<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAlgorithmStore } from '@/stores/algorithm'
import { CATEGORIES } from '@/core/categories'
import { countByCategory, getGroupedByCategory } from '@/algorithms'
import type { AlgoCategoryId } from '@/core/types'

const store = useAlgorithmStore()
const { algorithm } = storeToRefs(store)

const open = ref(false)
/** 右列正在展示哪个大类 —— 绿色勾就打在它身上 */
const shownCategory = ref<AlgoCategoryId>(algorithm.value.category)
/** 是否已锁定：点过大类之后悬停不再改变右列，再点一次同一个大类可以解锁 */
const locked = ref(false)

const rootEl = ref<HTMLDivElement | null>(null)

/** 按子类分组；没有 group 的算法会合成一个空标题的组，模板里跳过标题即可 */
const groups = computed(() => getGroupedByCategory(shownCategory.value))

function toggle(): void {
  open.value = !open.value
  if (open.value && !locked.value) {
    // 没锁定时：每次打开回到"当前算法所属大类"，鼠标一放上去就能预览。
    // 已锁定时：保持原样 —— 关掉再打开还是那一列，直到手动解锁为止。
    shownCategory.value = algorithm.value.category
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
            v-for="cat in CATEGORIES"
            :key="cat.id"
            class="cat-item"
            :class="{ on: cat.id === shownCategory }"
            @mouseenter="onHover(cat.id)"
            @click="onPickCategory(cat.id)"
          >
            <span class="check">{{ cat.id === shownCategory ? '✓' : '' }}</span>
            <span class="cat-name">{{ cat.name }}</span>
            <span class="count">{{ countByCategory(cat.id) }}</span>
          </li>
        </ul>
        <p v-if="locked" class="lock-hint">已锁定，再次点击取消锁定</p>
      </div>

      <!-- 第二列：该大类下的算法（按子类分组） -->
      <div class="algos">
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

.group-title {
  margin: 6px 0 2px;
  padding: 0 11px;
  font-size: 11px;
  color: #5c6674;
  letter-spacing: 0.5px;
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
