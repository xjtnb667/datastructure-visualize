/**
 * 后端入口：HTTP 服务 + 路由分发 + 静态文件。
 *
 * 开发模式：只跑 API（端口 3000），前端由 Vite 提供（5173），Vite 把 /api 代理过来；
 * 生产模式：`npm run build` 之后 dist/ 存在，这一个端口就同时提供 API 和前端页面。
 *
 * 可测性（`server/test/` 用）：本文件**在 import 时不再自己监听端口**，
 * 只导出 `createApp()` / `startServer()`；只有"直接运行本文件"时（`node server/index.mjs`）
 * 才走下面的 main()，也就是 `npm run server` 和 `启动项目.bat` 的行为完全没变。
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DB_PATH, db, seededAlgorithms } from './db.mjs'
import { ADMIN_PASSWORD, ADMIN_USERNAME, ensureAdminSeed } from './auth.mjs'
import { HttpError, handleApi, sendError } from './api.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST_DIR = join(ROOT, 'dist')
const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '127.0.0.1'

const HAS_DIST = existsSync(join(DIST_DIR, 'index.html'))

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

function sendFile(res, filePath, status = 200) {
  const ext = extname(filePath).toLowerCase()
  // 带 hash 的构建产物可以长缓存，index.html 必须每次问服务器要
  const immutable = filePath.includes(`${sep}assets${sep}`)
  res.writeHead(status, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': statSync(filePath).size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(filePath).pipe(res)
}

function notFound(res) {
  const body = '404 Not Found'
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * dist/ 里的静态文件。
 * 磁盘上没有这个文件时：
 * - 看起来像文件（带扩展名，如 /assets/x.js）→ 老老实实 404，别把 HTML 当成 JS 回给浏览器；
 * - 看起来像页面路径（/#/favorites 这类 hash 路由刷新时请求的是 /、/favorites）→ 回 index.html。
 */
function serveStatic(req, res, pathname) {
  if (!HAS_DIST) {
    notFound(res)
    return
  }
  let rel = decodeURIComponent(pathname)
  if (rel.endsWith('/')) rel += 'index.html'

  const target = normalize(join(DIST_DIR, rel))
  const insideDist = target === DIST_DIR || target.startsWith(DIST_DIR + sep)
  if (insideDist && existsSync(target) && statSync(target).isFile()) {
    sendFile(res, target)
    return
  }

  const last = rel.slice(rel.lastIndexOf('/') + 1)
  if (last.includes('.') && !last.endsWith('.html')) {
    notFound(res)
    return
  }
  sendFile(res, join(DIST_DIR, 'index.html'))
}

// ---------------------------------------------------------------------------
// 请求分发
// ---------------------------------------------------------------------------
const QUIET = /\.(ico|png|jpg|jpeg|svg|webp|woff2?|ttf|map)$/i
/** 每来一个 API 请求打一行日志（默认开）。自动化测试把它关掉，输出才看得清 */
const API_LOG = process.env.SERVER_API_LOG !== '0'

/** 每个 HTTP 服务共用的请求处理函数（不监听端口，纯逻辑，方便测试） */
async function requestListener(req, res) {
  const started = Date.now()
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)
  const pathname = url.pathname
  const isApi = pathname === '/api' || pathname.startsWith('/api/')

  try {
    if (isApi) {
      // /api/xxx → /xxx（路由表里都写成不带前缀的相对路径）
      const rest = pathname.slice('/api'.length) || '/'
      url.pathname = rest
      try {
        await handleApi(req, res, url)
      } catch (err) {
        sendError(res, err)
      }
      if (API_LOG && !QUIET.test(pathname)) {
        console.log(`[api] ${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - started}ms)`)
      }
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, new HttpError(405, '该地址只支持 GET 请求'))
      return
    }
    serveStatic(req, res, pathname)
  } catch (err) {
    console.error('[server] 未处理的错误：', err)
    if (!res.headersSent) sendError(res, new HttpError(500, '服务器内部错误'))
    else res.end()
  }
}

/**
 * 组装一个 HTTP 服务（**还没开始监听**），并把管理员种子账号准备好。
 *
 * 测试怎么用：先在 import 之前设好 `process.env.DB_PATH`（指向临时文件），
 * 再调 `startServer({ port: 0 })` —— 端口由系统分配（`server.address().port`），
 * 不会和正在跑的 3000 撞车；测完 `close()`。
 */
export function createApp({ dbPath } = {}) {
  // db.mjs 在 import 时就把数据库打开了，所以这里改不了路径。
  // 传了不一致的路径就直接报错，而不是"悄悄连上真实数据库"。
  if (dbPath !== undefined && resolve(dbPath) !== resolve(DB_PATH)) {
    throw new Error(
      `createApp() 改不了数据库路径（当前用的是 ${DB_PATH}）：请在 import server/index.mjs 之前设置环境变量 DB_PATH`,
    )
  }
  const createdAdmin = ensureAdminSeed()
  const server = createServer(requestListener)
  return { server, db, createdAdmin }
}

/**
 * 启动后端并等它**真的在监听**之后才 resolve。
 * @param {{ port?: number, host?: string, dbPath?: string }} [options]
 *   `port` 传 0 = 让系统分配随机端口（测试用）；`dbPath` 只用于"确认路径没传错"
 * @returns {Promise<{ server: import('node:http').Server, db: unknown, createdAdmin: boolean,
 *                     host: string, port: number, url: string, close: () => Promise<void> }>}
 */
export function startServer({ port = PORT, host = HOST, dbPath } = {}) {
  const app = createApp({ dbPath })
  return new Promise((resolvePromise, rejectPromise) => {
    app.server.once('error', rejectPromise)
    app.server.listen(port, host, () => {
      app.server.removeListener('error', rejectPromise)
      const actualPort = app.server.address().port
      resolvePromise({
        ...app,
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () => new Promise((done) => app.server.close(() => done())),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// 直接运行本文件时（`npm run server` / `启动项目.bat`）才启动，行为与以前一致
// ---------------------------------------------------------------------------
async function main() {
  let app
  try {
    app = await startServer({ port: PORT, host: HOST })
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n[错误] 端口 ${PORT} 已被占用。`)
      console.error('很可能是上一次的后端还在运行：先关掉那个黑窗口（或重启电脑）再试一次。\n')
    } else {
      console.error('[错误] 后端启动失败：', err)
    }
    process.exit(1)
  }

  console.log('==================================================')
  console.log('  算法可视化平台 · 后端服务已启动')
  console.log('==================================================')
  console.log(`  接口地址   http://${app.host}:${app.port}/api`)
  console.log(`  数据文件   ${DB_PATH}`)
  console.log(
    `  算法元数据 ${seededAlgorithms > 0 ? `首次初始化，已写入 ${seededAlgorithms} 条算法` : '沿用已有数据'}`,
  )
  if (app.createdAdmin) console.log(`  管理员账号 已创建：${ADMIN_USERNAME} / ${ADMIN_PASSWORD}（请登录后尽快改密码）`)
  if (HAS_DIST) {
    console.log(`  前端页面   http://${app.host}:${app.port}/   （已发现 dist/，本端口直接访问）`)
  } else {
    console.log('  前端页面   开发模式，请用 Vite 打开的地址（http://localhost:5173/）')
  }
  console.log('  停止服务   按 Ctrl+C，或直接关闭这个窗口')
  console.log('==================================================')

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\n后端服务已停止。')
      app.server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 300).unref()
    })
  }
}

// 只有"命令行直接跑这个文件"才启动；被 import（比如测试）时什么都不做
const INVOKED_PATH = process.argv[1]
if (INVOKED_PATH && import.meta.url === pathToFileURL(INVOKED_PATH).href) {
  main()
}
