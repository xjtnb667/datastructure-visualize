<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useAlgorithmStore } from '@/stores/algorithm'

/**
 * 「上一个 / 下一个算法」。
 * 它不属于单步播放控制那一组，而是放在页脚里
 * **解说栏右边 → 「上一步」左边** 的那片空闲区域中。
 *
 * 按钮内部上下两段：上 2/3 是「上一个 / 下一个算法」标签，下 1/3 是缩小后的算法名。
 */
const store = useAlgorithmStore()
const {
  canPrevAlgorithm,
  canNextAlgorithm,
  prevAlgorithmSpec,
  nextAlgorithmSpec,
  algorithmIndex,
  categoryCount,
} = storeToRefs(store)

/** 悬浮提示：顺带把"在本大类里排第几"说清楚 */
const prevTitle = computed(() =>
  prevAlgorithmSpec.value
    ? `上一个算法：${prevAlgorithmSpec.value.name}（${store.category.name} 第 ${algorithmIndex.value} / ${categoryCount.value} 个）`
    : `${store.category.name}的第一个算法，已经没有上一个了`,
)
const nextTitle = computed(() =>
  nextAlgorithmSpec.value
    ? `下一个算法：${nextAlgorithmSpec.value.name}（${store.category.name} 第 ${algorithmIndex.value + 2} / ${categoryCount.value} 个）`
    : `${store.category.name}的最后一个算法，已经没有下一个了`,
)
</script>

<template>
  <div class="algo-nav">
    <button
      class="btn nav"
      :disabled="!canPrevAlgorithm"
      :title="prevTitle"
      @click="store.prevAlgorithm()"
    >
      <span class="nav-tag">⏮ 上一个算法</span>
      <span class="nav-name">{{ prevAlgorithmSpec ? prevAlgorithmSpec.name : '已是首个' }}</span>
    </button>

    <button
      class="btn nav"
      :disabled="!canNextAlgorithm"
      :title="nextTitle"
      @click="store.nextAlgorithm()"
    >
      <span class="nav-tag">下一个算法 ⏭</span>
      <span class="nav-name">{{ nextAlgorithmSpec ? nextAlgorithmSpec.name : '已是末尾' }}</span>
    </button>
  </div>
</template>

<style scoped>
.algo-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

/*
 * 上下两段：上 2/3 放「上一个 / 下一个算法」，下 1/3 放缩小后的算法名。
 * 用固定高度而不是 flex 比例，是为了让 2/3 与 1/3 是精确的：
 *   内容高 = 50 - 2(边框) - 6(内边距) = 42px  ->  28 + 14 = 42，正好 2:1
 */
.nav {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  height: 50px;
  max-width: 190px;
  padding: 3px 10px;
  gap: 0;
}

.nav-tag,
.nav-name {
  display: block;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 上段：2/3 = 28px */
.nav-tag {
  height: 28px;
  line-height: 28px;
  font-size: 13px;
  color: inherit;
}

/* 下段：1/3 = 14px，字更小、颜色更淡 */
.nav-name {
  height: 14px;
  line-height: 14px;
  font-size: 10.5px;
  font-weight: 400;
  color: #98a4b3;
}

/* 禁用时连同名字一起变浅 */
.btn:disabled .nav-name {
  color: inherit;
}

@media (max-width: 1380px) {
  .nav {
    max-width: 150px;
  }
}
</style>
