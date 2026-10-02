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
  patch: { nickname?: string; role?: string; disabled?: number; password?: string },
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
