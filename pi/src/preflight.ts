/**
 * 本机能力预检（dsh-purge 的 redteam_preflight 在 pi 侧的等价物）。
 *
 * 只做"能不能开工"的事实收集，不发包、不联网、不读密钥明文——
 * 密钥类只报告"有没有配置"，绝不回显值。
 *
 * 三个容易踩的坑（都已处理）：
 *   1. cwd 不能用 process.cwd()——那是 pi 进程目录，不是用户工作区；由调用方传 ctx.cwd。
 *   2. pi.getMcpServers() 只返回「扩展注册的」MCP，mcp.json 里的不算；
 *      所以同时看工具目录里 mcp__* 的工具名，那才是模型真能调到的。
 *   3. 技能可能装在 ~/.pi/agent/skills（脚本安装），也可能在包内 generated/skills
 *      （pi install 包安装），两边都要认。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DIR, PACKS_DIR, labModeOn } from "./packs.ts";

export interface Check {
	id: string;
	label: string;
	ok: boolean;
	detail: string;
	/** 缺了会影响什么 */
	impact?: string;
	hint?: string;
	/** 渲染时用来聚合建议：env / re / rt，其余不填 */
	group?: "env" | "re" | "rt";
}

export interface PreflightReport {
	ok: boolean;
	cwd: string;
	platform: string;
	node: string;
	labMode: boolean;
	checks: Check[];
	missing: string[];
}

export interface PreflightOptions {
	/** 用户工作区，取自 ctx.cwd；不要用 process.cwd() */
	cwd?: string;
	/** 扩展注册的 MCP 服务名（可能不全，见下） */
	mcpServers?: string[];
	/** 本会话已注册的工具名，用来判断 MCP 是否真的挂上了 */
	toolNames?: string[];
}

/** 逆向链：本机做 APK / 二进制分析最常用的几个 */
const RE_BINARIES: Array<{ name: string; stage: string }> = [
	{ name: "jadx", stage: "APK 反编译" },
	{ name: "apktool", stage: "APK 重打包" },
	{ name: "frida", stage: "动态 Hook" },
	{ name: "adb", stage: "设备调试" },
	{ name: "radare2", stage: "二进制分析" },
];

/** 红队链：按阶段分组，缺了要降级 */
const RT_BINARIES: Array<{ name: string; stage: string }> = [
	{ name: "nmap", stage: "信息收集" },
	{ name: "nuclei", stage: "漏洞发现" },
	{ name: "ffuf", stage: "目录爆破" },
	{ name: "fscan", stage: "内网扫描" },
	{ name: "gogo", stage: "内网扫描" },
	{ name: "suo5", stage: "隧道" },
	{ name: "chisel", stage: "隧道" },
	{ name: "frpc", stage: "隧道" },
	{ name: "impacket-psexec", stage: "横向" },
];

const ENV_KEYS: Array<{ key: string; stage: string; hint: string }> = [
	{ key: "FOFA_KEY", stage: "资产测绘", hint: "FOFA API key；缺失时可用 crt.sh / subfinder 降级" },
	{ key: "RT_VPS_HOST", stage: "反弹 Shell", hint: "演练 VPS 地址；缺失时只能做不需要落地 shell 的成果" },
];

const BUILTIN_SKILLS_DIR = (() => {
	try {
		return fileURLToPath(new URL("../generated/skills", import.meta.url));
	} catch {
		return "";
	}
})();

function which(bin: string): string | undefined {
	try {
		const cmd = process.platform === "win32" ? "where" : "which";
		const out = execFileSync(cmd, [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });
		const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
		return first || undefined;
	} catch {
		return undefined;
	}
}

function countDirs(dir: string, prefix?: string): number {
	if (!dir || !existsSync(dir)) return 0;
	try {
		return readdirSync(dir, { withFileTypes: true }).filter(
			(e) => e.isDirectory() && (!prefix || e.name.startsWith(prefix)),
		).length;
	} catch {
		return 0;
	}
}

function isMcpToolName(name: string): boolean {
	return name === "mcp" || name.startsWith("mcp__") || name.startsWith("mcp-");
}

export function runPreflight(opts: PreflightOptions = {}): PreflightReport {
	const checks: Check[] = [];

	const lab = labModeOn();
	checks.push({
		id: "lab-mode",
		label: "实验室模式开关",
		ok: lab,
		detail: lab ? "lab-mode.flag 存在" : "lab-mode.flag 不存在",
		hint: lab ? undefined : "在会话里发 `lab：` 打开；不影响本工具，只影响需要闸门的提示词包",
	});

	for (const item of ENV_KEYS) {
		const value = process.env[item.key];
		checks.push({
			id: `env:${item.key}`,
			label: `环境变量 ${item.key}（${item.stage}）`,
			ok: Boolean(value && value.trim()),
			detail: value && value.trim() ? "已配置（值不回显）" : "未配置",
			impact: item.stage,
			hint: item.hint,
			group: "env",
		});
	}

	for (const item of RE_BINARIES) {
		const path = which(item.name);
		checks.push({
			id: `bin:${item.name}`,
			label: `二进制 ${item.name}（${item.stage}）`,
			ok: Boolean(path),
			detail: path || "PATH 中找不到",
			impact: item.stage,
			hint: path ? undefined : `逆向链缺 ${item.name}，对应能力走不通`,
			group: "re",
		});
	}

	for (const item of RT_BINARIES) {
		const path = which(item.name);
		checks.push({
			id: `bin:${item.name}`,
			label: `二进制 ${item.name}（${item.stage}）`,
			ok: Boolean(path),
			detail: path || "PATH 中找不到",
			impact: item.stage,
			hint: path ? undefined : `红队链缺 ${item.name}，该阶段需换工具或说明降级`,
			group: "rt",
		});
	}

	const packs = existsSync(PACKS_DIR) ? readdirSync(PACKS_DIR).filter((f) => f.endsWith(".md")).length : 0;
	checks.push({
		id: "packs",
		label: "提示词包",
		ok: packs > 0,
		detail: `${packs} 个（${PACKS_DIR}）`,
		hint: packs > 0 ? undefined : "跑 `node pi/bin/install.mjs install`，或重启 pi 让扩展自动补内置包",
	});

	// 技能：脚本安装落在 ~/.pi/agent/skills，包安装留在仓库 generated/skills
	const userSkills = countDirs(join(AGENT_DIR, "skills"), "redteam-");
	const builtinSkills = countDirs(BUILTIN_SKILLS_DIR, "redteam-");
	const skillTotal = Math.max(userSkills, builtinSkills);
	const skillWhere = userSkills > 0 ? "~/.pi/agent/skills" : builtinSkills > 0 ? "包内 generated/skills" : "";
	checks.push({
		id: "skills",
		label: "红队技能",
		ok: skillTotal > 0,
		detail: skillTotal > 0 ? `${skillTotal} 个（${skillWhere}）` : `未找到（查过 ${join(AGENT_DIR, "skills")} 与包内 generated/skills）`,
		hint: skillTotal > 0 ? undefined : "`node pi/bin/install.mjs install` 或 `node pi/bin/build.mjs`",
	});

	// MCP：getMcpServers 只含扩展注册的，mcp.json 的要从工具名看
	const declared = opts.mcpServers ?? [];
	const mcpTools = (opts.toolNames ?? []).filter(isMcpToolName);
	const mcpOk = declared.length > 0 || mcpTools.length > 0;
	checks.push({
		id: "mcp",
		label: "MCP 服务",
		ok: mcpOk,
		detail: mcpOk
			? [
					declared.length > 0 ? declared.join(", ") : "",
					mcpTools.length > 0 ? `${mcpTools.length} 个 MCP 工具（${mcpTools.slice(0, 6).join(", ")}${mcpTools.length > 6 ? " …" : ""}）` : "",
				]
					.filter(Boolean)
					.join(" · ")
			: "本会话未挂载 MCP",
		hint: mcpOk ? undefined : "需要浏览器/扫描器类能力时，先 `pi mcp` 配好再用",
	});

	const missing = checks.filter((c) => !c.ok).map((c) => c.id);
	return {
		ok: missing.length === 0,
		cwd: opts.cwd ?? process.cwd(),
		platform: `${process.platform}/${process.arch}`,
		node: process.version,
		labMode: lab,
		checks,
		missing,
	};
}

export function renderPreflight(report: PreflightReport): string {
	const lines = report.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`);

	// 建议：env 逐条给，二进制按链路聚合成一行，其余按 hint
	const failed = report.checks.filter((c) => !c.ok);
	const advice: string[] = [];
	for (const c of failed.filter((c) => c.group === "env")) advice.push(`- ${c.label} → ${c.hint}`);
	const names = (group: "re" | "rt") => failed.filter((c) => c.group === group).map((c) => c.id.replace(/^bin:/, ""));
	const reMissing = names("re");
	const rtMissing = names("rt");
	if (reMissing.length > 0) advice.push(`- 逆向链缺 ${reMissing.length} 个：${reMissing.join(", ")} → 补装，或把对应能力标记为不可用`);
	if (rtMissing.length > 0) advice.push(`- 红队链缺 ${rtMissing.length} 个：${rtMissing.join(", ")} → 该阶段换工具，或在汇报里写明降级`);
	for (const c of failed.filter((c) => !c.group && c.hint)) advice.push(`- ${c.label} → ${c.hint}`);

	return [
		`purge 预检  cwd=${report.cwd}  ${report.platform}  node=${report.node}`,
		...lines,
		advice.length ? `\n补齐建议：\n${advice.join("\n")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
