<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { cpp } from '@codemirror/lang-cpp'
import { tags as t } from '@lezer/highlight'
import { useAlgorithmStore } from '@/stores/algorithm'

const store = useAlgorithmStore()
const { codeLines, currentLine } = storeToRefs(store)

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null

// ---------------------------------------------------------------------------
// 配色：C++ 源码 + Notepad++ 深色主题（"深邃夜晚"）
//   代码底 #1E1E1E ｜ 关键字白 ｜ 标识符浅蓝 #79ABFF ｜ 数字绿 #A1E569
//   注释灰 #858585
//   当前执行行：深青色底 + 左侧亮青竖条，整行文字统一为亮白 #FFFFFF
//   （亮青色 #33CCCC 打底时白字对比度只有 1.97:1，几乎看不清，
//     所以把底色压深到 #116A6E，白字对比度约 6.3:1，同时保留青色识别度）
// ---------------------------------------------------------------------------
const CM = {
  bg: '#1E1E1E',
  fg: '#FFFFFF',
  ident: '#79ABFF',
  number: '#A1E569',
  string: '#D9E577',
  comment: '#858585',
  invalid: '#FF2A55',
  execBg: '#116A6E',
  execBar: '#33CCCC',
  execFg: '#FFFFFF',
} as const

const notepadHighlight = HighlightStyle.define([
  // 关键字：白
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword],
    color: CM.fg,
  },
  // 类型名、类名、布尔、self：白
  { tag: [t.typeName, t.className, t.namespace, t.self, t.bool], color: CM.fg },
  // 变量 / 函数名 / 属性：浅蓝
  { tag: [t.name, t.variableName, t.propertyName, t.labelName, t.attributeName], color: CM.ident },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: CM.ident },
  // 数字：绿
  { tag: [t.number, t.integer, t.float], color: CM.number },
  // 字符串 / 字符：黄绿
  { tag: [t.string, t.special(t.string), t.character], color: CM.string },
  // 注释：灰
  { tag: [t.comment, t.lineComment, t.blockComment], color: CM.comment },
  // 运算符与括号：白
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: CM.fg },
  // 预处理指令等：浅蓝
  { tag: [t.meta, t.processingInstruction], color: CM.ident },
  { tag: t.invalid, color: CM.invalid },
])

const editorTheme = EditorView.theme(
  {
    '&': {
      fontSize: '13.5px',
      height: '100%',
      backgroundColor: CM.bg,
      color: CM.fg,
    },
    '.cm-content': { padding: '14px 0', caretColor: CM.execBg },
    '.cm-scroller': {
      fontFamily: "Consolas, Monaco, 'Courier New', monospace",
      lineHeight: '1.75',
      overflow: 'auto',
    },
    '.cm-gutters': {
      backgroundColor: CM.bg,
      color: CM.comment,
      border: 'none',
      paddingRight: '6px',
    },
    // 换行高亮时，让背景色和左侧竖条"渐变过去"而不是瞬间跳变。
    // 高亮移到新行时，旧行从深青淡出、新行淡入，形成交叉渐变。
    '.cm-line': {
      transition: 'background-color 160ms ease-out, box-shadow 160ms ease-out',
    },
    // 当前正在执行的那一行
    '.cm-exec-line': {
      backgroundColor: CM.execBg,
      boxShadow: `inset 4px 0 0 0 ${CM.execBar}`,
    },
    // 高亮行上的代码统一为亮白（不再跟随语法配色）
    '.cm-exec-line, .cm-exec-line span': {
      color: `${CM.execFg} !important`,
    },
  },
  { dark: true },
)

// ---------------------------------------------------------------------------
// 「当前执行行」装饰：用 StateEffect 通知换行，StateField 保存，
// 每次只 dispatch 一个 effect，CodeMirror 自己做增量重绘，不重建编辑器。
// ---------------------------------------------------------------------------
const setExecLine = StateEffect.define<number>()
const execLineDeco = Decoration.line({ class: 'cm-exec-line' })

const execLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setExecLine)) continue
      const n = effect.value
      if (n < 1 || n > tr.state.doc.lines) return Decoration.none
      return Decoration.set([execLineDeco.range(tr.state.doc.line(n).from)])
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field),
})

function highlight(line: number): void {
  if (!view || line < 1 || line > view.state.doc.lines) return
  view.dispatch({
    effects: [
      setExecLine.of(line),
      // 高亮行跑到视口外时自动滚到中间
      EditorView.scrollIntoView(view.state.doc.line(line).from, { y: 'center' }),
    ],
  })
}

function setDoc(lines: string[]): void {
  if (!view) return
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: lines.join('\n') } })
  highlight(currentLine.value)
}

onMounted(() => {
  view = new EditorView({
    state: EditorState.create({
      doc: codeLines.value.join('\n'),
      extensions: [
        lineNumbers(),
        cpp(),
        syntaxHighlighting(notepadHighlight),
        execLineField,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        editorTheme,
      ],
    }),
    parent: host.value!,
  })
  highlight(currentLine.value)
})

// 换算法时整份文档替换，然后立刻重新高亮（顺序不依赖 watcher 的注册次序）
watch(codeLines, (lines) => setDoc(lines))
watch(currentLine, (n) => highlight(n))

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})
</script>

<template>
  <div ref="host" class="code-host"></div>
</template>

<style scoped>
.code-host {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.code-host :deep(.cm-editor) {
  height: 100%;
}

.code-host :deep(.cm-editor.cm-focused) {
  outline: none;
}
</style>
