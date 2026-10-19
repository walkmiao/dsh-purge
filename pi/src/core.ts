/**
 * 与宿主无关的核心逻辑。
 *
 * 这一层不 import 任何 @earendil-works/* 包：
 *   · 可以脱离 pi 用 node 直接跑测试；
 *   · 将来接别的 harness（dsh / 其它 CLI）只要再写一层薄适配。
 *
 * index.ts 只负责把这里的返回值接到 pi 的 extension API 上。
 */

import { PACKS_DIR, type PurgeState, getPack, labModeOn, listPacks, loadState, matchModel, resolvePack, saveState } from "./packs.ts";
import { CAPABILITY_SECTION, capabilityProtocolText } from "./protocol.ts";
import { renderPreflight, runPreflight, type PreflightOptions, type PreflightReport } from "./preflight.ts";

export const PACK_SECTION = "purge_pack";

export interface ModelRef {
	provider: string;
	model: string;
}

export interface UiSink {
	notify(message: string, level: "info" | "warning" | "error"): void;
}

/** before_agent_start 事件里我们真正用到的字段（pi 的完整事件是这个的超集） */
export interface AgentStartLike {
	systemPrompt: string;
	systemPromptOptions: { sections?: Record<string, string> };
}

export function localeOf(): string {
	return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "zh";
}

export function modelRefOf(ctx: unknown): ModelRef {
	const model = (ctx as { model?: { provider?: string; id?: string; name?: string } } | undefined)?.model;
	return {
		provider: String(model?.provider ?? ""),
		model: String(model?.id ?? model?.name ?? ""),
	};
}

export function statusText(state: PurgeState, ref: ModelRef): string {
	const hit = matchModel(state, ref.provider, ref.model);
	const pack = getPack(hit);
	const packs = listPacks();
	const lines = [
		`pi-purge ${state.enabled ? "ON" : "OFF"}  mode=${state.mode}  labGate=${
			state.onlyInLabMode ? (labModeOn() ? "on(已开)" : "on(未开·不注入)") : "off"
		}  capability=${state.capabilityProtocol ? "on" : "off"}`,
		`当前模型 ${ref.provider || "?"}/${ref.model || "?"} → ${hit || "(无)"}${pack ? ` 《${pack.name}》 ${pack.body.length}B` : ""}`,
		`默认包 ${state.active || "(无)"}`,
	];
	const routes = Object.entries(state.byModel ?? {});
	if (routes.length > 0) {
		lines.push("模型路由：");
		for (const [pattern, id] of routes) lines.push(`  ${pattern} → ${id}`);
	}
	lines.push(`可用包 ${packs.length} 个${packs.length ? "：" : ""}`);
	for (const p of packs) lines.push(`  ${p.id}${p.name !== p.id ? `  《${p.name}》` : ""}  ${p.body.length}B`);
	if (packs.length === 0) lines.push(`  包目录：${PACKS_DIR}`);
	return lines.join("\n");
}

/**
 * 注入。返回 { systemPrompt } 表示要整段覆盖（lead 姿态），返回 undefined 表示已就地改 sections。
 */
export function applyPrompt(event: AgentStartLike, ref: ModelRef): { systemPrompt?: string } | undefined {
	const state = loadState();
	const pack = resolvePack(state, ref.provider, ref.model);
	const protocol = state.capabilityProtocol ? capabilityProtocolText(localeOf()) : "";
	if (!pack && !protocol) return undefined;

	const lead = pack?.lead ?? state.mode === "lead";
	if (lead) {
		const head = [pack?.body, protocol].filter(Boolean).join("\n\n");
		return { systemPrompt: `${head}\n\n${event.systemPrompt}` };
	}

	const sections = (event.systemPromptOptions.sections ??= {});
	if (pack) sections[PACK_SECTION] = pack.body;
	if (protocol) sections[CAPABILITY_SECTION] = protocol;
	return undefined;
}

export interface CommandResult {
	level: "info" | "warning" | "error";
	message: string;
}

/** `/purge <sub> ...`。纯函数：只读写磁盘状态并返回一条给用户的消息 */
export function runCommand(args: string, ref: ModelRef): CommandResult {
	const state = loadState();
	const [sub, ...rest] = args.trim().split(/\s+/);
	const arg = rest.join(" ").trim();
	const info = (message: string): CommandResult => ({ level: "info", message });
	const warn = (message: string): CommandResult => ({ level: "warning", message });
	const error = (message: string): CommandResult => ({ level: "error", message });

	switch ((sub || "status").toLowerCase()) {
		case "status":
			return info(statusText(state, ref));

		case "list": {
			const packs = listPacks();
			return info(
				packs.length
					? packs.map((p) => `${p.id}  《${p.name}》  ${p.body.length}B  ${p.models.join(",") || "-"}`).join("\n")
					: `包目录为空：${PACKS_DIR}\n跑 node pi/bin/install.mjs install 生成内置包`,
			);
		}

		case "use": {
			if (!arg) return warn("用法：/purge use <包id>");
			if (!getPack(arg)) return error(`找不到包 ${arg}（目录 ${PACKS_DIR}）`);
			state.active = arg;
			saveState(state);
			return info(`默认包 → ${arg}（下一轮对话生效）`);
		}

		case "model": {
			const [pattern, packId] = rest;
			if (!pattern || !packId) return warn("用法：/purge model <provider/模型或glob> <包id|->");
			if (packId === "-") delete state.byModel[pattern];
			else {
				if (!getPack(packId)) return error(`找不到包 ${packId}`);
				state.byModel[pattern] = packId;
			}
			saveState(state);
			return info(`路由 ${pattern} → ${packId === "-" ? "(已删除)" : packId}`);
		}

		case "mode": {
			if (arg !== "lead" && arg !== "section") return warn("用法：/purge mode lead|section");
			state.mode = arg;
			saveState(state);
			return info(
				`注入姿态 = ${arg}${arg === "lead" ? "（整段置顶，prompt cache 会失效）" : "（结构化段，cache 友好）"}`,
			);
		}

		case "lab": {
			state.onlyInLabMode = arg === "on";
			saveState(state);
			return info(`实验环境闸门 = ${state.onlyInLabMode ? "on" : "off"}（lab-mode.flag：${labModeOn() ? "存在" : "不存在"}）`);
		}

		case "capability": {
			state.capabilityProtocol = arg !== "off";
			saveState(state);
			return info(`能力选用协议段 = ${state.capabilityProtocol ? "on" : "off"}`);
		}

		case "on":
		case "off": {
			state.enabled = sub.toLowerCase() === "on";
			saveState(state);
			return info(`pi-purge = ${state.enabled ? "ON" : "OFF"}`);
		}

		default:
			return info(
				"子命令：status | list | use <id> | model <glob> <id> | mode lead|section | lab on|off | capability on|off | doctor | on | off",
			);
	}
}

export interface PreflightResult {
	text: string;
	report: PreflightReport;
}

export function preflight(opts: PreflightOptions = {}): PreflightResult {
	const report = runPreflight({ ...opts, cwd: opts.cwd ?? process.cwd() });
	return { text: renderPreflight(report), report };
}
