/**
 * 后端自动化测试 · 权限边界（最重要的一组）
 *
 * 答辩口径：光测"拦得住"不够，还要测"该放行的也放行了"。
 * 所以这里既有"普通用户越权 → 403"，也有"管理员正常管理用户 → 200"。
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

/** 需要登录的接口（方法, 路径, 请求体）—— 未登录时应当一律 401 */
const AUTH_ROUTES = [
  ['POST', '/api/auth/logout', {}],
  ['GET', '/api/auth/me', undefined],
  ['PATCH', '/api/auth/me', { nickname: '新昵称' }],
  ['GET', '/api/favorites', undefined],
  ['POST', '/api/favorites', { algoKey: 'bubble-sort' }],
  ['DELETE', '/api/favorites/bubble-sort', undefined],
  ['GET', '/api/history', undefined],
  ['POST', '/api/history', { algoKey: 'bubble-sort', step: 1, totalSteps: 10 }],
]

/** 管理员的 8 个接口 —— 普通用户用自己有效的令牌也一律 403 */
const ADMIN_ROUTES = [
  ['GET', '/api/admin/stats', undefined],
  ['GET', '/api/admin/users', undefined],
  ['PATCH', '/api/admin/users/1', { nickname: '越权改动' }],
  ['DELETE', '/api/admin/users/1', undefined],
  ['GET', '/api/admin/algorithms', undefined],
  ['POST', '/api/admin/algorithms', { algo_key: 'hacked', name: '越权新增', category: 'sort' }],
  ['PATCH', '/api/admin/algorithms/1', { name: '越权改名' }],
  ['DELETE', '/api/admin/algorithms/1', undefined],
]

/** 当前"可用管理员"（角色 admin 且没被禁用）的数量，直接问接口，不猜 */
async function activeAdminCount() {
  const res = await ctx.api('GET', '/api/admin/users?size=100', { token: ctx.adminToken })
  assert.equal(res.status, 200)
  return res.data.items.filter((u) => u.role === 'admin' && u.disabled === 0).length
}

test('未登录调用 8 个需要登录的接口：一律 401 + “请先登录”', async () => {
  for (const [method, path, body] of AUTH_ROUTES) {
    const res = await ctx.api(method, path, { body })
    assert.equal(res.status, 401, `${method} ${path} 未登录应当 401`)
    assert.equal(res.ok, false)
    assert.equal(res.error, '请先登录', `${method} ${path} 的提示文案不对`)
  }
})

test('未登录调用 8 个管理员接口：也是 401（先认证再谈权限）', async () => {
  for (const [method, path, body] of ADMIN_ROUTES) {
    const res = await ctx.api(method, path, { body })
    assert.equal(res.status, 401, `${method} ${path} 未登录应当 401`)
    assert.equal(res.error, '请先登录')
  }
})

test('普通用户越权：8 个管理员接口逐个试，全部 403（不能只测一个）', async () => {
  const user = await ctx.register({ nickname: '普通用户' })

  for (const [method, path, body] of ADMIN_ROUTES) {
    const res = await ctx.api(method, path, { token: user.token, body })
    assert.equal(res.status, 403, `${method} ${path} 普通用户应当 403，实际 ${res.status}`)
    assert.equal(res.ok, false)
    assert.equal(res.error, '需要管理员权限', `${method} ${path} 的提示文案不对`)
  }

  // 拿自己的 id 去调管理员接口改自己，同样是 403（不能靠"是我的记录"绕过）
  const selfAdminCall = await ctx.api('PATCH', `/api/admin/users/${user.user.id}`, {
    token: user.token,
    body: { role: 'admin' },
  })
  assert.equal(selfAdminCall.status, 403, '普通用户不能给自己提权')
  assert.equal(selfAdminCall.error, '需要管理员权限')

  // 确认没提权成功
  const stillUser = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(stillUser.data.role, 'user')
})

test('游客可以读公开算法列表（该放行的也放行了）', async () => {
  const res = await ctx.api('GET', '/api/algorithms')
  assert.equal(res.status, 200)
  assert.equal(res.ok, true)
  assert.ok(Array.isArray(res.data))
  assert.equal(res.data.length, 98, '种子算法元数据是 98 条')
  assert.deepEqual(Object.keys(res.data[0]).includes('algo_key'), true)
})

test('管理员不能删除自己：400', async () => {
  const me = await ctx.api('GET', '/api/auth/me', { token: ctx.adminToken })
  assert.equal(me.data.role, 'admin')

  const res = await ctx.api('DELETE', `/api/admin/users/${me.data.id}`, { token: ctx.adminToken })
  assert.equal(res.status, 400)
  assert.equal(res.error, '不能删除自己的账号')

  // 自己还在，后台还能进
  const stillThere = await ctx.api('GET', '/api/admin/stats', { token: ctx.adminToken })
  assert.equal(stillThere.status, 200)
})

test('只剩一个管理员时：不能禁用它自己，也不能把自己降级（400 ×2）', async () => {
  const me = await ctx.api('GET', '/api/auth/me', { token: ctx.adminToken })
  assert.equal(await activeAdminCount(), 1, '这条用例的前提：当前只有 1 个可用管理员')

  const disable = await ctx.api('PATCH', `/api/admin/users/${me.data.id}`, {
    token: ctx.adminToken,
    body: { disabled: 1 },
  })
  assert.equal(disable.status, 400)
  assert.equal(disable.error, '系统至少要保留一个可用的管理员，不能降级或禁用最后一个管理员')

  const demote = await ctx.api('PATCH', `/api/admin/users/${me.data.id}`, {
    token: ctx.adminToken,
    body: { role: 'user' },
  })
  assert.equal(demote.status, 400)
  assert.equal(demote.error, '系统至少要保留一个可用的管理员，不能降级或禁用最后一个管理员')

  // 两次都被拒之后，账号状态一点没变
  const after = await ctx.api('GET', '/api/auth/me', { token: ctx.adminToken })
  assert.equal(after.data.role, 'admin')
  assert.equal(after.data.disabled, 0)
  assert.equal(await activeAdminCount(), 1)
})

test('只剩一个管理员时：删除它也被拒，且系统不会被锁死', async () => {
  const me = await ctx.api('GET', '/api/auth/me', { token: ctx.adminToken })
  assert.equal(await activeAdminCount(), 1, '这条用例的前提：当前只有 1 个可用管理员')

  // 唯一的那个管理员就是自己，所以先撞上"不能删自己"这条；结果同样是 400 被拒
  const res = await ctx.api('DELETE', `/api/admin/users/${me.data.id}`, { token: ctx.adminToken })
  assert.equal(res.status, 400)
  assert.equal(res.error, '不能删除自己的账号')

  assert.equal(await activeAdminCount(), 1, '失败之后管理员数量不能变')
  assert.equal((await ctx.api('GET', '/api/admin/stats', { token: ctx.adminToken })).status, 200)
})

test('有两个管理员时：一个可以删掉另一个（规则是“最后一个受保护”，不是“一律不能删”）', async () => {
  assert.equal(await activeAdminCount(), 1)
  const second = await ctx.createAdmin(ctx.adminToken)
  assert.equal(await activeAdminCount(), 2, '提权之后就是 2 个可用管理员')

  try {
    // 两个管理员之间互删：应该成功
    const res = await ctx.api('DELETE', `/api/admin/users/${second.user.id}`, { token: ctx.adminToken })
    assert.equal(res.status, 200, `删第二个管理员应当成功，实际 ${res.status} ${res.error ?? ''}`)
    assert.equal(res.ok, true)

    const list = await ctx.api('GET', `/api/admin/users?q=${second.username}`, { token: ctx.adminToken })
    assert.equal(list.data.total, 0, '删掉之后列表里查不到')
    assert.equal(await activeAdminCount(), 1)

    // 被删掉的人令牌立刻作废
    const stale = await ctx.api('GET', '/api/auth/me', { token: second.token })
    assert.equal(stale.status, 401)
  } finally {
    // 兜底清理，保证下一条用例看到的管理员数量还是 1（不依赖用例执行顺序）
    const still = await ctx.api('GET', `/api/admin/users?q=${second.username}`, { token: ctx.adminToken })
    if (still.data.total > 0) {
      await ctx.api('DELETE', `/api/admin/users/${second.user.id}`, { token: ctx.adminToken })
    }
  }
})

test('管理员正常管理用户：改昵称 / 禁用 / 解禁 / 重置密码 / 删除 都放行', async () => {
  const user = await ctx.register({ nickname: '待管理用户' })

  const rename = await ctx.api('PATCH', `/api/admin/users/${user.user.id}`, {
    token: ctx.adminToken,
    body: { nickname: '被改过的昵称' },
  })
  assert.equal(rename.status, 200)
  assert.equal(rename.data.nickname, '被改过的昵称')

  const disable = await ctx.api('PATCH', `/api/admin/users/${user.user.id}`, {
    token: ctx.adminToken,
    body: { disabled: 1 },
  })
  assert.equal(disable.status, 200)
  assert.equal(disable.data.disabled, 1)

  const enable = await ctx.api('PATCH', `/api/admin/users/${user.user.id}`, {
    token: ctx.adminToken,
    body: { disabled: 0 },
  })
  assert.equal(enable.status, 200)
  assert.equal(enable.data.disabled, 0)

  const resetPassword = await ctx.api('PATCH', `/api/admin/users/${user.user.id}`, {
    token: ctx.adminToken,
    body: { password: 'reset-pass-1' },
  })
  assert.equal(resetPassword.status, 200)
  const oldPassword = await ctx.api('POST', '/api/auth/login', {
    body: { username: user.username, password: user.password },
  })
  assert.equal(oldPassword.status, 401, '重置密码后旧密码应当失效')
  const newPassword = await ctx.api('POST', '/api/auth/login', {
    body: { username: user.username, password: 'reset-pass-1' },
  })
  assert.equal(newPassword.status, 200, '重置后的新密码应当能登录')

  // 顺手造一点收藏 / 学习记录，验证删除用户会一起清掉
  await ctx.api('POST', '/api/favorites', { token: newPassword.data.token, body: { algoKey: 'quick-sort-x' } })
  await ctx.api('POST', '/api/history', {
    token: newPassword.data.token,
    body: { algoKey: 'quick-sort-x', step: 3, totalSteps: 9 },
  })

  const removed = await ctx.api('DELETE', `/api/admin/users/${user.user.id}`, { token: ctx.adminToken })
  assert.equal(removed.status, 200)
  assert.equal(
    Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?').get(user.user.id).n),
    0,
    '删用户要连收藏一起清掉',
  )
  assert.equal(
    Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM history WHERE user_id = ?').get(user.user.id).n),
    0,
    '删用户要连学习记录一起清掉',
  )
  const gone = await ctx.api('GET', `/api/admin/users?q=${user.username}`, { token: ctx.adminToken })
  assert.equal(gone.data.total, 0)
})

test('数据隔离：A 取消收藏删不掉 B 的收藏', async () => {
  const a = await ctx.register({ nickname: '用户A' })
  const b = await ctx.register({ nickname: '用户B' })

  await ctx.api('POST', '/api/favorites', { token: a.token, body: { algoKey: 'shared-algo' } })
  await ctx.api('POST', '/api/favorites', { token: a.token, body: { algoKey: 'only-a' } })
  await ctx.api('POST', '/api/favorites', { token: b.token, body: { algoKey: 'shared-algo' } })

  const removed = await ctx.api('DELETE', '/api/favorites/shared-algo', { token: a.token })
  assert.equal(removed.status, 200)

  const listA = await ctx.api('GET', '/api/favorites', { token: a.token })
  const listB = await ctx.api('GET', '/api/favorites', { token: b.token })
  assert.deepEqual(
    listA.data.map((f) => f.algo_key),
    ['only-a'],
    'A 的列表里只剩自己的另一条',
  )
  assert.deepEqual(
    listB.data.map((f) => f.algo_key),
    ['shared-algo'],
    'B 的收藏不能被 A 的取消操作删掉',
  )
})

test('数据隔离：A 看不到 B 的学习记录，views 各算各的', async () => {
  const a = await ctx.register({ nickname: '记录用户A' })
  const b = await ctx.register({ nickname: '记录用户B' })

  await ctx.api('POST', '/api/history', {
    token: a.token,
    body: { algoKey: 'algo-for-a', step: 4, totalSteps: 20 },
  })
  await ctx.api('POST', '/api/history', {
    token: b.token,
    body: { algoKey: 'algo-for-b', step: 7, totalSteps: 30 },
  })
  await ctx.api('POST', '/api/history', {
    token: b.token,
    body: { algoKey: 'algo-for-b', step: 8, totalSteps: 30 },
  })

  const listA = await ctx.api('GET', '/api/history', { token: a.token })
  const listB = await ctx.api('GET', '/api/history', { token: b.token })

  assert.deepEqual(listA.data.map((h) => h.algo_key), ['algo-for-a'])
  assert.deepEqual(listB.data.map((h) => h.algo_key), ['algo-for-b'])
  assert.equal(listA.data[0].views, 1, 'A 只上报过 1 次')
  assert.equal(listB.data[0].views, 2, 'B 上报了 2 次，不能算到 A 头上')
  assert.equal(listA.data[0].max_step, 4)
  assert.equal(listB.data[0].max_step, 8)
})
