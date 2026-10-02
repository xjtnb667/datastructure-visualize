import { ref, watch, type Ref } from 'vue'

/**
 * 极简 hash 路由（**自己写的，零依赖**，不引入 vue-router）。
 *
 * 为什么用 hash 而不是 history API：
 *   1. hash 变化浏览器**不会重新请求页面**，所以本地静态服务（Vite / 后端静态目录）
 *      不需要为 `/favorites` 这种路径配任何 rewrite 规则；
 *   2. 直接把地址复制给别人也能打开同一个页面（答辩演示时省事）；
 *   3. 代码量小到一眼能看完 —— 这个项目总共就三个页面，不值得为它加一个依赖。
 *
 * 路由表：
 *   #/            主界面（算法可视化）
 *   #/favorites   我的收藏 + 学习记录
 *   #/admin       管理员后台
 */

export type RouteName = 'home' | 'favorites' | 'admin'

/** 地址 -> 路由名。带了别的东西（比如 `#/favorites?x=1`）也照样认得出来 */
export function routeNameFromHash(hash: string): RouteName {
  const path = hash.replace(/^#/, '').replace(/^\/*/, '/').split('?')[0]!.replace(/\/+$/, '')
  if (path === '/favorites') return 'favorites'
  if (path === '/admin') return 'admin'
  return 'home'
}

/** 路由名 -> 地址（`navigate` 用；`home` 就是这个平台的默认地址） */
export const ROUTE_PATHS: Record<RouteName, string> = {
  home: '/',
  favorites: '/favorites',
  admin: '/admin',
}

function readHash(): RouteName {
  if (typeof window === 'undefined') return 'home'
  return routeNameFromHash(window.location.hash)
}

/** 当前路由（模块级单例，任何组件拿到的都是同一份） */
const route: Ref<RouteName> = ref(readHash())

/**
 * 浏览器前进 / 后退。只挂一次；赋值放在回调里就够了，
 * `navigate()` 自己会**立刻**改状态，界面不用等下一个 tick。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route.value = readHash()
  })
}

/** 路由名 -> 给用户看的页面标题（浏览器的标签页标题用得上） */
const TITLES: Record<RouteName, string> = {
  home: '算法可视化平台',
  favorites: '我的收藏与学习记录 · 算法可视化平台',
  admin: '后台管理 · 算法可视化平台',
}

watch(route, (name) => {
  if (typeof document === 'undefined') return
  document.title = TITLES[name]
})

/**
 * 跳转。地址栏和状态一起改：
 * `hashchange` 在部分浏览器里是异步派发的，只改 hash 的话界面会慢半拍。
 */
export function navigate(path: string): void {
  const name = routeNameFromHash(path)
  route.value = name
  if (typeof window === 'undefined') return
  const next = `#${path.startsWith('/') ? path : `/${path}`}`
  // 转到同一个地址时浏览器不派发 hashchange，所以状态在上面已经写好了
  if (window.location.hash !== next) window.location.hash = next
}

/** 组合式 API：`const { route } = useRoute()` */
export function useRoute(): { route: Ref<RouteName> } {
  return { route }
}

/**
 * 把地址栏归位到路由表里认识的形式：`#/`、`#/favorites`、`#/admin`。
 * 空地址（首次打开）或写错的地址（`#/fav`）都会被纠正，
 * 免得用户对着一个"什么都不显示"的地址发懵。
 */
export function normalizeHash(): void {
  if (typeof window === 'undefined') return
  const name = readHash()
  const want = `#${ROUTE_PATHS[name]}`
  if (window.location.hash !== want) {
    // history.replaceState 不会派发 hashchange，也不会往历史里塞一条记录
    window.history.replaceState(null, '', want)
  }
  route.value = name
}
