import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  ApiError,
  NOTE_MAX_LENGTH,
  listNotes,
  removeNote as apiRemoveNote,
  saveNote as apiSaveNote,
  type Note,
} from '@/api/client'
import { useUserStore } from '@/stores/user'

/**
 * 「学习笔记」的状态（Pinia）。
 *
 * 一个用户对一个算法只有一条笔记，所以本地就用 `Map<algo_key, note>` 存 ——
 * 算法面板要看某个算法的笔记时是 O(1)，不用每次都翻数组。
 *
 * 三条设计约定（和 `stores/user.ts` 里的收藏保持一致）：
 *   1. **未登录不自己弹登录框**：`saveNote` / `removeNote` 回一个 `{status:'login'}` 信号，
 *      弹窗由界面决定（同一个信号在不同界面各弹各的）。store 保持纯净。
 *   2. **乐观更新 + 失败回滚**：点保存立刻能看到结果，请求失败再退回原样并报中文错。
 *      "以服务器为准"这条很重要 —— 否则后端没存上，用户却以为存好了。
 *   3. **静默拉取**：登录后拉一次全部笔记，失败（后端没启动 / 令牌过期）不打断看动画。
 */
export type NoteResult =
  | { status: 'ok'; note: Note | null }
  | { status: 'login' }
  | { status: 'failed'; message: string }

/** 正文长度上限（去空白后算）。和服务端 `MAX_NOTE_LENGTH` 一致，`client.ts` 里是同一个常量 */
export { NOTE_MAX_LENGTH }

export const useNotesStore = defineStore('notes', () => {
  const userStore = useUserStore()

  // ---------- state ----------
  /** 我的笔记：`algo_key -> note` */
  const notes = ref<Map<string, Note>>(new Map())
  /** 正在拉全部笔记（界面可以显示"加载中"） */
  const loading = ref(false)
  /** 正在保存 / 删除（按钮禁用用） */
  const busy = ref(false)

  /** 每次拉取自增，用来丢掉"过期的返回"：先发的请求后回来时不该覆盖新数据 */
  let callSeq = 0

  // ---------- getters ----------
  const count = computed(() => notes.value.size)
  /** 全部笔记，按"最近修改"倒序（给需要列表的界面用） */
  const sorted = computed(() =>
    [...notes.value.values()].sort((a, b) => b.updated_at - a.updated_at),
  )

  /** 取某个算法的笔记；没写过就是 null */
  function getNote(algoKey: string): Note | null {
    return notes.value.get(algoKey) ?? null
  }

  /** 某个算法有没有笔记（界面上打"有笔记"的小标记用） */
  function hasNote(algoKey: string): boolean {
    return notes.value.has(algoKey)
  }

  /** Map 整体替换，Vue 才认得出变化（和 `stores/user.ts` 里的收藏一样） */
  function putNote(note: Note): void {
    const next = new Map(notes.value)
    next.set(note.algo_key, note)
    notes.value = next
  }

  function dropNote(algoKey: string): void {
    if (!notes.value.has(algoKey)) return
    const next = new Map(notes.value)
    next.delete(algoKey)
    notes.value = next
  }

  function clear(): void {
    callSeq += 1 // 丢掉可能在飞的旧请求
    notes.value = new Map()
  }

  // ---------- 拉数据 ----------
  /** 拉我的全部笔记。**静默失败**：后端没起来也不该在界面上弹错误 */
  async function refreshNotes(): Promise<void> {
    if (!userStore.isLoggedIn) {
      clear()
      return
    }
    const seq = ++callSeq
    loading.value = true
    try {
      const list = await listNotes()
      if (seq !== callSeq) return
      notes.value = new Map(list.map((item) => [item.algo_key, item] as const))
    } catch {
      // 后端不可用 / 令牌过期都走这里。保持现状即可
    } finally {
      if (seq === callSeq) loading.value = false
    }
  }

  // ---------- 写 ----------
  function isUnauthorized(error: unknown): boolean {
    return error instanceof ApiError && error.status === 401
  }

  /**
   * 保存某个算法的笔记（有就更新，没有就新增）。
   *
   * `content` 去空白后是空串时会**删掉这条笔记** —— 这是后端契约（见
   * 《用户与管理员系统-设计.md》第四部分），所以这里直接转给 `removeNote`，
   * 前后端对"空内容"的理解不会有第二种。
   *
   * 本地先改（乐观更新）再发请求，失败回滚；`status:'login'` 表示还没登录 /
   * 令牌已失效，**store 不弹窗**，界面拿到这个信号自己决定怎么办。
   */
  async function saveNote(algoKey: string, content: string): Promise<NoteResult> {
    if (!userStore.isLoggedIn) return { status: 'login' }

    const text = (content ?? '').trim()
    if (text === '') return removeNote(algoKey)
    if (text.length > NOTE_MAX_LENGTH) {
      return { status: 'failed', message: `笔记太长了：最多 ${NOTE_MAX_LENGTH} 个字` }
    }

    const before = notes.value.get(algoKey) ?? null
    const now = Date.now()
    putNote({
      algo_key: algoKey,
      content: text,
      created_at: before?.created_at ?? now,
      updated_at: now,
    })

    busy.value = true
    try {
      const saved = await apiSaveNote(algoKey, text)
      if (saved) putNote(saved) // 用服务端返回的时间戳覆盖本地的估算值
      else dropNote(algoKey) // 服务端认为"空内容 = 删除"时的兜底
      return { status: 'ok', note: saved ?? null }
    } catch (error) {
      // 回滚：以服务器为准，不能让用户以为存上了
      if (before) putNote(before)
      else dropNote(algoKey)
      if (isUnauthorized(error)) {
        clear()
        return { status: 'login' }
      }
      return { status: 'failed', message: userStore.errorText(error) }
    } finally {
      busy.value = false
    }
  }

  /** 删除某个算法的笔记（乐观更新 + 失败回滚；后端那边是幂等的） */
  async function removeNote(algoKey: string): Promise<NoteResult> {
    if (!userStore.isLoggedIn) return { status: 'login' }

    const before = notes.value.get(algoKey) ?? null
    dropNote(algoKey)

    busy.value = true
    try {
      await apiRemoveNote(algoKey)
      return { status: 'ok', note: null }
    } catch (error) {
      if (before) putNote(before)
      if (isUnauthorized(error)) {
        clear()
        return { status: 'login' }
      }
      return { status: 'failed', message: userStore.errorText(error) }
    } finally {
      busy.value = false
    }
  }

  /**
   * 登录状态一变就把笔记对齐：
   * 登录（含刷新页面后恢复登录）→ 拉全部笔记；退出 → 清空本地，别让下一个人看到。
   */
  watch(
    () => userStore.isLoggedIn,
    (logged) => {
      if (logged) void refreshNotes()
      else clear()
    },
    { immediate: true },
  )

  return {
    // state
    notes,
    loading,
    busy,
    // getters
    count,
    sorted,
    // 查询
    getNote,
    hasNote,
    // actions
    refreshNotes,
    saveNote,
    removeNote,
  }
})
