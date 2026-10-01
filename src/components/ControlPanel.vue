<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { SPEEDS, useAlgorithmStore } from '@/stores/algorithm'

const store = useAlgorithmStore()
const { currentStepIndex, totalSteps, canPrev, canNext, playing, speed } = storeToRefs(store)

function onSeek(event: Event): void {
  store.goToStep(Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="controls">
    <!-- 单步执行当前算法（「上一个 / 下一个算法」在左边那片空闲区，见 AlgorithmNav） -->
    <div class="btn-row">
      <button class="btn" :disabled="!canPrev" @click="store.prevStep()">◀ 上一步</button>
      <button class="btn play" @click="store.togglePlay()">
        {{ playing ? '⏸ 暂停' : '▶ 播放' }}
      </button>
      <button class="btn" :disabled="!canNext" @click="store.nextStep()">下一步 ▶</button>
      <button class="btn ghost" @click="store.reset()">↺ 重置</button>

      <span class="gap"></span>

      <span class="speeds">
        <button
          v-for="s in SPEEDS"
          :key="s"
          class="chip"
          :class="{ on: speed === s }"
          @click="store.setSpeed(s)"
        >
          {{ s }}×
        </button>
      </span>
    </div>

    <!-- 进度条 -->
    <div class="seek-row">
      <input
        class="progress"
        type="range"
        min="0"
        :max="Math.max(totalSteps - 1, 0)"
        :value="currentStepIndex"
        @input="onSeek"
      />
      <span class="counter">第 {{ currentStepIndex + 1 }} / {{ totalSteps }} 步</span>
    </div>
  </div>
</template>

<style scoped>
.controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.btn-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.gap {
  flex: 1 1 0;
  min-width: 0;
}

.speeds {
  display: inline-flex;
  gap: 4px;
}

.counter {
  font-size: 13px;
  color: #8b949e;
  min-width: 104px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.seek-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress {
  flex: 1;
  accent-color: #f5c518;
  height: 4px;
  cursor: pointer;
}
</style>
