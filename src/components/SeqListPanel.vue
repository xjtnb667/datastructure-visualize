<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useAlgorithmStore } from '@/stores/algorithm'
import { PALETTE, css, type RGB } from '@/core/palette'
import type { AlgoStep } from '@/core/types'

const store = useAlgorithmStore()
const { currentStep, currentArray, currentVars, sortedIndices } = storeToRefs(store)

/** 顺序表容量：以算法声明为准，兜底用当前元素个数 */
const capacity = () => store.algorithm.capacity ?? Math.max(currentArray.value.length, 1)

/** 某一个格子该是什么颜色；空位返回 null */
function cellColor(index: number, step: AlgoStep | undefined, settled: number[]): RGB | null {
  if (index >= currentArray.value.length) return null
  if (!step) return PALETTE.base
  if (settled.includes(index)) return PALETTE.sorted
  if (!step.indices.includes(index)) return PALETTE.base
  switch (step.action) {
    case 'compare':
      return PALETTE.compare
    case 'set':
    case 'swap':
      return PALETTE.swap
    case 'mark':
      return PALETTE.mark
    case 'done':
      return PALETTE.sorted
    default:
      return PALETTE.base
  }
}

/** 表长（逻辑长度）：优先用步骤里声明的 n */
const logicalLength = () => currentVars.value.n ?? currentArray.value.length
</script>

<template>
  <div class="seqlist">
    <div class="cells" :style="{ gridTemplateColumns: `repeat(${capacity()}, minmax(0, 1fr))` }">
      <div
        v-for="i in capacity()"
        :key="i - 1"
        class="cell"
        :class="{ empty: i - 1 >= currentArray.length }"
        :style="
          cellColor(i - 1, currentStep, sortedIndices)
            ? { background: css(cellColor(i - 1, currentStep, sortedIndices)!) }
            : undefined
        "
      >
        <span class="value">{{ i - 1 < currentArray.length ? currentArray[i - 1] : '' }}</span>
        <span class="index">{{ i - 1 }}</span>
      </div>
    </div>

    <div class="meta">
      <span class="badge">表长 n = {{ logicalLength() }}</span>
      <span class="badge">容量 MAX = {{ capacity() }}</span>
      <span class="badge">空闲 {{ capacity() - logicalLength() }}</span>
    </div>
  </div>
</template>

<style scoped>
.seqlist {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 14px;
  padding-top: 6px;
}

.cells {
  display: grid;
  gap: 6px;
}

.cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 62px;
  border-radius: 8px;
  background: #3f6fd8;
  color: #fff;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 17px;
  font-weight: 600;
  /* 换步骤时颜色渐变过去，而不是瞬间跳变 */
  transition: background-color 160ms ease-out, border-color 160ms ease-out, color 160ms ease-out;
}

/* 超出表长的空位：只留虚线框 */
.cell.empty {
  background: transparent;
  border: 1px dashed #333c4a;
  color: #46505f;
}

.cell .value {
  line-height: 1;
}

.cell .index {
  position: absolute;
  bottom: -20px;
  font-size: 11px;
  font-weight: 400;
  color: #6e7681;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 2px;
  margin-top: 22px;
}

.badge {
  padding: 3px 10px;
  font-size: 12px;
  font-family: Consolas, Monaco, monospace;
  color: #9aa4b2;
  background: #1b212b;
  border: 1px solid #2c3542;
  border-radius: 6px;
}
</style>
