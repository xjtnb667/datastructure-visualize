<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAlgorithmStore } from '@/stores/algorithm'
import { useUserStore } from '@/stores/user'
import { CATEGORIES } from '@/core/categories'
import { getGroupedByCategory } from '@/algorithms'
import { searchAlgorithms } from '@/core/algorithmSearch'
import type { AlgoCategoryId, AlgorithmSpec } from '@/core/types'

const store = useAlgorithmStore()
const userStore = useUserStore()
const { algorithm, hasSelection } = storeToRefs(store)

/**
 * 列表里"打蓝色高亮"的那个算法 id —— **用户没选过就是空串**。
 *
 * 为什么不能直接用 `algorithm.id`：`algorithm` 一进页面就装着默认算法（冒泡排序），
 * 用户还没选任何东西时，列表里就会把"冒泡排序"高亮成"你正在看的这个"，
 * 而实际上他什么都没选（顶栏显示的是「请选择算法」）。空串谁都匹配不上，正好。
 */
const currentId = computed(() => (hasSelection.value ? algorithm.value.id : ''))

const open = ref(false)
/** 右列正在展示哪个大类 —— 绿色勾就打在它身上 */
const shownCategory = ref<AlgoCategoryId>(algorithm.value.category)
/** 是否已锁定：点过大类之后悬停不再改变右列，再点一次同一个大类可以解锁 */
const locked = ref(false)

/**
 * 搜索关键词。
 * 非空时面板**整块换成搜索结果**（跨所有大类匹配名称 / id），清空就回到两级选择器。
 * 输入框在打开面板时自动聚焦，所以打开就能直接打字。
 */
const query = ref('')
/** 搜索结果里键盘选中的那条（上下键移动，回车选中） */
const activeIndex = ref(0)
const searchInput = ref<HTMLInputElement | null>(null)

const rootEl = ref<HTMLDivElement | null>(null)
/** 右列（算法列表）—— 打开时要把它滚到"当前算法"那一行居中 */
const algosEl = ref<HTMLElement | null>(null)
/** 搜索结果列表 —— 键盘移动时要把选中那条滚进可视区 */
const resultsEl = ref<HTMLElement | null>(null)

/**
 * 只显示**上架**的算法。
 * 下架状态由管理员在后台改，前端从 `/api/algorithms` 拿；
 * 后端没启动 / 游客时元数据是空的，`isOnline` 一律返回 true，
 * 也就是"和以前完全一样，98 个全在"。
 *
 * 注意：**当前正在看的算法一定要留着**，否则切换器上会显示一个
 * 列表里根本不存在的名字，看起来像是坏了。
 * （"当前正在看" = `currentId`；用户还没选过算法时它是空串，没有谁需要被留住。）
 */
function visible(spec: AlgorithmSpec): boolean {
  return userStore.isOnline(spec.id) || spec.id === currentId.value
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
 * 搜索结果（跨所有大类按名称 / id 模糊匹配）。
 * 匹配规则是纯函数，见 `src/core/algorithmSearch.ts`。
 * 搜索时也照样遵守"下架的不显示"——但**当前正在看的那个算法一定留着**，
 * 不然会出现"顶栏显示着它、列表里搜不到"的怪现象。
 */
const results = computed(() =>
  searchAlgorithms(query.value).filter((hit) => visible(hit.spec)),
)

/** 关键词非空 = 面板切到搜索结果模式（清空就回到两级选择器） */
const searching = computed(() => query.value.trim().length > 0)

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
 * 打开面板（并且和点触发器一样：回到当前算法所属大类、把当前算法滚到中间）。
 * 空状态里那颗「看看有哪些算法」按钮用它 —— 界面上只有一个面板，
 * 不必为它再写一套"从外面打开"的第二状态。
 */
function openPanel(): void {
  if (!open.value) toggle()
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
  query.value = ''
  close()
}

// 关键词一变，键盘选中的那条回到第一条（否则会出现"高亮停在第 7 条，可结果只剩 2 条"）
watch(query, () => {
  activeIndex.value = 0
})

// 面板一打开就聚焦搜索框：打开即可打字，不用先点一下输入框
watch(open, (isOpen) => {
  if (isOpen) void nextTick(() => searchInput.value?.focus())
})

// 键盘选中的那条滚进可视区（结果多于一屏时，光高亮看不见等于没有）
watch([activeIndex, results], () => {
  void nextTick(() => {
    resultsEl.value?.querySelector('.result-item.active')?.scrollIntoView({ block: 'nearest' })
  })
})

function moveActive(delta: number): void {
  const count = results.value.length
  if (count === 0) return
  // 绕着走：在第一条按 ↑ 跳到末尾，在最后一条按 ↓ 回到第一条
  activeIndex.value = (activeIndex.value + delta + count) % count
}

/** 当前算法是否算"学过"用不上，这里只管选中并收起面板 */
function chooseActive(): void {
  const hit = results.value[activeIndex.value]
  if (hit) choose(hit.spec.id)
}

/** `Esc`：搜索框里有字就先清空、回到两级选择器；已经空了才关面板 */
function escapeSearch(): void {
  if (query.value) {
    query.value = ''
    searchInput.value?.focus()
    return
  }
  close()
}

/**
 * 搜索结果区（不是输入框）上的键盘操作。
 * 输入框失焦后上下键仍然可用，因为整个面板是一个整体，不该出现"点了结果区键盘就失效"。
 */
function onResultsKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (document.activeElement !== searchInput.value) moveActive(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    chooseActive()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    escapeSearch()
  }
}

/**
 * 搜索框自己的键盘操作。
 * 输入框里的方向键 / 回车本来没有默认行为，直接接管；
 * 一律 `stopPropagation`，免得触发了外层（App.vue）的左右方向键单步。
 */
function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.stopPropagation()
    event.preventDefault()
    moveActive(1)
  } else if (event.key === 'ArrowUp') {
    event.stopPropagation()
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === 'Enter') {
    event.stopPropagation()
    event.preventDefault()
    chooseActive()
  } else if (event.key === 'Escape') {
    event.stopPropagation()
    event.preventDefault()
    escapeSearch()
  }
}

function clearSearch(): void {
  query.value = ''
  searchInput.value?.focus()
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
  // 焦点在搜索框上时由 `onSearchKeydown` 处理（它会 stopPropagation，走不到这里）
  if (event.key !== 'Escape' || !open.value) return
  // 焦点不在搜索框（比如刚点过左列大类）：Esc 关面板，但先把光标送回搜索框，
  // 免得"下一次打开面板时输入焦点还留在别处"
  close()
  searchInput.value?.focus()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  document.removeEventListener('keydown', onKeydown)
})

/**
 * 放出去的东西：
 *   - `openPanel()` —— 空状态里那颗「看看有哪些算法」按钮用它打开面板；
 *   - `open` —— 面板开没开（父组件和自动化测试都能直接看）。
 */
defineExpose({ openPanel, open })
</script>

<template>
  <div ref="rootEl" class="picker">
    <!--
      触发器上的两段文字（大类 / 算法名）**只在用户选过算法时**才显示：
      没选之前显示「请选择算法」，免得看起来像"已经默认选中了冒泡排序"。
    -->
    <button class="trigger" :class="{ open }" @click="toggle">
      <template v-if="hasSelection">
        <span class="cat">{{ store.category.name }}</span>
        <span class="slash">/</span>
        <span class="name">{{ algorithm.name }}</span>
      </template>
      <span v-else class="placeholder">请选择算法</span>
      <span class="caret">▾</span>
    </button>

    <div v-if="open" class="panel" @keydown="onResultsKeydown">
      <!--
        搜索框：跨所有大类按算法名 / id 模糊匹配。
        面板打开时自动获得焦点；有内容时下面整块换成搜索结果；清空就回到两级选择器。
      -->
      <div class="search-bar">
        <span class="search-ico">🔍</span>
        <input
          ref="searchInput"
          v-model="query"
          class="search-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="搜索算法（名称或 id，跨全部大类）"
          aria-label="搜索算法"
          @keydown="onSearchKeydown"
        />
        <button v-if="query" class="search-clear" title="清空搜索（Esc）" @click="clearSearch">
          ✕
        </button>
      </div>

      <!-- 搜索结果：跨大类，所以每条都标出它属于哪个大类 / 子类 -->
      <div v-if="searching" ref="resultsEl" class="results">
        <p v-if="results.length === 0" class="results-empty">
          没找到匹配「{{ query }}」的算法，换个关键词试试
        </p>
        <ul v-else class="result-list">
          <li
            v-for="(hit, index) in results"
            :key="hit.spec.id"
            class="result-item"
            :class="{ on: hit.spec.id === currentId, active: index === activeIndex }"
            @mouseenter="activeIndex = index"
            @click="choose(hit.spec.id)"
          >
            <div class="result-top">
              <span class="result-name">{{ hit.spec.name }}</span>
              <span class="result-time">{{ hit.spec.complexity.time }}</span>
            </div>
            <div class="result-where">
              <span class="result-cat">{{ hit.categoryName }}</span>
              <span v-if="hit.group" class="result-group">{{ hit.group }}</span>
              <span class="result-id">id: {{ hit.spec.id }}</span>
            </div>
          </li>
        </ul>
        <p class="results-tip">↑ ↓ 选择 · 回车打开 · Esc 清空搜索</p>
      </div>

      <!-- 没有搜索关键词：原来的两级选择器（左列大类 + 右列算法） -->
      <div v-else class="columns">
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
                :class="{ on: item.id === currentId }"
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

/*
 * 还没选算法时触发器上那句「请选择算法」。
 * 用灰色（#8b949e，和顶栏其它标签同色）而不是白色：它是**提示**，
 * 不能看起来像"已经选中了一个叫『请选择算法』的算法"。
 */
.placeholder {
  color: #8b949e;
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
  /* 搜索框在上、内容在下：所以这里改成纵向排列 */
  display: flex;
  flex-direction: column;
  background: #161b23;
  border: 1px solid #2c3542;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  /* 视口窄的时候别让面板长到屏幕外（搜索结果是单列，比两级选择器高） */
  max-width: min(430px, calc(100vw - 28px));
}

/* ---------- 顶部搜索框 ---------- */
.search-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-bottom: 1px solid #232a35;
}

.search-ico {
  flex: none;
  font-size: 12px;
  color: #7d8694;
}

.search-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
  color: #e6edf3;
  background: #11161d;
  border: 1px solid #2c3542;
  border-radius: 7px;
  transition: border-color 0.14s, background 0.14s;
}

.search-input::placeholder {
  color: #59636f;
}

.search-input:hover {
  border-color: #3c4757;
}

.search-input:focus {
  outline: none;
  background: #161d26;
  border-color: #3f6fd8;
}

.search-clear {
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 11px;
  line-height: 1;
  color: #8b949e;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.search-clear:hover {
  color: #e6edf3;
  background: #1f2733;
}

/* ---------- 两级选择器那两列 ---------- */
.columns {
  display: flex;
  min-height: 0;
}

/* ---------- 搜索结果（跨大类，所以每条都标位置） ---------- */
.results {
  width: 412px;
  max-width: 100%;
  max-height: 340px;
  overflow-y: auto;
  padding: 6px;
}

.results-empty {
  margin: 14px 10px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #8b949e;
  text-align: center;
}

.result-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.result-item {
  padding: 8px 10px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.12s;
}

/* 键盘选中的那条：浅蓝底 + 左侧主色竖条。
   注意这三条的顺序 —— `.active` 必须排在 `.on` 后面（两个选择器优先级相同，
   后写的赢），否则"当前选中的算法"那条键盘高亮会被 `.on` 的底色吃掉、看不出来。 */
.result-item:hover {
  background: #1c222c;
}

.result-item.on {
  background: rgba(63, 111, 216, 0.16);
}

.result-item.active {
  background: #1c222c;
  box-shadow: inset 2px 0 0 #3f6fd8;
}

.result-item.active .result-name {
  color: #79abff;
}

.result-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.result-name {
  font-size: 13.5px;
  color: #e6edf3;
}

.result-item.on .result-name {
  color: #79abff;
}

.result-time {
  flex: none;
  font-size: 11px;
  font-family: Consolas, Monaco, monospace;
  color: #5c6674;
}

/* 所属位置那一行：大类（绿）+ 子类（白）+ id（灰），一眼看出"它在哪儿" */
.result-where {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 4px;
  font-size: 11px;
  overflow: hidden;
  white-space: nowrap;
}

.result-cat {
  flex: none;
  padding: 1px 7px;
  color: #10b981;
  background: rgba(16, 185, 129, 0.13);
  border: 1px solid rgba(16, 185, 129, 0.35);
  border-radius: 20px;
}

.result-group {
  flex: none;
  color: #c3cddb;
}

.result-id {
  color: #5c6674;
  overflow: hidden;
  text-overflow: ellipsis;
}

.results-tip {
  margin: 6px 4px 2px;
  padding-top: 6px;
  font-size: 10.5px;
  color: #5c6674;
  text-align: center;
  border-top: 1px solid #1f2733;
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

/*
 * 窄屏（手机 / 分屏）：面板撑满除去页面内边距的宽度，
 * 并且把左列收窄、右列改成弹性宽度 —— 否则 164 + 248 的固定宽会把面板顶出屏幕。
 */
@media (max-width: 520px) {
  .panel {
    width: calc(100vw - 28px);
  }

  .cat-col {
    width: 122px;
  }

  .algos {
    flex: 1;
    width: auto;
    min-width: 0;
  }

  .results {
    width: auto;
    flex: 1;
  }
}
</style>
