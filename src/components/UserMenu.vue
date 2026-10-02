<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AuthDialog from '@/components/AuthDialog.vue'
import AvatarDialog from '@/components/AvatarDialog.vue'
import { navigate } from '@/router'
import { useUserStore } from '@/stores/user'

/**
 * 顶栏右上角的用户区。
 *
 * 三种长相：
 *   ① 还没问完服务器"我是谁"（`ready === false`）—— 一个占位，避免顶栏闪一下再变；
 *   ② 游客 —— 一个「登录 / 注册」按钮；
 *   ③ 已登录 —— 头像 + 昵称，点开下拉菜单（我的收藏 / 学习记录 / 更换头像 / 后台管理 / 退出登录）。
 *      其中「后台管理」只有 `role === 'admin'` 才出现
 *      （前端藏着只是为了不难看，后端每个管理接口都会再查一次角色）。
 *
 * 头像那 24px 的圆：**有自定义头像就显示图片，没有就显示昵称第一个字**（`store.avatarText`）。
 * 两种情况都显示在同一个 `.user-avatar` 里，所以切换时顶栏不会跳一下。
 */

const store = useUserStore()

const open = ref(false)
const rootEl = ref<HTMLDivElement | null>(null)
const authDialog = ref<InstanceType<typeof AuthDialog> | null>(null)
const avatarDialog = ref<InstanceType<typeof AvatarDialog> | null>(null)

function toggle(): void {
  open.value = !open.value
}

/** 菜单项统一走这里：先收起菜单，再干正事 */
function run(action: () => void): void {
  open.value = false
  action()
}

function openAuthDialog(tab: 'login' | 'register' = 'login'): void {
  authDialog.value?.open(tab)
}

function openAvatarDialog(): void {
  avatarDialog.value?.open()
}

async function onLogout(): Promise<void> {
  open.value = false
  await store.logout()
}

function onDocPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const el = rootEl.value
  if (el && !el.contains(event.target as Node)) open.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) open.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootEl" class="user-menu">
    <!-- ① 还没确认登录态：占个位，避免"未登录"闪一下 -->
    <span v-if="!store.ready" class="user-skeleton" title="正在读取登录状态…">…</span>

    <!-- ② 游客 -->
    <template v-else-if="!store.isLoggedIn">
      <button class="btn ghost login-btn" @click="openAuthDialog('login')">登录 / 注册</button>
    </template>

    <!-- ③ 已登录 -->
    <template v-else>
      <button class="user-trigger" :class="{ open }" @click="toggle">
        <span class="user-avatar">
          <img v-if="store.hasAvatar" class="avatar-img" :src="store.avatarUrl" alt="头像" />
          <template v-else>{{ store.avatarText }}</template>
        </span>
        <span class="user-name">{{ store.displayName }}</span>
        <span v-if="store.isAdmin" class="user-role">管理员</span>
        <span class="user-caret">▾</span>
      </button>

      <div v-if="open" class="user-dropdown">
        <p class="dropdown-head">
          {{ store.displayName }}
          <span class="dropdown-sub">{{ store.user?.username }}</span>
        </p>

        <button class="dropdown-item" @click="run(() => navigate('/favorites'))">
          <span class="ico">★</span> 我的收藏
          <span class="count">{{ store.favorites.size }}</span>
        </button>

        <button class="dropdown-item" @click="run(() => navigate('/favorites?tab=history'))">
          <span class="ico">🕘</span> 学习记录
          <span class="count">{{ store.history.length }}</span>
        </button>

        <button class="dropdown-item" @click="run(openAvatarDialog)">
          <span class="ico">🖼</span> 更换头像
        </button>

        <button
          v-if="store.isAdmin"
          class="dropdown-item"
          @click="run(() => navigate('/admin'))"
        >
          <span class="ico">⚙</span> 后台管理
        </button>

        <div class="dropdown-sep"></div>

        <button class="dropdown-item danger" @click="onLogout">
          <span class="ico">⎋</span> 退出登录
        </button>
      </div>
    </template>

    <!-- 弹窗挂在用户区里，跟着它一起出现；点收藏触发的登录框也用它 -->
    <AuthDialog ref="authDialog" />
    <!-- 「更换头像」弹窗（下拉菜单里那一项打开它） -->
    <AvatarDialog ref="avatarDialog" />
  </div>
</template>

<style scoped>
.user-menu {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
}

.user-skeleton {
  display: inline-block;
  min-width: 74px;
  padding: 8px 15px;
  font-size: 13.5px;
  color: #4d5561;
  text-align: center;
}

/* 登录 / 注册 按钮 */
.login-btn {
  padding: 7px 14px;
  font-size: 13px;
}

/* ---------- 已登录：头像 + 昵称 ---------- */
.user-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 11px 5px 6px;
  font-family: inherit;
  font-size: 13px;
  color: #e6edf3;
  background: #1b212b;
  border: 1px solid #2c3542;
  border-radius: 20px;
  cursor: pointer;
  transition: border-color 0.14s, background 0.14s;
}

.user-trigger:hover,
.user-trigger.open {
  border-color: #3c4757;
  background: #222a36;
}

/* 有自定义头像时里面是一张 <img>（全局 .avatar-img 把它裁成圆并铺满），
   没有时就是昵称首字。overflow: hidden 保证图片不会溢出这个圆。 */
.user-avatar {
  width: 24px;
  height: 24px;
  flex: none;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
  background: #3f6fd8;
  border-radius: 50%;
  overflow: hidden;
}

.user-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 管理员的身份标识：和「排序」图例里的琥珀色同色系，一眼能认出来 */
.user-role {
  padding: 1px 7px;
  font-size: 10.5px;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.14);
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: 20px;
}

.user-caret {
  font-size: 10px;
  color: #7d8694;
}

/* ---------- 下拉菜单 ---------- */
.user-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 60;
  width: 196px;
  padding: 6px;
  background: #161b23;
  border: 1px solid #2c3542;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}

.dropdown-head {
  margin: 0 0 4px;
  padding: 7px 9px 8px;
  font-size: 13px;
  color: #e6edf3;
  border-bottom: 1px solid #232a35;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dropdown-sub {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: #5c6674;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 9px;
  font-family: inherit;
  font-size: 13px;
  color: #c3cddb;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.dropdown-item:hover {
  background: #1c222c;
  color: #e6edf3;
}

.dropdown-item .ico {
  width: 14px;
  flex: none;
  text-align: center;
  color: #7d8694;
}

.dropdown-item .count {
  margin-left: auto;
  font-size: 11px;
  color: #5c6674;
}

.dropdown-item.danger:hover {
  color: #ef4444;
}

.dropdown-item.danger:hover .ico {
  color: #ef4444;
}

.dropdown-sep {
  margin: 4px 6px;
  border-top: 1px solid #232a35;
}
</style>
