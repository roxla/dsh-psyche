# PSY-M4 隔离 Host 实测报告

日期：2026-11-25
被测版本：`dsh-psyche` v0.2.0（工作树 HEAD `8723b95`）
宿主：本机已安装 DSH CLI（`D:\project\lingban\.tmp-dsh-cli\node_modules\@deepseek-ai\dsh`）
结论：**隔离 Host 与空数据根成立，product.json 门禁与 QQ 默认关闭成立；发布包安装（npm pack 安装路径）仍未验。**

## 1. 做了什么

用一个与日常桌面 profile 完全分离的 DSH Home 启动宿主，profile 里只挂 `dsh-psyche`：

- `DSH_HOME=D:\project\lingban\.tmp-psyche-m4`（全新目录，不含任何旧品牌数据）
- profile `psychem4`：从 `web` 模板物化（`cordis.yml` + `package.json`），`dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-psyche']`，`node_modules/dsh-psyche` 是指向 `D:\project\dsh-psyche` 的 Junction
- 启动：`node main/h2-probe/host-psyche.mjs`（内部用 `psyche-cli.mjs` 设置 DSH_HOME 再 spawn CLI，避开 shell 动态环境变量限制）
- 端口 62121，`--no-open`，日志 `main/h2-probe/psyche-host.log`

一处实现细节值得记下：profile 只需要把 **bundle 包名**写进 `dsh.profile.bundles`，插件自己 `package.json` 的 `dsh.bundle.patch` 会被自动套用；在 profile 的 `cordis.patch.yml` 里手写 `- insert:` 反而不会生效（那层是给已存在条目做覆盖的）。

## 2. 证据

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 宿主启动 | 通过 | 日志单行：`dsh web: http://127.0.0.1:62121/?token=…` |
| 插件已加载 | 通过 | `--dump-config` 合成树含 `# == dsh-psyche` / `- id: dsh-psyche` / `name: dsh-psyche` |
| 数据根隔离 | 通过 | `$DSH_HOME/psyche/` 全新生成：`product.json`、`memory.sqlite3(-wal/-shm)`、`assets`、`backups`、`exports`、`memory-view`、`narrative`、`config-audit.jsonl` |
| 归属门禁 | 通过 | 新建的 `product.json` = `{"product":"dsh-psyche","formatVersion":1}`；仓库 `test/product-isolation.ts` 8 passed 0 failed（含「其他产品标识拒绝启动」「标识损坏拒绝启动」） |
| 服务可用 | 通过 | `GET /api/psyche/status` 200：`{"ok":true,"enabled":true,"driver":"node:sqlite","selfCheck":{"ok":true,…}}` |
| 面板可用 | 通过 | `GET /api/psyche/panel` 200，同一形状 |
| QQ 默认关闭 | 通过 | `GET /api/psyche/qq` 200：`{"enabled":false,"connection":"unknown","allowFrom":{"ownerConfigured":false,"extraCount":0}}`，`counts.received:0`；宿主日志无 onebot / 3001 / snowluma 记录 |
| 旧 Lingban 不受影响 | 通过（静态） | `C:\Users\roxla\.dsh\profiles\desktop\cordis.patch.yml` 仍单独声明 `- id: dsh-lingban`；`psychem4` 的合成树里没有 lingban，`.tmp-psyche-m4` 下也没有 `lingban/` 目录 |

鉴权口径：根页 `GET /?token=…` 返回 303 并下发一个 cookie，后续 `/api/psyche/*` 用该 cookie 访问；未带 cookie 时按宿主既有行为拒绝。

## 3. 没验到的

- **发布包安装**：本轮用的是 Junction 直连源码仓库，没有走 `npm pack` → 安装到干净 profile 的路径。发布前需要补一次。
- **真实 QQ 通道**：本轮只验了「默认不连接」。真实收发要等 SnowLuma 登录与 OneBot WS 同时在场。
- **面板交互**：只打了 `/api/psyche/panel` 与 `/api/psyche/status`，没有在浏览器里点面板（宿主客户端 bundle 是否在隔离 Home 下正确挂载未验）。
- **多 profile 并存**：desktop 与 psychem4 是先后/静态核对，没有同时启动两个宿主做并行隔离验证。

## 4. 复现步骤

```powershell
# 1) 物化 profile（一次性）
node main\h2-probe\psyche-cli.mjs --from-default-profile web --profile psychem4 --dump-config

# 2) profile 的 package.json 里把 dsh-psyche 加进 dsh.profile.bundles，
#    并准备 node_modules\dsh-psyche -> D:\project\dsh-psyche 的 Junction

# 3) 启动隔离宿主（后台）
node main\h2-probe\host-psyche.mjs

# 4) 只读探针
node main\h2-probe\psyche-m4-probe.mjs
```

清理：停掉宿主进程后删除 `D:\project\lingban\.tmp-psyche-m4` 即可，不影响日常 `~/.dsh`。
