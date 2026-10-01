import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useAlgorithmStore } from '@/stores/algorithm'
import '@/styles/main.css'

const pinia = createPinia()
const app = createApp(App)
app.use(pinia)

const store = useAlgorithmStore(pinia)

// 应用挂载前就把步骤序列预计算好（SRS 约束 C1 / C2），
// 组件首次渲染就能拿到完整数据，不会出现"先空一下再出画面"。
store.load()

// 支持 ?algo=xxx&step=N 直达某个算法的某一步（SRS EF-06 分享链接）
const params = new URLSearchParams(window.location.search)
const algoId = params.get('algo')
if (algoId) store.selectAlgorithm(algoId)

const stepParam = Number(params.get('step'))
if (Number.isInteger(stepParam) && stepParam > 0) store.goToStep(stepParam)

app.mount('#app')
