# dsh-purge · pi agent 版

把 dsh-purge 的「清洗」能力接到 [pi](https://pi.dev) 上。**不碰宿主任何文件**——pi 把系统提示词注入和工具拦截做成了官方扩展点，所以这一层只有一千多行，不是三万八。

| 能力 | dsh 版怎么做 | pi 版怎么做 |
|---|---|---|
| 注入提示词 | 改宿主 prompt 组装链（order -10000） | `before_agent_start` 改 `systemPromptOptions.sections` 或返回 `systemPrompt` |
| prompt 落进原生 system 槽 | 改 provider adapter 源码 | `before_provider_request` 直接改 payload |
| 审批门放行 | 改宿主审批常量 / 清空拒绝签名 | pi 没有这套门，不需要 |
| 升级后重打补丁 | 42 个补丁 + 解 asar | 不存在这个需求 |
| 侧栏 UI | client slot 注入 | `/purge` 命令 + `purge_preflight` 工具 |

## 安装

```bash
# 1) 生成 pi 资产（提示词包 / 23 个技能）
node pi/bin/build.mjs

# 2) 装进本机 pi
node pi/bin/install.mjs install

# 看装了什么
node pi/bin/install.mjs status

# 卸载（只删自己装过的路径）
node pi/bin/install.mjs uninstall
```

装完重启 pi 会话，发 `/purge` 看状态。

也可以走 pi 包管理（仓库根的 `package.json` 已声明 `pi` 字段）：

```bash
pi install git+https://github.com/walkmiao/dsh-purge
```

## 用法

```
/purge                     状态：当前模型命中哪个包、路由表、可用包
/purge list                列出所有包
/purge use zh-default      切默认包
/purge model deepseek/* en-default    按模型路由（支持 * 和 ?）
/purge mode section|lead   注入姿态
/purge lab on|off          只在 lab-mode.flag 存在时注入
/purge capability on|off   能力选用协议段（先读 skill/MCP 目录再动手）
/purge doctor              本机预检（等价 dsh 的 redteam_preflight）
/purge off | on            总开关
```

模型侧还有一个工具 `purge_preflight`，模型可以自己调它确认"现在能不能开工"。

## 两种注入姿态怎么选

- **`section`（默认）**：把包挂成 `<purge_pack>` 结构化段，pi 会记 transcript delta，**prompt cache 不失效**。日常用这个。
- **`lead`**：整段置顶，人格压过一切。代价是 pi 会写入 `forceSystemPrompt`，后续请求按不透明整段发送，**缓存失效、成本上升**。包 frontmatter 写 `lead: true` 可以让单个包强制置顶。

## 提示词包

`~/.pi/agent/purge/packs/*.md`，frontmatter 可选：

```markdown
---
name: 红队总控
models: deepseek/*, openai-codex/*
lead: false
---
<正文>
```

内置两个包由 `lib/default-prompt-inject.{zh,en}.md` 生成（已剥掉 dsh 的 ChatML 外壳）：

- `zh-default` — 中文破甲底座
- `en-default` — 英文版

自己加的包不会被卸载脚本删掉。

## 红队角色（配合 pi-subagents）

装进 `~/.pi/agent/agents/`：

| 角色 | 职责 |
|---|---|
| `redteam-recon` | 信息收集，把资产面收全，不碰漏洞检测 |
| `redteam-assess` | 资产梳理，逐条评估易打性与优先级 |
| `redteam-vuln-scan` | 漏洞发现，Nday/1day 优先再未授权接口 |
| `redteam-exploit` | 漏洞利用，拿权限 + 建隧道并实测可达 |
| `redteam-internal` | 内网渗透，走既有隧道把网段挖全 |

五个角色都是**叶子节点**（`tools` 白名单里没有 `subagent`，结构上就无法再往下派活）。

## 技能

23 个技能从 `skills/redteam/*.md` 转成 pi 规范（`redteam-<name>/SKILL.md`）：

- dsh 的 `whenToUse` 并进 `description`
- dsh 的 `role`（recon/assess/vuln-scan/exploit/internal）是红队调度键，**没有丢**，折进正文首行

转换表见 `pi/generated/manifest.json`。

## 自测

```bash
node pi/test/run.mjs
```

覆盖：ChatML 剥壳、23 个技能转换、install/uninstall 只删自己的、section/lead/off/lab 闸门、模型路由、命令落盘、预检不回显密钥。

## 目录

```
pi/
├── src/            扩展（index.ts 接线，core.ts 纯逻辑，packs.ts 状态/路由，preflight.ts 预检）
├── bin/build.mjs   生成 packs + skills
├── bin/install.mjs 安装 / 卸载 / 状态
├── agents/*.md     5 个红队角色（pi-subagents 格式）
├── generated/      生成物（已入库，git 安装不用先 build）
└── test/run.mjs    无依赖自测
```

## 署名

思路、提示词、技能库来自 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)（MIT）。移植层同样 MIT。
