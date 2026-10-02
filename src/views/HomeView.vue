<script setup lang="ts">
import { computed } from 'vue'
import { CATEGORIES } from '@/core/categories'
import { algorithmRegistry } from '@/algorithms'
import { navigate } from '@/router'
import UserMenu from '@/components/UserMenu.vue'

/**
 * 首页（落地页）。
 *
 * 它只干三件事：
 *   1. 把"这个平台是什么"用一行大字说清楚（算法可视化平台）；
 *   2. 给一个明确的下一步 —— `进入学习-->` 按钮，点了进 `#/learn` 的算法界面；
 *   3. 右上角留一个用户区（登录 / 注册 / 我的收藏），不然用户在首页没法登录。
 *
 * 顶栏（logo + 算法选择器）刻意**不在首页显示**（见 App.vue 的 `v-if="route !== 'home'"`），
 * 首页要干净；算法选择器在还没进算法界面时也没有意义。
 *
 * 规模数字**从代码里数出来**（注册表 + 大类表），不是写死的文案 ——
 * 以后加算法，首页这行字会自己跟着变。
 */

const categoryCount = CATEGORIES.length
const algorithmCount = algorithmRegistry.length

const stats = computed(() => [
  `${categoryCount} 个大类`,
  `${algorithmCount} 个算法`,
  '代码与动画逐帧同步',
])
</script>

<template>
  <main class="home">
    <!-- 首页没有顶栏，用户区单独放在右上角（登录 / 注册 / 我的收藏都在这里） -->
    <div class="home-top">
      <UserMenu />
    </div>

    <div class="home-hero">
      <h1 class="home-title">算法可视化平台</h1>
      <p class="home-sub">
        数据结构与算法的可视化学习工具：选一个算法，边看动画边对照代码，每一步都讲清楚在做什么。
      </p>
      <p class="home-stats">
        <span v-for="(item, index) in stats" :key="item" class="stat">
          <i v-if="index > 0" class="dot">·</i>{{ item }}
        </span>
      </p>
      <!-- 按钮文字就是用户要求的那串字符（两个减号 + 一个大于号），直接写可以见字符 -->
      <button class="home-enter" @click="navigate('/learn')">进入学习--></button>
    </div>
  </main>
</template>

<style scoped>
/*
 * 首页。
 * 配色沿用全局那套（底 #0b0e13、面板 #12161d、主色 #3f6fd8），
 * 只在背后加一层极淡的主色径向渐变当装饰 —— 不用任何图片文件。
 */
.home {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(circle at 50% 0%, rgba(63, 111, 216, 0.16), transparent 58%),
    radial-gradient(circle at 50% 118%, rgba(63, 111, 216, 0.1), transparent 52%),
    #12161d;
  border: 1px solid #232a35;
  border-radius: 12px;
  overflow: hidden;
}

.home-top {
  display: flex;
  justify-content: flex-end;
  padding: 14px 18px 0;
}

.home-hero {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 24px 24px 56px;
  text-align: center;
}

/*
 * 一行大字。桌面上 64px，靠 clamp 在窄屏自动收小（最小 30px），
 * 用主色渐变做质感但不加阴影 / 描边，保持毕业设计该有的稳重。
 */
.home-title {
  margin: 0;
  font-size: clamp(30px, 7.2vw, 64px);
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: 2px;
  background: linear-gradient(180deg, #ffffff 0%, #b9cdf5 100%);
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}

.home-sub {
  margin: 0;
  max-width: 620px;
  font-size: 15px;
  line-height: 1.85;
  color: #8b949e;
}

.home-stats {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 0;
  font-size: 12.5px;
  color: #5c6674;
}

.stat {
  display: inline-flex;
  align-items: center;
}

.dot {
  margin: 0 9px;
  font-style: normal;
  color: #333c4a;
}

/*
 * 「进入学习-->」。文字用模板里的纯文本，这里只负责把它做大做显眼：
 * 主色实底 + 悬停提亮 + 按下微沉，和全局 .btn.primary 是同一套语言。
 */
.home-enter {
  margin-top: 8px;
  padding: 14px 40px;
  font-size: 17px;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: 1px;
  color: #ffffff;
  background: #3f6fd8;
  border: 1px solid #4b7ce6;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.16s, border-color 0.16s, transform 0.06s, box-shadow 0.16s;
}

.home-enter:hover {
  background: #4b7ce6;
  border-color: #5b8bf0;
  box-shadow: 0 8px 24px rgba(63, 111, 216, 0.34);
}

.home-enter:active {
  transform: translateY(1px);
}

/* 窄屏：字变小、按钮变窄，副标题的行距收一点，避免挤成一团 */
@media (max-width: 900px) {
  .home-hero {
    gap: 14px;
    padding: 16px 16px 36px;
  }

  .home-title {
    letter-spacing: 1px;
  }

  .home-sub {
    font-size: 13.5px;
    line-height: 1.75;
  }

  .home-stats {
    font-size: 12px;
  }

  .home-enter {
    padding: 12px 28px;
    font-size: 15.5px;
  }
}
</style>
