/**
 * 后端自动化测试 · 管理员功能（概览 / 用户管理 / 算法管理）
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

/**
 * 新增一个临时算法，跑完自动删掉。
 * 这样"算法总数 = 101"这类断言不会因为别的用例留下垃圾数据而受影响（不依赖执行顺序）。
 */
async function withAlgorithm(fields, fn) {
  const created = await ctx.api('POST', '/api/admin/algorithms', { token: ctx.adminToken, body: fields })
  assert.equal(created.status, 200, `新增测试算法失败：${created.error}`)
  try {
    return await fn(created.data)
  } finally {
    await ctx.api('DELETE', `/api/admin/algorithms/${created.data.id}`, { token: ctx.adminToken })
  }
}

test('概览统计：算法数 = 种子 101，用户数与收藏数按增量对得上', async () => {
  const before = await ctx.api('GET', '/api/admin/stats', { token: ctx.adminToken })
  assert.equal(before.status, 200)
  assert.equal(before.data.algorithms, 101, '算法元数据种子一共 101 条')
  assert.ok(before.data.users >= 1, '至少有种子管理员 admin')
  assert.ok(Number.isInteger(before.data.todayUsers))

  const user = await ctx.register()
  await ctx.api('POST', '/api/favorites', { token: user.token, body: { algoKey: 'stat-check-a' } })
  await ctx.api('POST', '/api/favorites', { token: user.token, body: { algoKey: 'stat-check-b' } })

  const now = await ctx.api('GET', '/api/admin/stats', { token: ctx.adminToken })
  assert.equal(now.data.users, before.data.users + 1, '多注册 1 个人，用户数应当 +1')
  assert.equal(now.data.favorites, before.data.favorites + 2, '多收藏 2 条，收藏数应当 +2')
  assert.equal(now.data.algorithms, 101, '统计里不能把用户/收藏算进算法数')
  assert.ok(now.data.todayUsers >= 1, '今天至少注册了刚才这个人')
})

test('用户列表：按用户名搜索 + 分页，总数与页数对得上', async () => {
  const prefix = uniqueName('pg')
  const nickPrefix = `昵称${prefix}`
  for (const suffix of ['a', 'b', 'c']) {
    const res = await ctx.api('POST', '/api/auth/register', {
      body: { username: `${prefix}${suffix}`, nickname: `${nickPrefix}${suffix}`, password: 'pass123' },
    })
    assert.equal(res.status, 200)
  }

  const all = await ctx.api('GET', `/api/admin/users?q=${prefix}`, { token: ctx.adminToken })
  assert.equal(all.status, 200)
  assert.equal(all.data.total, 3, '搜索前缀应当正好命中 3 个人')
  assert.equal(all.data.items.length, 3)
  assert.equal(all.data.page, 1)
  assert.equal(all.data.size, 20, '不传 size 时默认 20')

  const page1 = await ctx.api('GET', `/api/admin/users?q=${prefix}&page=1&size=2`, { token: ctx.adminToken })
  const page2 = await ctx.api('GET', `/api/admin/users?q=${prefix}&page=2&size=2`, { token: ctx.adminToken })
  assert.equal(page1.data.total, 3)
  assert.equal(page2.data.total, 3)
  assert.equal(page1.data.items.length, 2, '第一页 2 条')
  assert.equal(page2.data.items.length, 1, '第二页 1 条')
  assert.equal(Math.ceil(page1.data.total / page1.data.size), 2, '3 条 / 每页 2 条 = 2 页')
  assert.equal(page2.data.page, 2)

  const ids = [...page1.data.items, ...page2.data.items].map((u) => u.id)
  assert.equal(new Set(ids).size, 3, '两页不能有重复的人')
  for (const item of page1.data.items) {
    assert.equal('password_hash' in item, false, '用户列表也不能漏出密码哈希')
    assert.equal('salt' in item, false)
  }

  // 昵称也能搜（后端搜索同时匹配 username 和 nickname）
  const byNickname = await ctx.api('GET', `/api/admin/users?q=${nickPrefix}`, { token: ctx.adminToken })
  assert.equal(byNickname.data.total, 3, '按昵称也应当搜到 3 个人')
})

test('新增算法成功：中文大类归一化成 id，字段都按传入值存', async () => {
  const algoKey = uniqueName('test-algo-')
  await withAlgorithm(
    {
      algo_key: algoKey,
      name: '测试用算法',
      category: '排序',
      grp: '测试子类',
      difficulty: 3,
      summary: '这是一条测试用的简介',
      online: 1,
    },
    async (algo) => {
      assert.equal(algo.algo_key, algoKey)
      assert.equal(algo.name, '测试用算法')
      assert.equal(algo.category, 'sort', '传中文大类"排序"应当归一化成 id "sort"')
      assert.equal(algo.grp, '测试子类')
      assert.equal(algo.difficulty, 3)
      assert.equal(algo.summary, '这是一条测试用的简介')
      assert.equal(algo.online, 1)
      assert.equal(typeof algo.id, 'number')
      assert.equal(typeof algo.sort_order, 'number')
    },
  )
})

test('新增算法：英文大类 id 直接可用（含动态规划 dp），非法大类返回 400', async () => {
  await withAlgorithm(
    { algo_key: uniqueName('en-'), name: '英文大类算法', category: 'tree' },
    async (algo) => {
      assert.equal(algo.category, 'tree')
      assert.equal(algo.difficulty, 2, '不传难度默认 2')
      assert.equal(algo.online, 1, '不传上架默认上架')
    },
  )

  // 动态规划是后加的大类：白名单里少一个 dp，管理员就没法在后台新增 / 修改这类算法（400）
  await withAlgorithm(
    { algo_key: uniqueName('dp-'), name: '动态规划类算法', category: 'dp' },
    async (algo) => {
      assert.equal(algo.category, 'dp', '英文 id "dp" 必须被放行')
    },
  )
  await withAlgorithm(
    { algo_key: uniqueName('dp-cn-'), name: '动态规划类算法（中文大类）', category: '动态规划' },
    async (algo) => {
      assert.equal(algo.category, 'dp', '中文大类"动态规划"应当归一化成 id "dp"')
    },
  )

  const bad = await ctx.api('POST', '/api/admin/algorithms', {
    token: ctx.adminToken,
    body: { algo_key: uniqueName('bad-'), name: '非法大类', category: '不存在的类' },
  })
  assert.equal(bad.status, 400)
  assert.match(bad.error, /大类只能是：/, '提示语要列出允许的大类')
  assert.match(bad.error, /排序/)
  assert.match(bad.error, /动态规划/, '提示语要跟着白名单一起更新，列出"动态规划"')
})

test('新增算法：algo_key 重复返回 409', async () => {
  const algoKey = uniqueName('dup-')
  await withAlgorithm({ algo_key: algoKey, name: '第一次', category: 'sort' }, async () => {
    const again = await ctx.api('POST', '/api/admin/algorithms', {
      token: ctx.adminToken,
      body: { algo_key: algoKey, name: '第二次', category: 'sort' },
    })
    assert.equal(again.status, 409)
    assert.equal(again.error, '该算法标识已存在')
  })
})

test('修改算法：改名生效；下架后公开列表里查不到、后台列表里还在', async () => {
  const algoKey = uniqueName('off-')
  await withAlgorithm({ algo_key: algoKey, name: '下架前名字', category: 'sort' }, async (algo) => {
    const renamed = await ctx.api('PATCH', `/api/admin/algorithms/${algo.id}`, {
      token: ctx.adminToken,
      body: { name: '改名之后' },
    })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.data.name, '改名之后')
    assert.equal(renamed.data.algo_key, algoKey, '没传的字段不能被动')

    const offline = await ctx.api('PATCH', `/api/admin/algorithms/${algo.id}`, {
      token: ctx.adminToken,
      body: { online: 0 },
    })
    assert.equal(offline.status, 200)
    assert.equal(offline.data.online, 0)

    const publicList = await ctx.api('GET', '/api/algorithms')
    assert.equal(
      publicList.data.some((a) => a.algo_key === algoKey),
      false,
      '下架的算法不能出现在公开列表里',
    )

    const adminList = await ctx.api('GET', `/api/admin/algorithms?q=${algoKey}`, { token: ctx.adminToken })
    assert.equal(adminList.data.total, 1, '后台列表里还应当看得到（包括下架的）')
    assert.equal(adminList.data.items[0].online, 0)
  })
})

test('修改算法：id 不存在返回 404', async () => {
  const res = await ctx.api('PATCH', '/api/admin/algorithms/999999', {
    token: ctx.adminToken,
    body: { name: '不存在的算法' },
  })
  assert.equal(res.status, 404)
  assert.equal(res.error, '算法不存在')
})

test('删除算法成功，再删返回 404；关联的收藏会被一起清掉', async () => {
  const algoKey = uniqueName('del-')
  const user = await ctx.register()

  const created = await ctx.api('POST', '/api/admin/algorithms', {
    token: ctx.adminToken,
    body: { algo_key: algoKey, name: '待删除算法', category: 'sort' },
  })
  assert.equal(created.status, 200)
  await ctx.api('POST', '/api/favorites', { token: user.token, body: { algoKey } })

  const removed = await ctx.api('DELETE', `/api/admin/algorithms/${created.data.id}`, { token: ctx.adminToken })
  assert.equal(removed.status, 200)
  assert.equal(removed.ok, true)

  const again = await ctx.api('DELETE', `/api/admin/algorithms/${created.data.id}`, { token: ctx.adminToken })
  assert.equal(again.status, 404)
  assert.equal(again.error, '算法不存在')

  const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE algo_key = ?').get(algoKey)
  assert.equal(Number(rows.n), 0, '算法删了，指向它的收藏也应当清掉')
  const stats = await ctx.api('GET', '/api/admin/stats', { token: ctx.adminToken })
  assert.equal(stats.data.algorithms, 101, '删干净之后算法总数回到 101')
})

test('算法列表：搜索（algo_key / 名称）与分页都能用', async () => {
  const algoKey = uniqueName('find-')
  const name = `搜索用算法${algoKey.slice(-4)}`

  await withAlgorithm({ algo_key: algoKey, name, category: 'sort' }, async (algo) => {
    const byKey = await ctx.api('GET', `/api/admin/algorithms?q=${algoKey}`, { token: ctx.adminToken })
    assert.equal(byKey.data.total, 1)
    assert.equal(byKey.data.items[0].id, algo.id)

    const byName = await ctx.api('GET', `/api/admin/algorithms?q=${encodeURIComponent(name)}`, {
      token: ctx.adminToken,
    })
    assert.equal(byName.data.total, 1)
    assert.equal(byName.data.items[0].algo_key, algoKey)
  })

  const page1 = await ctx.api('GET', '/api/admin/algorithms?page=1&size=10', { token: ctx.adminToken })
  const page2 = await ctx.api('GET', '/api/admin/algorithms?page=2&size=10', { token: ctx.adminToken })
  assert.equal(page1.data.total, 101)
  assert.equal(page1.data.items.length, 10)
  assert.equal(page2.data.items.length, 10)
  const ids = new Set([...page1.data.items, ...page2.data.items].map((a) => a.id))
  assert.equal(ids.size, 20, '两页之间不能重复')

  const lastPage = await ctx.api('GET', '/api/admin/algorithms?page=11&size=10', { token: ctx.adminToken })
  assert.equal(lastPage.data.items.length, 1, '101 条 = 10 页满 + 最后一页 1 条')
})

test('管理员编辑用户时 id 不存在返回 404', async () => {
  const res = await ctx.api('PATCH', '/api/admin/users/999999', {
    token: ctx.adminToken,
    body: { nickname: '查无此人' },
  })
  assert.equal(res.status, 404)
  assert.equal(res.error, '用户不存在')

  const del = await ctx.api('DELETE', '/api/admin/users/999999', { token: ctx.adminToken })
  assert.equal(del.status, 404)
  assert.equal(del.error, '用户不存在')
})
