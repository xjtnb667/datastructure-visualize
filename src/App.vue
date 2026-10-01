<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import CodePanel from '@/components/CodePanel.vue'
import CanvasPanel from '@/components/CanvasPanel.vue'
import SeqListPanel from '@/components/SeqListPanel.vue'
import LinkedListPanel from '@/components/LinkedListPanel.vue'
import ScenePanel from '@/components/ScenePanel.vue'
import ControlPanel from '@/components/ControlPanel.vue'
import AlgorithmNav from '@/components/AlgorithmNav.vue'
import AlgorithmPicker from '@/components/AlgorithmPicker.vue'
import { useAlgorithmStore } from '@/stores/algorithm'
import type { StepAction } from '@/core/types'
import logoUrl from '@/assets/logo.png'

const store = useAlgorithmStore()
const { algorithm, currentAction, currentComment, currentVars, currentStats, isSearch } =
  storeToRefs(store)

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

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="app">
    <header class="topbar">
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
        <button class="btn ghost" @click="store.restoreDefault()">示例数据</button>
      </div>
    </header>

    <main class="stage">
      <section class="pane">
        <div class="pane-head">
          <h2>{{ algorithm.name }}</h2>
          <span class="badge">{{ store.category.name }}</span>
          <span v-if="algorithm.group" class="badge">{{ algorithm.group }}</span>
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
  </div>
</template>
