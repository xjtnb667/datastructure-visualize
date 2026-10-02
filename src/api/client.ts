/**
 * 后端接口的统一封装（前端只从这里发请求）。
 * 这是**正式实现**，不是临时占位文件，请勿删除。
 *
 * 约定（和《用户与管理员系统-设计.md》第 4 节一一对应）：
 * - 令牌存 localStorage，key = `algo-platform-token`；
 * - 每次请求自动带 `Authorization: Bearer <token>`；
 * - 失败一律 **抛 Error**，`error.message` 就是后端返回的中文说明（界面直接显示它）；
 * - 只有 `me()` 例外：未登录 / 令牌失效时返回 `null`，用于启动时静默判断登录状态。
 *
 * 后端响应信封：成功 `{ ok: true, data }`，失败 `{ ok: false, error }`。
 */

export interface User {
  id: number
  username: string
  nickname: string
  role: 'user' | 'admin'
  disabled: number
  created_at: number
  /**
   * 自定义头像：**图片的 data URL**（如 `data:image/jpeg;base64,...`）。
   * 没设置就是 `null`（界面显示昵称首字的圆形占位）。
   * 由用户在「更换头像」弹窗里选图 → 前端压到 128×128 → 再上传，见 `AvatarDialog.vue`。
   */
  avatar?: string | null
}

/**
 * 头像的两条硬规矩：**只收图片的 data URL**，base64 正文最多 200KB。
 * 服务端有一份一模一样的校验（`server/api.mjs` 的 `assertAvatar`），这里这份
 * 只是让前端**先挡一道**、不用等一个来回才知道图片太大 —— 真正的把关在服务端。
 */
export const AVATAR_MAX_BASE64 = 200 * 1024

/** `data:image/(png|jpeg|jpg|webp|gif);base64,` 开头才算头像 */
export const AVATAR_DATA_URL_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/

/** 取 data URL 里 base64 正文的字符数（不是图片的字节数，但足够用来卡上限） */
export function avatarBase64Length(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  return comma < 0 ? 0 : dataUrl.length - comma - 1
}

export interface AlgoMeta {
  id: number
  algo_key: string
  name: string
  category: string
  grp: string | null
  difficulty: number
  summary: string | null
  online: number
  sort_order: number
}

export interface FavItem {
  algo_key: string
  created_at: number
}

export interface HistoryItem {
  algo_key: string
  views: number
  max_step: number
  total_steps: number
  updated_at: number
}

/**
 * 学习笔记：一个用户对一个算法**只有一条**（后端 `notes` 表的主键是 user_id + algo_key）。
 * `content` 是纯文本（支持多行；界面不渲染 Markdown）；`created_at` 是第一次写的时间，
 * 之后每次保存只动 `updated_at` —— 界面上"最后修改"显示的就是它。
 */
export interface Note {
  algo_key: string
  content: string
  created_at: number
  updated_at: number
}

/**
 * 笔记正文的长度上限（按**去掉首尾空白后**的字符数算）。
 * 服务端有一份一模一样的校验（`server/api.mjs` 的 `MAX_NOTE_LENGTH`），
 * 这里这份只是让前端先挡一道、顺带给"还能写几个字"的计数用 —— 真正的把关在服务端。
 */
export const NOTE_MAX_LENGTH = 2000

export interface AdminStats {
  users: number
  algorithms: number
  favorites: number
  todayUsers: number
}

export interface Page<T> {
  items: T[]
  total: number
}

/** 后端返回的错误（带 HTTP 状态码）；当普通 Error 用也完全没问题 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: string
}

const TOKEN_KEY = 'algo-platform-token'
const BASE = '/api'

// ---------------------------------------------------------------------------
// 令牌
// ---------------------------------------------------------------------------
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function getToken(): string | null {
  return storage()?.getItem(TOKEN_KEY) ?? null
}

export function setToken(t: string | null): void {
  const s = storage()
  if (!s) return
  if (t) s.setItem(TOKEN_KEY, t)
  else s.removeItem(TOKEN_KEY)
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------
const STATUS_TEXT: Record<number, string> = {
  400: '请求的参数不对',
  401: '登录状态已失效，请重新登录',
  403: '没有权限进行这个操作',
  404: '请求的内容不存在',
  409: '数据已存在',
  413: '提交的内容太大了',
  500: '服务器内部错误，请稍后再试',
}

async function parse(res: Response): Promise<Envelope<unknown> | null> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as Envelope<unknown>
  } catch {
    return null
  }
}

/**
 * 发一个请求并解出 `data`。
 * @param nullOn401 令牌失效时返回 null 而不是抛错（只有 me() 这么用）
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  nullOn401 = false,
): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, '连不上后端服务，请确认后端已经启动')
  }

  const env = await parse(res)

  if (res.status === 401 && nullOn401) {
    if (token) setToken(null) // 令牌已经没用了，清掉，免得一直带着过期令牌
    return null as T
  }

  if (!res.ok) {
    /*
     * 5xx 而且响应体**不是我们后端的 JSON 信封** —— 说明这个响应根本不是后端发的。
     * 最常见的情况：Vite 的开发代理连不上后端（后端没启动 / 已退出），
     * 于是它自己回一个 HTML 或纯文本的 500。
     *
     * 这时候如果只说"服务器内部错误"，用户会以为程序坏了，根本想不到是"后端没开" ——
     * 实际排查中确实发生过（用户只跑了 npm run dev，只起了前端）。所以要直接说清怎么办。
     */
    if (res.status >= 500 && !env) {
      throw new ApiError(
        res.status,
        '后端服务没有启动（或已经退出）。请关掉这个窗口，重新双击项目目录下的「启动项目.bat」—— 它会同时启动后端和前端。',
      )
    }
    const message = (env?.error ?? '').trim() || STATUS_TEXT[res.status] || `请求失败（${res.status}）`
    if (res.status === 401 && token) setToken(null)
    throw new ApiError(res.status, message)
  }

  if (env && env.ok === false) {
    throw new ApiError(res.status, (env.error ?? '').trim() || '操作失败')
  }
  return (env?.data ?? null) as T
}

function query(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------
export async function register(username: string, nickname: string, password: string): Promise<User> {
  return request<User>('POST', '/auth/register', { username, nickname, password })
}

/** 登录成功后令牌已经自动存好，返回的是用户 */
export async function login(username: string, password: string): Promise<User> {
  const data = await request<{ token: string; user: User }>('POST', '/auth/login', {
    username,
    password,
  })
  setToken(data.token)
  return data.user
}

export async function logout(): Promise<void> {
  try {
    if (getToken()) await request<null>('POST', '/auth/logout')
  } finally {
    setToken(null)
  }
}

/** 当前登录用户；未登录或令牌失效返回 null（不抛错，启动时静默判断用） */
export async function me(): Promise<User | null> {
  if (!getToken()) return null
  return request<User | null>('GET', '/auth/me', undefined, true)
}

export async function updateMe(patch: {
  nickname?: string
  oldPassword?: string
  newPassword?: string
  /** 头像：data URL 字符串表示设置，`null` 表示清除（恢复成昵称首字占位） */
  avatar?: string | null
}): Promise<User> {
  return request<User>('PATCH', '/auth/me', patch)
}

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------
export async function listFavorites(): Promise<FavItem[]> {
  const data = await request<FavItem[] | null>('GET', '/favorites')
  return data ?? []
}

export async function addFavorite(algoKey: string): Promise<void> {
  await request<null>('POST', '/favorites', { algoKey })
}

export async function removeFavorite(algoKey: string): Promise<void> {
  await request<null>('DELETE', `/favorites/${encodeURIComponent(algoKey)}`)
}

// ---------------------------------------------------------------------------
// 学习记录
// ---------------------------------------------------------------------------
export async function listHistory(): Promise<HistoryItem[]> {
  const data = await request<HistoryItem[] | null>('GET', '/history')
  return data ?? []
}

/** 上报一次学习进度：后端 views +1、max_step 取较大值（前端要节流，别每一步都发） */
export async function reportHistory(algoKey: string, step: number, totalSteps: number): Promise<void> {
  await request<null>('POST', '/history', { algoKey, step, totalSteps })
}

// ---------------------------------------------------------------------------
// 学习笔记（都要登录；后端只认令牌里的用户，所以只能读写自己的笔记）
// ---------------------------------------------------------------------------
/** 我的全部笔记（每个算法最多一条） */
export async function listNotes(): Promise<Note[]> {
  const data = await request<Note[] | null>('GET', '/notes')
  return data ?? []
}

/** 某个算法的笔记；**还没写过返回 null（不是 404）** */
export async function getNote(algoKey: string): Promise<Note | null> {
  return request<Note | null>('GET', `/notes/${encodeURIComponent(algoKey)}`)
}

/**
 * 新增或更新某个算法的笔记。
 * ⚠️ `content` **去掉首尾空白后是空串 = 删掉这条笔记**（后端契约如此），
 * 这时返回 `null`；正常保存则返回写进去的那一条（带服务端的时间戳）。
 */
export async function saveNote(algoKey: string, content: string): Promise<Note | null> {
  return request<Note | null>('PUT', `/notes/${encodeURIComponent(algoKey)}`, { content })
}

/** 删除某个算法的笔记（幂等：没写过也不报错） */
export async function removeNote(algoKey: string): Promise<void> {
  await request<null>('DELETE', `/notes/${encodeURIComponent(algoKey)}`)
}

// ---------------------------------------------------------------------------
// 算法元数据（游客可用，只返回上架的）
// ---------------------------------------------------------------------------
export async function listAlgorithms(): Promise<AlgoMeta[]> {
  const data = await request<AlgoMeta[] | null>('GET', '/algorithms')
  return data ?? []
}

// ---------------------------------------------------------------------------
// 管理员
// ---------------------------------------------------------------------------
export async function adminStats(): Promise<AdminStats> {
  return request<AdminStats>('GET', '/admin/stats')
}

export async function adminListUsers(
  q?: string,
  page = 1,
  size = 20,
): Promise<{ items: User[]; total: number }> {
  const data = await request<Page<User> | null>('GET', `/admin/users${query({ q, page, size })}`)
  return data ?? { items: [], total: 0 }
}

export async function adminUpdateUser(
  id: number,
  patch: {
    nickname?: string
    role?: string
    disabled?: number
    password?: string
    /** 传 `null` 表示清空这个用户的头像（后台"清空头像"用） */
    avatar?: string | null
  },
): Promise<User> {
  return request<User>('PATCH', `/admin/users/${id}`, patch)
}

export async function adminDeleteUser(id: number): Promise<void> {
  await request<null>('DELETE', `/admin/users/${id}`)
}

export async function adminListAlgorithms(
  q?: string,
  page = 1,
  size = 20,
): Promise<{ items: AlgoMeta[]; total: number }> {
  const data = await request<Page<AlgoMeta> | null>(
    'GET',
    `/admin/algorithms${query({ q, page, size })}`,
  )
  return data ?? { items: [], total: 0 }
}

export async function adminCreateAlgorithm(data: Partial<AlgoMeta>): Promise<AlgoMeta> {
  return request<AlgoMeta>('POST', '/admin/algorithms', data)
}

export async function adminUpdateAlgorithm(id: number, patch: Partial<AlgoMeta>): Promise<AlgoMeta> {
  return request<AlgoMeta>('PATCH', `/admin/algorithms/${id}`, patch)
}

export async function adminDeleteAlgorithm(id: number): Promise<void> {
  await request<null>('DELETE', `/admin/algorithms/${id}`)
}
