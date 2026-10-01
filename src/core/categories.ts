import type { AlgoCategoryId, CategoryMeta } from './types'

/**
 * 算法大类（SRS FR-03）。
 * 新增一个大类只需要在这里加一项，两级选择器会自动多出一列。
 */
export const CATEGORIES: CategoryMeta[] = [
  {
    id: 'sort',
    name: '排序',
    summary: '把数据按大小重新排列',
    legend: [
      { color: '#3f6fd8', label: '未排序' },
      { color: '#f59e0b', label: '比较中' },
      { color: '#ef4444', label: '交换 / 移动' },
      { color: '#10b981', label: '已就位' },
      { color: '#8b5cf6', label: '当前指针' },
    ],
  },
  {
    id: 'search',
    name: '查找',
    summary: '在数据中定位目标值',
    legend: [
      { color: '#3f6fd8', label: '候选区间内' },
      { color: '#f59e0b', label: '正在比较' },
      { color: '#8b5cf6', label: 'mid 指针' },
      { color: '#10b981', label: '已命中' },
      { color: '#3a4150', label: '已排除（变暗）' },
    ],
  },
  {
    id: 'linear',
    name: '线性表',
    summary: '顺序存储与链式存储',
    legend: [
      { color: '#3f6fd8', label: '元素 / 结点' },
      { color: '#f59e0b', label: '正在比较' },
      { color: '#ef4444', label: '移动 / 后移' },
      { color: '#8b5cf6', label: '当前指针' },
      { color: '#10b981', label: '已就位 / 命中' },
      { color: '#2b323c', label: '空位（超出表长）' },
    ],
  },
  {
    id: 'stack',
    name: '栈',
    summary: '后进先出的线性结构',
    legend: [
      { color: '#3f6fd8', label: '栈中元素' },
      { color: '#8b5cf6', label: '刚进栈 / 栈顶' },
      { color: '#ef4444', label: '正在出栈' },
      { color: '#10b981', label: '匹配成功 / 计算完成' },
      { color: '#2b323c', label: '空位' },
    ],
  },
  {
    id: 'queue',
    name: '队列',
    summary: '先进先出的线性结构',
    legend: [
      { color: '#3f6fd8', label: '队中元素' },
      { color: '#8b5cf6', label: '刚入队' },
      { color: '#ef4444', label: '正在出队' },
      { color: '#10b981', label: '已完成' },
      { color: '#2b323c', label: '空位' },
    ],
  },
  {
    id: 'matrix',
    name: '数组与矩阵',
    summary: '特殊矩阵的压缩存储与稀疏矩阵',
    legend: [
      { color: '#3f6fd8', label: '矩阵元素' },
      { color: '#8b5cf6', label: '正在定位' },
      { color: '#f59e0b', label: '对应的存储位置' },
      { color: '#10b981', label: '已存入' },
      { color: '#2b323c', label: '不存储 / 零元' },
    ],
  },
  {
    id: 'string',
    name: '串',
    summary: '字符串的存储与模式匹配',
    legend: [
      { color: '#3f6fd8', label: '一般字符' },
      { color: '#8b5cf6', label: '正在比较' },
      { color: '#f59e0b', label: '相等的前后缀' },
      { color: '#10b981', label: '匹配成功' },
      { color: '#ef4444', label: '失配' },
    ],
  },
]

export function getCategory(id: AlgoCategoryId): CategoryMeta {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0]!
}
