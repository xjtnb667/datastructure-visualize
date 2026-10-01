/** 柱状图 / 单元格 / 结点共用的配色。用 RGB 三元组是为了能在动画里做颜色插值 */
export type RGB = readonly [number, number, number]

export const PALETTE: Record<'base' | 'compare' | 'swap' | 'sorted' | 'mark', RGB> = {
  base: [63, 111, 216],
  compare: [245, 158, 11],
  swap: [239, 68, 68],
  sorted: [16, 185, 129],
  mark: [139, 92, 246],
}

export type PaletteKey = keyof typeof PALETTE

export const css = (c: RGB) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`

/** 颜色线性插值：t=0 取 a，t=1 取 b */
export function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}
