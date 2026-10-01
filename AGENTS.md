# 工作约定

## 1. Git：每个里程碑提交一次，不留脏工作区

这是一个已初始化 git 的项目。**每次做完一件可交付的事、并且验证通过之后，就提交一次**，
不要攒着，也不要让工作区长时间处于有未提交改动的状态。

- 提交前必须三项全绿：`npm run typecheck`、`npm test`、`npm run build`。
- 提交信息写清**改了什么、为什么**，用中文，第一行是概要。
- 提交时只 `git add` 相关文件；`node_modules/`、`dist/`、`.shots/` 已在 `.gitignore` 里，不要提交。
- 任务收尾时工作区应当是干净的。
- **不要**执行 `git push`、`git reset --hard`、`git rebase`、`git branch -D` 这类会丢东西或影响远端的操作；
  提交、查看状态、查看历史、恢复单个文件（`git checkout -- <file>`）是允许的。

如果发现用户之前的工作被搞坏了，**优先用 git 恢复**：`git status` → `git diff` → `git checkout -- <file>`。

## 2. 中文文本文件：禁止用 PowerShell 读写

**绝对不要用 `Get-Content` / `Set-Content` / `Out-File` 读写任何含中文的文件**
（`.md` 文档、`启动项目.bat` 等）。PowerShell 的编码往返会不可逆地破坏中文。

- 读文件：用 read 工具。
- 改文件：用 edit / write 工具。
- 必须做批量文本替换时：用 Node 脚本（`fs.readFileSync(f, 'utf8')`），不要用 PowerShell。
- 只读的命令行检查（比如 `git status`、`Select-String` 查代码）不受此限，但**不要**把结果写回文件。

## 3. 项目背景

- 这是「算法可视化平台」毕业设计项目，用户**不懂技术**，只看最终效果。技术决策由我负责，不要问代码细节。
- 交付物：① 能跑起来的本地网页（`http://localhost:5173/`）② `毕业设计答辩说明书.md`（通俗易懂）。
- 改完界面后要**自己启动 dev server 并实际验证**（截图 / 无头浏览器逐帧采样），不要只看代码。
- 用户会靠截图反馈视觉问题，所以报告里要给出可核对的具体数值。
