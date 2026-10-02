/**
 * 后端自动化测试 · `users.avatar` 的**表结构升级**（老库升级不丢数据）
 *
 * 跑法：`npm run test:server`。
 *
 * 这个文件跟别的用例不一样：它不能用 `helpers.mjs` 的 `startTestServer()`
 * （那是"从零建库"），而要**自己动手造一个"老版本的库"** ——
 * users 表结构里没有 avatar 列、并且已经装了真实数据 ——
 * 再让 `server/db.mjs` 去打开它，模拟"用户手上那个已经在用的 app.db 升到新版本"。
 *
 * 要证明的三件事：
 *   ① 老库打开后，avatar 列被自动补上（`PRAGMA table_info` 里能看到）；
 *   ② 老库里的用户 / 收藏 / 学习记录 / 算法元数据**一条没少、值也没变**
 *      （尤其是算法：老库里已有元数据时，**绝不能**再灌一遍种子把管理员改过的行覆盖掉；
 *      但**缺的种子要补齐** —— 见下面《老库升级顺带补齐缺的种子》那条，动态规划就是这么进来的）；
 *   ③ 升级是幂等的：再跑一次什么都不做、也不报错。
 *
 * ⚠️ `server/db.mjs` 在 import 时就把库打开，所以 `DB_PATH` 必须在 `await import()` 之前设好。
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { scryptSync } from 'node:crypto'

const LEGACY_SALT = '0123456789abcdef0123456789abcdef'
const LEGACY_PASSWORD = 'legacy123'

const dir = mkdtempSync(join(tmpdir(), 'algo-avatar-migrate-'))
const dbPath = join(dir, 'legacy-app.db')

// ---------------------------------------------------------------------------
// 造一个"上个版本"的库：users 表**没有 avatar 列**，而且里面已经有数据
// ---------------------------------------------------------------------------
{
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      nickname      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt          TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      disabled      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE algorithms (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      algo_key   TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL,
      grp        TEXT,
      difficulty INTEGER NOT NULL DEFAULT 2,
      summary    TEXT,
      online     INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE favorites (
      user_id    INTEGER NOT NULL,
      algo_key   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, algo_key)
    );

    CREATE TABLE history (
      user_id      INTEGER NOT NULL,
      algo_key     TEXT NOT NULL,
      views        INTEGER NOT NULL DEFAULT 0,
      max_step     INTEGER NOT NULL DEFAULT 0,
      total_steps  INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (user_id, algo_key)
    );
  `)

  const hash = scryptSync(LEGACY_PASSWORD, LEGACY_SALT, 64).toString('hex')
  legacy
    .prepare(
      `INSERT INTO users (username, nickname, password_hash, salt, role, disabled, created_at)
       VALUES (?, ?, ?, ?, 'user', 0, ?)`,
    )
    .run('legacy_user', '老用户', hash, LEGACY_SALT, 1700000000000)
  legacy
    .prepare(
      `INSERT INTO users (username, nickname, password_hash, salt, role, disabled, created_at)
       VALUES (?, ?, ?, ?, 'admin', 0, ?)`,
    )
    .run('legacy_admin', '老管理员', hash, LEGACY_SALT, 1700000000001)

  // 老库里已经有算法元数据（模拟"管理员在后台改过"）——
  // 升级时**不能**覆盖这三条（名字 / 难度 / 简介 / 下架状态都要留着），
  // 但种子里**缺的那些**要补齐（见下面《老库升级顺带补齐缺的种子》那条用例）。
  const insertAlgo = legacy.prepare(
    `INSERT INTO algorithms (algo_key, name, category, grp, difficulty, summary, online, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertAlgo.run('bubble-sort', '冒泡排序（我改过的名字）', 'sort', '交换类排序', 1, '改过的简介', 1, 0)
  insertAlgo.run('quick-sort', '快速排序', 'sort', '交换类排序', 3, '原来的简介', 1, 1)
  insertAlgo.run('retired-algo', '已下架的算法', 'sort', '交换类排序', 2, null, 0, 2)

  legacy
    .prepare('INSERT INTO favorites (user_id, algo_key, created_at) VALUES (1, ?, ?)')
    .run('bubble-sort', 1700000001000)
  legacy
    .prepare(
      `INSERT INTO history (user_id, algo_key, views, max_step, total_steps, updated_at)
       VALUES (1, ?, 7, 12, 20, ?)`,
    )
    .run('bubble-sort', 1700000002000)
  legacy.close()
}

// 先建好老库，再让 db.mjs 打开它（顺序不能反）
process.env.DB_PATH = dbPath
process.env.SERVER_API_LOG = '0'

const dbModule = await import('../db.mjs')
const { db, DB_PATH, ensureColumn, addedAvatarColumn } = dbModule

/** 收尾：关掉临时库、连目录一起删（绝不碰 server/data/app.db） */
after(() => {
  try {
    db.close()
  } catch {
    // 已经关过了就算了
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** 老库升级前的快照（用来跟升级后逐项比对） */
const BEFORE = {
  users: 2,
  /**
   * 算法条数：老库自己那 3 条（bubble-sort / quick-sort / retired-algo）
   * + 种子 101 条里**缺的那些**。
   * `bubble-sort` 正好是种子里的 algo_key，所以它算"已存在、不重复插"——
   * 于是补进来 101 - 1 = 100 条，合计 3 + 100 = 103 条。
   */
  algorithms: 103,
  insertedAlgorithms: 100,
  favorites: 1,
  history: 1,
  bubbleName: '冒泡排序（我改过的名字）',
}

test('老库升级：users 表被补上 avatar 列，一行数据都不用重建', () => {
  assert.equal(DB_PATH, dbPath, '测试必须跑在临时库上')

  const columns = db
    .prepare('PRAGMA table_info(users)')
    .all()
    .map((c) => c.name)
  assert.ok(columns.includes('avatar'), `升级后 users 表应当有 avatar 列，实际是：${columns.join(', ')}`)

  // 升级前的那些列一个都不能少（ALTER TABLE ADD COLUMN 是"加一列"，不是"改表结构"）
  for (const col of [
    'id',
    'username',
    'nickname',
    'password_hash',
    'salt',
    'role',
    'disabled',
    'created_at',
  ]) {
    assert.ok(columns.includes(col), `原有列 ${col} 不能丢`)
  }

  assert.equal(addedAvatarColumn, true, '这个库原本没有 avatar 列，本次启动应当补上它')
})

test('升级不丢数据：用户 / 收藏 / 学习记录 / 算法元数据原有的那些都还是原来的样子', () => {
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)

  assert.equal(count('users'), BEFORE.users, '用户数不能变')
  assert.equal(
    count('algorithms'),
    BEFORE.algorithms,
    '算法 = 老库原有 3 条 + 补进来的 100 条缺项（种子 101 条里 bubble-sort 已在老库，不重复插）',
  )
  assert.equal(count('favorites'), BEFORE.favorites, '收藏数不能变')
  assert.equal(count('history'), BEFORE.history, '学习记录数不能变')

  // 老数据的具体值也要一字不差
  const user = db.prepare('SELECT * FROM users WHERE id = 1').get()
  assert.equal(user.username, 'legacy_user')
  assert.equal(user.nickname, '老用户')
  assert.equal(user.created_at, 1700000000000)
  assert.equal(user.password_hash, scryptSync(LEGACY_PASSWORD, LEGACY_SALT, 64).toString('hex'), '密码哈希没被动过')
  assert.equal(user.avatar, null, '升级上来的老用户：avatar 是 NULL（界面显示昵称首字）')

  const algo = db.prepare('SELECT * FROM algorithms WHERE algo_key = ?').get('bubble-sort')
  assert.equal(algo.name, BEFORE.bubbleName, '后台改过的算法名字不能被种子覆盖回去')
  assert.equal(algo.difficulty, 1)
  assert.equal(algo.summary, '改过的简介')

  const retired = db.prepare('SELECT online FROM algorithms WHERE algo_key = ?').get('retired-algo')
  assert.equal(Number(retired.online), 0, '下架状态也要留着')
})

test('老库升级顺带补齐缺的种子：动态规划那 3 条进来了，顺序仍和前端注册表一致', async () => {
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)

  // 补进来的条数 = 种子里老库没有的那些（101 - bubble-sort 这 1 条）
  assert.equal(dbModule.seededAlgorithms, BEFORE.insertedAlgorithms, '这次启动应当补进来 100 条')

  // 老库原有那 3 条一条没少（名字 / 下架状态见上一条用例）
  for (const key of ['bubble-sort', 'quick-sort', 'retired-algo']) {
    assert.ok(db.prepare('SELECT id FROM algorithms WHERE algo_key = ?').get(key), `${key} 不能被删掉`)
  }

  // 动态规划：algo_key / 大类 / 子类都照前端注册表（dp.ts）
  const dp = db
    .prepare("SELECT algo_key, category, grp, sort_order FROM algorithms WHERE category = 'dp' ORDER BY sort_order")
    .all()
  assert.deepEqual(
    dp.map((r) => r.algo_key),
    ['dp-knapsack', 'dp-lcs', 'dp-edit-distance'],
  )
  assert.deepEqual(
    dp.map((r) => r.grp),
    ['背包问题', '双串模型', '双串模型'],
  )

  // sort_order 必须落在「图」和「查找」之间 —— 前端注册表里 dp 就插在这两段中间
  const maxGraph = Number(
    db.prepare("SELECT MAX(sort_order) AS m FROM algorithms WHERE category = 'graph'").get().m,
  )
  const minSearch = Number(
    db.prepare("SELECT MIN(sort_order) AS m FROM algorithms WHERE category = 'search'").get().m,
  )
  for (const row of dp) {
    assert.ok(Number(row.sort_order) > maxGraph, `${row.algo_key} 应当排在"图"之后`)
    assert.ok(Number(row.sort_order) < minSearch, `${row.algo_key} 应当排在"查找"之前`)
  }

  // 幂等：把库再打开一次（等价于"后端又启动了一次"），不会再插一遍
  const again = await import('../db.mjs?second-boot')
  try {
    assert.equal(again.seededAlgorithms, 0, '第二次启动不该再插入任何种子')
    assert.equal(count('algorithms'), BEFORE.algorithms, '第二次启动也没多出行来')
  } finally {
    again.db.close()
  }
})

test('升级是幂等的：再跑一次 ensureColumn 返回 false、不抛错（重复启动安全）', () => {
  assert.equal(ensureColumn('users', 'avatar', 'TEXT'), false, '已经有的列不该再加一次')
  assert.equal(ensureColumn('users', 'avatar', 'TEXT'), false)

  const columns = db
    .prepare('PRAGMA table_info(users)')
    .all()
    .filter((c) => c.name === 'avatar')
  assert.equal(columns.length, 1, '不能出现两个 avatar 列')
})

test('升级后的老库照常能用：老用户能登录、能设头像，收藏和记录还在', async () => {
  const { startServer } = await import('../index.mjs')
  const app = await startServer({ port: 0, host: '127.0.0.1', dbPath })

  async function api(method, path, { token, body } = {}) {
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    return { status: res.status, data: json?.data ?? null, error: json?.error }
  }

  try {
    const login = await api('POST', '/api/auth/login', {
      body: { username: 'legacy_user', password: LEGACY_PASSWORD },
    })
    assert.equal(login.status, 200, '老用户的密码必须还是好用的')
    assert.equal(login.data.user.avatar, null)
    const token = login.data.token

    const avatar = `data:image/png;base64,${'C'.repeat(48)}`
    const set = await api('PATCH', '/api/auth/me', { token, body: { avatar } })
    assert.equal(set.status, 200)
    assert.equal(set.data.avatar, avatar)
    assert.equal(set.data.nickname, '老用户', '老昵称还在')

    const favorites = await api('GET', '/api/favorites', { token })
    assert.deepEqual(
      favorites.data.map((f) => f.algo_key),
      ['bubble-sort'],
      '升级前的收藏还在',
    )

    const history = await api('GET', '/api/history', { token })
    assert.equal(history.data.length, 1)
    assert.equal(history.data[0].views, 7, '升级前的学习记录还在')
    assert.equal(history.data[0].max_step, 12)
  } finally {
    app.server.closeIdleConnections?.()
    await app.close()
    // 注意：不要在这里 close 数据库 —— 上面那几条断言还要用它，收尾统一交给 after()
  }
})

test('临时库确实在 %TEMP% 下，绝不落在 server/data 里', () => {
  assert.ok(dbPath.includes(tmpdir()), '临时库必须在 %TEMP% 下')
  assert.ok(!dbPath.includes(join('server', 'data')), '临时库不能落在 server/data 里')
})
