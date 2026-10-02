/**
 * 「手动输入数据」的解析与校验。
 *
 * 用户输入的是**一串数字**，比如 `5,2,9,1,7,3`；逗号可能是英文 `,`、
 * 中文 `，`、顿号 `、`、分号 `;`，也可能干脆用空格隔开。
 * 解析规则就一条：**按这些分隔符切开，每段必须是一个整数** —— 别的一律不算数。
 *
 * 为什么单独一个文件（而不是写在弹窗组件里）：
 *   弹窗只管"输入框、错误提示、确认按钮"，规则是纯函数，拿来直接测最方便；
 *   而且不依赖 DOM，SSR / 单元测试里都能跑。
 *
 * ⚠️ 这里**只做前端第一道校验**（快速给中文提示、不用等算法报错）。
 * 真正的数据规整仍然由算法自己的 `prepareData` 负责 ——
 * 比如折半查找要求输入有序，`load()` 会调它排好序再生成步骤序列。
 */

/** 最少 / 最多几个数 —— 和「数据规模」下拉框的范围（5~12）不冲突，用户手输可以更短 */
export const MIN_COUNT = 2
export const MAX_COUNT = 12
/** 建议的数值范围（提示语里会写出来） */
export const MIN_VALUE = 1
export const MAX_VALUE = 999

/** 分隔符：英文逗号 / 中文逗号 / 顿号 / 分号 / 冒号 / 任意空白 */
const SEPARATOR = /[,，、;；:：\s]+/

export type ManualInputResult =
  | { ok: true; values: number[] }
  | { ok: false; error: string }

/** 把当前数据变成输入框里的初值（"5, 2, 9"），方便用户在现有数据上微调 */
export function formatDataInput(values: readonly number[]): string {
  return values.join(', ')
}

/**
 * 解析用户输入的一串数字。
 *
 * 成功的条件（全满足才算成功）：
 *   1. 去掉首尾空白后不是空的；
 *   2. 每一段都是**整数**（`12.5`、`a`、`1e3` 都不行）；
 *   3. 个数在 `MIN_COUNT` ~ `MAX_COUNT` 之间；
 *   4. 每个数在 `MIN_VALUE` ~ `MAX_VALUE` 之间。
 * 失败返回**中文**说明，界面直接显示它。
 */
export function parseNumberList(raw: string): ManualInputResult {
  const text = (raw ?? '').trim()
  if (!text) return { ok: false, error: '请先输入数据，比如：5, 2, 9, 1, 7, 3' }

  const parts = text.split(SEPARATOR).filter((part) => part.length > 0)
  const values: number[] = []
  for (const part of parts) {
    // 只认纯整数：可选负号 + 数字。小数点 / 字母 / 科学计数法都在这里被挡住
    if (!/^-?\d+$/.test(part)) {
      return { ok: false, error: `「${part}」不是整数，请只输入数字，用逗号或空格分开` }
    }
    values.push(Number(part))
  }

  if (values.length < MIN_COUNT) {
    return { ok: false, error: `至少要输入 ${MIN_COUNT} 个数字（现在只有 ${values.length} 个）` }
  }
  if (values.length > MAX_COUNT) {
    return { ok: false, error: `最多输入 ${MAX_COUNT} 个数字（现在有 ${values.length} 个）` }
  }
  for (const value of values) {
    if (value < MIN_VALUE || value > MAX_VALUE) {
      return {
        ok: false,
        error: `数字要在 ${MIN_VALUE} ~ ${MAX_VALUE} 之间，「${value}」超出了范围`,
      }
    }
  }

  return { ok: true, values }
}
