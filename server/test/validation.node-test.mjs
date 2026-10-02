/**
 * 后端自动化测试 · 参数校验与安全边界
 *
 * 覆盖：缺参数 / 类型不对 / 非法 JSON / 未知接口 / 目录穿越 / SQL 注入 / LIKE 通配符转义。
 *
 * 跑法：`npm run test:server`；其余说明见本目录 helpers.mjs 开头。
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

test('缺参数：返回 400 + 中文说明', async () => {
  const user = await ctx.register()

  const noAlgoKey = await ctx.api('POST', '/api/favorites', { token: user.token, body: {} })
  assert.equal(noAlgoKey.status, 400)
  assert.equal(noAlgoKey.error, '缺少算法标识 algoKey')

  const emptyAlgoKey = await ctx.api('POST', '/api/favorites', { token: user.token, body: { algoKey: '   ' } })
  assert.equal(emptyAlgoKey.status, 400)
  assert.equal(emptyAlgoKey.error, '缺少算法标识 algoKey')

  const noHistoryKey = await ctx.api('POST', '/api/history', { token: user.token, body: {} })
  assert.equal(noHistoryKey.status, 400)
  assert.equal(noHistoryKey.error, '缺少算法标识 algoKey')

  const emptyRegister = await ctx.api('POST', '/api/auth/register', { body: {} })
  assert.equal(emptyRegister.status, 400)
  assert.equal(emptyRegister.error, '用户名必须是 3~20 位的字母、数字或下划线')

  const emptyLogin = await ctx.api('POST', '/api/auth/login', { body: {} })
  assert.equal(emptyLogin.status, 400)
  assert.equal(emptyLogin.error, '请填写用户名和密码')
})

test('算法标识过长 → 400', async () => {
  const user = await ctx.register()
  const res = await ctx.api('POST', '/api/favorites', {
    token: user.token,
    body: { algoKey: 'k'.repeat(65) },
  })
  assert.equal(res.status, 400)
  assert.equal(res.error, '算法标识过长（最多 64 个字符）')
})

test('step / totalSteps 类型不对或为负数 → 400', async () => {
  const user = await ctx.register()
  const cases = [
    [{ step: 'abc', totalSteps: 10 }, '参数 step 必须是整数'],
    [{ step: 1.5, totalSteps: 10 }, '参数 step 必须是整数'],
    [{ step: -5, totalSteps: 10 }, '参数 step 超出允许范围'],
    [{ step: 3, totalSteps: 'x' }, '参数 totalSteps 必须是整数'],
    [{ step: 3, totalSteps: -1 }, '参数 totalSteps 超出允许范围'],
  ]
  for (const [body, message] of cases) {
    const res = await ctx.api('POST', '/api/history', {
      token: user.token,
      body: { algoKey: 'step-check', ...body },
    })
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应当被拒`)
    assert.equal(res.error, message, `${JSON.stringify(body)} 的提示文案不对`)
  }

  // 校验失败的请求不能落库
  const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM history WHERE user_id = ?').get(user.user.id)
  assert.equal(Number(rows.n), 0, '参数非法时一条记录都不该写进去')
})

test('分页参数非法 → 400', async () => {
  const cases = [
    ['page=abc', '参数 page 必须是整数'],
    ['page=0', '参数 page 超出允许范围'],
    ['size=0', '参数 size 超出允许范围'],
    ['size=101', '参数 size 超出允许范围'],
  ]
  for (const [query, message] of cases) {
    const res = await ctx.api('GET', `/api/admin/users?${query}`, { token: ctx.adminToken })
    assert.equal(res.status, 400, `?${query} 应当被拒`)
    assert.equal(res.error, message)
  }
})

test('请求体不是合法 JSON → 400', async () => {
  const res = await ctx.api('POST', '/api/auth/register', { rawBody: '{用户名: 没引号' })
  assert.equal(res.status, 400)
  assert.equal(res.error, '请求体不是合法的 JSON')
})

test('请求体是 JSON 但不是对象（数字 / 字符串）→ 400', async () => {
  const number = await ctx.api('POST', '/api/auth/login', { rawBody: '12345' })
  assert.equal(number.status, 400)
  assert.equal(number.error, '请求体必须是一个 JSON 对象')

  const text = await ctx.api('POST', '/api/auth/login', { rawBody: '"just a string"' })
  assert.equal(text.status, 400)
  assert.equal(text.error, '请求体必须是一个 JSON 对象')
})

test('请求体校验发生在认证之前（未登录 + 非法 JSON 得到的是 400）', async () => {
  const res = await ctx.api('POST', '/api/favorites', { rawBody: 'not json at all' })
  assert.equal(res.status, 400)
  assert.equal(res.error, '请求体不是合法的 JSON')
})

test('未知接口 → 404 “接口不存在”；路径对了但方法不对 → 也是 404', async () => {
  const unknown = await ctx.api('GET', '/api/not-a-real-endpoint')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.error, '接口不存在')

  const wrongMethod = await ctx.api('DELETE', '/api/algorithms', { token: ctx.adminToken })
  assert.equal(wrongMethod.status, 404)
  assert.equal(wrongMethod.error, '接口不存在')
})

test('静态资源只接受 GET / HEAD：用 POST 访问返回 405', async () => {
  const res = await ctx.api('POST', '/')
  assert.equal(res.status, 405)
  assert.equal(res.error, '该地址只支持 GET 请求')
})

test('目录穿越：读不到 dist/ 之外的任何文件', async () => {
  const attacks = [
    '/../package.json',
    '/..%2fpackage.json',
    '/%2e%2e/package.json',
    '/../server/data/app.db',
    '/..%2f..%2fpackage.json',
  ]
  for (const path of attacks) {
    const res = await ctx.rawRequest(path)
    assert.equal(res.status, 404, `${path} 必须 404，实际 ${res.status}`)
    assert.equal(
      /algo-visual-platform|devDependencies|SQLite format/.test(res.text),
      false,
      `${path} 把项目文件的内容吐出来了：${res.text.slice(0, 80)}`,
    )
  }

  // 对照组：正常的静态首页该给的还是要给（证明上面的 404 不是"静态服务整个坏了"）
  const root = await ctx.rawRequest('/')
  if (root.status === 200) {
    assert.match(root.text, /<html/i, '静态首页应当是 HTML')
  } else {
    assert.equal(root.status, 404, '没有 dist/ 时首页才是 404')
  }
})

test('SQL 注入尝试：登录不成功、也不报 500', async () => {
  const injections = [
    ["' OR 1=1 --", 'whatever'],
    ["admin'--", 'whatever'],
    ["admin' OR '1'='1", 'whatever'],
    ['admin', "' OR 1=1 --"],
    ['admin', "' OR '1'='1' --"],
    ['"; DROP TABLE users; --', 'whatever'],
  ]
  for (const [username, password] of injections) {
    const res = await ctx.api('POST', '/api/auth/login', { body: { username, password } })
    assert.equal(res.status, 401, `注入 ${JSON.stringify(username)} 不能登录成功（实际 ${res.status}）`)
    assert.equal(res.error, '用户名或密码错误')
  }

  // 注入字符串当用户名注册：非法字符直接 400
  const register = await ctx.api('POST', '/api/auth/register', {
    body: { username: "' OR 1=1 --", nickname: '注入', password: 'pass123' },
  })
  assert.equal(register.status, 400)
  assert.equal(register.error, '用户名必须是 3~20 位的字母、数字或下划线')

  // 公告表没被 DROP 掉：管理员还能正常读到用户列表
  const users = await ctx.api('GET', '/api/admin/users', { token: ctx.adminToken })
  assert.equal(users.status, 200)
  assert.ok(users.data.total >= 1, 'users 表还活着')
})

test('LIKE 通配符已转义：搜索 "%" 不会匹配到所有人', async () => {
  const users = await ctx.api('GET', `/api/admin/users?q=${encodeURIComponent('%')}`, { token: ctx.adminToken })
  assert.equal(users.status, 200)
  assert.equal(users.data.total, 0, '% 必须当字面量，不能变成"匹配所有人"')

  const algorithms = await ctx.api('GET', `/api/admin/algorithms?q=${encodeURIComponent('%')}`, {
    token: ctx.adminToken,
  })
  assert.equal(algorithms.status, 200)
  assert.equal(algorithms.data.total, 0, '算法搜索里的 % 同样要转义')

  // 下划线同理：只匹配名字里真的有下划线的人，不能变成"任意一个字符"
  const plainUsername = `zzplain${uniqueName('').replace(/_/g, '')}`
  const plain = await ctx.api('POST', '/api/auth/register', {
    body: { username: plainUsername, nickname: '没有下划线', password: 'pass123' },
  })
  assert.equal(plain.status, 200)

  const underscore = await ctx.api('GET', '/api/admin/users?q=_', { token: ctx.adminToken })
  assert.equal(underscore.status, 200)
  assert.ok(underscore.data.items.length > 0, '确实有带下划线的用户名')
  for (const item of underscore.data.items) {
    assert.ok(
      item.username.includes('_') || item.nickname.includes('_'),
      `${item.username} 里没有下划线，不该被搜出来`,
    )
  }
  assert.equal(
    underscore.data.items.some((u) => u.username === plainUsername),
    false,
    '不含下划线的用户不能被 _ 搜出来',
  )

  // 直接按用户名精确搜索还能用（证明搜索功能本身没坏）
  const byName = await ctx.api('GET', `/api/admin/users?q=${plainUsername}`, { token: ctx.adminToken })
  assert.equal(byName.data.total, 1)
  assert.equal(byName.data.items[0].username, plainUsername)
})
