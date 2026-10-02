<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

/**
 * 后台的通用弹窗（编辑 / 新增 / 删除确认三处共用）。
 *
 * 用 `v-if` 挂载，所以"打开"就等于"组件存在"：
 *   - 点遮罩空白处关闭（`@click.self`）；
 *   - Esc 关闭（监听 window，因为弹窗本身不一定拿到焦点）；
 *   - 提交中（busy）时**不许关**，免得请求飞在半路界面就没了。
 *
 * 表单控件（`.field select` / `textarea` / `.switch` / `.warn`）的样式也放在这里：
 * 插槽内容属于父组件的作用域，只有 `:deep()` 才能统一给两个标签页的弹窗上样式，
 * 与其在两个面板里各抄一遍，不如跟着弹窗一起定义。
 */

const props = withDefaults(defineProps<{ title: string; busy?: boolean; wide?: boolean }>(), {
  busy: false,
  wide: false,
})

const emit = defineEmits<{ close: [] }>()

function close(): void {
  if (props.busy) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="admin-mask" @click.self="close">
    <div
      class="admin-dialog"
      :class="{ wide }"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <div class="admin-dialog-head">
        <h3>{{ title }}</h3>
        <button class="admin-close" type="button" title="关闭（Esc）" @click="close">✕</button>
      </div>

      <div class="admin-dialog-body">
        <slot />
      </div>

      <div class="admin-dialog-foot">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 半透明黑比纯黑偏蓝一点，和 main.css 里登录弹窗的遮罩保持一致 */
.admin-mask {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(6, 9, 14, 0.68);
}

.admin-dialog {
  width: 100%;
  max-width: 420px;
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  background: #12161d;
  border: 1px solid #2c3542;
  border-radius: 14px;
  box-shadow: 0 20px 52px rgba(0, 0, 0, 0.62);
}

/* 字段多的弹窗（算法新增 / 编辑）宽一点，一行能放两个字段 */
.admin-dialog.wide {
  max-width: 560px;
}

.admin-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 18px 11px;
  border-bottom: 1px solid #232a35;
}

.admin-dialog-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-close {
  width: 26px;
  height: 26px;
  flex: none;
  font-size: 13px;
  color: #8b949e;
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
}

.admin-close:hover {
  color: #e6edf3;
  background: #1f2733;
}

.admin-dialog-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px;
}

.admin-dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px 16px;
  border-top: 1px solid #232a35;
}

/* ---------- 插槽里的表单控件（两个标签页共用） ---------- */
.admin-dialog-body :deep(.form-col) {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.admin-dialog-body :deep(.form-row) {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

/* `.field input` 是全局样式，下拉框和文本域在这里补齐同款外观 */
.admin-dialog-body :deep(.field select),
.admin-dialog-body :deep(.field textarea) {
  padding: 9px 11px;
  font-size: 13.5px;
  font-family: inherit;
  color: #e6edf3;
  background: #1b212b;
  border: 1px solid #2c3542;
  border-radius: 8px;
}

.admin-dialog-body :deep(.field select) {
  cursor: pointer;
}

.admin-dialog-body :deep(.field textarea) {
  min-height: 64px;
  line-height: 1.6;
  resize: vertical;
}

.admin-dialog-body :deep(.field select:focus),
.admin-dialog-body :deep(.field textarea:focus) {
  outline: none;
  background: #1e2530;
  border-color: #3f6fd8;
}

.admin-dialog-body :deep(.field select:disabled),
.admin-dialog-body :deep(.field textarea:disabled) {
  color: #59636f;
  background: #151a21;
  cursor: not-allowed;
}

/* 勾选式开关（上架 / 禁用） */
.admin-dialog-body :deep(.switch) {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #c3cddb;
  cursor: pointer;
}

.admin-dialog-body :deep(.switch input) {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: #3f6fd8;
  cursor: pointer;
}

.admin-dialog-body :deep(.switch input:disabled) {
  cursor: not-allowed;
}

.admin-dialog-body :deep(.switch-tip) {
  color: #7d8694;
}

/* 关于"最后一个管理员"的提醒：和"正在比较"同色系，是提醒不是报错 */
.admin-dialog-body :deep(.warn) {
  margin: 0;
  padding: 8px 11px;
  font-size: 12px;
  line-height: 1.6;
  color: #f5c04a;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: 8px;
}

.admin-dialog-body :deep(.confirm-text) {
  margin: 0 0 8px;
  font-size: 13.5px;
  line-height: 1.7;
  color: #d6dee8;
}

.admin-dialog-body :deep(.confirm-text b) {
  color: #ff9c9c;
}

.admin-dialog-body :deep(.hint) {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: #7d8694;
}

/* 危险操作按钮（确定删除）：红色，一眼看出和"保存"不是一类 */
.admin-dialog-foot :deep(.btn.danger-solid) {
  color: #ffffff;
  font-weight: 600;
  background: #b3392f;
  border-color: #c9483c;
}

.admin-dialog-foot :deep(.btn.danger-solid:hover:not(:disabled)) {
  background: #c9483c;
  border-color: #d55a4e;
}
</style>
