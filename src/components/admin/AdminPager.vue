<script setup lang="ts">
import { computed } from 'vue'

/**
 * 后台两个标签页共用的分页条。
 * 只报"要跳哪一页 / 每页几条"，具体怎么拉数据由面板决定。
 */

const props = withDefaults(
  defineProps<{ total: number; page: number; size: number; unit: string; loading?: boolean }>(),
  { loading: false },
)

const emit = defineEmits<{ 'update:page': [page: number]; 'update:size': [size: number] }>()

const pages = computed(() => Math.max(1, Math.ceil(props.total / props.size)))

function onSize(event: Event): void {
  emit('update:size', Number((event.target as HTMLSelectElement).value))
}
</script>

<template>
  <div class="pager">
    <span class="pager-info">
      共 {{ total }} 个{{ unit }} · 第 {{ page }} / {{ pages }} 页
    </span>

    <label class="pager-size">
      每页
      <select :value="size" :disabled="loading" @change="onSize">
        <option :value="10">10 条</option>
        <option :value="20">20 条</option>
      </select>
    </label>

    <button
      class="btn ghost tiny"
      type="button"
      :disabled="loading || page <= 1"
      @click="emit('update:page', page - 1)"
    >
      上一页
    </button>
    <button
      class="btn ghost tiny"
      type="button"
      :disabled="loading || page >= pages"
      @click="emit('update:page', page + 1)"
    >
      下一页
    </button>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 2px 2px;
}

.pager-info {
  font-size: 12.5px;
  color: #8b949e;
}

/* 「每页几条」推到右边，和翻页按钮挨着 */
.pager-size {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 12.5px;
  color: #8b949e;
}

.pager-size select {
  padding: 5px 8px;
  font-size: 12.5px;
  font-family: inherit;
  color: #e6edf3;
  background: #1b212b;
  border: 1px solid #2c3542;
  border-radius: 7px;
  cursor: pointer;
}

.pager-size select:disabled {
  color: #59636f;
  background: #151a21;
  cursor: not-allowed;
}

.btn.tiny {
  padding: 5px 11px;
  font-size: 12.5px;
}
</style>
