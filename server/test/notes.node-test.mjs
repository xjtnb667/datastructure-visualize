/**
 * 后端自动化测试 · 学习笔记（`notes` 表 + 4 个接口）
 *
 * 覆盖：
 *   ① 4 个接口未登录一律 401；
 *   ② 新增 → 读取 → 更新 → 删除 全流程（含 `created_at` 不被更新改掉）；
 *   ③ 空内容 = 删除（这是契约里写明的行为，不是错误）；
 *   ④ 超长（2001 字）→ 400，且一个字都不落库；正好 2000 字要能写进去；
 *   ⑤ **数据隔离**：A 的笔记 B 看不到、改不了、删不掉；
 *   ⑥ 幂等：删两次都成功；读一个没写过的算法返回 `null` 而**不是 404**。
 *
 * 跑法：`npm run test:server`；库和端口的隔离方式见本目录 helpers.mjs 开头。
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

/** 4 个笔记接口（方法, 路径, 请求体）—— 未登录时应当一律 401 */
const NOTE_ROUTES = [
  ['GET', '/api/notes', undefined],
  ['GET', '/api/notes/bubble-sort', undefined],
  ['PUT', '/api/notes/bubble-sort', { content: '未登录不该写得进去' }],
  ['DELETE', '/api/notes/bubble-sort', undefined],
]

/** 库里一共有几条笔记（断言"没落库"用；只查总数，不关心是谁的） */
function noteCount() {
  return Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n)
}

/** 某个用户的笔记条数 */
function noteCountOf(userId) {
  return Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?').get(userId).n)
}

/** 时间戳是毫秒，同一毫秒内写完两条会看不出先后；要测顺序就隔开一点点 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 8))

test('未登录调用 4 个笔记接口：一律 401 + “请先登录”，一条都没写进库', async () => {
  for (const [method, path, body] of NOTE_ROUTES) {
    const res = await ctx.api(method, path, { body })
    assert.equal(res.status, 401, `${method} ${path} 未登录应当 401`)
    assert.equal(res.ok, false)
    assert.equal(res.error, '请先登录', `${method} ${path} 的提示文案不对`)
  }
  assert.equal(noteCount(), 0, '被拒的请求不能留下任何笔记')
})

test('新增 → 读取：字段是 algo_key / content / created_at / updated_at', async () => {
  const user = await ctx.register({ nickname: '笔记用户' })

  const empty = await ctx.api('GET', '/api/notes', { token: user.token })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.data, [], '新用户的笔记列表是空的')

  const saved = await ctx.api('PUT', '/api/notes/bubble-sort', {
    token: user.token,
    body: { content: '冒泡：相邻两两比较，大的往后冒。易错点：内层循环的边界要减 i。' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.ok, true)
  assert.equal(saved.data.algo_key, 'bubble-sort')
  assert.equal(saved.data.content, '冒泡：相邻两两比较，大的往后冒。易错点：内层循环的边界要减 i。')
  assert.equal(typeof saved.data.created_at, 'number')
  assert.equal(typeof saved.data.updated_at, 'number')
  assert.deepEqual(Object.keys(saved.data).sort(), [
    'algo_key',
    'content',
    'created_at',
    'updated_at',
  ])

  const one = await ctx.api('GET', '/api/notes/bubble-sort', { token: user.token })
  assert.equal(one.status, 200)
  assert.deepEqual(one.data, saved.data, '单条查询和写入时返回的应当是同一份内容')

  const list = await ctx.api('GET', '/api/notes', { token: user.token })
  assert.equal(list.data.length, 1)
  assert.deepEqual(list.data[0], saved.data)
})

test('同一个算法写第二次就是更新：只留一行、created_at 不变、content 变', async () => {
  const user = await ctx.register()
  const algoKey = 'quick-sort'

  const first = await ctx.api('PUT', `/api/notes/${algoKey}`, {
    token: user.token,
    body: { content: '第一版理解' },
  })
  assert.equal(first.status, 200)

  await tick()
  const second = await ctx.api('PUT', `/api/notes/${algoKey}`, {
    token: user.token,
    body: { content: '第二版理解（补充了划分过程）' },
  })
  assert.equal(second.status, 200)
  assert.equal(second.data.content, '第二版理解（补充了划分过程）')
  assert.equal(second.data.created_at, first.data.created_at, 'created_at 是"第一次写"的时间，不该被改掉')
  assert.ok(
    second.data.updated_at > first.data.updated_at,
    'updated_at 要跟着更新往前走（界面上"最后修改时间"靠它）',
  )

  assert.equal(noteCountOf(user.user.id), 1, '一个用户对一个算法只能有一行')
  const list = await ctx.api('GET', '/api/notes', { token: user.token })
  assert.equal(list.data.length, 1, '更新不能插出第二条')
  assert.equal(list.data[0].content, '第二版理解（补充了划分过程）')
})

test('正文首尾空白会被去掉再存（纯空白 = 空内容）', async () => {
  const user = await ctx.register()
  const saved = await ctx.api('PUT', '/api/notes/insertion-sort', {
    token: user.token,
    body: { content: '  \n  插入排序：把新元素插到左边有序区  \n\n  ' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.content, '插入排序：把新元素插到左边有序区')
})

test('空内容 = 删除这条笔记（PUT 返回 null，列表里也没了）', async () => {
  const user = await ctx.register()
  const algoKey = 'merge-sort'
  await ctx.api('PUT', `/api/notes/${algoKey}`, { token: user.token, body: { content: '先写点东西' } })
  assert.equal(noteCountOf(user.user.id), 1)

  // 纯空串
  const cleared = await ctx.api('PUT', `/api/notes/${algoKey}`, { token: user.token, body: { content: '' } })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.data, null, '清空笔记时返回 null')
  assert.equal(noteCountOf(user.user.id), 0, '空内容要把这一行删掉')
  assert.equal((await ctx.api('GET', `/api/notes/${algoKey}`, { token: user.token })).data, null)

  // 只有空白也算空内容
  await ctx.api('PUT', `/api/notes/${algoKey}`, { token: user.token, body: { content: '又写了一条' } })
  const blank = await ctx.api('PUT', `/api/notes/${algoKey}`, {
    token: user.token,
    body: { content: ' \n\t  ' },
  })
  assert.equal(blank.status, 200)
  assert.equal(blank.data, null)
  assert.equal(noteCountOf(user.user.id), 0, '纯空白也要当成清空')

  // 本来就没有笔记时，空内容照样成功（幂等，不报错）
  const again = await ctx.api('PUT', `/api/notes/${algoKey}`, { token: user.token, body: { content: '' } })
  assert.equal(again.status, 200)
  assert.equal(again.data, null)
})

test('超长：2001 字 → 400 + 中文说明，且不落库；正好 2000 字可以写', async () => {
  const user = await ctx.register()
  const algoKey = 'heap-sort'

  const tooLong = await ctx.api('PUT', `/api/notes/${algoKey}`, {
    token: user.token,
    body: { content: '长'.repeat(2001) },
  })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.error, '笔记太长了：最多 2000 个字，当前 2001 个字')
  assert.equal(noteCountOf(user.user.id), 0, '被拒的内容一个字都不该写进库')
  assert.equal((await ctx.api('GET', `/api/notes/${algoKey}`, { token: user.token })).data, null)

  // 边界：正好 2000 字要能写进去（证明上面的 400 不是"随便拒"）
  const exactly = await ctx.api('PUT', `/api/notes/${algoKey}`, {
    token: user.token,
    body: { content: '长'.repeat(2000) },
  })
  assert.equal(exactly.status, 200)
  assert.equal(exactly.data.content.length, 2000)

  // 首尾空白不算长度：2000 字 + 一圈空格，去空白后还是 2000 字
  const padded = await ctx.api('PUT', `/api/notes/${algoKey}`, {
    token: user.token,
    body: { content: `   ${'长'.repeat(2000)}   ` },
  })
  assert.equal(padded.status, 200)
})

test('content 不是字符串（缺参数 / null / 数字 / 对象）→ 一律 400', async () => {
  const user = await ctx.register()
  const cases = [
    [{}, '缺少参数 content：笔记内容必须是字符串'],
    [{ content: null }, '缺少参数 content：笔记内容必须是字符串'],
    [{ content: 123 }, '缺少参数 content：笔记内容必须是字符串'],
    [{ content: { text: '对象' } }, '缺少参数 content：笔记内容必须是字符串'],
    [{ content: ['数组'] }, '缺少参数 content：笔记内容必须是字符串'],
  ]
  for (const [body, message] of cases) {
    const res = await ctx.api('PUT', '/api/notes/bad-content', { token: user.token, body })
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应当被拒`)
    assert.equal(res.error, message, `${JSON.stringify(body)} 的提示文案不对`)
  }
  assert.equal(noteCountOf(user.user.id), 0, '非法入参一条都不写')
})

test('读一个没写过的算法：返回 200 + data 是 null（不是 404）', async () => {
  const user = await ctx.register()

  const res = await ctx.api('GET', '/api/notes/never-written', { token: user.token })
  assert.equal(res.status, 200, '“还没写过”是正常状态，不该当错误处理')
  assert.equal(res.ok, true)
  assert.equal(res.data, null)

  // 中文 / 带空格的算法标识：只要能对上 key 就照常返回 null，而不是 500
  const weird = await ctx.api('GET', `/api/notes/${encodeURIComponent('不存在的算法')}`, {
    token: user.token,
  })
  assert.equal(weird.status, 200)
  assert.equal(weird.data, null)
})

test('删除是幂等的：删两次都成功，删没写过的也成功', async () => {
  const user = await ctx.register()
  await ctx.api('PUT', '/api/notes/radix-sort', { token: user.token, body: { content: '基数排序' } })

  const first = await ctx.api('DELETE', '/api/notes/radix-sort', { token: user.token })
  assert.equal(first.status, 200)
  assert.equal(first.ok, true)

  const second = await ctx.api('DELETE', '/api/notes/radix-sort', { token: user.token })
  assert.equal(second.status, 200, '再删一次不能报错')

  const never = await ctx.api('DELETE', '/api/notes/never-written-algo', { token: user.token })
  assert.equal(never.status, 200, '删一个从没写过的也不报错')

  assert.equal((await ctx.api('GET', '/api/notes', { token: user.token })).data.length, 0)
})

test('数据隔离：A 的笔记 B 看不到、改不了、也删不掉', async () => {
  const a = await ctx.register({ nickname: '笔记A' })
  const b = await ctx.register({ nickname: '笔记B' })
  const algoKey = 'dijkstra'

  const aNote = await ctx.api('PUT', `/api/notes/${algoKey}`, {
    token: a.token,
    body: { content: '这是 A 写的笔记' },
  })
  assert.equal(aNote.status, 200)

  // B 看同一个算法：读不到 A 的内容（B 自己没写过 → null）
  const bRead = await ctx.api('GET', `/api/notes/${algoKey}`, { token: b.token })
  assert.equal(bRead.status, 200)
  assert.equal(bRead.data, null, 'B 不能读到 A 的笔记')

  // B 的列表里也没有 A 的笔记
  const bList = await ctx.api('GET', '/api/notes', { token: b.token })
  assert.deepEqual(bList.data, [], 'B 的列表不该出现 A 的笔记')

  // B 写同名算法：各写各的，谁也没覆盖谁
  await ctx.api('PUT', `/api/notes/${algoKey}`, { token: b.token, body: { content: '这是 B 写的笔记' } })
  assert.equal(
    (await ctx.api('GET', `/api/notes/${algoKey}`, { token: a.token })).data.content,
    '这是 A 写的笔记',
    'B 的写入不能覆盖 A 的笔记',
  )
  assert.equal(
    (await ctx.api('GET', `/api/notes/${algoKey}`, { token: b.token })).data.content,
    '这是 B 写的笔记',
  )
  assert.equal(
    noteCountOf(a.user.id) + noteCountOf(b.user.id),
    2,
    '同一个算法、两个用户 = 两行（别的用例写的笔记不算在这里）',
  )

  // B 删这个算法：只删掉 B 自己那条
  const removed = await ctx.api('DELETE', `/api/notes/${algoKey}`, { token: b.token })
  assert.equal(removed.status, 200)
  assert.equal(
    (await ctx.api('GET', `/api/notes/${algoKey}`, { token: a.token })).data.content,
    '这是 A 写的笔记',
    'B 的删除不能删掉 A 的笔记',
  )

  // B 想把 A 的笔记"清空"：同样碰不到 A（空内容只删除请求者自己的那一条）
  await ctx.api('PUT', `/api/notes/${algoKey}`, { token: b.token, body: { content: '   ' } })
  assert.equal(
    (await ctx.api('GET', `/api/notes/${algoKey}`, { token: a.token })).data.content,
    '这是 A 写的笔记',
    'B 发空内容不能把 A 的笔记也删了',
  )

  // 总数对得上：A 1 条 + B 0 条
  assert.equal(noteCountOf(a.user.id), 1)
  assert.equal(noteCountOf(b.user.id), 0)
})

test('user_id 只能来自令牌：请求体里塞 user_id / userId 也写不到别人名下', async () => {
  const a = await ctx.register({ nickname: '伪造目标A' })
  const b = await ctx.register({ nickname: '伪造者B' })

  const forged = await ctx.api('PUT', '/api/notes/huffman-build', {
    token: b.token,
    body: { content: '我假装是 A 写的', user_id: a.user.id, userId: a.user.id },
  })
  assert.equal(forged.status, 200)

  assert.equal((await ctx.api('GET', '/api/notes', { token: a.token })).data.length, 0, 'A 名下不能多出笔记')
  const bList = await ctx.api('GET', '/api/notes', { token: b.token })
  assert.equal(bList.data.length, 1)
  assert.equal(bList.data[0].content, '我假装是 A 写的')

  // 数据库里那一行的 user_id 必须是令牌对应的那个人
  const row = ctx.db.prepare('SELECT user_id FROM notes WHERE algo_key = ?').get('huffman-build')
  assert.equal(Number(row.user_id), Number(b.user.id), 'user_id 必须由服务端从令牌得出')
})

test('笔记列表：按最近修改倒序（刚改过的排最前）', async () => {
  const user = await ctx.register()
  for (const key of ['algo-one', 'algo-two', 'algo-three']) {
    await ctx.api('PUT', `/api/notes/${key}`, { token: user.token, body: { content: `${key} 的笔记` } })
    await tick()
  }

  let list = await ctx.api('GET', '/api/notes', { token: user.token })
  assert.deepEqual(list.data.map((n) => n.algo_key), ['algo-three', 'algo-two', 'algo-one'])

  // 回头改最早那条，它应当跑到最前面
  await tick()
  await ctx.api('PUT', '/api/notes/algo-one', { token: user.token, body: { content: '改一下第一条' } })
  list = await ctx.api('GET', '/api/notes', { token: user.token })
  assert.deepEqual(list.data.map((n) => n.algo_key), ['algo-one', 'algo-three', 'algo-two'])
})

test('删除用户时：他写的笔记一起清掉（不留孤儿数据）', async () => {
  const user = await ctx.register({ nickname: '待删除用户' })
  await ctx.api('PUT', '/api/notes/some-algo', { token: user.token, body: { content: '删号前的笔记' } })
  assert.equal(noteCountOf(user.user.id), 1)

  const removed = await ctx.api('DELETE', `/api/admin/users/${user.user.id}`, { token: ctx.adminToken })
  assert.equal(removed.status, 200)
  assert.equal(noteCountOf(user.user.id), 0, '删用户要连笔记一起清掉')
})

test('删除算法时：这个 algo_key 下的笔记一起清掉', async () => {
  const user = await ctx.register()

  const created = await ctx.api('POST', '/api/admin/algorithms', {
    token: ctx.adminToken,
    body: { algo_key: 'temp-algo-for-notes', name: '临时算法', category: 'sort' },
  })
  assert.equal(created.status, 200)
  await ctx.api('PUT', '/api/notes/temp-algo-for-notes', {
    token: user.token,
    body: { content: '这个算法要被删掉了' },
  })
  assert.equal(
    Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE algo_key = ?').get('temp-algo-for-notes').n),
    1,
  )

  const removed = await ctx.api('DELETE', `/api/admin/algorithms/${created.data.id}`, {
    token: ctx.adminToken,
  })
  assert.equal(removed.status, 200)
  assert.equal(
    Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE algo_key = ?').get('temp-algo-for-notes').n),
    0,
    '删算法要连笔记一起清掉（否则以后同 key 的算法会看到旧笔记）',
  )
})

test('笔记落在临时库上，绝不碰 server/data/app.db', () => {
  assert.ok(ctx.dbPath.includes('algo-server-test-'), '临时库目录名不对')
  assert.ok(!ctx.dbPath.includes('server\\data') && !ctx.dbPath.includes('server/data'))
})
