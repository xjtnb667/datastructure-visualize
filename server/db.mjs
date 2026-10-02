/**
 * 数据库层：建表、种子数据、查询封装。
 *
 * 只用 Node 自带的能力（`node:sqlite`），**零新增依赖**。
 * SQLite 是单文件数据库：不用装服务、不用配端口，但支持 SQL / 事务 / 索引，
 * 数据文件在 `server/data/app.db`（已进 .gitignore，不进版本库）。
 *
 * 本模块在 import 时就把库打开、把表和种子数据建好（幂等，重复启动不会重复写）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 数据目录 / 数据文件（deliverable 里就一个文件，备份 = 复制它） */
export const DATA_DIR = join(HERE, 'data')
export const DB_PATH = join(DATA_DIR, 'app.db')

mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(DB_PATH)

/** 当前毫秒时间戳（全库统一用它，方便换实现） */
export function now() {
  return Date.now()
}

// ---------------------------------------------------------------------------
// 建表
// ---------------------------------------------------------------------------
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    nickname      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

  CREATE TABLE IF NOT EXISTS algorithms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    algo_key   TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    category   TEXT NOT NULL,
    grp        TEXT,
    difficulty INTEGER NOT NULL DEFAULT 2,
    summary    TEXT,
    online     INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_algorithms_order ON algorithms (sort_order, id);

  CREATE TABLE IF NOT EXISTS favorites (
    user_id    INTEGER NOT NULL,
    algo_key   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, algo_key)
  );

  CREATE TABLE IF NOT EXISTS history (
    user_id      INTEGER NOT NULL,
    algo_key     TEXT NOT NULL,
    views        INTEGER NOT NULL DEFAULT 0,
    max_step     INTEGER NOT NULL DEFAULT 0,
    total_steps  INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, algo_key)
  );
`)

// ---------------------------------------------------------------------------
// 算法元数据种子
//
// 后端不重复维护算法清单的"来源"，但后端是 .mjs、前端注册表是 .ts，运行时读不到，
// 所以这里内置一份**一次性快照**：大类（前端 AlgoCategoryId）/ 子类（界面上的小标题）/
// id（= 前端注册表里的 id）/ 名称 / 难度 / 一句话简介，一共 98 条，顺序 = 前端注册顺序。
// 前端注册表以后再加算法，管理员在后台"新增算法"即可，不用改这里的代码。
// ---------------------------------------------------------------------------
const SEED_ALGORITHMS = [
  // 顺序表（4）
  ['linear', '顺序表', [
    ['seq-insert', '插入', 1, '腾位置后移，再放入新元素'],
    ['seq-delete', '删除', 1, '前移填补空位，表长减一'],
    ['seq-locate', '按值查找', 1, '从头逐个比对，返回位序'],
    ['seq-get', '按位查找', 1, '按下标直接取，O(1)'],
  ]],
  // 单链表（6）
  ['linear', '单链表', [
    ['sll-create-head', '头插法建表', 1, '每次插到最前面，结果与输入相反'],
    ['sll-create-tail', '尾插法建表', 1, '每次接到尾部，结果与输入一致'],
    ['sll-get', '按序号查找', 1, '只能从头一个个走，O(n)'],
    ['sll-locate', '按值查找', 1, '顺着 next 找等于 x 的结点'],
    ['sll-insert', '插入', 1, '找到前驱，两行指针不能反'],
    ['sll-delete', '删除', 1, '让前驱越过被删结点'],
  ]],
  // 双链表（2）
  ['linear', '双链表', [
    ['dll-insert', '插入', 2, '四根指针，顺序不能乱'],
    ['dll-delete', '删除', 2, '前后两个方向都要断开'],
  ]],
  // 循环链表与环（2）
  ['linear', '循环链表与环', [
    ['cycle-detect', '判断链表是否有环', 2, '快慢指针相遇即有环'],
    ['cycle-entry', '寻找环的入口', 2, '相遇后同速前进，再遇即入口'],
  ]],
  // 顺序栈（2）
  ['stack', '顺序栈', [
    ['stack-seq-push', '顺序栈进栈', 1, '栈顶指针上移，新元素放到新的栈顶'],
    ['stack-seq-pop', '顺序栈出栈', 1, '取出栈顶元素，栈顶指针下移'],
  ]],
  // 链栈（2）
  ['stack', '链栈', [
    ['stack-linked-push', '链栈进栈', 1, '链栈的入栈就是一次头插，栈顶永远是首结点'],
    ['stack-linked-pop', '链栈出栈', 1, '摘下首结点，栈顶指针顺着 next 下移一格'],
  ]],
  // 共享栈（1）
  ['stack', '共享栈', [
    ['stack-shared', '共享栈', 2, '两个栈共用一段数组，从两端往中间长，栈顶相遇才算满'],
  ]],
  // 栈的应用（3）
  ['stack', '栈的应用', [
    ['bracket-match', '括号匹配', 1, '左括号进栈，右括号弹栈比对，最后栈空才算匹配'],
    ['infix-to-postfix', '中缀转后缀', 3, '操作数直接输出，运算符按优先级进栈出栈，括号当分界'],
    ['postfix-eval', '后缀表达式求值', 3, '遇数字进栈，遇运算符弹出两个数算完再压回'],
  ]],
  // 栈与递归（1）
  ['stack', '栈与递归', [
    ['recursion-fact', '递归求阶乘', 1, '递归的推进与回退就是系统调用栈的压栈与出栈'],
  ]],
  // 循环队列（2）
  ['queue', '循环队列', [
    ['queue-circular-enqueue', '循环队列入队', 1, 'rear 所指处写入元素，再 rear = (rear + 1) % MAXSIZE 绕环后移'],
    ['queue-circular-dequeue', '循环队列出队', 1, '取出 front 所指元素，再 front = (front + 1) % MAXSIZE 绕环后移'],
  ]],
  // 链队列（2）
  ['queue', '链队列', [
    ['queue-linked-enqueue', '链队列入队', 1, '带头结点，新结点只接在队尾之后，然后 rear 后移'],
    ['queue-linked-dequeue', '链队列出队', 1, '摘掉头结点后面的队头结点；变空时 rear 要指回头结点'],
  ]],
  // 特殊矩阵（3）
  ['matrix', '特殊矩阵', [
    ['matrix-symmetric', '对称矩阵压缩存储', 1, '只存下三角，a[i][j] 与 a[j][i] 共用一格，按 k = i(i+1)/2 + j 定位'],
    ['matrix-triangular', '三角矩阵压缩存储', 2, '下三角逐个存，上三角那一堆相同的值只多留一格放常量'],
    ['matrix-diagonal', '对角矩阵压缩存储', 3, '只存主对角线和上下各一条带，按 k = 2i + j 定位，带外直接判 0'],
  ]],
  // 稀疏矩阵（2）
  ['matrix', '稀疏矩阵', [
    ['sparse-triple', '稀疏矩阵三元组表', 1, '只存非零元，每个非零元记一行 (行, 列, 值)，按行优先排列'],
    ['sparse-cross', '稀疏矩阵十字链表', 3, '每个非零元一个结点，right 串同行、down 串同列，零元不建结点'],
  ]],
  // 模式匹配（1）
  ['string', '模式匹配', [
    ['bf-match', 'BF 暴力匹配', 1, '主串指针一趟一趟地回溯，最坏 O(n×m)'],
  ]],
  // KMP算法匹配（3）
  ['string', 'KMP算法匹配', [
    ['kmp-next', '求 next 数组', 3, 'next[j] = 前缀 p[1..j-1] 里最长的"既是前缀又是后缀"的长度'],
    ['kmp-nextval', '求 nextval 数组', 3, '在 next 基础上再优化：退回后还是同一个字符就索性再退一步'],
    ['kmp-match', 'KMP 算法', 3, '主串指针永不回退，失配时按 next 让模式串往前滑，O(n+m)'],
  ]],
  // 二叉树的遍历（7）
  ['tree', '二叉树的遍历', [
    ['tree-preorder-rec', '先序遍历（递归）', 1, '根 -> 左 -> 右，递归实现'],
    ['tree-inorder-rec', '中序遍历（递归）', 1, '左 -> 根 -> 右，递归实现'],
    ['tree-postorder-rec', '后序遍历（递归）', 1, '左 -> 右 -> 根，递归实现'],
    ['tree-level', '层次遍历', 1, '用队列一层一层地访问，先进先出'],
    ['tree-preorder-iter', '先序遍历（非递归）', 3, '用栈模拟递归，出栈即访问（右孩子先入栈）'],
    ['tree-inorder-iter', '中序遍历（非递归）', 3, '沿左链一路压栈，弹出来访问后再转向右子树'],
    ['tree-postorder-iter', '后序遍历（非递归）', 3, '栈 + last 访问标记：确认右子树访问过，才敢访问栈顶'],
  ]],
  // 线索二叉树（2）
  ['tree', '线索二叉树', [
    ['thread-inorder', '中序线索化', 3, '把中序序列里的"前驱 / 后继"存进空指针，pre 始终指向上一个访问过的结点'],
    ['thread-traverse', '线索二叉树的遍历', 3, '不用栈、不用递归走完中序：有右线索顺线索走，没有就进右子树找最左下结点'],
  ]],
  // 树与森林（6）
  ['tree', '树与森林', [
    ['tree-parent-repr', '树的存储·双亲表示法', 2, '一维数组存结点，每个结点只记双亲下标：找双亲 O(1)，找孩子要遍历整个数组'],
    ['tree-child-repr', '树的存储·孩子表示法', 2, '每个结点挂一条孩子链表：找孩子 O(1)，找双亲要把所有链表扫一遍'],
    ['tree-sibling-repr', '树的存储·孩子兄弟表示法', 3, '左指针连第一个孩子、右指针连下一个兄弟，多叉树直接变成二叉树'],
    ['tree-root-traverse', '树的遍历（先根 / 后根）', 2, '一棵树：先根遍历（先根、再各子树）与后根遍历（先各子树、最后才根）—— 树没有"中序遍历"'],
    ['forest-traverse', '森林的遍历（先序 / 中序）', 3, '森林逐棵树走：先序遍历（= 各棵树的先根遍历）与中序遍历（= 各棵树的后根遍历）'],
    ['tree-to-binary', '树与森林转二叉树', 3, '左孩子右兄弟：原树 -> 二叉树，并且树的先根遍历 = 二叉树的先序遍历'],
  ]],
  // 哈夫曼树（2）
  ['tree', '哈夫曼树', [
    ['huffman-build', '哈夫曼树·构造', 2, '反复取权值最小的两棵树合成一棵，直到只剩一棵'],
    ['huffman-code', '哈夫曼编码', 3, '从根往下走，向左记 0、向右记 1，走到叶子就是该字符的编码'],
  ]],
  // 并查集（2）
  ['tree', '并查集', [
    ['uf-find', '并查集·Find（查找根 + 路径压缩）', 3, '顺着双亲一路走到根，走完把路上所有结点直接挂到根上'],
    ['uf-union', '并查集·Union（合并集合）', 3, '先各自 Find 到根，再按秩合并：把矮的树挂到高的树下'],
  ]],
  // 存储结构（4）
  ['graph', '存储结构', [
    ['graph-adj-matrix', '图的存储·邻接矩阵', 2, '一张 n×n 的矩阵：arc[i][j] 写权值、无边写 ∞，无向图沿主对角线对称，查边 O(1)'],
    ['graph-adj-list', '图的存储·邻接表', 2, 'n 个表头 + 每条边一个边结点：边结点串成链，顶点多、边少时比矩阵省'],
    ['graph-orthogonal', '图的存储·十字链表', 3, '有向图的每个弧结点同时挂进同弧尾链和同弧头链，找入边、找出边都方便'],
    ['graph-adj-multi', '图的存储·邻接多重表', 3, '无向图每条边只有一个结点：邻接表一条边存两遍，它只存一遍，删边、遍历都省'],
  ]],
  // 遍历（3）
  ['graph', '遍历', [
    ['graph-dfs-rec', '深度优先搜索 DFS（递归）', 2, '一条路走到黑：递归下去，走不动了才退回来换一条（递归调用栈画在下面）'],
    ['graph-dfs-iter', '深度优先搜索 DFS（非递归）', 2, '用显式栈模拟递归：压栈时只是排队，弹出时才访问'],
    ['graph-bfs', '广度优先搜索 BFS', 2, '一层一层往外扩：用队列，离起点近的全部访问完才轮到更远的（顶点旁标访问次序）'],
  ]],
  // 拓扑排序（1）
  ['graph', '拓扑排序', [
    ['graph-topo', '拓扑排序（AOV 网）', 3, '反复挑出入度为 0 的顶点输出：每输出一个，该顶点和以它为起点的出边一起从图上消失，后继入度减 1（已输出的排在图下的板子里）'],
  ]],
  // 最小生成树（2）
  ['graph', '最小生成树', [
    ['graph-prim', '最小生成树·Prim', 3, '从一个起点开始，每次把"连接已选集合与未选集合的最小边"加进来'],
    ['graph-kruskal', '最小生成树·Kruskal', 3, '把所有边按权值排序，从小到大依次考察，不成环就加入生成树'],
  ]],
  // 最短路径（2）
  ['graph', '最短路径', [
    ['graph-dijkstra', '最短路径·Dijkstra', 3, '每次确定 dist 最小的顶点，再用它去松弛别的顶点'],
    ['graph-floyd', '最短路径·Floyd', 3, '三层循环 for k / for i / for j，一轮加一个中转站，一次算出所有顶点对的最短路'],
  ]],
  // 关键路径（1）
  ['graph', '关键路径', [
    ['graph-critical-path', '关键路径（AOE 网）', 3, '按拓扑序求 ve、逆拓扑序求 vl，e == l 的活动就是关键活动'],
  ]],
  // 线性表的查找（3）
  ['search', '线性表的查找', [
    ['sequential-search', '顺序查找', 1, '从头到尾一个一个比对'],
    ['binary-search', '折半查找', 1, '每次砍掉一半（要求有序）'],
    ['search-block', '分块查找', 2, '先查索引表定块，再在块内顺序查'],
  ]],
  // 二叉排序树（3）
  ['search', '二叉排序树', [
    ['bst-insert', '二叉排序树·插入', 2, '比它小往左、比它大往右，走到空位挂上去；相同的关键字不插入'],
    ['bst-search', '二叉排序树·查找', 2, '逐层比较，命中就标绿；走到 NULL 说明树里没有'],
    ['bst-delete', '二叉排序树·删除', 2, '① 叶子直接摘 ② 一个孩子顶替 ③ 两个孩子用中序后继顶替（再摘掉后继）'],
  ]],
  // 平衡二叉树（5）
  ['search', '平衡二叉树', [
    ['avl-ll', 'AVL 旋转·LL（右单旋）', 3, '在左孩子的左子树上插入导致失衡 -> 对失衡点做一次右单旋'],
    ['avl-rr', 'AVL 旋转·RR（左单旋）', 3, '在右孩子的右子树上插入导致失衡 -> 对失衡点做一次左单旋'],
    ['avl-lr', 'AVL 旋转·LR（先左后右）', 3, '在左孩子的右子树上插入导致失衡 -> 先左旋左孩子，再右旋失衡点'],
    ['avl-rl', 'AVL 旋转·RL（先右后左）', 3, '在右孩子的左子树上插入导致失衡 -> 先右旋右孩子，再左旋失衡点'],
    ['rb-tree', '红黑树·插入与调整', 3, '新结点先染红，按"叔叔的颜色"分三种情况修复：变色 / 旋转成外侧 / 旋转加变色'],
  ]],
  // 多路平衡查找树（2）
  ['search', '多路平衡查找树', [
    ['b-tree', 'B 树·插入与查找', 3, '阶 m = 3：结点装满了就分裂，中间的关键字升到父结点；所有叶子都在同一层'],
    ['b-plus-tree', 'B+ 树·插入与查找', 3, '所有关键字都在叶子层，内部结点只当索引，叶子之间用链表串起来'],
  ]],
  // 散列表（1）
  ['search', '散列表', [
    ['search-hash', '哈希表查找', 2, '算桶号直接定位，冲突用链地址法挂在同一个桶上'],
  ]],
  // 插入类排序（3）
  ['sort', '插入类排序', [
    ['insertion-sort', '直接插入排序', 1, '把新元素插入到左边有序区'],
    ['sort-bin-insert', '折半插入排序', 3, '用折半查找定位插入点，比较次数降到 O(n log n)，移动次数仍是 O(n²)'],
    ['sort-shell', '希尔排序', 3, '按增量 gap 分组做插入排序，gap 逐步减到 1，整体基本有序后再收尾'],
  ]],
  // 交换类排序（2）
  ['sort', '交换类排序', [
    ['bubble-sort', '冒泡排序', 1, '相邻两两比较，大的往后冒'],
    ['sort-quick', '快速排序', 3, '取第一个元素作基准，左右指针向中间扫着换，一趟划分后基准归位'],
  ]],
  // 选择类排序（4）
  ['sort', '选择类排序', [
    ['selection-sort', '选择排序', 1, '每轮选出最小值放到前面'],
    ['sort-heap', '堆排序', 3, '先建成大根堆，再反复把堆顶换到堆尾并重新调整，整体 O(n log n)'],
    ['heap-build', '建堆（自下而上）', 3, '从最后一个非叶结点 n/2-1 往前，逐个向下调整，O(n) 建堆'],
    ['heap-sift', '堆调整（向下调整 / 筛选）', 3, '和**较大的**那个孩子比较，不满足大根堆就交换，然后继续往下'],
  ]],
  // 归并类排序（1）
  ['sort', '归并类排序', [
    ['sort-merge', '归并排序', 3, '自底向上：相邻两个有序段两两归并，段长按 1、2、4 倍增'],
  ]],
  // 分配类排序（2）
  ['sort', '分配类排序', [
    ['sort-count', '计数排序', 2, '不比较元素，先统计每个值出现几次，再按计数直接写进输出数组'],
    ['sort-radix', '基数排序', 3, 'LSD 低位优先：按个位、十位、百位逐位分到 10 个桶里再收回来'],
  ]],
  // 外部排序（4）
  ['sort', '外部排序', [
    ['sort-external', '外部排序（多趟归并）', 3, '内存装不下就分趟：先做初始归并段，再每趟把相邻两段归并成一段'],
    ['sort-loser-tree', '多路平衡归并与败者树', 3, '内部结点记败者、树顶记冠军，每输出一个记录只重赛 log k 次'],
    ['sort-replace-select', '置换-选择排序', 3, '用一个小内存窗口生成尽量长的初始归并段：选最小输出、补一个进来，更小的就冻结'],
    ['sort-optimal-merge', '最佳归并树', 3, '按哈夫曼思路每次合并最短的 k 段，段数不足时补长度 0 的虚段'],
  ]],
]

/** 建表之后写入算法元数据（只在表是空的时候写一次） */
function seedAlgorithms() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM algorithms').get()
  if (Number(row.n) > 0) return 0

  const insert = db
    .prepare(
      `INSERT INTO algorithms (algo_key, name, category, grp, difficulty, summary, online, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )

  let order = 0
  db.exec('BEGIN')
  try {
    for (const [category, grp, items] of SEED_ALGORITHMS) {
      for (const [algoKey, name, difficulty, summary] of items) {
        insert.run(algoKey, name, category, grp, difficulty, summary, order)
        order += 1
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return order
}

/** 本次启动写了多少条算法种子（已经在库里就不写） */
export const seededAlgorithms = seedAlgorithms()

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
/** 去掉 node:sqlite 返回的 null 原型对象，变成普通对象（方便 JSON / 展开） */
export function plain(row) {
  return row ? { ...row } : row
}

export function plainAll(rows) {
  return rows.map((r) => ({ ...r }))
}
