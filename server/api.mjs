/**
 * 业务接口：认证、收藏、学习记录、算法元数据、管理员增删改查。
 *
 * 全部以 /api 开头，请求 / 响应都是 JSON：
 *   成功 `{ ok: true, data: ... }`
 *   失败 `{ ok: false, error: "给用户看的中文说明" }`，HTTP 状态码同时给对。
 * SQL 一律参数绑定（db.prepare(...).run(a, b)），不做字符串拼接。
 */
import { db, now, plain, plainAll } from './db.mjs'
import {
  HttpError,
  activeAdminCount,
  assertNickname,
  assertPassword,
  destroySession,
  hashPassword,
  loginUser,
  makeSalt,
  publicUser,
  registerUser,
  requireAdmin,
  requireAuth,
  verifyPassword,
} from './auth.mjs'

export { HttpError }

/** 大类：数据库里存前端用的英文 id（linear / stack / …），中文名也接受（会归一化成 id） */
const CATEGORY_NAMES = {
  linear: '线性表',
  stack: '栈',
  queue: '队列',
  matrix: '数组与矩阵',
  string: '串',
  tree: '树与二叉树',
  graph: '图',
  search: '查找',
  sort: '排序',
}
const CATEGORY_IDS = Object.keys(CATEGORY_NAMES)

const MAX_PAGE_SIZE = 100

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------
function toInt(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback
    throw new HttpError(400, `缺少参数 ${label}`)
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new HttpError(400, `参数 ${label} 必须是整数`)
  if (n < min || n > max) throw new HttpError(400, `参数 ${label} 超出允许范围`)
  return n
}

function toBool01(value, label, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback
    throw new HttpError(400, `缺少参数 ${label}`)
  }
  if (value === true || value === 1 || value === '1') return 1
  if (value === false || value === 0 || value === '0') return 0
  throw new HttpError(400, `参数 ${label} 只能是 0 或 1`)
}

/** 收藏 / 学习记录里的算法标识 */
function assertAlgoKey(value) {
  const key = String(value ?? '').trim()
  if (!key) throw new HttpError(400, '缺少算法标识 algoKey')
  if (key.length > 64) throw new HttpError(400, '算法标识过长（最多 64 个字符）')
  return key
}

function normalizeCategory(value) {
  const s = String(value ?? '').trim()
  if (CATEGORY_IDS.includes(s)) return s
  const hit = CATEGORY_IDS.find((id) => CATEGORY_NAMES[id] === s)
  if (hit) return hit
  throw new HttpError(400, `大类只能是：${CATEGORY_IDS.map((id) => CATEGORY_NAMES[id]).join(' / ')}`)
}

/** LIKE 的 % / _ 要转义，否则用户搜 "a_b" 会变成通配 */
function likeParam(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

function paging(searchParams) {
  const page = toInt(searchParams.get('page'), 'page', { min: 1, fallback: 1 })
  const size = toInt(searchParams.get('size'), 'size', { min: 1, max: MAX_PAGE_SIZE, fallback: 20 })
  return { page, size, offset: (page - 1) * size }
}

function findUser(id) {
  const row = db
    .prepare('SELECT id, username, nickname, role, disabled, created_at FROM users WHERE id = ?')
    .get(id)
  if (!row) throw new HttpError(404, '用户不存在')
  return plain(row)
}

function findAlgorithm(id) {
  const row = db.prepare('SELECT * FROM algorithms WHERE id = ?').get(id)
  if (!row) throw new HttpError(404, '算法不存在')
  return plain(row)
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------
function authRegister({ body }) {
  return registerUser(body)
}

function authLogin({ body }) {
  return loginUser(body)
}

function authLogout({ req }) {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (token) destroySession(token)
  return null
}

function authMe({ user }) {
  return publicUser(user)
}

function authUpdateMe({ req, user, body }) {
  const patch = {}
  if (body.nickname !== undefined) patch.nickname = assertNickname(body.nickname)

  const wantsPassword = body.newPassword !== undefined && body.newPassword !== ''
  if (wantsPassword) {
    const newPassword = assertPassword(body.newPassword)
    const oldPassword = String(body.oldPassword ?? '')
    if (!oldPassword) throw new HttpError(400, '修改密码需要填写原密码')
    const row = db.prepare('SELECT salt, password_hash FROM users WHERE id = ?').get(user.id)
    if (!verifyPassword(oldPassword, row.salt, row.password_hash)) {
      throw new HttpError(400, '原密码不正确')
    }
    const salt = makeSalt()
    patch.password_hash = hashPassword(newPassword, salt)
    patch.salt = salt
  }

  if (Object.keys(patch).length === 0) throw new HttpError(400, '没有需要修改的内容')

  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(patch), user.id)

  // 改完密码，把该用户在**其它设备**上的会话全部作废 —— 当前这个保留，
  // 否则用户自己会被自己的操作踢下线，体验反而奇怪。
  // （只是改昵称的时候不清会话：那不算"凭据变了"。管理员重置密码走 adminUpdateUser，
  //  那边连自己在用的会话一起清，因为他重置的本来就不是自己。）
  if (patch.password_hash !== undefined) {
    const currentToken = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, currentToken)
  }
  return findUser(user.id)
}

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------
function listFavorites({ user }) {
  return plainAll(
    db
      .prepare('SELECT algo_key, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC, algo_key')
      .all(user.id),
  )
}

function addFavorite({ user, body }) {
  const algoKey = assertAlgoKey(body.algoKey)
  const exists = db
    .prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND algo_key = ?')
    .get(user.id, algoKey)
  if (exists) throw new HttpError(409, '该算法已经收藏过了')
  db.prepare('INSERT INTO favorites (user_id, algo_key, created_at) VALUES (?, ?, ?)').run(
    user.id,
    algoKey,
    now(),
  )
  return null
}

function removeFavorite({ user, params }) {
  const algoKey = assertAlgoKey(params.algoKey)
  // 取消收藏做成幂等：重复点不会弹错误
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND algo_key = ?').run(user.id, algoKey)
  return null
}

// ---------------------------------------------------------------------------
// 学习记录
// ---------------------------------------------------------------------------
function listHistory({ user }) {
  return plainAll(
    db
      .prepare(
        `SELECT algo_key, views, max_step, total_steps, updated_at
           FROM history WHERE user_id = ? ORDER BY updated_at DESC, algo_key`,
      )
      .all(user.id),
  )
}

function reportHistory({ user, body }) {
  const algoKey = assertAlgoKey(body.algoKey)
  const step = toInt(body.step, 'step', { min: 0, fallback: 0 })
  const totalSteps = toInt(body.totalSteps, 'totalSteps', { min: 0, fallback: 0 })
  db.prepare(
    `INSERT INTO history (user_id, algo_key, views, max_step, total_steps, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT (user_id, algo_key) DO UPDATE SET
       views       = views + 1,
       max_step    = MAX(max_step, excluded.max_step),
       total_steps = excluded.total_steps,
       updated_at  = excluded.updated_at`,
  ).run(user.id, algoKey, step, totalSteps, now())
  return null
}

// ---------------------------------------------------------------------------
// 公开：算法元数据（只给上架的）
// ---------------------------------------------------------------------------
function listAlgorithms() {
  return plainAll(
    db.prepare('SELECT * FROM algorithms WHERE online = 1 ORDER BY sort_order, id').all(),
  )
}

// ---------------------------------------------------------------------------
// 管理员：概览
// ---------------------------------------------------------------------------
function adminStats() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return {
    users: Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n),
    algorithms: Number(db.prepare('SELECT COUNT(*) AS n FROM algorithms').get().n),
    favorites: Number(db.prepare('SELECT COUNT(*) AS n FROM favorites').get().n),
    todayUsers: Number(
      db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?').get(start.getTime()).n,
    ),
  }
}

// ---------------------------------------------------------------------------
// 管理员：用户
// ---------------------------------------------------------------------------
function adminListUsers({ query }) {
  const q = String(query.get('q') ?? '').trim()
  const { page, size, offset } = paging(query)
  const where = q ? "WHERE username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\'" : ''
  const args = q ? [likeParam(q), likeParam(q)] : []

  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...args).n)
  const items = plainAll(
    db
      .prepare(
        `SELECT id, username, nickname, role, disabled, created_at FROM users ${where}
          ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(...args, size, offset),
  )
  return { items, total, page, size }
}

function adminUpdateUser({ params, body }) {
  const id = toInt(params.id, 'id', { min: 1 })
  const target = findUser(id)

  const patch = {}
  if (body.nickname !== undefined) patch.nickname = assertNickname(body.nickname)

  if (body.role !== undefined) {
    const role = String(body.role)
    if (role !== 'user' && role !== 'admin') throw new HttpError(400, '角色只能是 user 或 admin')
    patch.role = role
  }

  if (body.disabled !== undefined) patch.disabled = toBool01(body.disabled, 'disabled', 0)

  if (body.password !== undefined && body.password !== '') {
    const pwd = assertPassword(body.password)
    const salt = makeSalt()
    patch.password_hash = hashPassword(pwd, salt)
    patch.salt = salt
  }

  if (Object.keys(patch).length === 0) throw new HttpError(400, '没有需要修改的内容')

  // 不能把最后一个可用管理员降级或禁用（否则没人能进后台了）
  const isActiveAdmin = target.role === 'admin' && target.disabled === 0
  const leavesAdmin = (patch.role ?? target.role) !== 'admin' || (patch.disabled ?? target.disabled) === 1
  if (isActiveAdmin && leavesAdmin && activeAdminCount() <= 1) {
    throw new HttpError(400, '系统至少要保留一个可用的管理员，不能降级或禁用最后一个管理员')
  }

  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(patch), id)

  // 改密码 / 禁用之后，把这个人已登录的会话清掉
  if (patch.password_hash !== undefined || patch.disabled === 1) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
  }
  return findUser(id)
}

function adminDeleteUser({ params, user: actor }) {
  const id = toInt(params.id, 'id', { min: 1 })
  const target = findUser(id)

  if (id === Number(actor.id)) throw new HttpError(400, '不能删除自己的账号')
  if (target.role === 'admin' && target.disabled === 0 && activeAdminCount() <= 1) {
    throw new HttpError(400, '不能删除最后一个管理员')
  }

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM history WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return null
}

// ---------------------------------------------------------------------------
// 管理员：算法
// ---------------------------------------------------------------------------
const ALGO_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/

function assertAlgoKeyField(value) {
  const key = String(value ?? '').trim()
  if (!ALGO_KEY_RE.test(key)) {
    throw new HttpError(400, '算法标识只能包含字母、数字、下划线和中划线（1~64 位）')
  }
  return key
}

function assertAlgoName(value) {
  const name = String(value ?? '').trim()
  if (name.length < 1 || name.length > 40) throw new HttpError(400, '算法名称长度必须是 1~40 个字符')
  return name
}

function assertGrp(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const grp = String(value).trim()
  if (grp.length > 40) throw new HttpError(400, '子类名最多 40 个字符')
  return grp
}

function assertSummary(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const summary = String(value).trim()
  if (summary.length > 300) throw new HttpError(400, '简介最多 300 个字符')
  return summary
}

function adminListAlgorithms({ query }) {
  const q = String(query.get('q') ?? '').trim()
  const { page, size, offset } = paging(query)
  const where = q ? "WHERE algo_key LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'" : ''
  const args = q ? [likeParam(q), likeParam(q)] : []

  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM algorithms ${where}`).get(...args).n)
  const items = plainAll(
    db
      .prepare(`SELECT * FROM algorithms ${where} ORDER BY sort_order, id LIMIT ? OFFSET ?`)
      .all(...args, size, offset),
  )
  return { items, total, page, size }
}

function adminCreateAlgorithm({ body }) {
  const algoKey = assertAlgoKeyField(body.algo_key ?? body.algoKey)
  const name = assertAlgoName(body.name)
  const category = normalizeCategory(body.category)
  const grp = assertGrp(body.grp)
  const difficulty = toInt(body.difficulty, 'difficulty', { min: 1, max: 3, fallback: 2 })
  const summary = assertSummary(body.summary)
  const online = toBool01(body.online, 'online', 1)

  const dup = db.prepare('SELECT id FROM algorithms WHERE algo_key = ?').get(algoKey)
  if (dup) throw new HttpError(409, '该算法标识已存在')

  let sortOrder = body.sort_order ?? body.sortOrder
  if (sortOrder === undefined || sortOrder === null || sortOrder === '') {
    const max = db.prepare('SELECT MAX(sort_order) AS m FROM algorithms').get()
    sortOrder = (max.m === null ? -1 : Number(max.m)) + 1
  } else {
    sortOrder = toInt(sortOrder, 'sort_order', { min: 0 })
  }

  const info = db
    .prepare(
      `INSERT INTO algorithms (algo_key, name, category, grp, difficulty, summary, online, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(algoKey, name, category, grp, difficulty, summary, online, sortOrder)

  return findAlgorithm(info.lastInsertRowid)
}

function adminUpdateAlgorithm({ params, body }) {
  const id = toInt(params.id, 'id', { min: 1 })
  findAlgorithm(id) // 不存在直接 404

  const patch = {}
  if (body.algo_key !== undefined || body.algoKey !== undefined) {
    const algoKey = assertAlgoKeyField(body.algo_key ?? body.algoKey)
    const dup = db.prepare('SELECT id FROM algorithms WHERE algo_key = ? AND id <> ?').get(algoKey, id)
    if (dup) throw new HttpError(409, '该算法标识已存在')
    patch.algo_key = algoKey
  }
  if (body.name !== undefined) patch.name = assertAlgoName(body.name)
  if (body.category !== undefined) patch.category = normalizeCategory(body.category)
  if (body.grp !== undefined) patch.grp = assertGrp(body.grp)
  if (body.difficulty !== undefined) {
    patch.difficulty = toInt(body.difficulty, 'difficulty', { min: 1, max: 3 })
  }
  if (body.summary !== undefined) patch.summary = assertSummary(body.summary)
  if (body.online !== undefined) patch.online = toBool01(body.online, 'online', 1)
  if (body.sort_order !== undefined || body.sortOrder !== undefined) {
    patch.sort_order = toInt(body.sort_order ?? body.sortOrder, 'sort_order', { min: 0 })
  }

  if (Object.keys(patch).length === 0) throw new HttpError(400, '没有需要修改的内容')

  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE algorithms SET ${sets} WHERE id = ?`).run(...Object.values(patch), id)
  return findAlgorithm(id)
}

function adminDeleteAlgorithm({ params }) {
  const id = toInt(params.id, 'id', { min: 1 })
  const target = findAlgorithm(id)

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM favorites WHERE algo_key = ?').run(target.algo_key)
    db.prepare('DELETE FROM history WHERE algo_key = ?').run(target.algo_key)
    db.prepare('DELETE FROM algorithms WHERE id = ?').run(id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return null
}

// ---------------------------------------------------------------------------
// 路由表
//   path 用 :name 占位；auth = 需要登录；admin = 需要管理员
// ---------------------------------------------------------------------------
const ROUTES = [
  { method: 'POST', path: '/auth/register', handler: authRegister },
  { method: 'POST', path: '/auth/login', handler: authLogin },
  { method: 'POST', path: '/auth/logout', handler: authLogout, auth: true },
  { method: 'GET', path: '/auth/me', handler: authMe, auth: true },
  { method: 'PATCH', path: '/auth/me', handler: authUpdateMe, auth: true },

  { method: 'GET', path: '/favorites', handler: listFavorites, auth: true },
  { method: 'POST', path: '/favorites', handler: addFavorite, auth: true },
  { method: 'DELETE', path: '/favorites/:algoKey', handler: removeFavorite, auth: true },

  { method: 'GET', path: '/history', handler: listHistory, auth: true },
  { method: 'POST', path: '/history', handler: reportHistory, auth: true },

  { method: 'GET', path: '/algorithms', handler: listAlgorithms },

  { method: 'GET', path: '/admin/stats', handler: adminStats, auth: true, admin: true },
  { method: 'GET', path: '/admin/users', handler: adminListUsers, auth: true, admin: true },
  { method: 'PATCH', path: '/admin/users/:id', handler: adminUpdateUser, auth: true, admin: true },
  { method: 'DELETE', path: '/admin/users/:id', handler: adminDeleteUser, auth: true, admin: true },
  { method: 'GET', path: '/admin/algorithms', handler: adminListAlgorithms, auth: true, admin: true },
  { method: 'POST', path: '/admin/algorithms', handler: adminCreateAlgorithm, auth: true, admin: true },
  { method: 'PATCH', path: '/admin/algorithms/:id', handler: adminUpdateAlgorithm, auth: true, admin: true },
  { method: 'DELETE', path: '/admin/algorithms/:id', handler: adminDeleteAlgorithm, auth: true, admin: true },
]

/** 把 /favorites/a%2Fb 这种路径按段匹配，返回参数对象或 null */
function matchRoute(routePath, pathname) {
  const want = routePath.split('/').filter(Boolean)
  const got = pathname.split('/').filter(Boolean)
  if (want.length !== got.length) return null
  const params = {}
  for (let i = 0; i < want.length; i += 1) {
    const w = want[i]
    const g = got[i]
    if (w.startsWith(':')) {
      try {
        params[w.slice(1)] = decodeURIComponent(g)
      } catch {
        throw new HttpError(400, '请求路径里有非法字符')
      }
    } else if (w !== g) {
      return null
    }
  }
  return params
}

/** 读请求体（JSON）。空体 = {}；超长 / 非 JSON 都给中文错误 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new HttpError(413, '请求体太大了'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => reject(new HttpError(400, '读取请求内容失败')))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object') {
          reject(new HttpError(400, '请求体必须是一个 JSON 对象'))
          return
        }
        resolve(parsed)
      } catch {
        reject(new HttpError(400, '请求体不是合法的 JSON'))
      }
    })
  })
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

export function sendOk(res, data = null) {
  sendJson(res, 200, { ok: true, data })
}

export function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500
  const message = error instanceof HttpError ? error.message : '服务器内部错误'
  if (status >= 500) console.error('[api] 未处理的错误：', error)
  sendJson(res, status, { ok: false, error: message })
}

/**
 * 处理一个 /api 请求。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url 已经解析好的地址（pathname 已去掉 /api 前缀）
 */
export async function handleApi(req, res, url) {
  const path = url.pathname
  for (const route of ROUTES) {
    if (route.method !== req.method) continue
    const params = matchRoute(route.path, path)
    if (!params) continue

    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJsonBody(req)
    let user = null
    if (route.auth) {
      user = requireAuth(req)
      if (route.admin) requireAdmin(user)
    }
    const data = await route.handler({ req, res, params, query: url.searchParams, body, user })
    sendOk(res, data ?? null)
    return
  }
  throw new HttpError(404, '接口不存在')
}
