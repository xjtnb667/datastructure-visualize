/**
 * 后端自动化测试 · 自定义头像（`users.avatar`）
 *
 * 跑法：`npm run test:server`；其余说明见本目录 helpers.mjs 开头。
 *
 * 这里盯的是**服务端校验**这一关 —— 前端的 canvas 压缩只是"省流量"，
 * 谁都能绕过前端直接发请求，所以"什么能存、什么不能存"必须由后端说了算。
 * 覆盖：正常设置 / 清除 / 各种非法输入 / 超长 / 用户之间互不影响 / 管理员清空。
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

/** 一张真的 1×1 PNG 的 data URL（合法的图片数据，不是随手拼的字符串） */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** 一张"看起来像 JPEG"的 data URL（内容不要求真能解码，后端只校验格式与长度） */
const JPEG_TINY = `data:image/jpeg;base64,${'A'.repeat(64)}`

/** 格式合法、但 base64 正文超过 200KB 的 data URL（用来测长度上限） */
function oversizedAvatar(kb = 300) {
  return `data:image/png;base64,${'A'.repeat(kb * 1024)}`
}

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------
test('设置头像成功：PATCH 的返回、GET me、再次登录，三处都能读回同一张图', async () => {
  const user = await ctx.register({ password: 'avatar123' })

  const me0 = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me0.data.avatar, null, '新用户没设置头像时是 null（不是空串、也不是没有这个字段）')

  const set = await ctx.api('PATCH', '/api/auth/me', {
    token: user.token,
    body: { avatar: PNG_1X1 },
  })
  assert.equal(set.status, 200)
  assert.equal(set.data.avatar, PNG_1X1, 'PATCH 的返回值里就带上了新头像')
  assert.equal(set.data.nickname, user.nickname, '只改头像不该动昵称')

  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.status, 200)
  assert.equal(me.data.avatar, PNG_1X1, 'GET /api/auth/me 读得回来')

  const relogin = await ctx.api('POST', '/api/auth/login', {
    body: { username: user.username, password: 'avatar123' },
  })
  assert.equal(relogin.status, 200)
  assert.equal(relogin.data.user.avatar, PNG_1X1, '登录响应里的用户对象也带 avatar')

  // 落库的确实就是这个字符串（不是被截断 / 转义过的）
  const row = ctx.db.prepare('SELECT avatar FROM users WHERE id = ?').get(user.user.id)
  assert.equal(row.avatar, PNG_1X1)
})

test('各种图片类型都收：png / jpeg / jpg / webp / gif', async () => {
  const user = await ctx.register()
  for (const mime of ['png', 'jpeg', 'jpg', 'webp', 'gif']) {
    const url = `data:image/${mime};base64,${'B'.repeat(32)}`
    const res = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: url } })
    assert.equal(res.status, 200, `data:image/${mime};base64, 应当被接受`)
    assert.equal(res.data.avatar, url)

    const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
    assert.equal(me.data.avatar, url)
  }
})

test('换一张新头像：直接覆盖，不会报错', async () => {
  const user = await ctx.register()
  await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: PNG_1X1 } })
  const res = await ctx.api('PATCH', '/api/auth/me', {
    token: user.token,
    body: { avatar: JPEG_TINY },
  })
  assert.equal(res.status, 200)
  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.data.avatar, JPEG_TINY)
})

// ---------------------------------------------------------------------------
// 清除
// ---------------------------------------------------------------------------
test('传 null 清除头像：库里变回 NULL，再读回来也是 null', async () => {
  const user = await ctx.register()
  await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: PNG_1X1 } })

  const cleared = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: null } })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.data.avatar, null)

  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.data.avatar, null)

  // 反复清除不报错（幂等）
  const again = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: null } })
  assert.equal(again.status, 200)
  assert.equal(again.data.avatar, null)

  const row = ctx.db.prepare('SELECT avatar FROM users WHERE id = ?').get(user.user.id)
  assert.equal(row.avatar, null, '库里存的是 NULL，不是空串')
})

test('传空串等同于清除（前端"恢复默认"按钮的两种写法都认）', async () => {
  const user = await ctx.register()
  await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: PNG_1X1 } })

  const res = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: '' } })
  assert.equal(res.status, 200)
  assert.equal(res.data.avatar, null)

  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.data.avatar, null)
})

// ---------------------------------------------------------------------------
// 非法输入：一律 400，且**不能写进库**
// ---------------------------------------------------------------------------
const ILLEGAL_AVATARS = [
  ['不是图片的 data URL', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
  ['javascript: 伪协议（XSS 载荷）', 'javascript:alert(1)'],
  ['普通网址', 'https://example.com/avatar.png'],
  ['HTML 片段', '<img src=x onerror=alert(1)>'],
  ['纯文本', '这就是一段随便写的中文，不是图片'],
  ['只有 base64 没有 data URL 头', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='],
  ['image/svg+xml（SVG 能内嵌脚本，不收）', 'data:image/svg+xml;base64,PHN2Zy8+'],
  ['base64 正文里有非法字符（把 HTML 直接塞进 base64 位置）', 'data:image/png;base64,<script>alert(1)</script>'],
  ['前缀对但没有内容', 'data:image/png;base64,'],
]

for (const [label, value] of ILLEGAL_AVATARS) {
  test(`非法头像被拒：${label} → 400 + 中文说明，库里没被写进去`, async () => {
    const user = await ctx.register()
    const res = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: value } })

    assert.equal(res.status, 400, `${label} 应当被 400 拒绝`)
    assert.equal(res.ok, false)
    assert.ok(typeof res.error === 'string' && res.error.length > 0, '必须给中文错误说明')
    assert.ok(
      res.error.includes('头像'),
      `错误说明要提到"头像"，实际是：${res.error}`,
    )

    const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
    assert.equal(me.data.avatar, null, '被拒绝之后库里必须还是空')

    const row = ctx.db.prepare('SELECT avatar FROM users WHERE id = ?').get(user.user.id)
    assert.equal(row.avatar, null, '被拒绝之后数据库里必须还是 NULL')
  })
}

test('头像只接受字符串 / null：数字、对象、数组都是 400', async () => {
  const user = await ctx.register()
  for (const bad of [123, true, { a: 1 }, ['data:image/png;base64,AA']]) {
    const res = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: bad } })
    assert.equal(res.status, 400, `${JSON.stringify(bad)} 应当被拒绝`)
    assert.ok(res.error.includes('data URL'), `错误说明要说清正确格式，实际是：${res.error}`)
  }
})

// ---------------------------------------------------------------------------
// 长度上限
// ---------------------------------------------------------------------------
test('超过 200KB 的合法 data URL → 400，提示里带 200KB', async () => {
  const user = await ctx.register()
  const huge = oversizedAvatar(300)
  assert.ok(huge.length > 200 * 1024)

  const res = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: huge } })
  assert.equal(res.status, 400)
  assert.ok(res.error.includes('200KB'), `提示里要写清上限，实际是：${res.error}`)

  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.data.avatar, null, '超长内容绝不能落库')
})

test('刚好在 200KB 以内（199KB）能存下 —— 上限是"内容长度"，不是随便卡的', async () => {
  const user = await ctx.register()
  const near = oversizedAvatar(199)
  const res = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: near } })
  assert.equal(res.status, 200)

  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.data.avatar, near)
})

test('一个正常压缩过的头像（约 5KB）远在上限之内', async () => {
  const user = await ctx.register()
  const normal = `data:image/jpeg;base64,${'A'.repeat(5 * 1024)}`
  const res = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: normal } })
  assert.equal(res.status, 200)
})

// ---------------------------------------------------------------------------
// 数据隔离
// ---------------------------------------------------------------------------
test('别人的头像不受影响：三个用户各存各的，改一个不动其它两个', async () => {
  const a = await ctx.register({ nickname: '甲' })
  const b = await ctx.register({ nickname: '乙' })
  const c = await ctx.register({ nickname: '丙' })

  const avatarA = `data:image/png;base64,${'A'.repeat(40)}`
  const avatarB = `data:image/png;base64,${'B'.repeat(40)}`
  await ctx.api('PATCH', '/api/auth/me', { token: a.token, body: { avatar: avatarA } })
  await ctx.api('PATCH', '/api/auth/me', { token: b.token, body: { avatar: avatarB } })

  // c 清空自己的头像（它本来就没有）—— 不能把 a / b 的一起清掉
  await ctx.api('PATCH', '/api/auth/me', { token: c.token, body: { avatar: null } })

  assert.equal((await ctx.api('GET', '/api/auth/me', { token: a.token })).data.avatar, avatarA)
  assert.equal((await ctx.api('GET', '/api/auth/me', { token: b.token })).data.avatar, avatarB)
  assert.equal((await ctx.api('GET', '/api/auth/me', { token: c.token })).data.avatar, null)

  // a 换头像，b 的不能被顺带改掉
  await ctx.api('PATCH', '/api/auth/me', { token: a.token, body: { avatar: JPEG_TINY } })
  assert.equal((await ctx.api('GET', '/api/auth/me', { token: b.token })).data.avatar, avatarB)
})

test('改昵称 / 改密码不会把头像弄丢', async () => {
  const user = await ctx.register({ password: 'origin123' })
  await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: PNG_1X1 } })

  const nick = await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { nickname: '改了昵称' } })
  assert.equal(nick.status, 200)
  assert.equal(nick.data.avatar, PNG_1X1)

  const pwd = await ctx.api('PATCH', '/api/auth/me', {
    token: user.token,
    body: { oldPassword: 'origin123', newPassword: 'changed456' },
  })
  assert.equal(pwd.status, 200)
  assert.equal(pwd.data.avatar, PNG_1X1, '改密码只动密码，头像要留着')

  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.data.avatar, PNG_1X1)
})

test('未登录改头像：401「请先登录」（安全规则一个字没改）', async () => {
  const res = await ctx.api('PATCH', '/api/auth/me', { body: { avatar: PNG_1X1 } })
  assert.equal(res.status, 401)
  assert.equal(res.error, '请先登录')
})

// ---------------------------------------------------------------------------
// 管理员
// ---------------------------------------------------------------------------
test('管理员用户列表里带 avatar（没设置的是 null）', async () => {
  const user = await ctx.register({ nickname: '列表头像用户' })
  await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: PNG_1X1 } })

  const list = await ctx.api('GET', `/api/admin/users?q=${encodeURIComponent(user.username)}`, {
    token: ctx.adminToken,
  })
  assert.equal(list.status, 200)
  assert.equal(list.data.items.length, 1)
  assert.equal(list.data.items[0].avatar, PNG_1X1)

  // 列表项的形状应当和 me 的用户对象一致
  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.deepEqual(Object.keys(list.data.items[0]).sort(), Object.keys(me.data).sort())
})

test('管理员能把某个用户的头像清空（传 null）', async () => {
  const user = await ctx.register({ nickname: '被清空头像' })
  await ctx.api('PATCH', '/api/auth/me', { token: user.token, body: { avatar: PNG_1X1 } })

  const res = await ctx.api('PATCH', `/api/admin/users/${user.user.id}`, {
    token: ctx.adminToken,
    body: { avatar: null },
  })
  assert.equal(res.status, 200)
  assert.equal(res.data.avatar, null, '返回的对象里已经是清空后的状态')

  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.data.avatar, null, '被清空的人自己再读也是空')
})

test('管理员改别人头像同样要过校验：非法内容 → 400', async () => {
  const user = await ctx.register({ nickname: '非法头像目标' })
  const res = await ctx.api('PATCH', `/api/admin/users/${user.user.id}`, {
    token: ctx.adminToken,
    body: { avatar: 'javascript:alert(1)' },
  })
  assert.equal(res.status, 400)
  assert.ok(res.error.includes('头像'), `实际错误：${res.error}`)

  const me = await ctx.api('GET', '/api/auth/me', { token: user.token })
  assert.equal(me.data.avatar, null)
})

test('普通用户不能改别人的头像：403（越权防护照旧）', async () => {
  const a = await ctx.register({ nickname: '越权甲' })
  const b = await ctx.register({ nickname: '越权乙' })

  const res = await ctx.api('PATCH', `/api/admin/users/${b.user.id}`, {
    token: a.token,
    body: { avatar: null },
  })
  assert.equal(res.status, 403)
  assert.equal(res.error, '需要管理员权限')

  await ctx.api('PATCH', '/api/auth/me', { token: b.token, body: { avatar: PNG_1X1 } })
  const me = await ctx.api('GET', '/api/auth/me', { token: b.token })
  assert.equal(me.data.avatar, PNG_1X1, 'b 的头像不能被 a 弄掉')
})

test('注册返回的用户对象里也带 avatar（形状统一，值是 null）', async () => {
  const res = await ctx.api('POST', '/api/auth/register', {
    body: { username: `shape_${Math.random().toString(36).slice(2, 8)}`, nickname: '形状', password: 'pass123' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.data.avatar, null)
  assert.ok('avatar' in res.data, 'avatar 字段必须存在')
})
