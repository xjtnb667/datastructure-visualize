<script setup lang="ts">
import { computed, ref } from 'vue'
import { useUserStore } from '@/stores/user'

/**
 * 登录 / 注册弹窗。
 *
 * 深色主题居中弹窗，两个标签页。
 * 前端先校验一遍（规则见《用户与管理员系统-设计.md》第 5 节：
 *   用户名 3~20 位字母数字下划线、密码至少 6 位、两次密码要一致），
 * 校验过了才发请求 —— 少一次往返，也少一次让用户等的机会。
 * 后端返回的中文错误原样显示给用户（比如"用户名已被占用"）。
 */

const store = useUserStore()

const visible = ref(false)
const mode = ref<'login' | 'register'>('login')
const busy = ref(false)
const error = ref('')

const loginName = ref('')
const loginPassword = ref('')

const regName = ref('')
const regNickname = ref('')
const regPassword = ref('')
const regConfirm = ref('')

/** 打开弹窗；父组件传 'register' 就直接落在注册页 */
function open(tab: 'login' | 'register' = 'login'): void {
  mode.value = tab
  error.value = ''
  visible.value = true
}

function close(): void {
  visible.value = false
  error.value = ''
  // 密码不在界面上留：关掉就把输入框清空
  loginPassword.value = ''
  regPassword.value = ''
  regConfirm.value = ''
}

function switchMode(next: 'login' | 'register'): void {
  mode.value = next
  error.value = ''
}

/** 用户名的格式问题（两个标签页共用同一套规则） */
function nameProblem(name: string): string {
  if (!name) return '请输入用户名'
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return '用户名要 3~20 位，只能用字母、数字和下划线'
  return ''
}

async function submitLogin(): Promise<void> {
  const name = loginName.value.trim()
  const problem = nameProblem(name)
  if (problem) {
    error.value = problem
    return
  }
  if (!loginPassword.value) {
    error.value = '请输入密码'
    return
  }

  busy.value = true
  error.value = ''
  try {
    await store.login(name, loginPassword.value)
    close()
  } catch (err) {
    error.value = store.errorText(err)
  } finally {
    busy.value = false
  }
}

async function submitRegister(): Promise<void> {
  const name = regName.value.trim()
  const nickname = regNickname.value.trim()
  const problem = nameProblem(name)
  if (problem) {
    error.value = problem
    return
  }
  if (!nickname) {
    error.value = '请输入昵称（显示在右上角的名字）'
    return
  }
  if (nickname.length > 20) {
    error.value = '昵称最多 20 个字'
    return
  }
  if (regPassword.value.length < 6) {
    error.value = '密码至少 6 位'
    return
  }
  if (regPassword.value !== regConfirm.value) {
    error.value = '两次输入的密码不一致，请再检查一遍'
    return
  }

  busy.value = true
  error.value = ''
  try {
    await store.register(name, nickname, regPassword.value)
    close()
  } catch (err) {
    error.value = store.errorText(err)
  } finally {
    busy.value = false
  }
}

/**
 * 给父组件用的开关。
 * `open()` 是主要入口；`visible` 也放出去，是为了让父组件（以及自动化测试）
 * 能在需要时直接读 / 写"弹窗开着没有"，而不用为了看一眼状态再包一层。
 */
defineExpose({ open, close, visible })

const title = computed(() => (mode.value === 'login' ? '登录' : '注册新账号'))
</script>

<template>
  <div v-if="visible" class="auth-mask" @click.self="close">
    <div class="auth-dialog" role="dialog" aria-modal="true" :aria-label="title">
      <div class="auth-head">
        <div class="auth-tabs">
          <button
            class="auth-tab"
            :class="{ on: mode === 'login' }"
            type="button"
            @click="switchMode('login')"
          >
            登录
          </button>
          <button
            class="auth-tab"
            :class="{ on: mode === 'register' }"
            type="button"
            @click="switchMode('register')"
          >
            注册
          </button>
        </div>
        <button class="auth-close" type="button" title="关闭" @click="close">✕</button>
      </div>

      <!-- 说明文字只在登录页出现（注册页那句话已按要求删掉，不留空容器撑间距） -->
      <p v-if="mode === 'login'" class="auth-hint">登录后可以收藏算法、查看自己的学习记录。</p>

      <!-- 登录 -->
      <form v-if="mode === 'login'" class="auth-form" @submit.prevent="submitLogin">
        <label class="field">
          <span>用户名</span>
          <input
            v-model="loginName"
            type="text"
            autocomplete="username"
            placeholder="3~20 位字母、数字或下划线"
            :disabled="busy"
          />
        </label>

        <label class="field">
          <span>密码</span>
          <input
            v-model="loginPassword"
            type="password"
            autocomplete="current-password"
            placeholder="至少 6 位"
            :disabled="busy"
          />
        </label>

        <p v-if="error" class="auth-error">{{ error }}</p>

        <div class="auth-actions">
          <button class="btn ghost" type="button" :disabled="busy" @click="close">取消</button>
          <button class="btn primary" type="submit" :disabled="busy">
            {{ busy ? '登录中…' : '登录' }}
          </button>
        </div>
      </form>

      <!-- 注册 -->
      <form v-else class="auth-form" @submit.prevent="submitRegister">
        <label class="field">
          <span>用户名</span>
          <input
            v-model="regName"
            type="text"
            autocomplete="username"
            placeholder="3~20 位字母、数字或下划线，登录时用"
            :disabled="busy"
          />
        </label>

        <label class="field">
          <span>昵称</span>
          <input
            v-model="regNickname"
            type="text"
            autocomplete="nickname"
            placeholder="想显示在右上角的名字"
            :disabled="busy"
          />
        </label>

        <label class="field">
          <span>密码</span>
          <input
            v-model="regPassword"
            type="password"
            autocomplete="new-password"
            placeholder="至少 6 位"
            :disabled="busy"
          />
        </label>

        <label class="field">
          <span>确认密码</span>
          <input
            v-model="regConfirm"
            type="password"
            autocomplete="new-password"
            placeholder="再输一遍刚才的密码"
            :disabled="busy"
          />
        </label>

        <p v-if="error" class="auth-error">{{ error }}</p>

        <div class="auth-actions">
          <button class="btn ghost" type="button" :disabled="busy" @click="close">取消</button>
          <button class="btn primary" type="submit" :disabled="busy">
            {{ busy ? '注册中…' : '注册并登录' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
