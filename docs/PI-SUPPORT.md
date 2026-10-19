# 在 pi agent 上运行 dsh-purge 的能力

这份文档解释**为什么能移植、移植了什么、什么搬不过去**，以及两边的对应关系。
实现见 [`pi/`](../pi/README.md)，安装见 [`pi/README.md`](../pi/README.md#安装)。

---

## 一、dsh 版为什么要打 42 个补丁

dsh-purge 在 DSH 上做两件事，两件事都没有官方口子：

1. **把 25KB 提示词塞进系统提示词的最前面。**
   宿主把 prompt 组装写死在 `@deepseek-ai/dsh-*` 的 JS 里，插件只能
   `applyPatchesAllHosts()` 去改 `node_modules` 的源码，把注入段折进 persona-prefix（`order -10000`）。
2. **让审批门不拦。**
   审批策略、`DENIAL_SIGNATURES`、hooks 的 deny/ask 都是宿主常量，只能改源码清零。

配套的 42 个编号补丁（`lib/core.js` 的 `PATCHES / CODE_PATCHES / ENGINE_PATCHES / NEW_TOOL_PATCHES`）里，
还有一批是在**修 provider adapter**：只有把 systemPrompt 写进 `params.system` / `messages[0].role=system`，
模型才真的看见它——否则会被宿主自己的组装逻辑折掉。

所以仓库里 38k 行代码，绝大部分不是"破甲"，是**跟宿主耦合的工程**：
解 `app.asar`、升级后重打、藏控制台闪窗、失败不重启、markers 防重复应用。

---

## 二、pi 侧为什么不需要补丁

pi 把同样的能力做成了**官方扩展点**：

| 需要的能力 | pi 的接口 | 说明 |
|---|---|---|
| 改系统提示词 | `pi.on("before_agent_start")` | `event.systemPromptOptions.sections` 可变；返回 `{systemPrompt}` 则整段替换（写入 `forceSystemPrompt`） |
| 改 provider 请求体 | `pi.on("before_provider_request")` | 直接改 payload（`safetySettings`、`system`、`messages` 都行） |
| 拦/放行工具 | `pi.on("tool_call")` | 返回 `{block:true, reason}` |
| 改上下文 | `pi.on("context")` / `context_with_system` | 请求级改写，宿主会还原 |
| 改用户输入 | `pi.on("input")` | `{action:"transform", text}` |
| 加 UI | `ctx.ui.notify / custom / widget` + `registerCommand` | 没有 dsh 的 client slot，换 TUI 组件 |
| 多角色 | `pi-subagents`（`~/.pi/agent/agents/*.md`） | 替代 cordis agent preset |

且 pi 的扩展加载器给用户扩展**预置了 jiti alias**（`@earendil-works/pi-ai`、`typebox` 等），
所以扩展可以直接 `import { Type }` + `defineTool`，不需要打补丁也不需要自带 node_modules。

**结论：dsh 的 42 个补丁在 pi 上一个都不需要。** 移植层 1000 行左右，逻辑只有三件事：
注入、路由、预检。

---

## 三、能力对照表

| dsh-purge | 移植状态 | pi 侧落点 |
|---|---|---|
| 25KB 破甲提示词（zh/en） | ✅ 完整搬 | `pi/generated/packs/{zh,en}-default.md`（已剥 ChatML 外壳） |
| 多套提示词包 + 切换 | ✅ 重写 | `~/.pi/agent/purge/packs/*.md` + `/purge use\|list` |
| 「不同模型换不同提示词」 | ✅ 强化 | `/purge model <glob> <pack>`，精确 → glob → 默认包 |
| 注入置顶（order -10000） | ✅ 等价 | `mode=lead`：返回 `systemPrompt` 整段置顶 |
| 尾部注入（trailInjectSections） | ✅ 等价 | `mode=section`（默认）：挂 `<purge_pack>` 结构化段 |
| 能力选用协议（capability-protocol） | ✅ 搬 | 独立 `<purge_capability>` 段，`/purge capability` 单独开关 |
| 23 个红队技能 | ✅ 转换 | `~/.pi/agent/skills/redteam-*/SKILL.md`（`role` 保留进正文） |
| 五角色红队预设 | ✅ 重写 | `pi/agents/redteam-{recon,assess,vuln-scan,exploit,internal}.md` |
| `redteam_preflight`（能力探测） | ⚠️ 精简版 | `purge_preflight` 工具 + `/purge doctor`：环境变量 / 二进制 / 包 / 技能 / MCP |
| 审批门放行（补丁 30/31/64/65） | ⛔ 不需要 | pi 没有审批门这套机制 |
| `DENIAL_SIGNATURES` 清空 | ⛔ 不需要 | 同上 |
| 沙箱拒绝话术改写 | ⛔ 不需要 | pi 工具描述里没有这类话术 |
| provider adapter 改写 | ⛔ 不需要 | `before_provider_request` 直接改 payload |
| 侧栏 UI（client slot） | ❌ 不搬 | 换 `/purge` 命令 + TUI；要做图形面板得走 pi-web |
| SQLite 资产库 + 2000 行 tools | ❌ 未搬 | 需要单独做一个 pi 工具包（下一阶段） |
| 评分规则 / 攻击链入库 / 报告导出 | ❌ 未搬 | 同上 |
| 升级后自动重打、解 asar、藏窗 | ⛔ 不存在 | 没有补丁就没有这些活 |

---

## 四、三个必须知道的差异

### 1. `lead` 姿态会砸 prompt cache

pi 的 `before_agent_start` 一旦有 handler 返回 `systemPrompt`，就写入 `forceSystemPrompt`，
后续请求按**不透明整段**发送，结构化 section 全部失效。dsh 没有这个代价（它直接改缓存里的 prompt 段）。

所以默认是 `section`；只有需要"人格压过一切"时才用 `lead`。

### 2. 子智能体的角色稿走同一个 `forceSystemPrompt` 槽

`pi-subagents` 用 `before_agent_start` 返回 `systemPrompt` 注入 `<active_agent>` 和角色稿
（`src/extension/herdr-pi-bridge.js`）。两边都用 lead 时，谁后跑谁当基底——顺序影响内容。

实践建议：**主会话 lead + 子会话 section**，用 `/purge model` 按子智能体模型单独路由。

### 3. pi 没有"审批门"，所以没有"破门"

dsh 的破甲有一半是把审批/沙箱拦下来的东西放行。pi 默认不拦工具（拦不拦由扩展决定），
所以这部分工作量在 pi 上直接归零——不是移植成功，是**宿主根本没有这道门**。

---

## 五、验证

```bash
node pi/test/run.mjs
```

37 项断言，覆盖生成、安装、卸载、注入姿态、闸门、路由、命令落盘、预检脱敏。

端到端加载验证（pi 真实 jiti + alias 管线）：

```bash
HOME=/tmp/piprobe pi -p --no-session -ne -e /tmp/piprobe/.pi/agent/extensions/dsh-purge-pi/index.ts "x"
# 扩展报错会打印 "Failed to load extension ..."；无输出即加载成功
```
