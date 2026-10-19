/**
 * 能力选用协议段。
 *
 * 直接来自 dsh-purge 的 lib/capability-protocol.js（MIT，署名 YuJunZhiXue/dsh-purge）。
 * dsh 侧把它挂在注入提示词前面；pi 侧挂成独立 section，不污染主包，
 * 这样 /purge off 时主包关掉、协议仍可单独保留。
 */

export const CAPABILITY_SECTION = "purge_capability";

const PROTOCOL_ZH = `## 能力选用协议（强制）

1. **先读目录**：动手前先看 \`<skills>\` 里的技能清单，以及本会话已挂载的 MCP 工具。知道有什么，再决定用不用。
2. **按任务匹配**：从目录里挑**这件任务真正需要**的技能与 MCP/CLI 工具——不是"每个都必须用"，也不是"一律不用"。
3. **命中的就调用**：技能 → 用 \`read\` 读该 SKILL.md 并照它的方法/前提/分支/反证走；MCP/CLI → 按真实参数调用，失败按该工具语义处理。
4. **都不匹配再自己造**：目录里没有合适的，才用 bash 临时拼，并在回执里说明缺了什么。
5. **子智能体继承这条**：你派出的任何 subagent，任务书里都要写清"先读目录、只调本任务需要的"，并点名具体技能。
6. 技能与 MCP 依然全部可用；这段协议不删减任何工具。`;

const PROTOCOL_EN = `## Capability selection by task (mandatory)

1. **Read first**: inspect the \`<skills>\` catalog and the MCP tools mounted in this session before acting.
2. **Match the task**: pick the skill(s) and MCP/CLI tools that fit *this* task — not "always use something", not "never use something".
3. **Call what matches**: Skill → read its SKILL.md and follow it; MCP/CLI → call with real arguments and honour its failure semantics.
4. **Only then DIY**: if nothing fits, use bash ad-hoc and say what was missing.
5. **Subagents inherit this**: every subagent brief must require reading the catalog and calling only task-matched skills, naming them explicitly.
6. Skills and MCP stay fully available; this section removes nothing.`;

export function capabilityProtocolText(locale: string): string {
	const zh = /^zh/i.test(locale);
	return zh ? PROTOCOL_ZH : PROTOCOL_EN;
}
