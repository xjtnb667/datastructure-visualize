<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  ApiError,
  adminDeleteUser,
  adminListUsers,
  adminUpdateUser,
  type User,
} from '@/api/client'
import AdminModal from '@/components/admin/AdminModal.vue'
import AdminPager from '@/components/admin/AdminPager.vue'
import { useUserStore } from '@/stores/user'

/**
 * 后台 · 「用户管理」标签页：搜索 + 分页 + 编辑弹窗 + 删除二次确认。
 *
 * 两条贯穿全页的规矩：
 *   1. **以后端为准** —— 保存 / 删除成功之后重新拉一遍列表，绝不在本地改数据；
 *   2. **错误不吞** —— 后端返回的中文说明原样显示（`error.message`），
 *      包括"不能删除自己的账号""系统至少要保留一个可用的管理员"这两种。
 *
 * 另外两种"删不掉"的情况在界面上提前打了招呼（见 `deleteTitle` 和 `leavesAdmin`）：
 * 自己的那一行删除按钮直接是灰的；编辑管理员时只要动了角色 / 状态就给出提醒。
 *
 * 头像列：有自定义头像显示小圆图（`row.avatar` 是 data URL），
 * 没有就显示"昵称第一个字"的圆形占位 —— 和顶栏那条规则完全一致。
 * 编辑弹窗里能**清空**某个用户的头像（后端 `PATCH /api/admin/users/:id` 传 `avatar: null`）。
 */

const store = useUserStore()

const emit = defineEmits<{
  notice: [text: string, kind?: 'ok' | 'error']
  changed: []
}>()

// ---------- 列表 ----------
const items = ref<User[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(10)
const q = ref('')
const loading = ref(false)
const error = ref('')

// ---------- 编辑弹窗 ----------
const editing = ref<User | null>(null)
const saving = ref(false)
const dialogError = ref('')
const form = ref({ nickname: '', role: 'user', disabled: false, password: '', clearAvatar: false })

// ---------- 删除确认 ----------
const deleting = ref<User | null>(null)
const removing = ref(false)
const deleteError = ref('')

/** 后端错误一律原样显示；401（令牌过期）顺手把登录状态同步回来 */
function fail(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) void store.init()
  return store.errorText(err)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const keyword = q.value.trim() || undefined
    const res = await adminListUsers(keyword, page.value, size.value)
    const pages = Math.max(1, Math.ceil(res.total / size.value))
    if (page.value > pages) {
      // 删掉末页最后一条之后页码会越界，自动退一页再拉，别给用户看一张空表
      page.value = pages
      const again = await adminListUsers(keyword, page.value, size.value)
      items.value = again.items
      total.value = again.total
    } else {
      items.value = res.items
      total.value = res.total
    }
  } catch (err) {
    error.value = fail(err)
  } finally {
    loading.value = false
  }
}

function search(): void {
  page.value = 1
  void load()
}

function clearSearch(): void {
  q.value = ''
  search()
}

function setPage(next: number): void {
  page.value = next
  void load()
}

function setSize(next: number): void {
  size.value = next
  page.value = 1
  void load()
}

const emptyText = computed(() => {
  if (loading.value) return '正在加载用户列表…'
  return q.value.trim() ? '没有匹配的用户' : '还没有用户'
})

function isSelf(row: User): boolean {
  return row.id === store.user?.id
}

/** 时间戳 -> "2026-02-14 20:31"（本地时区，不引日期库） */
function formatTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 删除按钮的悬停说明：把"为什么点不了 / 要小心什么"直接写在按钮上 */
function deleteTitle(row: User): string {
  if (isSelf(row)) return '不能删除自己的账号'
  if (row.role === 'admin' && row.disabled === 0) {
    return '删除前请留意：系统至少要保留一个可用的管理员'
  }
  return `删除用户 ${row.username}`
}

function openEdit(row: User): void {
  editing.value = row
  dialogError.value = ''
  form.value = {
    nickname: row.nickname,
    role: row.role,
    disabled: row.disabled === 1,
    password: '',
    clearAvatar: false,
  }
}

function closeEdit(): void {
  editing.value = null
  dialogError.value = ''
  form.value.password = ''
  form.value.clearAvatar = false
}

/** 头像列 / 编辑弹窗里的占位字：昵称拿不到就退回用户名，和顶栏一个规则 */
function avatarLetter(row: User): string {
  return (row.nickname || row.username || '?').slice(0, 1)
}

/** 编辑弹窗里那个头像预览：点了"清空"就按"没有头像"显示（保存后才真的清） */
const editingAvatar = computed(() => (form.value.clearAvatar ? null : editing.value?.avatar ?? null))

/**
 * 这次修改会不会让一个"可用管理员"不再是管理员。
 * 真的动手时后端会拦（并且返回中文说明），这里只是**提前提醒**一句 ——
 * 前端数不出"全系统还有几个管理员"（列表是分页的），所以不硬拦，只提示。
 */
const leavesAdmin = computed(() => {
  const before = editing.value
  if (!before) return false
  if (before.role !== 'admin' || before.disabled !== 0) return false
  return form.value.role !== 'admin' || form.value.disabled
})

function onRole(event: Event): void {
  form.value.role = (event.target as HTMLSelectElement).value
}

function onDisabled(event: Event): void {
  form.value.disabled = (event.target as HTMLSelectElement).value === 'true'
}

/** 只提交真的改过的字段（后端对"没有需要修改的内容"会直接报错） */
async function save(): Promise<void> {
  const before = editing.value
  if (!before) return

  const nickname = form.value.nickname.trim()
  if (!nickname) {
    dialogError.value = '请输入昵称'
    return
  }
  if (nickname.length > 20) {
    dialogError.value = '昵称最多 20 个字'
    return
  }
  if (form.value.password && form.value.password.length < 6) {
    dialogError.value = '密码至少 6 位'
    return
  }

  const patch: {
    nickname?: string
    role?: string
    disabled?: number
    password?: string
    avatar?: string | null
  } = {}
  if (nickname !== before.nickname) patch.nickname = nickname
  if (form.value.role !== before.role) patch.role = form.value.role
  if ((form.value.disabled ? 1 : 0) !== before.disabled) {
    patch.disabled = form.value.disabled ? 1 : 0
  }
  if (form.value.password) patch.password = form.value.password
  // 清空头像：只有本来有头像、且这次确实点了"清空"才提交（后端对 null 是"清除"语义）
  if (form.value.clearAvatar && before.avatar) patch.avatar = null
  if (Object.keys(patch).length === 0) {
    dialogError.value = '没有修改任何内容'
    return
  }

  saving.value = true
  dialogError.value = ''
  try {
    const updated = await adminUpdateUser(before.id, patch)
    closeEdit()
    emit('notice', `用户「${updated.nickname}」保存成功`)
    await load()
    // 改的是自己（昵称 / 密码 / 状态）：让顶栏跟着更新。
    // 改密码或禁用之后后端会作废这个人的所有会话，`init()` 会顺势发现"已经掉线了"。
    if (updated.id === store.user?.id) void store.init()
  } catch (err) {
    dialogError.value = fail(err)
  } finally {
    saving.value = false
  }
}

function openDelete(row: User): void {
  deleting.value = row
  deleteError.value = ''
}

/*
 * 弹窗标题 / 确认文案里的用户名。
 * 走 computed 而不是在模板里直接写 `editing.username`：`v-if` 的类型收窄进不了插槽，
 * 这里给一个"取不到就是空串"的值，模板就永远不用管 null。
 */
const editingName = computed(() => editing.value?.username ?? '')
const deletingName = computed(() => deleting.value?.username ?? '')

async function confirmDelete(): Promise<void> {
  const target = deleting.value
  if (!target) return
  removing.value = true
  deleteError.value = ''
  try {
    await adminDeleteUser(target.id)
    deleting.value = null
    emit('notice', `已删除用户「${target.username}」`)
    emit('changed')
    await load()
  } catch (err) {
    // 删自己 / 删最后一个管理员：后端的中文说明就显示在这个弹窗里
    deleteError.value = fail(err)
  } finally {
    removing.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="panel">
    <form class="toolbar" @submit.prevent="search">
      <input
        v-model="q"
        class="search-input"
        type="search"
        placeholder="按用户名或昵称搜索"
        :disabled="loading"
      />
      <button class="btn primary" type="submit" :disabled="loading">搜索</button>
      <button v-if="q" class="btn ghost" type="button" @click="clearSearch">清空</button>
      <button class="btn ghost" type="button" :disabled="loading" @click="load">刷新</button>
    </form>

    <p v-if="error" class="row-error">
      {{ error }}
      <button class="btn ghost tiny" type="button" @click="load">重试</button>
    </p>

    <table class="admin-table">
      <thead>
        <tr>
          <th class="col-id">ID</th>
          <th class="col-avatar">头像</th>
          <th>用户名</th>
          <th>昵称</th>
          <th>角色</th>
          <th>状态</th>
          <th>注册时间</th>
          <th class="col-ops">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in items" :key="row.id">
          <td class="mono">{{ row.id }}</td>
          <td class="col-avatar">
            <!-- 有自定义头像显示图片，没有就是昵称首字（和顶栏同一条规则） -->
            <img v-if="row.avatar" class="avatar-img row-avatar" :src="row.avatar" alt="头像" />
            <span v-else class="row-avatar row-avatar-text">{{ avatarLetter(row) }}</span>
          </td>
          <td class="mono">
            {{ row.username }}
            <span v-if="isSelf(row)" class="me-tag">我自己</span>
          </td>
          <td>{{ row.nickname }}</td>
          <td>
            <span class="role-tag" :class="row.role">
              {{ row.role === 'admin' ? '管理员' : '普通用户' }}
            </span>
          </td>
          <td>
            <span class="state-tag" :class="{ off: row.disabled === 1 }">
              {{ row.disabled === 1 ? '已禁用' : '正常' }}
            </span>
          </td>
          <td class="mono">{{ formatTime(row.created_at) }}</td>
          <td class="col-ops">
            <button class="btn ghost tiny" type="button" @click="openEdit(row)">编辑</button>
            <button
              class="btn ghost tiny danger"
              type="button"
              :disabled="isSelf(row)"
              :title="deleteTitle(row)"
              @click="openDelete(row)"
            >
              删除
            </button>
          </td>
        </tr>
        <tr v-if="items.length === 0">
          <td class="table-empty" colspan="8">{{ emptyText }}</td>
        </tr>
      </tbody>
    </table>

    <AdminPager
      :total="total"
      :page="page"
      :size="size"
      unit="用户"
      :loading="loading"
      @update:page="setPage"
      @update:size="setSize"
    />

    <!-- 编辑用户 -->
    <AdminModal
      v-if="editing"
      :title="`编辑用户：${editingName}`"
      :busy="saving"
      @close="closeEdit"
    >
      <div class="form-col">
        <label class="field">
          <span>昵称（显示在页面右上角的名字）</span>
          <input v-model="form.nickname" type="text" maxlength="20" :disabled="saving" />
        </label>

        <div class="form-row">
          <label class="field">
            <span>角色</span>
            <select :value="form.role" :disabled="saving" @change="onRole">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </label>

          <label class="field">
            <span>状态</span>
            <select :value="String(form.disabled)" :disabled="saving" @change="onDisabled">
              <option value="false">正常</option>
              <option value="true">已禁用（不能登录）</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span>重置密码（留空表示不改）</span>
          <input
            v-model="form.password"
            type="password"
            autocomplete="new-password"
            placeholder="至少 6 位"
            :disabled="saving"
          />
        </label>

        <p v-if="form.password" class="hint">
          改完密码，这个用户当前的登录会立刻失效，需要用新密码重新登录。
        </p>

        <!-- 头像：只能在这里"清空"（换头像要用户自己在右上角换）。
             没有头像的用户不显示这一块，免得给一个永远点不动的按钮。 -->
        <div v-if="editing?.avatar" class="field">
          <span>头像</span>
          <div class="avatar-edit">
            <img v-if="editingAvatar" class="avatar-img avatar-edit-img" :src="editingAvatar" alt="头像" />
            <span v-else class="avatar-edit-img avatar-edit-text">
              {{ editing ? avatarLetter(editing) : '' }}
            </span>
            <button
              v-if="!form.clearAvatar"
              class="btn ghost tiny"
              type="button"
              :disabled="saving"
              @click="form.clearAvatar = true"
            >
              清空头像
            </button>
            <button
              v-else
              class="btn ghost tiny"
              type="button"
              :disabled="saving"
              @click="form.clearAvatar = false"
            >
              撤销清空
            </button>
          </div>
          <p class="hint">
            {{
              form.clearAvatar
                ? '保存后这个用户的头像会恢复成昵称的第一个字。'
                : '这里只支持清空。用户想换头像，可以在页面右上角的下拉菜单里自己换。'
            }}
          </p>
        </div>

        <p v-if="leavesAdmin" class="warn">
          注意：系统至少要保留一个可用的管理员。如果这是最后一个管理员，保存会被拒绝。
        </p>

        <p v-if="dialogError" class="auth-error">{{ dialogError }}</p>
      </div>

      <template #footer>
        <button class="btn ghost" type="button" :disabled="saving" @click="closeEdit">取消</button>
        <button class="btn primary" type="button" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </template>
    </AdminModal>

    <!-- 删除确认 -->
    <AdminModal
      v-if="deleting"
      title="删除用户"
      :busy="removing"
      @close="deleting = null"
    >
      <p class="confirm-text">
        确定删除用户 <b>{{ deletingName }}</b> 吗？此操作不可恢复。
      </p>
      <p class="hint">这个用户的收藏和学习记录也会一起删掉。</p>
      <p v-if="deleteError" class="auth-error">{{ deleteError }}</p>

      <template #footer>
        <button class="btn ghost" type="button" :disabled="removing" @click="deleting = null">
          取消
        </button>
        <button class="btn danger-solid" type="button" :disabled="removing" @click="confirmDelete">
          {{ removing ? '删除中…' : '确定删除' }}
        </button>
      </template>
    </AdminModal>
  </div>
</template>

<style scoped>
/* ---------- 工具条 ---------- */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 2px;
}

.search-input {
  width: 240px;
  padding: 7px 11px;
  font-size: 13px;
  font-family: inherit;
  color: #e6edf3;
  background: #1b212b;
  border: 1px solid #2c3542;
  border-radius: 8px;
}

.search-input::placeholder {
  color: #59636f;
}

.search-input:focus {
  outline: none;
  background: #1e2530;
  border-color: #3f6fd8;
}

.toolbar .btn {
  padding: 7px 14px;
  font-size: 13px;
}

/* 列表整体失败（后端没起来 / 令牌过期）时的提示 */
.row-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 10px;
  padding: 8px 11px;
  font-size: 12.5px;
  color: #ff9c9c;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 8px;
}

/* ---------- 表格 ---------- */
.admin-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.admin-table th {
  padding: 8px 10px;
  font-size: 11.5px;
  font-weight: 600;
  color: #8b949e;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid #232a35;
}

.admin-table td {
  padding: 9px 10px;
  color: #c3cddb;
  border-bottom: 1px solid #1b212b;
  white-space: nowrap;
}

.admin-table tbody tr:hover {
  background: #161b23;
}

.mono {
  font-family: Consolas, Monaco, monospace;
}

.col-id {
  width: 56px;
}

/* ---------- 头像列 ---------- */
.col-avatar {
  width: 52px;
}

/* 图片和"首字占位"是同一个尺寸的圆，列表里一行的高度不会因为有没有头像而变 */
.row-avatar {
  width: 26px;
  height: 26px;
}

.row-avatar-text {
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
  background: #3f6fd8;
  border-radius: 50%;
}

/* ---------- 编辑弹窗里的头像块（只能清空，换头像由用户自己换） ---------- */
.avatar-edit {
  display: flex;
  align-items: center;
  gap: 10px;
}

.avatar-edit-img {
  width: 40px;
  height: 40px;
  flex: none;
}

.avatar-edit-text {
  display: grid;
  place-items: center;
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  background: #3f6fd8;
  border-radius: 50%;
}

.col-ops {
  text-align: right;
}

.btn.tiny {
  padding: 4px 10px;
  font-size: 12px;
}

.btn.tiny + .btn.tiny {
  margin-left: 6px;
}

.btn.ghost.tiny.danger {
  color: #c98b8b;
}

.btn.ghost.tiny.danger:hover:not(:disabled) {
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.1);
}

.table-empty {
  padding: 34px 10px;
  color: #7d8694;
  text-align: center;
}

/* ---------- 小标签 ---------- */
/* 角色：管理员用琥珀色（和顶栏那个"管理员"标识同色），普通用户用平台主色蓝 */
.role-tag {
  padding: 1px 8px;
  font-size: 11px;
  border-radius: 20px;
}

.role-tag.admin {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.14);
  border: 1px solid rgba(245, 158, 11, 0.4);
}

.role-tag.user {
  color: #79abff;
  background: rgba(63, 111, 216, 0.16);
  border: 1px solid rgba(63, 111, 216, 0.45);
}

/* 状态：正常绿、已禁用红 */
.state-tag {
  padding: 1px 8px;
  font-size: 11px;
  color: #10b981;
  background: rgba(16, 185, 129, 0.14);
  border: 1px solid rgba(16, 185, 129, 0.4);
  border-radius: 20px;
}

.state-tag.off {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.4);
}

/* "我自己"：提醒这一行不能删 */
.me-tag {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10.5px;
  font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  color: #79abff;
  background: rgba(63, 111, 216, 0.16);
  border: 1px solid rgba(63, 111, 216, 0.4);
  border-radius: 20px;
}
</style>
