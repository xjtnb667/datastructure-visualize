/// <reference path="./node-builtins.d.ts" />
import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/** 后端端口：和 `server/index.mjs` 的默认端口、下面 proxy 的目标保持一致 */
const BACKEND_PORT = 3000

/**
 * 3000 端口上已经有人在监听了吗？（只探一下，不发 HTTP 请求）
 * 连得上 = 已有后端在跑；连不上 / 超时 = 空着。
 */
function isBackendRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (running: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(running)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1000, () => done(false))
  })
}

/**
 * 让 `npm run dev` **顺手把后端也带起来**。
 *
 * 起因：只跑 `npm run dev` 时前端是好的，但登录 / 收藏全报错，因为后端没人起；
 * 用户很容易忘掉"还要再起一个服务"这件事。所以把"起后端"并进前端启动里。
 *
 * 三条规矩：
 * 1. **已经在跑就不重复起** —— 3000 被监听时直接跳过（否则第二个后端会因端口占用立刻退出）；
 * 2. **Vite 关了，后端跟着关** —— Ctrl+C / 关窗口都不留孤儿进程；
 * 3. **只在 dev 生效** —— `npm run build` 不碰后端（靠 `apply: 'serve'`）。
 *
 * 想临时关掉这个行为：`NO_AUTO_SERVER=1 npm run dev`。
 */
function autoStartBackend(): Plugin {
  let child: ChildProcess | null = null
  /** true = 这次退出是我们主动杀的，不用再当成"后端自己挂了"来提示 */
  let stopping = false

  /** 只杀"自己起的那个"；3000 上原本跑着的后端不归我们管，不动它 */
  function stopChild(): void {
    const proc = child
    if (!proc) return
    child = null
    stopping = true
    try {
      proc.kill()
    } catch {
      // 已经退出了，什么都不用做
    }
  }

  return {
    name: 'algo:auto-start-backend',
    // 只作用于 vite serve（开发）；build 时这个插件根本不生效
    apply: 'serve',

    async configureServer(server) {
      // vitest 也会加载这份配置（它内部就是一个 Vite server），但那是"跑测试"，不是"用户在起开发服务器"：
      // 这里绝不能起后端 —— 一是测试不该有副作用（起的是真后端，会碰真的 server/data/app.db），
      // 二是那个子进程句柄会让 vitest 报 "something prevents Vite server from exiting"。静默跳过。
      if (process.env.VITEST || server.config.mode === 'test') return

      if (process.env.NO_AUTO_SERVER === '1') {
        console.log('[后端] NO_AUTO_SERVER=1，跳过自动启动（要后端请自己跑 npm run server）')
        return
      }

      if (await isBackendRunning(BACKEND_PORT)) {
        console.log(`[后端] 已在 ${BACKEND_PORT} 端口运行，跳过`)
        return
      }

      console.log(`[后端] 正在启动…  node server/index.mjs（端口 ${BACKEND_PORT}）`)
      const proc = spawn(process.execPath, ['server/index.mjs'], {
        // 项目根目录 = vite.config.ts 所在目录，等价于手动跑 `npm run server`
        cwd: server.config.root,
        // 后端的横幅直接印在这个终端里，用户一眼能看出后端起没起。
        // 必须是 'inherit'：默认的管道 stdio 在这台机器上会 EPERM。
        stdio: 'inherit',
      })
      child = proc

      proc.once('exit', (code) => {
        if (child === proc) child = null
        if (stopping) return
        console.log(`[后端] 后端进程退出了（code ${code === null ? '被信号终止' : code}）—— 登录 / 收藏暂时不可用`)
      })

      // —— 清理：Vite 一关就把后端一起带走（Ctrl+C / 关窗口都不留孤儿）——
      server.httpServer?.once('close', () => {
        if (!child) return
        console.log('[后端] Vite 已关闭，正在停止后端…')
        stopChild()
        console.log('[后端] 已停止')
      })
      // 兜底：进程正常退出、以及 Ctrl+C / 被 kill 的情况
      process.once('exit', stopChild)
      process.once('SIGINT', () => {
        stopChild()
        process.exit(0)
      })
      process.once('SIGTERM', () => {
        stopChild()
        process.exit(0)
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), autoStartBackend()],
  // '@' -> /src。用 Vite 的根相对路径，省掉 node:path + @types/node
  resolve: { alias: { '@': '/src' } },
  server: {
    // 后端（server/index.mjs）跑在 3000；前端只发 /api/xxx，由这里转发过去。
    // 这样浏览器看到的是同源请求，不需要处理跨域。
    proxy: {
      '/api': { target: `http://localhost:${BACKEND_PORT}`, changeOrigin: true },
    },
    watch: {
      // 有些编辑器和工具在保存时会先写一个临时文件/临时目录（形如 .xxx.ts.<pid>.tmpdir），
      // 写完再改名覆盖。Vite 的监听器会去 watch 这个临时文件，正好撞上它被锁住，
      // 抛出 EBUSY 并让整个 dev server 崩掉。忽略掉这些中间产物即可。
      ignored: ['**/*.tmp', '**/*.tmpdir/**', '**/.*.tmpdir/**'],
    },
  },
})
