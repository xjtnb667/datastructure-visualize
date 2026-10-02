<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  ApiError,
  adminCreateAlgorithm,
  adminDeleteAlgorithm,
  adminListAlgorithms,
  adminUpdateAlgorithm,
  type AlgoMeta,
} from '@/api/client'
import AdminModal from '@/components/admin/AdminModal.vue'
import AdminPager from '@/components/admin/AdminPager.vue'
import { CATEGORIES } from '@/core/categories'
import { difficultyText, useUserStore } from '@/stores/user'

/**
 * 后台 · 「算法管理」标签页：搜索 + 分页 + 新增/编辑弹窗 + 删除二次确认。
 *
 * 几个约定（都跟后端接口对齐）：
 *   - **大类的下拉框用 `CATEGORIES` 的 `id` 当 value、`name` 当显示文字** ——
 *     数据库里存的就是 `sort` / `linear` 这种 id（后端也接受中文名，会归一化）；
 *   - 难度 1~3，表格里用星表示；
 *   - `algo_key` 重复时后端返回 409 + 中文说明，这里原样显示在弹窗里；
 *   - 保存 / 删除之后重新拉列表，**以后端为准**。
 */

const store = useUserStore()

const emit = defineEmits<{
  notice: [text: string, kind?: 'ok' | 'error']
  changed: []
}>()

const items = ref<AlgoMeta[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(10)
const q = ref('')
const loading = ref(false)
const error = ref('')

const dialogOpen = ref(false)
const editing = ref<AlgoMeta | null>(null)
const saving = ref(false)
const dialogError = ref('')

interface AlgoForm {
  algo_key: string
  name: string
  category: string
  grp: string
  difficulty: number
  summary: string
  online: boolean
}

function emptyForm(): AlgoForm {
  return {
    algo_key: '',
    name: '',
    category: CATEGORIES[0]!.id,
    grp: '',
    difficulty: 2,
    summary: '',
    online: true,
  }
}

const form = ref<AlgoForm>(emptyForm())

const deleting = ref<AlgoMeta | null>(null)
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
    const res = await adminListAlgorithms(keyword, page.value, size.value)
    const pages = Math.max(1, Math.ceil(res.total / size.value))
    if (page.value > pages) {
      page.value = pages
      const again = await adminListAlgorithms(keyword, page.value, size.value)
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
  if (loading.value) return '正在加载算法列表…'
  return q.value.trim() ? '没有匹配的算法' : '还没有算法'
})

/** 后端存的大类 -> 选择器里那个 id（万一是中文名，也认） */
function categoryIdOf(value: string): string {
  const byId = CATEGORIES.find((c) => c.id === value)
  if (byId) return byId.id
  const byName = CATEGORIES.find((c) => c.name === value)
  return byName ? byName.id : value
}

/** 表格里显示大类的中文名；前端都不认识的值就原样显示，不瞎猜 */
function categoryName(value: string): string {
  const hit = CATEGORIES.find((c) => c.id === value) ?? CATEGORIES.find((c) => c.name === value)
  return hit ? hit.name : value || '—'
}

/** 难度 1~3 -> ★★☆ */
function stars(level: number): string {
  const n = Math.min(3, Math.max(1, Math.trunc(level) || 2))
  return '★'.repeat(n) + '☆'.repeat(3 - n)
}

function onCategory(event: Event): void {
  form.value.category = (event.target as HTMLSelectElement).value
}

function onDifficulty(event: Event): void {
  form.value.difficulty = Number((event.target as HTMLSelectElement).value)
}

function openCreate(): void {
  editing.value = null
  dialogError.value = ''
  form.value = emptyForm()
  dialogOpen.value = true
}

function openEdit(row: AlgoMeta): void {
  editing.value = row
  dialogError.value = ''
  form.value = {
    algo_key: row.algo_key,
    name: row.name,
    category: categoryIdOf(row.category),
    grp: row.grp ?? '',
    difficulty: row.difficulty,
    summary: row.summary ?? '',
    online: row.online === 1,
  }
  dialogOpen.value = true
}

function closeDialog(): void {
  dialogOpen.value = false
  editing.value = null
  dialogError.value = ''
}

/** 弹窗标题里的算法名：取不到就是"新增算法" */
const dialogTitle = computed(() =>
  editing.value ? `编辑算法：${editing.value.name}` : '新增算法',
)

async function save(): Promise<void> {
  const key = form.value.algo_key.trim()
  const name = form.value.name.trim()
  const grp = form.value.grp.trim()
  const summary = form.value.summary.trim()

  if (!key) {
    dialogError.value = '请填写算法标识，比如 bubble-sort'
    return
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
    dialogError.value = '算法标识只能包含字母、数字、下划线和中划线（1~64 位）'
    return
  }
  if (!name) {
    dialogError.value = '请填写算法名称'
    return
  }
  if (name.length > 40) {
    dialogError.value = '算法名称最多 40 个字符'
    return
  }
  if (grp.length > 40) {
    dialogError.value = '子类名最多 40 个字符'
    return
  }
  if (summary.length > 300) {
    dialogError.value = '简介最多 300 个字符'
    return
  }

  saving.value = true
  dialogError.value = ''
  try {
    if (editing.value) {
      const before = editing.value
      const patch: Partial<AlgoMeta> = {}
      if (key !== before.algo_key) patch.algo_key = key
      if (name !== before.name) patch.name = name
      if (form.value.category !== categoryIdOf(before.category)) patch.category = form.value.category
      if (grp !== (before.grp ?? '')) patch.grp = grp || null
      if (form.value.difficulty !== before.difficulty) patch.difficulty = form.value.difficulty
      if (summary !== (before.summary ?? '')) patch.summary = summary || null
      if ((form.value.online ? 1 : 0) !== before.online) patch.online = form.value.online ? 1 : 0

      if (Object.keys(patch).length === 0) {
        dialogError.value = '没有修改任何内容'
        return
      }
      const updated = await adminUpdateAlgorithm(before.id, patch)
      closeDialog()
      emit('notice', `算法「${updated.name}」保存成功`)
      await load()
    } else {
      const created = await adminCreateAlgorithm({
        algo_key: key,
        name,
        category: form.value.category,
        grp: grp || null,
        difficulty: form.value.difficulty,
        summary: summary || null,
        online: form.value.online ? 1 : 0,
      })
      closeDialog()
      emit('notice', `算法「${created.name}」新增成功`)
      emit('changed')
      await load()
    }
  } catch (err) {
    // algo_key 重复（409）等错误：后端的中文说明就显示在弹窗里
    dialogError.value = fail(err)
  } finally {
    saving.value = false
  }
}

function openDelete(row: AlgoMeta): void {
  deleting.value = row
  deleteError.value = ''
}

const deletingName = computed(() => deleting.value?.name ?? '')

async function confirmDelete(): Promise<void> {
  const target = deleting.value
  if (!target) return
  removing.value = true
  deleteError.value = ''
  try {
    await adminDeleteAlgorithm(target.id)
    deleting.value = null
    emit('notice', `已删除算法「${target.name}」`)
    emit('changed')
    await load()
  } catch (err) {
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
        placeholder="按算法标识或名称搜索"
        :disabled="loading"
      />
      <button class="btn primary" type="submit" :disabled="loading">搜索</button>
      <button v-if="q" class="btn ghost" type="button" @click="clearSearch">清空</button>
      <button class="btn ghost" type="button" :disabled="loading" @click="load">刷新</button>
      <button class="btn primary add-btn" type="button" @click="openCreate">＋ 新增算法</button>
    </form>

    <p v-if="error" class="row-error">
      {{ error }}
      <button class="btn ghost tiny" type="button" @click="load">重试</button>
    </p>

    <table class="admin-table">
      <thead>
        <tr>
          <th class="col-id">ID</th>
          <th>算法标识</th>
          <th>名称</th>
          <th>大类</th>
          <th>子类</th>
          <th>难度</th>
          <th>上架状态</th>
          <th class="col-ops">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in items" :key="row.id">
          <td class="mono">{{ row.id }}</td>
          <td class="mono key">{{ row.algo_key }}</td>
          <td>{{ row.name }}</td>
          <td>{{ categoryName(row.category) }}</td>
          <td>{{ row.grp || '—' }}</td>
          <td class="stars" :title="difficultyText(row.difficulty)">{{ stars(row.difficulty) }}</td>
          <td>
            <span class="online-tag" :class="{ off: row.online !== 1 }">
              {{ row.online === 1 ? '已上架' : '已下架' }}
            </span>
          </td>
          <td class="col-ops">
            <button class="btn ghost tiny" type="button" @click="openEdit(row)">编辑</button>
            <button
              class="btn ghost tiny danger"
              type="button"
              :title="`删除算法 ${row.name}`"
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
      unit="算法"
      :loading="loading"
      @update:page="setPage"
      @update:size="setSize"
    />

    <!-- 新增 / 编辑算法 -->
    <AdminModal v-if="dialogOpen" :title="dialogTitle" :busy="saving" wide @close="closeDialog">
      <div class="form-col">
        <div class="form-row">
          <label class="field">
            <span>算法标识（英文，和前端注册表对应）</span>
            <input
              v-model="form.algo_key"
              type="text"
              placeholder="比如 bubble-sort"
              :disabled="saving"
            />
          </label>

          <label class="field">
            <span>算法名称</span>
            <input
              v-model="form.name"
              type="text"
              maxlength="40"
              placeholder="比如 冒泡排序"
              :disabled="saving"
            />
          </label>
        </div>

        <div class="form-row">
          <label class="field">
            <span>大类</span>
            <select :value="form.category" :disabled="saving" @change="onCategory">
              <option v-for="item in CATEGORIES" :key="item.id" :value="item.id">
                {{ item.name }}
              </option>
            </select>
          </label>

          <label class="field">
            <span>子类（可留空）</span>
            <input
              v-model="form.grp"
              type="text"
              maxlength="40"
              placeholder="比如 交换类排序"
              :disabled="saving"
            />
          </label>
        </div>

        <div class="form-row">
          <label class="field">
            <span>难度</span>
            <select :value="form.difficulty" :disabled="saving" @change="onDifficulty">
              <option :value="1">★ 入门</option>
              <option :value="2">★★ 中等</option>
              <option :value="3">★★★ 较难</option>
            </select>
          </label>

          <label class="switch online-switch">
            <input v-model="form.online" type="checkbox" :disabled="saving" />
            <span>上架</span>
            <span class="switch-tip">（下架的算法前端不显示）</span>
          </label>
        </div>

        <label class="field">
          <span>简介（一句话说明这个算法干什么，可留空）</span>
          <textarea
            v-model="form.summary"
            maxlength="300"
            placeholder="比如：反复比较相邻两个元素，把大的往后换。"
            :disabled="saving"
          ></textarea>
        </label>

        <p v-if="dialogError" class="auth-error">{{ dialogError }}</p>
      </div>

      <template #footer>
        <button class="btn ghost" type="button" :disabled="saving" @click="closeDialog">取消</button>
        <button class="btn primary" type="button" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </template>
    </AdminModal>

    <!-- 删除确认 -->
    <AdminModal v-if="deleting" title="删除算法" :busy="removing" @close="deleting = null">
      <p class="confirm-text">
        确定删除算法 <b>{{ deletingName }}</b> 吗？此操作不可恢复。
      </p>
      <p class="hint">用户收藏和学习记录里这个算法的条目也会一起删掉。</p>
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

/* 「新增算法」推到最右边，和其它按钮拉开距离 */
.add-btn {
  margin-left: auto;
}

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

.key {
  color: #79abff;
}

.col-id {
  width: 56px;
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
/* 难度：亮的是"到几星"，暗的是"还差几星" */
.stars {
  font-size: 12px;
  letter-spacing: 1px;
  color: #f5c518;
  cursor: default;
}

/* 上架绿、下架红 */
.online-tag {
  padding: 1px 8px;
  font-size: 11px;
  color: #10b981;
  background: rgba(16, 185, 129, 0.14);
  border: 1px solid rgba(16, 185, 129, 0.4);
  border-radius: 20px;
}

.online-tag.off {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.4);
}

/* 上架开关在弹窗里单独占一格，和左边的"难度"对齐 */
.online-switch {
  align-self: end;
  padding-bottom: 9px;
}
</style>
