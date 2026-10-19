/**
 * 提示词包：读盘 / 解析 frontmatter / 模型路由。
 *
 * 与 dsh 版的关系：dsh 侧靠改宿主的 prompt 组装链（order -10000）来置顶，
 * pi 侧只需要在 before_agent_start 里改 systemPromptOptions.sections 或返回
 * 整段 systemPrompt，宿主会重排并记录 transcript delta。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const AGENT_DIR = join(homedir(), ".pi", "agent");
export const PURGE_DIR = join(AGENT_DIR, "purge");
export const PACKS_DIR = join(PURGE_DIR, "packs");
export const STATE_FILE = join(PURGE_DIR, "state.json");
export const LAB_FLAG = join(AGENT_DIR, "lab-mode.flag");

export type InjectMode = "lead" | "section";

export interface PurgeState {
	/** 没有模型命中时使用的默认包 */
	active: string;
	/** provider/model glob → 包 id；支持 * 与 ? */
	byModel: Record<string, string>;
	/** lead = 整段置顶；section = 追加 XML 段（cache 友好） */
	mode: InjectMode;
	/** 只在实验室模式（lab-mode.flag 存在）下注入 */
	onlyInLabMode: boolean;
	/** 总开关 */
	enabled: boolean;
	/** 能力选用协议段（先读 skill/MCP 目录再动手） */
	capabilityProtocol: boolean;
}

export const DEFAULT_STATE: PurgeState = {
	active: "",
	byModel: {},
	mode: "section",
	onlyInLabMode: false,
	enabled: true,
	capabilityProtocol: true,
};

export function loadState(): PurgeState {
	try {
		if (existsSync(STATE_FILE)) {
			const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<PurgeState>;
			return { ...DEFAULT_STATE, ...raw, byModel: { ...(raw.byModel ?? {}) } };
		}
	} catch {
		/* 坏文件按默认值走，绝不阻断会话 */
	}
	return { ...DEFAULT_STATE, byModel: {} };
}

export function saveState(state: PurgeState): void {
	mkdirSync(PURGE_DIR, { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export interface Pack {
	id: string;
	name: string;
	models: string[];
	/** frontmatter 显式指定时覆盖全局 mode */
	lead?: boolean;
	body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parsePack(id: string, raw: string): Pack {
	let body = raw;
	let name = id;
	let models: string[] = [];
	let lead: boolean | undefined;

	const m = FRONTMATTER.exec(raw);
	if (m) {
		body = raw.slice(m[0].length);
		for (const line of m[1].split(/\r?\n/)) {
			const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
			if (!kv) continue;
			const key = kv[1];
			const value = kv[2].trim();
			if (key === "name") name = value || id;
			else if (key === "models") models = value.split(",").map((s) => s.trim()).filter(Boolean);
			else if (key === "lead") lead = /^(true|1|yes)$/i.test(value);
		}
	}

	return { id, name, models, lead, body: body.trim() };
}

const SAFE_ID = /^[\w.-]+$/;

export function getPack(id: string): Pack | undefined {
	if (!id || !SAFE_ID.test(id)) return undefined;
	const fp = join(PACKS_DIR, `${id}.md`);
	if (!existsSync(fp)) return undefined;
	try {
		return parsePack(id, readFileSync(fp, "utf8"));
	} catch {
		return undefined;
	}
}

export function listPacks(): Pack[] {
	const out: Pack[] = [];
	if (!existsSync(PACKS_DIR)) return out;
	let files: string[] = [];
	try {
		files = readdirSync(PACKS_DIR);
	} catch {
		return out;
	}
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const pack = getPack(basename(file, ".md"));
		if (pack) out.push(pack);
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/** 精确匹配优先，其余按 pattern 长度降序（越长越具体） */
export function matchModel(state: PurgeState, provider: string, model: string): string {
	const full = `${provider}/${model}`;
	const entries = Object.entries(state.byModel ?? {});
	if (entries.length === 0) return state.active;
	for (const [pattern, packId] of entries) {
		if (pattern === full) return packId;
	}
	const sorted = [...entries].sort((a, b) => b[0].length - a[0].length);
	for (const [pattern, packId] of sorted) {
		if (globToRegExp(pattern).test(full)) return packId;
	}
	return state.active;
}

export function labModeOn(): boolean {
	return existsSync(LAB_FLAG);
}

export function resolvePack(state: PurgeState, provider: string, model: string): Pack | undefined {
	if (!state.enabled) return undefined;
	if (state.onlyInLabMode && !labModeOn()) return undefined;
	const pack = getPack(matchModel(state, provider, model));
	return pack && pack.body ? pack : undefined;
}
