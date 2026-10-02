<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  AVATAR_DATA_URL_RE,
  AVATAR_MAX_BASE64,
  avatarBase64Length,
} from '@/api/client'
import { useUserStore } from '@/stores/user'

/**
 * 「更换头像」弹窗。
 *
 * 四件事：① 看当前头像 ② 选图并**实时预览** ③ 保存 ④ 恢复默认（清除头像）。
 * 外观沿用全局的 `.auth-mask` / `.auth-dialog` 那一套（和登录框、后台弹窗同一个长相）。
 *
 * ## 为什么要在前端压图片（这一步是这个功能的关键）
 * 用户随手拍的一张手机照片就有 3~5MB，直接当 data URL 上传的话：
 * 数据库一行被撑到几 MB、每次读 `me` 都要传几 MB、后台列表拉 10 个用户就是几十 MB。
 * 所以选完图**先在本机处理**：
 *   `<input type="file">` → `FileReader` 读成 data URL → 画进 `<canvas>`，
 *   **居中裁成正方形 → 缩到 128×128** → `canvas.toDataURL('image/jpeg', 0.85)`。
 * 出来的通常只有 5~15KB，比原图小两三个数量级。
 * 这套全是浏览器自带的能力（FileReader / Image / canvas），**零新增依赖** ——
 * 否则为了压个图要装一个图片处理库，对一个"双击就能跑"的交付物不划算。
 */
const store = useUserStore()

/** 头像的边长（正方形）。128 够顶栏 24px 和后台列表 24px 用，还能在高分屏下清楚 */
const AVATAR_SIZE = 128
/** JPEG 质量：0.85 是"看不出压缩痕迹"和"体积小"的常规平衡点 */
const JPEG_QUALITY = 0.85
/** 单张原图的最大值：再大就不是"头像"了，读进内存也没意义（压缩后只有几 KB） */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024

const visible = ref(false)
const busy = ref(false)
const error = ref('')

/** 打开弹窗那一刻的头像（用来判断"改了没有"，决定保存按钮亮不亮） */
const original = ref('')
/** 当前预览用的 data URL；空串 = 没有头像（显示昵称首字占位） */
const preview = ref('')

const fileInput = ref<HTMLInputElement | null>(null)

/** 和打开时相比改过没有 */
const dirty = computed(() => preview.value !== original.value)

/** 预览图的大小（KB）。画完就固定是 128×128 的 JPEG，报出来用户心里有数 */
const previewKb = computed(() => {
  if (!preview.value) return 0
  const bytes = Math.round((avatarBase64Length(preview.value) * 3) / 4)
  return bytes / 1024
})

const sizeText = computed(() => {
  if (!preview.value) return '当前没有自定义头像，显示昵称的第一个字'
  const kb = previewKb.value
  return `压缩后约 ${kb < 1 ? '不到 1' : Math.round(kb)} KB（128 × 128 的 JPEG）`
})

function open(): void {
  original.value = store.avatarUrl
  preview.value = store.avatarUrl
  error.value = ''
  busy.value = false
  if (fileInput.value) fileInput.value.value = '' // 同一个文件再选一次也要能触发 change
  visible.value = true
}

function close(): void {
  if (busy.value) return
  visible.value = false
  error.value = ''
  preview.value = ''
  original.value = ''
  if (fileInput.value) fileInput.value.value = ''
}

// ---------------------------------------------------------------------------
// 选图 → 压缩
// ---------------------------------------------------------------------------
/** 文件读成 data URL（原图，可能有好几 MB，只在本机内存里过一下） */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('这个文件读不出来，请换一张图片试试'))
    reader.readAsDataURL(file)
  })
}

/** data URL → 可绘制的图片（这一步同时验证了"它真的是张图"） */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('这个文件不是能识别的图片，请换一张'))
    img.src = src
  })
}

/**
 * 居中裁成正方形 → 缩到 128×128 → 导出 JPEG。
 * JPEG 没有透明通道，所以先铺一层白底（不然透明 PNG 的区域会变成纯黑）。
 */
function compress(img: HTMLImageElement): string {
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  if (!side) throw new Error('这张图片读不出尺寸，请换一张')

  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持图片处理，请换一个浏览器再试')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE)
  ctx.drawImage(
    img,
    Math.floor((img.naturalWidth - side) / 2), // 裁掉左右多出来的部分
    Math.floor((img.naturalHeight - side) / 2), // 裁掉上下多出来的部分
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  )
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  busy.value = true
  error.value = ''
  void (async () => {
    try {
      if (!file.type.startsWith('image/')) {
        throw new Error('请选择图片文件（PNG / JPEG / WebP / GIF）')
      }
      if (file.size > MAX_SOURCE_BYTES) {
        throw new Error('原图太大了（超过 20MB），请换一张小一点的图片')
      }

      const compressed = compress(await loadImage(await readAsDataUrl(file)))

      // 128×128 的 JPEG 正常只有几 KB，真撞上这个上限说明遇到了极端图片
      if (avatarBase64Length(compressed) > AVATAR_MAX_BASE64) {
        throw new Error('压缩后还是太大，请换一张内容简单一点的图片')
      }
      if (!AVATAR_DATA_URL_RE.test(compressed)) {
        throw new Error('图片处理失败，请换一张图片再试')
      }
      preview.value = compressed
    } catch (err) {
      error.value = err instanceof Error && err.message ? err.message : '处理这张图片失败了，请换一张'
    } finally {
      busy.value = false
      input.value = '' // 清空，保证再选同一个文件也有 change 事件
    }
  })()
}

// ---------------------------------------------------------------------------
// 保存 / 恢复默认
// ---------------------------------------------------------------------------
async function save(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    // 预览为空 = 用户点了"恢复默认"，明确传 null（后端把这一列置成 NULL）
    await store.updateAvatar(preview.value === '' ? null : preview.value)
    close()
  } catch (err) {
    // 后端的中文说明原样显示（比如"头像太大了…"）
    error.value = store.errorText(err)
  } finally {
    busy.value = false
  }
}

/** 恢复默认：**先只改预览**，等用户点保存才真的提交（不然"手滑点一下"就没了） */
function useDefault(): void {
  preview.value = ''
  error.value = ''
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) close()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

defineExpose({ open, close, visible })
</script>

<template>
  <div v-if="visible" class="auth-mask" @click.self="close">
    <div class="auth-dialog avatar-dialog" role="dialog" aria-modal="true" aria-label="更换头像">
      <div class="auth-head">
        <h3 class="avatar-title">更换头像</h3>
        <button class="auth-close" type="button" title="关闭（Esc）" @click="close">✕</button>
      </div>

      <p class="auth-hint">
        选一张图片，会自动居中裁成方形并压缩成 128 × 128 的 JPEG 再上传 ——
        原图再大也不会把数据库撑大。
      </p>

      <div class="avatar-body">
        <!-- 实时预览：有图就显示图，没有就显示昵称首字（= 顶栏那个占位的样子） -->
        <img v-if="preview" class="avatar-preview" :src="preview" alt="头像预览" />
        <span v-else class="avatar-preview avatar-placeholder">{{ store.avatarText }}</span>

        <div class="avatar-side">
          <label class="btn ghost avatar-pick" :class="{ disabled: busy }">
            {{ busy ? '处理中…' : '选择图片' }}
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              :disabled="busy"
              @change="onPick"
            />
          </label>
          <p class="avatar-size">{{ sizeText }}</p>
          <p v-if="preview && dirty" class="avatar-tag">还没保存，点下面的「保存」才生效</p>
          <p v-else-if="!preview && dirty" class="avatar-tag">保存后头像会恢复成昵称首字</p>
        </div>
      </div>

      <p v-if="error" class="auth-error">{{ error }}</p>

      <div class="auth-actions">
        <button
          class="btn ghost"
          type="button"
          :disabled="busy || !preview"
          title="清除自定义头像，改回昵称首字"
          @click="useDefault"
        >
          恢复默认
        </button>
        <button class="btn ghost" type="button" :disabled="busy" @click="close">取消</button>
        <button
          class="btn primary"
          type="button"
          :disabled="busy || !dirty"
          @click="save"
        >
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>
