<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useAlgorithmStore } from '@/stores/algorithm'
import {
  MAX_COUNT,
  MAX_VALUE,
  MIN_COUNT,
  MIN_VALUE,
  formatDataInput,
  parseNumberList,
} from '@/core/manualInput'

/**
 * 「手动输入数据」弹窗。
 *
 * 以前只有「随机数据 / 示例数据」两个按钮 —— 想演示"已经基本有序的数组上插入排序很快"
 * 这种情形就没法造数据。这个弹窗让用户自己敲一串数字（`5,2,9,1,7,3`）。
 *
 * 三条约定：
 *   1. **输入框预填当前数据**（`formatDataInput`），用户可以只改一两个数，不用从头敲；
 *   2. 确认时**先在前端校验**（规则见 `src/core/manualInput.ts`），不合法只显示中文提示、
 *      **不提交**；
 *   3. 校验通过后走的是和「随机数据」**完全相同的那条路** —— `store.load(values)`：
 *      它负责按算法把数据规整一遍（折半查找要排序、顺序表不能超容量）、重新生成步骤序列、
 *      光标归零。所以手输数据和随机数据在后续播放里没有任何区别。
 *
 * 固定输入的算法（括号匹配 / 表达式求值，`useFixedInput`）用不了这个弹窗，
 * 顶栏那个按钮会直接禁用并在 title 里说明原因。
 */

const store = useAlgorithmStore()

const visible = ref(false)
const text = ref('')
const error = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

/** 当前算法的数据在输入框里长什么样（打开时预填用） */
const currentText = computed(() => formatDataInput(store.inputData))

/** 打开弹窗。每次打开都重新预填当前数据，并把上一次的错误清掉 */
function open(): void {
  text.value = currentText.value
  error.value = ''
  visible.value = true
  // 等输入框渲染出来再聚焦 + 全选：用户直接敲就能覆盖旧数据
  void nextTick(() => {
    inputEl.value?.focus()
    inputEl.value?.select()
  })
}

function close(): void {
  visible.value = false
  error.value = ''
}

/** 恢复成当前算法正在用的数据（清掉用户改了一半的内容） */
function resetToCurrent(): void {
  text.value = currentText.value
  error.value = ''
}

function submit(): void {
  const result = parseNumberList(text.value)
  if (!result.ok) {
    error.value = result.error
    return
  }
  store.load([...result.values])
  close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

defineExpose({ open, close, visible })
</script>

<template>
  <div v-if="visible" class="auth-mask" @click.self="close" @keydown="onKeydown">
    <div class="auth-dialog data-dialog" role="dialog" aria-modal="true" aria-label="手动输入数据">
      <div class="auth-head">
        <h3 class="data-title">手动输入数据</h3>
        <button class="auth-close" title="关闭" @click="close">✕</button>
      </div>

      <p class="auth-hint">
        输入 <b>{{ MIN_COUNT }} ~ {{ MAX_COUNT }}</b> 个整数，用逗号或空格分开，
        数值在 <b>{{ MIN_VALUE }} ~ {{ MAX_VALUE }}</b> 之间。<br />
        例如：<code>5, 2, 9, 1, 7, 3</code>
      </p>

      <div class="auth-form">
        <label class="field">
          <span>数据（当前算法：{{ store.algorithm.name }}）</span>
          <input
            ref="inputEl"
            v-model="text"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            placeholder="5, 2, 9, 1, 7, 3"
            @keydown.enter.prevent="submit"
          />
        </label>

        <p v-if="error" class="auth-error">{{ error }}</p>

        <div class="data-quick">
          <button class="chip" type="button" @click="resetToCurrent">用当前数据</button>
          <button class="chip" type="button" @click="text = '5, 2, 9, 1, 7, 3'">示例：5, 2, 9, 1, 7, 3</button>
        </div>

        <div class="auth-actions">
          <button class="btn ghost" type="button" @click="close">取消</button>
          <button class="btn primary" type="button" @click="submit">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 弹窗本体沿用登录框那一套（.auth-mask / .auth-dialog / .auth-head / .auth-close /
   .field / .auth-error / .auth-actions），只补"标题 + 快捷键提示"这点新东西，
   于是它和登录框、头像框的长相天然一致。 */
.data-dialog {
  max-width: 420px;
}

.data-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.data-dialog .auth-hint {
  margin: 10px 0 12px;
}

.data-dialog code {
  padding: 1px 6px;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  color: #f5c518;
  background: #1b212b;
  border: 1px solid #2c3542;
  border-radius: 5px;
}

.data-dialog .auth-hint b {
  color: #d6dee8;
}

.data-quick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
