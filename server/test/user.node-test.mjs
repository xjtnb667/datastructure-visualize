/**
 * 后端自动化测试 · 用户功能（收藏 / 学习记录 / 改自己的资料）
 *
 * 跑法：`npm run test:server`；其余说明见本目录 helpers.mjs 开头。
 */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { startTestServer } from './helpers.mjs'

let ctx
before(async () => {
  ctx = await startTestServer()
})
after(async () => {
  await ctx.close()
})

test('收藏新增成功：列表里能看到，字段是 algo_key / created_at', async () => {
  const user = await ctx.register({ nickname: '收藏用户' })

  const empty = await ctx.api('GET', '/api/favorites', { token: user.token })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.data, [], '新用户的收藏是空列表')

  const added = await ctx.api('POST', '/api/favorites', { token: user.token, body: { algoKey: 'bubble-sort' } })
  assert.equal(added.status, 200)
  assert.equal(added.ok, true)

  const list = await ctx.api('GET', '/api/favorites', { token: user.token })
  assert.equal(list.data.length, 1)
  assert.equal(list.data[0].algo_key, 'bubble-sort')
  assert.equal(typeof list.data[0].created_at, 'number')
  assert.deepEqual(Object.keys(list.data[0]).sort(), ['algo_key', 'created_at'])
})

test('重复收藏同一算法：返回 409 + 中文说明', async () => {
  const user = await ctx.register()
  const body = { algoKey: 'quick-sort' }

  assert.equal((await ctx.api('POST', '/api/favorites', { token: user.token, body })).status, 200)
  const again = await ctx.api('POST', '/api/favorites', { token: user.token, body })
  assert.equal(again.status, 409)
  assert.equal(again.error, '该算法已经收藏过了')

  const list = await ctx.api('GET', '/api/favorites', { token: user.token })
  assert.equal(list.data.length, 1, '重复收藏不能插出第二条')
})

test('取消收藏是幂等的：取消不存在的收藏也不报错', async () => {
  const user = await ctx.register()
  await ctx.api('POST', '/api/favorites', { token: user.token, body: { algoKey: 'merge-sort' } })

  const first = await ctx.api('DELETE', '/api/favorites/merge-sort', { token: user.token })
  assert.equal(first.status, 200)
  assert.equal(first.ok, true)

  const second = await ctx.api('DELETE', '/api/favorites/merge-sort', { token: user.token })
  assert.equal(second.status, 200, '再取消一次不能报错')

  const neverFavorited = await ctx.api('DELETE', '/api/favorites/never-favorited-algo', { token: user.token })
  assert.equal(neverFavorited.status, 200, '取消一个从没收藏过的也不报错')

  const list = await ctx.api('GET', '/api/favorites', { token: user.token })
  assert.deepEqual(list.data, [])
})

test('收藏列表：多条记录都按 algo_key 正确返回，取消其中一条不影响其它', async () => {
  const user = await ctx.register()
  for (const key of ['heap-sort', 'shell-sort', 'radix-sort']) {
    assert.equal((await ctx.api('POST', '/api/favorites', { token: user.token, body: { algoKey: key } })).status, 200)
  }

  let list = await ctx.api('GET', '/api/favorites', { token: user.token })
  assert.deepEqual(list.data.map((f) => f.algo_key).sort(), ['heap-sort', 'radix-sort', 'shell-sort'])

  await ctx.api('DELETE', '/api/favorites/shell-sort', { token: user.token })
  list = await ctx.api('GET', '/api/favorites', { token: user.token })
  assert.deepEqual(list.data.map((f) => f.algo_key).sort(), ['heap-sort', 'radix-sort'])
})

test('学习记录：views 累加、max_step 取最大值、total_steps 记最后一次', async () => {
  const user = await ctx.register()
  const algoKey = 'insertion-sort'

  const first = await ctx.api('POST', '/api/history', {
    token: user.token,
    body: { algoKey, step: 3, totalSteps: 10 },
  })
  assert.equal(first.status, 200)

  let list = await ctx.api('GET', '/api/history', { token: user.token })
  assert.equal(list.data.length, 1)
  assert.equal(list.data[0].algo_key, algoKey)
  assert.equal(list.data[0].views, 1, '第一次上报 views = 1')
  assert.equal(list.data[0].max_step, 3)
  assert.equal(list.data[0].total_steps, 10)
  assert.equal(typeof list.data[0].updated_at, 'number')
  assert.deepEqual(Object.keys(list.data[0]).sort(), [
    'algo_key',
    'max_step',
    'total_steps',
    'updated_at',
    'views',
  ])

  // 第二次：步数更大 → max_step 跟上
  await ctx.api('POST', '/api/history', { token: user.token, body: { algoKey, step: 5, totalSteps: 12 } })
  list = await ctx.api('GET', '/api/history', { token: user.token })
  assert.equal(list.data[0].views, 2, 'views 每上报一次 +1')
  assert.equal(list.data[0].max_step, 5)
  assert.equal(list.data[0].total_steps, 12, 'total_steps 记最后一次的值')

  // 第三次：步数更小 → max_step 不能被改小
  await ctx.api('POST', '/api/history', { token: user.token, body: { algoKey, step: 2, totalSteps: 20 } })
  list = await ctx.api('GET', '/api/history', { token: user.token })
  assert.equal(list.data[0].views, 3)
  assert.equal(list.data[0].max_step, 5, 'max_step 只能取最大值，不能被更小的值覆盖')
  assert.equal(list.data[0].total_steps, 20)

  // 只留一条记录（同一用户 + 同一算法是一行，不是三行）
  const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM history WHERE user_id = ?').get(user.user.id)
  assert.equal(Number(rows.n), 1, '同一算法只应当有一行学习记录')
})

test('修改自己的昵称成功；改完 me 立刻生效', async () => {
  const user = await ctx.register({ nickname: '原名' })

  const res = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { nickname: '新昵称' } })
  assert.equal(res.status, 200)
  assert.equal(res.data.nickname, '新昵称')

  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.data.nickname, '新昵称')
  assert.equal(me.data.username, user.username, '用户名不允许改')
})

test('改密码：原密码不对返回 400，且密码真的没被改掉', async () => {
  const user = await ctx.register({ password: 'origin123' })

  const res = await ctx.api('PATCH', '/api/auth/me', {
    token: user.token,
    body: { oldPassword: 'wrong-old', newPassword: 'brand-new-1' },
  })
  assert.equal(res.status, 400)
  assert.equal(res.error, '原密码不正确')

  const stillOld = await ctx.api('POST', '/api/auth/login', {
    body: { username: user.username, password: 'origin123' },
  })
  assert.equal(stillOld.status, 200, '失败之后原密码必须还是好用的')
  const notNew = await ctx.api('POST', '/api/auth/login', {
    body: { username: user.username, password: 'brand-new-1' },
  })
  assert.equal(notNew.status, 401)
})

test('改密码成功：旧密码失效、新密码可用', async () => {
  const user = await ctx.register({ password: 'origin123' })

  const res = await ctx.api('PATCH', '/api/auth/me', {
    token: user.token,
    body: { oldPassword: 'origin123', newPassword: 'changed456' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.ok, true)

  const oldLogin = await ctx.api('POST', '/api/auth/login', {
    body: { username: user.username, password: 'origin123' },
  })
  assert.equal(oldLogin.status, 401)
  assert.equal(oldLogin.error, '用户名或密码错误')

  const newLogin = await ctx.api('POST', '/api/auth/login', {
    body: { username: user.username, password: 'changed456' },
  })
  assert.equal(newLogin.status, 200)
  assert.equal(newLogin.data.user.username, user.username)
})

test('改资料：只给 newPassword 没给 oldPassword → 400', async () => {
  const user = await ctx.register()
  const res = await ctx.api('PATCH', '/api/auth/me', {
    token: user.token,
    body: { newPassword: 'no-old-pass' },
  })
  assert.equal(res.status, 400)
  assert.equal(res.error, '修改密码需要填写原密码')
})

test('改资料：什么都没给 → 400 “没有需要修改的内容”', async () => {
  const user = await ctx.register()
  const res = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: {} })
  assert.equal(res.status, 400)
  assert.equal(res.error, '没有需要修改的内容')
})
