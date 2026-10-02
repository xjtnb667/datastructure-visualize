<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NOTE_MAX_LENGTH } from '@/api/client'
import AuthDialog from '@/components/AuthDialog.vue'
import { useNotesStore } from '@/stores/notes'
import { useUserStore } from '@/stores/user'

/**
 * 「学习笔记」面板：给**当前这个算法**写自己的笔记（理解、易错点、调试心得）。
 *
 * - 属性只有一个 `algoKey`（当前算法的 id），内部跟着它变：换算法就换成那个算法的笔记，
 *   没写过就是空白的，可以直接开始写。
 * - 一个用户对一个算法只有一条笔记，所以**没有"新增"这个动作**：写第二次就是更新；
 *   想删就把内容清空保存，或者点「删除」。
 * - 纯文本多行输入（`<textarea>`），**不渲染 Markdown** —— 老师问起来也好解释：
 *   笔记是给自己看的草稿，原样显示比渲染成 HTML 更安全（不用引 Markdown 库、也没有 XSS 面）。
 *
 * ### 未登录时怎么办（和 `stores/user.ts` 收藏的写法一致）
 * 面板只显示一句提示 + 一个「登录 / 注册」按钮。**store 自己不弹窗**，
 * 弹窗由界面决定 —— 这里面板内嵌了一个 `AuthDialog`，所以挂到任何地方都能直接用，
 * 父组件不需要额外接线（这也是它没有用 emit 的原因）。
 */
const props = withDefaults(defineProps<{ algoKey: string }>(), { algoKey: '' })

const userStore = useUserStore()
const notesStore = useNotesStore()

/** 面板自己那个登录框（未登录 / 令牌失效时用） */
const authDialog = ref<InstanceType<typeof AuthDialog> | null>(null)

/** 正在编辑的内容（textarea 的值） */
const draft = ref('')
/**
 * 用户是不是正在改草稿。
 * 服务器数据变新时（比如刚登录把笔记拉下来）**只在用户没在编辑时**覆盖草稿，
 * 否则会把人家正在写的字冲掉。
 */
const editing = ref(false)
/** 后端给的中文错误（保存失败 / 内容太长） */
const error = ref('')
/** 一下下就不见的成功提示（"已保存"） */
const flash = ref('')
/** 令牌已经失效（后端回了 401）：登录框再出现之前，先按"未登录"显示 */
const sessionExpired = ref(false)
/** 删除是不是已经到了"再点一下就删"的那一步 */
const confirmingDelete = ref(false)

let flashTimer: ReturnType<typeof setTimeout> | undefined

/** 服务器上那条笔记（没写过就是 null） */
const storedNote = computed(() => notesStore.getNote(props.algoKey))
const storedContent = computed(() => storedNote.value?.content ?? '')
/** 比较和提交都用**去掉首尾空白**的内容，和后端契约一致 */
const draftText = computed(() => draft.value.trim())
const dirty = computed(() => draftText.value !== storedContent.value)
const overLimit = computed(() => draftText.value.length > NOTE_MAX_LENGTH)

/** 需要显示登录提示：没登录，或者刚才令牌失效了 */
const needLogin = computed(() => !userStore.isLoggedIn || sessionExpired.value)

/** 把草稿对齐到服务器上的内容（换算法、保存成功、放弃修改都走它） */
function syncFromStore(): void {
  draft.value = storedContent.value
  editing.value = false
  error.value = ''
  confirmingDelete.value = false
}

// 换算法：立刻换成那个算法的笔记
watch(() => props.algoKey, syncFromStore, { immediate: true })

// 服务器上的笔记变新了（刚登录拉下来 / 在别的地方改过）：用户没在编辑就跟着更新
watch(
  () => storedNote.value?.updated_at,
  () => {
    if (!editing.value) syncFromStore()
  },
)

/**
 * 登录成功（AuthDialog 内部会换掉 `userStore.user`）：
 * 清掉"登录已失效"、补拉一次笔记，界面立刻可用。
 */
watch(
  () => userStore.user,
  (user) => {
    if (!user) return
    sessionExpired.value = false
    error.value = ''
    void notesStore.refreshNotes()
  },
)

onBeforeUnmount(() => {
  if (flashTimer !== undefined) clearTimeout(flashTimer)
})

/** 短暂的"已保存"提示（2.2 秒后自己消失） */
function showFlash(text: string): void {
  flash.value = text
  if (flashTimer !== undefined) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flash.value = ''
    flashTimer = undefined
  }, 2200)
}

function onInput(): void {
  editing.value = true
  error.value = ''
}

function openLogin(): void {
  authDialog.value?.open('login')
}

async function save(): Promise<void> {
  error.value = ''
  const had = storedNote.value !== null
  const result = await notesStore.saveNote(props.algoKey, draft.value)

  if (result.status === 'ok') {
    if (result.note) {
      draft.value = result.note.content // 用服务端存下来的那一份（首尾空白已去掉）
      editing.value = false
      showFlash(had ? '已保存' : '笔记已保存')
    } else {
      // 去掉空白后是空的 → 后端把这条笔记删掉了（契约如此）
      draft.value = ''
      editing.value = false
      showFlash('内容为空，已删除这条笔记')
    }
    return
  }
  if (result.status === 'login') {
    sessionExpired.value = true
    openLogin()
    return
  }
  error.value = result.message
}

async function remove(): Promise<void> {
  confirmingDelete.value = false
  error.value = ''
  const result = await notesStore.removeNote(props.algoKey)

  if (result.status === 'ok') {
    draft.value = ''
    editing.value = false
    showFlash('笔记已删除')
    return
  }
  if (result.status === 'login') {
    sessionExpired.value = true
    openLogin()
    return
  }
  error.value = result.message
}

/** 放弃这次修改，回到服务器上的版本 */
function discard(): void {
  draft.value = storedContent.value
  editing.value = false
  error.value = ''
  confirmingDelete.value = false
}

/** 时间戳 -> "2026-02-14 20:31"（本地时区；不引任何日期库） */
function formatTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <section class="notes-panel">
    <div class="notes-head">
      <h2 class="notes-title">📝 学习笔记</h2>
      <span v-if="storedNote" class="notes-time">最后修改：{{ formatTime(storedNote.updated_at) }}</span>
      <span v-else class="notes-time">还没有笔记，记录一下你的理解吧</span>
    </div>

    <!-- 未登录（或令牌刚失效）：说清楚登录之后能做什么 -->
    <div v-if="needLogin" class="notes-login">
      <p class="notes-login-title">
        {{ sessionExpired ? '登录状态已失效，请重新登录' : '登录之后就能给每个算法写笔记' }}
      </p>
      <p class="notes-login-tip">
        把你对这个算法的理解、容易记错的地方写在这里 —— 笔记存在你的账号里，换台电脑也还在。
      </p>
      <button class="btn primary" type="button" @click="openLogin">登录 / 注册</button>
    </div>

    <div v-else class="notes-body">
      <textarea
        v-model="draft"
        class="notes-input"
        :maxlength="NOTE_MAX_LENGTH"
        rows="6"
        spellcheck="false"
        placeholder="写下你对这个算法的理解、容易记错的地方…（支持多行，最多 2000 字）"
        :disabled="notesStore.busy"
        @input="onInput"
      ></textarea>

      <p v-if="error" class="auth-error notes-error">{{ error }}</p>

      <div class="notes-actions">
        <span class="notes-count" :class="{ over: overLimit }">
          {{ draftText.length }} / {{ NOTE_MAX_LENGTH }} 字
        </span>
        <span v-if="flash" class="notes-flash">{{ flash }}</span>
        <span v-else-if="dirty" class="notes-dirty">还没保存</span>

        <div class="notes-buttons">
          <!-- 删除做成"点两次"：第一次只是问一句，不会真的删 -->
          <template v-if="confirmingDelete && storedNote">
            <span class="notes-confirm">删除后这条笔记就没了，确定吗？</span>
            <button class="btn ghost danger" type="button" :disabled="notesStore.busy" @click="remove">
              确定删除
            </button>
            <button class="btn ghost" type="button" @click="confirmingDelete = false">取消</button>
          </template>
          <template v-else>
            <button
              class="btn ghost"
              type="button"
              :disabled="!storedNote || notesStore.busy"
              title="删除这个算法的笔记"
              @click="confirmingDelete = true"
            >
              删除
            </button>
            <button
              class="btn ghost"
              type="button"
              :disabled="!dirty || notesStore.busy"
              title="放弃这次修改，回到已保存的版本"
              @click="discard"
            >
              放弃修改
            </button>
            <button
              class="btn primary"
              type="button"
              :disabled="!dirty || notesStore.busy || overLimit"
              @click="save"
            >
              {{ notesStore.busy ? '保存中…' : '保存' }}
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- 面板自带的登录框（父组件不需要再接线） -->
    <AuthDialog ref="authDialog" />
  </section>
</template>

<style scoped>
/*
 * 配色、圆角、间距沿用全局那套（面板 #12161d、边框 #232a35、蓝 #3f6fd8、琥珀 #f5c04a 提醒），
 * 所以它和 `AvatarDialog.vue` / `FavoritesView.vue` 看起来是同一个产品。
 */
.notes-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 14px;
  background: #12161d;
  border: 1px solid #232a35;
  border-radius: 12px;
}

.notes-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.notes-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.notes-time {
  font-size: 11.5px;
  color: #7d8694;
}

.notes-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

/* 多行输入：深色同款输入框，右下角可以拖高一点 */
.notes-input {
  width: 100%;
  min-height: 128px;
  padding: 10px 12px;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.75;
  color: #e6edf3;
  background: #1b212b;
  border: 1px solid #2c3542;
  border-radius: 8px;
  resize: vertical;
  transition: border-color 0.14s, background 0.14s;
}

.notes-input::placeholder {
  color: #59636f;
}

.notes-input:hover:not(:disabled) {
  border-color: #3c4757;
}

.notes-input:focus {
  outline: none;
  background: #1e2530;
  border-color: #3f6fd8;
}

.notes-input:disabled {
  color: #59636f;
  background: #151a21;
  cursor: not-allowed;
}

.notes-error {
  /* 复用全局 `.auth-error` 的红底红字，只把外边距收掉 */
  margin: 0;
}

.notes-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 「n / 2000 字」和「还没保存」排在左边，按钮组靠右 */
.notes-buttons {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-left: auto;
}

.notes-count {
  font-family: Consolas, Monaco, monospace;
  font-size: 11.5px;
  color: #7d8694;
}

.notes-count.over {
  color: #ff9c9c;
}

.notes-dirty {
  font-size: 12px;
  color: #f5c04a;
}

.notes-flash {
  padding: 2px 9px;
  font-size: 12px;
  color: #10b981;
  background: rgba(16, 185, 129, 0.14);
  border: 1px solid rgba(16, 185, 129, 0.4);
  border-radius: 20px;
}

.notes-confirm {
  font-size: 12px;
  color: #ff9c9c;
}

.btn.danger {
  color: #ff9c9c;
  border-color: rgba(239, 68, 68, 0.45);
}

.btn.danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.14);
  border-color: rgba(239, 68, 68, 0.6);
}

/* ---------- 未登录 ---------- */
.notes-login {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 2px 2px;
}

.notes-login-title {
  margin: 0;
  font-size: 13.5px;
  color: #d6dee8;
}

.notes-login-tip {
  margin: 0;
  max-width: 520px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #8b949e;
}
</style>
