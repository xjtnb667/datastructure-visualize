/**
 * 后端测试公共工具：起一个**完全隔离**的测试服务器。
 *
 * 隔离手段：
 * 1. 数据库用 `os.tmpdir()` 下的临时文件（通过环境变量 `DB_PATH` 指定），
 *    **绝不会碰 `server/data/app.db`**；`close()` 时连库带目录一起删掉。
 * 2. 端口用 `listen(0)` 让系统随机分配，**不会和正在跑的 3000 撞车**，
 *    也允许 node --test 并行跑多个测试文件。
 * 3. 每个测试文件都在自己的进程里（node --test 默认行为），所以每个文件一个库；
 *    文件内部的用例靠"各自用不重名的账号 / 各自准备数据"保证互不影响。
 *
 * ⚠️ 顺序很重要：`server/db.mjs` 在 import 时就把数据库打开了，
 * 所以必须先设 `process.env.DB_PATH`，再 `await import('../index.mjs')`。
 *
 * ⚠️ 文件名后缀是 `.node-test.mjs`，不是 `.test.mjs`，这是故意的：
 * 前端测试跑的是 vitest，它默认把项目里任何 `*.test.mjs` 都当成自己的用例收集，
 * 而这里是 node:test 的用例 —— 用 `.test.mjs` 会让 `vitest run` 直接报
 * "No test suite found in file …" 而失败。改成 `-test.mjs` 之后：
 *   vitest 收不到它（前端 704 项照旧），node --test 收得到（后端用例照跑）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 用例里造不重名的用户名用（3~20 位字母数字下划线，这里生成的都在 12 位以内） */
let nameSeq = 0
export function uniqueName(prefix = 'u') {
  nameSeq += 1
  return `${prefix}${nameSeq}_${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 起一个测试服务器。
 * @returns {Promise<{ app: object, db: any, port: number, url: string, dir: string, dbPath: string,
 *   api: Function, rawRequest: Function, register: Function, login: Function, createAdmin: Function,
 *   adminToken: string, close: () => Promise<void> }>}
 */
export async function startTestServer() {
  const dir = mkdtempSync(join(tmpdir(), 'algo-server-test-'))
  const dbPath = join(dir, 'test.db')
  process.env.DB_PATH = dbPath
  process.env.SERVER_API_LOG = '0' // 关掉"每请求一行"的日志，测试输出才干净

  const [{ startServer }, dbModule] = await Promise.all([
    import('../index.mjs'),
    import('../db.mjs'),
  ])

  // 保险丝：万一有人用 --experimental-test-isolation=none 跑，模块被缓存复用，
  // 这里会立刻炸掉，而不是"悄悄连上真实数据库"。
  if (dbModule.DB_PATH !== dbPath) {
    throw new Error(`测试数据库没有隔离成功：期望 ${dbPath}，实际连的是 ${dbModule.DB_PATH}`)
  }

  const app = await startServer({ port: 0, host: '127.0.0.1', dbPath })

  /**
   * 发一个 API 请求（走真实 HTTP，和前端请求完全一样的路径）。
   * @param {string} method GET / POST / PATCH / DELETE
   * @param {string} path 形如 `/api/auth/login`
   * @param {{ token?: string, body?: unknown, rawBody?: string }} [options]
   */
  async function api(method, path, { token, body, rawBody } = {}) {
    const headers = {}
    let payload
    if (rawBody !== undefined) {
      payload = rawBody
      headers['Content-Type'] = 'application/json'
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['Content-Type'] = 'application/json'
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const res = await fetch(`${app.url}${path}`, { method, headers, body: payload })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      // 静态文件 / 纯文本响应（比如 404 Not Found）不是 JSON，保持 null
    }
    return {
      status: res.status,
      ok: json?.ok,
      data: json?.data ?? null,
      error: json?.error,
      json,
      text,
    }
  }

  /** 绕过 fetch 的地址规范化，按原样把 path 发出去（测目录穿越要用） */
  function rawRequest(path, { method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: app.port, path, method }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** 注册一个用户（默认随机用户名），返回 { username, password, nickname, user, token } */
  async function register({ username = uniqueName(), password = 'pass123', nickname = '测试用户' } = {}) {
    const reg = await api('POST', '/api/auth/register', { body: { username, nickname, password } })
    if (reg.status !== 200) throw new Error(`注册测试账号失败（${reg.status}）：${reg.error}`)
    const logged = await login(username, password)
    return { username, password, nickname, user: reg.data, token: logged.token }
  }

  /** 登录，返回 { token, user } */
  async function login(username, password = 'pass123') {
    const res = await api('POST', '/api/auth/login', { body: { username, password } })
    if (res.status !== 200) throw new Error(`登录测试账号失败（${res.status}）：${res.error}`)
    return { token: res.data.token, user: res.data.user }
  }

  /** 注册一个普通用户再用管理员令牌把它提成管理员，返回带 AdminToken 的账号 */
  async function createAdmin(operatorToken, { username = uniqueName('adm'), password = 'pass123' } = {}) {
    const account = await register({ username, password, nickname: '测试管理员' })
    const res = await api('PATCH', `/api/admin/users/${account.user.id}`, {
      token: operatorToken,
      body: { role: 'admin' },
    })
    if (res.status !== 200) throw new Error(`提权失败（${res.status}）：${res.error}`)
    return { ...account, user: res.data }
  }

  // 种子管理员 admin / （已移除的旧口令） 由 ensureAdminSeed() 自动创建，直接登录拿来用
  const { token: adminToken } = await login('admin', '（已移除的旧口令）')

  async function close() {
    app.server.closeIdleConnections?.()
    await app.close()
    try {
      app.db.close()
    } catch {
      // 已经关过了就算了
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }

  return {
    app,
    db: app.db,
    port: app.port,
    url: app.url,
    dir,
    dbPath,
    api,
    rawRequest,
    register,
    login,
    createAdmin,
    adminToken,
    close,
  }
}
