import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { SIZES, SQUARE_SIZES, useAlgorithmStore } from './algorithm'

/**
 * 直接驱动 store（不需要 DOM）。验证的核心是：
 * 光标一动，currentLine 和 currentArray 必然跟着动，且永远来自同一帧。
 */
describe('useAlgorithmStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('只有特殊矩阵压缩存储要求平方数规模，其余算法走常规列表', () => {
    const store = useAlgorithmStore()

    store.selectAlgorithm('bubble-sort')
    expect(store.sizes).toEqual([...SIZES])

    // 这三种是把一维数据按 n = √len 还原成 n×n 的，
    // 规模给非平方数就会"输入 12 个数、矩阵里只出现 9 个"。
    for (const id of ['matrix-symmetric', 'matrix-triangular', 'matrix-diagonal']) {
      store.selectAlgorithm(id)
      expect(store.sizes, `${id} 的数据规模应该是平方数`).toEqual([...SQUARE_SIZES])
      expect(store.sizes).toContain(store.dataSize)
    }

    // 稀疏矩阵对规模没有平方数要求，保持常规列表
    for (const id of ['sparse-triple', 'sparse-cross']) {
      store.selectAlgorithm(id)
      expect(store.sizes, `${id} 不该被改成平方数`).toEqual([...SIZES])
    }

    // 当前值如果不在列表里也要补进去，否则 <select> 会显示空白
    store.selectAlgorithm('bubble-sort')
    store.setDataSize(9)
    expect(store.sizes).toContain(9)
  })

  it('load() 后预计算步骤、光标归零、首帧是初始数组', () => {
    const store = useAlgorithmStore()
    store.load([3, 1, 2])

    expect(store.totalSteps).toBeGreaterThan(1)
    expect(store.currentStepIndex).toBe(0)
    expect(store.currentLine).toBe(1)
    expect(store.currentAction).toBe('init')
    expect(store.currentArray).toEqual([3, 1, 2])
    expect(store.canPrev).toBe(false)
    expect(store.canNext).toBe(true)
    expect(store.codeLines[store.currentLine - 1]).toContain('bubbleSort')
  })

  it('nextStep 让高亮行走下去，prevStep 精确走回来', () => {
    const store = useAlgorithmStore()
    store.load([3, 1, 2])

    store.nextStep()
    expect(store.currentStepIndex).toBe(1)
    expect(store.currentLine).toBe(4) // 第一个事件：比较，C++ 源码 line 4

    store.nextStep()
    expect(store.currentStepIndex).toBe(2)
    expect(store.currentLine).toBe(5) // 3 > 1，交换，C++ 源码 line 5
    expect(store.currentArray).toEqual([1, 3, 2])

    store.prevStep()
    expect(store.currentStepIndex).toBe(1)
    expect(store.currentLine).toBe(4)
    expect(store.currentArray).toEqual([3, 1, 2])

    store.prevStep()
    expect(store.currentStepIndex).toBe(0)
    expect(store.currentArray).toEqual([3, 1, 2])
  })

  it('currentLine 永远等于当前帧自己记的行号（不可能错位）', () => {
    const store = useAlgorithmStore()
    store.load([3, 1, 2])

    while (store.canNext) {
      expect(store.currentLine).toBe(store.currentStep!.line)
      expect(store.currentArray).toBe(store.currentStep!.array)
      store.nextStep()
    }
    expect(store.currentAction).toBe('done')
    expect(store.currentArray).toEqual([1, 2, 3])
    expect(store.canNext).toBe(false)
  })

  it('到尾步继续点 next 不越界，到首步继续点 prev 不越界', () => {
    const store = useAlgorithmStore()
    store.load([2, 1])

    for (let i = 0; i < store.totalSteps + 10; i++) store.nextStep()
    expect(store.currentStepIndex).toBe(store.totalSteps - 1)

    for (let i = 0; i < store.totalSteps + 10; i++) store.prevStep()
    expect(store.currentStepIndex).toBe(0)
  })

  it('回退与前进落在同一帧上（可重放性）', () => {
    const store = useAlgorithmStore()
    store.load([5, 1, 4, 2])

    store.goToStep(7)
    const forward = { line: store.currentLine, array: [...store.currentArray] }

    store.reset()
    for (let i = 0; i < 7; i++) store.nextStep()

    expect(store.currentLine).toBe(forward.line)
    expect(store.currentArray).toEqual(forward.array)
  })

  it('goToStep 越界会被夹到合法范围', () => {
    const store = useAlgorithmStore()
    store.load([3, 1, 2])

    store.goToStep(99999)
    expect(store.currentStepIndex).toBe(store.totalSteps - 1)
    store.goToStep(-5)
    expect(store.currentStepIndex).toBe(0)
  })

  it('切换算法会整体重算并归零', () => {
    const store = useAlgorithmStore()
    store.load([4, 3, 2, 1])
    store.goToStep(4)
    expect(store.currentStepIndex).toBeGreaterThan(0)

    store.selectAlgorithm('insertion-sort')
    expect(store.currentStepIndex).toBe(0)
    expect(store.algorithm.id).toBe('insertion-sort')
    expect(store.codeLines.join('\n')).toContain('insertionSort')
    expect(store.currentArray.length).toBeGreaterThan(0)
  })

  it('换数据规模会重新生成数据并归零', () => {
    const store = useAlgorithmStore()
    store.load([3, 1, 2])
    const before = store.totalSteps
    store.goToStep(5)

    store.setDataSize(12)
    expect(store.currentStepIndex).toBe(0)
    expect(store.inputData).toHaveLength(12)
    expect(store.totalSteps).not.toBe(before)
  })
})
