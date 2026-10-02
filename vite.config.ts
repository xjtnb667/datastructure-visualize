import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // '@' -> /src。用 Vite 的根相对路径，省掉 node:path + @types/node
  resolve: { alias: { '@': '/src' } },
  server: {
    // 后端（server/index.mjs）跑在 3000；前端只发 /api/xxx，由这里转发过去。
    // 这样浏览器看到的是同源请求，不需要处理跨域。
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
    watch: {
      // 有些编辑器和工具在保存时会先写一个临时文件/临时目录（形如 .xxx.ts.<pid>.tmpdir），
      // 写完再改名覆盖。Vite 的监听器会去 watch 这个临时文件，正好撞上它被锁住，
      // 抛出 EBUSY 并让整个 dev server 崩掉。忽略掉这些中间产物即可。
      ignored: ['**/*.tmp', '**/*.tmpdir/**', '**/.*.tmpdir/**'],
    },
  },
})
