/**
 * 只给 `vite.config.ts` 用的、极小的一份 Node 内置模块声明。
 *
 * 为什么需要它：这个项目的 tsconfig 只带 `vite/client` 类型，**故意不装 `@types/node`**
 * （见 vite.config.ts 里「用 Vite 的根相对路径，省掉 node:path + @types/node」那条注释）。
 * 现在 vite.config.ts 要自动拉起后端，就得用到 `node:child_process` / `node:net` ——
 * 与其为两个函数装一整套 `@types/node`，不如在这里**只声明真正用到的那几个成员**。
 *
 * 这个文件里没有 import / export，所以它是**全局声明**（ambient），由 vite.config.ts
 * 顶部的 `/// <reference path="./node-builtins.d.ts" />` 引入。它**只管类型检查**，不参与运行。
 */

declare var process: {
  /** 当前 Node 可执行文件（用 `process.execPath` 起后端，不依赖 PATH 里有没有 `node`） */
  execPath: string
  env: Record<string, string | undefined>
  cwd(): string
  on(event: 'exit' | 'SIGINT' | 'SIGTERM', listener: () => void): void
  once(event: 'exit' | 'SIGINT' | 'SIGTERM', listener: () => void): void
  exit(code?: number): void
}

declare module 'node:child_process' {
  export interface ChildProcess {
    readonly pid?: number
    kill(signal?: string): boolean
    once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd?: string
      /** 只允许 'inherit'（透传到当前终端）/ 'ignore'；**不要用默认的管道**，某些环境会 EPERM */
      stdio: 'inherit' | 'ignore'
      env?: Record<string, string | undefined>
    },
  ): ChildProcess
}

declare module 'node:net' {
  export interface Socket {
    destroy(): void
    setTimeout(ms: number, listener: () => void): void
    once(event: 'connect', listener: () => void): void
    once(event: 'error', listener: (err: Error) => void): void
  }
  export function connect(options: { port: number; host: string }): Socket
}
