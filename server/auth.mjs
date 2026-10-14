/**
 * 认证与权限：密码哈希、会话令牌、注册 / 登录、角色校验、入参校验。
 *
 * 安全要点（第 5 节，代码里都落实了）：
 * 1. 密码 **绝不存明文**：scrypt + 每个用户 16 字节随机盐，比对用 timingSafeEqual；
 * 2. 令牌 32 字节随机 hex，有效期 7 天，每次请求校验存在性与过期时间；
 * 3. 越权防护：管理员的每个接口都**在服务端**查角色（不靠前端藏按钮）。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db, now, plain } from './db.mjs'

const KEY_LEN = 64
const SALT_BYTES = 16
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ADMIN_USERNAME = 'admin'

/**
 * 管理员初始口令的来源（**仓库里不放明文口令**）：
 * 1. 优先读环境变量 `ADMIN_PASSWORD`（适合脚本化部署与自动化测试）；
 * 2. 环境变量为空时，进程启动时用 `randomBytes` 随机生成一个 —— 只会在
 *    "首次建号"那一次打印到控制台，提示登录后立刻修改。随机口令不落任何文件。
 * 注意：`ADMIN_PASSWORD` 在模块加载时就定下来了，所以**要在 import 本文件之前**
 * 设好 `process.env.ADMIN_PASSWORD`（测试就是这么保证确定性的）。
 */
const ENV_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || ''
/** true = 本次运行的口令是随机生成的（不是环境变量给的），只在控制台提示时用得上 */
export const ADMIN_PASSWORD_IS_GENERATED = !ENV_ADMIN_PASSWORD
export const ADMIN_PASSWORD = ENV_ADMIN_PASSWORD || randomBytes(12).toString('base64url')

/** 带 HTTP 状态码的错误：message 是给用户看的中文说明 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// 密码
// ---------------------------------------------------------------------------
export function makeSalt() {
  return randomBytes(SALT_BYTES).toString('hex')
}

export function hashPassword(password, salt) {
  return scryptSync(password, salt, KEY_LEN).toString('hex')
}

/** 定长哈希比对，用 timingSafeEqual 防时序侧信道 */
export function verifyPassword(password, salt, expectedHash) {
  const actual = scryptSync(password, salt, KEY_LEN)
  const expected = Buffer.from(String(expectedHash), 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

// ---------------------------------------------------------------------------
// 会话令牌
// ---------------------------------------------------------------------------
export function createSession(userId) {
  const token = randomBytes(32).toString('hex')
  const ts = now()
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    ts,
    ts + SESSION_TTL_MS,
  )
  return token
}

export function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

function dropExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now())
}

/** 令牌 → 用户（不存在 / 过期都返回 null） */
function userByToken(token) {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.nickname, u.role, u.disabled, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, now())
  return plain(row)
}

/** 从 Authorization: Bearer <token> 里取令牌 */
function bearerToken(req) {
  const raw = req.headers.authorization ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim())
  return m ? m[1].trim() : ''
}

/** 返回给前端的用户对象：**一定不含** password_hash / salt */
export function publicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    nickname: row.nickname,
    role: row.role,
    disabled: Number(row.disabled),
    created_at: Number(row.created_at),
  }
}

/** 需要登录的接口：校验令牌，返回用户；失败抛 401 / 403 */
export function requireAuth(req) {
  const token = bearerToken(req)
  if (!token) throw new HttpError(401, '请先登录')
  const user = userByToken(token)
  if (!user) throw new HttpError(401, '登录状态已失效，请重新登录')
  if (Number(user.disabled) === 1) throw new HttpError(403, '该账号已被禁用，请联系管理员')
  return user
}

/** 管理员接口：在服务端查角色，普通用户一律 403 */
export function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new HttpError(403, '需要管理员权限')
  return user
}

/** 当前"可用管理员"数量（没被禁用、且角色是 admin），用于防止把系统锁死 */
export function activeAdminCount() {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")
    .get()
  return Number(row.n)
}

// ---------------------------------------------------------------------------
// 入参校验（所有写接口都要过这一关，错误都是中文说明）
// ---------------------------------------------------------------------------
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/

export function assertUsername(value) {
  const username = String(value ?? '').trim()
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, '用户名必须是 3~20 位的字母、数字或下划线')
  }
  return username
}

export function assertNickname(value) {
  const nickname = String(value ?? '').trim()
  if (nickname.length < 1 || nickname.length > 20) {
    throw new HttpError(400, '昵称长度必须是 1~20 个字符')
  }
  return nickname
}

export function assertPassword(value) {
  const password = String(value ?? '')
  if (password.length < 6) throw new HttpError(400, '密码长度至少 6 位')
  if (password.length > 64) throw new HttpError(400, '密码长度不能超过 64 位')
  return password
}

// ---------------------------------------------------------------------------
// 注册 / 登录
// ---------------------------------------------------------------------------
export function registerUser({ username, nickname, password }) {
  const name = assertUsername(username)
  const nick = assertNickname(nickname)
  const pwd = assertPassword(password)

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(name)
  if (exists) throw new HttpError(409, '该用户名已被注册')

  const salt = makeSalt()
  const info = db
    .prepare(
      `INSERT INTO users (username, nickname, password_hash, salt, role, disabled, created_at)
       VALUES (?, ?, ?, ?, 'user', 0, ?)`,
    )
    .run(name, nick, hashPassword(pwd, salt), salt, now())

  const row = db
    .prepare('SELECT id, username, nickname, role, disabled, created_at FROM users WHERE id = ?')
    .get(info.lastInsertRowid)
  return publicUser(row)
}

export function loginUser({ username, password }) {
  const name = String(username ?? '').trim()
  const pwd = String(password ?? '')
  if (!name || !pwd) throw new HttpError(400, '请填写用户名和密码')

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(name)
  // 用户不存在也走一遍哈希，避免用响应时间区分"用户不存在"和"密码错误"
  if (!row) {
    verifyPassword(pwd, 'ffffffffffffffffffffffffffffffff', 'f'.repeat(KEY_LEN * 2))
    throw new HttpError(401, '用户名或密码错误')
  }
  if (!verifyPassword(pwd, row.salt, row.password_hash)) {
    throw new HttpError(401, '用户名或密码错误')
  }
  if (Number(row.disabled) === 1) throw new HttpError(403, '该账号已被禁用，请联系管理员')

  return { token: createSession(row.id), user: publicUser(row) }
}

// ---------------------------------------------------------------------------
// 启动时：清掉过期会话 + 写入管理员种子账号
// ---------------------------------------------------------------------------
export function ensureAdminSeed() {
  dropExpiredSessions()

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME)
  if (exists) return false

  const salt = makeSalt()
  db.prepare(
    `INSERT INTO users (username, nickname, password_hash, salt, role, disabled, created_at)
     VALUES (?, ?, ?, ?, 'admin', 0, ?)`,
  ).run(ADMIN_USERNAME, '管理员', hashPassword(ADMIN_PASSWORD, salt), salt, now())
  return true
}
