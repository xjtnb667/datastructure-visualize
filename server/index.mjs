/**
 * 后端入口：HTTP 服务 + 路由分发 + 静态文件。
 *
 * 开发模式：只跑 API（端口 3000），前端由 Vite 提供（5173），Vite 把 /api 代理过来；
 * 生产模式：`npm run build` 之后 dist/ 存在，这一个端口就同时提供 API 和前端页面。
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DB_PATH, seededAlgorithms } from './db.mjs'
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

const server = createServer(async (req, res) => {
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
      if (!QUIET.test(pathname)) {
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
})

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const createdAdmin = ensureAdminSeed()

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${PORT} 已被占用。`)
    console.error('很可能是上一次的后端还在运行：先关掉那个黑窗口（或重启电脑）再试一次。\n')
  } else {
    console.error('[错误] 后端启动失败：', err)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log('==================================================')
  console.log('  算法可视化平台 · 后端服务已启动')
  console.log('==================================================')
  console.log(`  接口地址   http://${HOST}:${PORT}/api`)
  console.log(`  数据文件   ${DB_PATH}`)
  console.log(
    `  算法元数据 ${seededAlgorithms > 0 ? `首次初始化，已写入 ${seededAlgorithms} 条算法` : '沿用已有数据'}`,
  )
  if (createdAdmin) console.log(`  管理员账号 已创建：${ADMIN_USERNAME} / ${ADMIN_PASSWORD}（请登录后尽快改密码）`)
  if (HAS_DIST) {
    console.log(`  前端页面   http://${HOST}:${PORT}/   （已发现 dist/，本端口直接访问）`)
  } else {
    console.log('  前端页面   开发模式，请用 Vite 打开的地址（http://localhost:5173/）')
  }
  console.log('  停止服务   按 Ctrl+C，或直接关闭这个窗口')
  console.log('==================================================')
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n后端服务已停止。')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 300).unref()
  })
}
