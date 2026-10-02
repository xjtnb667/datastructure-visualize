/**
 * 后端自动化测试 · 认证（注册 / 登录 / 令牌 / 退出）
 *
 * 跑法：`npm run test:server`，等价于 `node --test "server/test/*.node-test.mjs"`
 * （文件名为什么是 `-test.mjs` 而不是 `.test.mjs`，见 helpers.mjs 开头的说明）
 * 用的是一次性的临时数据库和随机端口，不会碰 server/data/app.db，也不占 3000 端口。
 */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { startTestServer, uniqueName } from './helpers.mjs'

let ctx
before(async () => {
  ctx = await startTestServer()
})
after(async () => {
  await ctx.close()
})

/** 给前端的用户对象**只能有**这几个字段（password_hash / salt 绝不能出现） */
const PUBLIC_USER_KEYS = ['created_at', 'disabled', 'id', 'nickname', 'role', 'username']

test('注册成功：返回的用户对象只有 6 个公开字段，没有 password_hash / salt', async () => {
  const username = uniqueName('reg')
  const res = await ctx.api('POST', '/api/auth/register', {
    body: { username, nickname: '注册测试', password: 'pass123' },
  })

  assert.equal(res.status, 200)
  assert.equal(res.ok, true)
  assert.deepEqual(Object.keys(res.data).sort(), PUBLIC_USER_KEYS, '返回字段多一个少一个都不行')
  assert.equal(res.data.username, username)
  assert.equal(res.data.nickname, '注册测试')
  assert.equal(res.data.role, 'user', '新注册的一律是普通用户')
  assert.equal(res.data.disabled, 0)
  assert.equal(typeof res.data.id, 'number')
  assert.equal(typeof res.data.created_at, 'number')
  assert.equal('password_hash' in res.data, false, '密码哈希不能漏给前端')
  assert.equal('salt' in res.data, false, '盐也不能漏给前端')

  // 库里存的必须不是明文密码
  const row = ctx.db.prepare('SELECT password_hash, salt FROM users WHERE username = ?').get(username)
  assert.notEqual(row.password_hash, 'pass123')
  assert.equal(row.password_hash.length, 128, 'scrypt 64 字节 → 128 位十六进制')
  assert.equal(row.salt.length, 32, '16 字节随机盐 → 32 位十六进制')
})

test('用户名重复：返回 409 和中文说明', async () => {
  const username = uniqueName('dup')
  const first = await ctx.api('POST', '/api/auth/register', {
    body: { username, nickname: '第一个', password: 'pass123' },
  })
  assert.equal(first.status, 200)

  const second = await ctx.api('POST', '/api/auth/register', {
    body: { username, nickname: '第二个', password: 'pass456' },
  })
  assert.equal(second.status, 409)
  assert.equal(second.ok, false)
  assert.equal(second.error, '该用户名已被注册')
})

test('用户名非法（太短 / 带中文 / 带空格 / 超长）：一律 400', async () => {
  const cases = ['ab', '张三', 'a b', 'x'.repeat(21), 'user@name']
  for (const username of cases) {
    const res = await ctx.api('POST', '/api/auth/register', {
      body: { username, nickname: '合法昵称', password: 'pass123' },
    })
    assert.equal(res.status, 400, `用户名 ${JSON.stringify(username)} 应该被拒`)
    assert.equal(res.error, '用户名必须是 3~20 位的字母、数字或下划线')
  }
})

test('密码太短（<6 位）返回 400，边界 6 位可以通过', async () => {
  const short = await ctx.api('POST', '/api/auth/register', {
    body: { username: uniqueName('pw'), nickname: '昵称', password: '12345' },
  })
  assert.equal(short.status, 400)
  assert.equal(short.error, '密码长度至少 6 位')

  const ok = await ctx.api('POST', '/api/auth/register', {
    body: { username: uniqueName('pw'), nickname: '昵称', password: '123456' },
  })
  assert.equal(ok.status, 200, '刚好 6 位应当放行')

  const tooLong = await ctx.api('POST', '/api/auth/register', {
    body: { username: uniqueName('pw'), nickname: '昵称', password: 'a'.repeat(65) },
  })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.error, '密码长度不能超过 64 位')
})

test('昵称超长（21 字）/ 空昵称返回 400', async () => {
  const tooLong = await ctx.api('POST', '/api/auth/register', {
    body: { username: uniqueName('nick'), nickname: '昵'.repeat(21), password: 'pass123' },
  })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.error, '昵称长度必须是 1~20 个字符')

  const empty = await ctx.api('POST', '/api/auth/register', {
    body: { username: uniqueName('nick'), nickname: '   ', password: 'pass123' },
  })
  assert.equal(empty.status, 400)
  assert.equal(empty.error, '昵称长度必须是 1~20 个字符')
})

test('登录成功：拿到 64 位十六进制令牌，用户对象同样不含密码哈希', async () => {
  const account = await ctx.register({ nickname: '登录测试' })
  const res = await ctx.api('POST', '/api/auth/login', {
    body: { username: account.username, password: account.password },
  })

  assert.equal(res.status, 200)
  assert.match(res.data.token, /^[0-9a-f]{64}$/, '32 字节随机 → 64 位十六进制')
  assert.deepEqual(Object.keys(res.data.user).sort(), PUBLIC_USER_KEYS)
  assert.equal(res.data.user.username, account.username)

  const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token = ?').get(res.data.token)
  assert.equal(Number(row.n), 1, '登录应当在 sessions 表里落一行')
})

test('密码错误 / 用户名不存在：都是 401 同一句文案（不泄露账号是否存在）', async () => {
  const account = await ctx.register()

  const wrongPassword = await ctx.api('POST', '/api/auth/login', {
    body: { username: account.username, password: 'wrong-pass' },
  })
  assert.equal(wrongPassword.status, 401)
  assert.equal(wrongPassword.error, '用户名或密码错误')

  const noSuchUser = await ctx.api('POST', '/api/auth/login', {
    body: { username: uniqueName('ghost'), password: 'pass123' },
  })
  assert.equal(noSuchUser.status, 401)
  assert.equal(noSuchUser.error, '用户名或密码错误', '两种情况文案必须一模一样')
})

test('被禁用的账号：登录返回 403，没退出的旧令牌也立刻失效', async () => {
  const account = await ctx.register()
  const before = await ctx.api('GET', '/api/auth/me', { token: account.token })
  assert.equal(before.status, 200, '禁用之前令牌是好用的')

  const disabled = await ctx.api('PATCH', `/api/admin/users/${account.user.id}`, {
    token: ctx.adminToken,
    body: { disabled: 1 },
  })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.data.disabled, 1)

  const loginAgain = await ctx.api('POST', '/api/auth/login', {
    body: { username: account.username, password: account.password },
  })
  assert.equal(loginAgain.status, 403)
  assert.equal(loginAgain.error, '该账号已被禁用，请联系管理员')

  // 禁用时会顺手把这个人的会话删掉，所以旧令牌不是 403 而是"查不到这个会话"的 401
  const staleToken = await ctx.api('GET', '/api/auth/me', { token: account.token })
  assert.equal(staleToken.status, 401)
  assert.equal(staleToken.error, '登录状态已失效，请重新登录')
  const sessionRows = ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(account.user.id)
  assert.equal(Number(sessionRows.n), 0, '禁用应当把他所有会话清掉')
})

test('令牌可用：me 返回自己的信息；未登录 / 乱写的令牌都是 401', async () => {
  const account = await ctx.register({ nickname: '我是谁' })
  const me = await ctx.api('GET', '/api/auth/me', { token: account.token })
  assert.equal(me.status, 200)
  assert.equal(me.data.username, account.username)
  assert.equal(me.data.nickname, '我是谁')
  assert.deepEqual(Object.keys(me.data).sort(), PUBLIC_USER_KEYS)

  const noToken = await ctx.api('GET', '/api/auth/me')
  assert.equal(noToken.status, 401)
  assert.equal(noToken.error, '请先登录')

  const garbage = await ctx.api('GET', '/api/auth/me', { token: 'not-a-real-token' })
  assert.equal(garbage.status, 401)
  assert.equal(garbage.error, '登录状态已失效，请重新登录')

  // 格式对但没发过的令牌（64 位 hex）也一样
  const fake = await ctx.api('GET', '/api/auth/me', { token: 'f'.repeat(64) })
  assert.equal(fake.status, 401)
  assert.equal(fake.error, '登录状态已失效，请重新登录')
})

test('过期的令牌返回 401（直接改库里的 expires_at 造过期）', async () => {
  const account = await ctx.register()
  assert.equal((await ctx.api('GET', '/api/auth/me', { token: account.token })).status, 200)

  ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(0, account.token)

  const res = await ctx.api('GET', '/api/auth/me', { token: account.token })
  assert.equal(res.status, 401)
  assert.equal(res.error, '登录状态已失效，请重新登录')
})

test('退出登录后原令牌立刻失效', async () => {
  const account = await ctx.register()

  const logout = await ctx.api('POST', '/api/auth/logout', { token: account.token, body: {} })
  assert.equal(logout.status, 200)
  assert.equal(logout.ok, true)

  const after = await ctx.api('GET', '/api/auth/me', { token: account.token })
  assert.equal(after.status, 401)
  assert.equal(after.error, '登录状态已失效，请重新登录')
})
