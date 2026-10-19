/**
 * dsh-purge → pi agent 移植（宿主适配层）
 *
 * 与 dsh 版的差别：dsh 要改宿主 node_modules / 解 app.asar 才能做到「注入提示词 + 放行审批门」；
 * pi 把这两件事做成了官方扩展点，所以这里不碰宿主任何文件。
 *
 * 能力：
 *   · 多套提示词包，按模型 glob 自动切换（section / lead 两种注入姿态）
 *   · 能力选用协议段（先读 skill/MCP 目录再动手）
 *   · purge_preflight 工具 + /purge doctor：本机能力预检
 *   · 实验室模式闸门（~/.pi/agent/lab-mode.flag）
 *
 * 逻辑都在 core.ts，这里只做接线，方便脱离宿主测试。
 *
 * 署名：思路与提示词来自 YuJunZhiXue/dsh-purge（MIT）。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPrompt, modelRefOf, preflight, runCommand } from "./core.ts";
import { seedBuiltinPacks } from "./packs.ts";

/** 收集预检需要的宿主侧事实：扩展注册的 MCP + 真实工具名（mcp.json 的只能从工具名看出来） */
function collectEnv(pi: ExtensionAPI, cwd: string | undefined) {
	let mcpServers: string[] = [];
	let toolNames: string[] = [];
	try {
		mcpServers = (pi.getMcpServers?.() ?? []).map((s: { name: string }) => s.name);
	} catch {
		/* 宿主没有 MCP 能力时忽略 */
	}
	try {
		toolNames = (pi.getAllTools?.() ?? []).map((t: { name: string }) => t.name);
	} catch {
		/* 工具目录尚不可用时忽略 */
	}
	return { cwd, mcpServers, toolNames };
}

export default function dshPurgePi(pi: ExtensionAPI) {
	// 包安装（pi install <repo>）不会执行 install.mjs，这里补一次内置包，只补缺不覆盖
	seedBuiltinPacks();

	// 每次 agent 启动都重读状态，改包不用重启
	pi.on("before_agent_start", async (event, ctx) => applyPrompt(event, modelRefOf(ctx)));

	pi.registerTool(
		defineTool({
			name: "purge_preflight",
			label: "Purge Preflight",
			description:
				"检查本机是否具备开工条件：LAB 开关、FOFA_KEY / VPS 等环境变量、nmap/fscan/gogo/suo5/chisel/frpc 等二进制、提示词包与红队技能、本会话 MCP。只做事实收集，不联网、不回显密钥。",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const result = preflight(collectEnv(pi, ctx?.cwd));
				return {
					content: [{ type: "text", text: result.text }],
					details: result.report,
				};
			},
		}),
	);

	pi.registerCommand("purge", {
		description: "pi-purge：提示词包 / 模型路由 / 注入姿态 / 预检",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "doctor") {
				ctx.ui.notify(preflight(collectEnv(pi, ctx.cwd)).text, "info");
				return;
			}
			const result = runCommand(args, modelRefOf(ctx));
			ctx.ui.notify(result.message, result.level);
		},
	});
}
