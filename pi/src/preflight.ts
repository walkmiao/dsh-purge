/**
 * 本机能力预检（dsh-purge 的 redteam_preflight 在 pi 侧的等价物）。
 *
 * 只做"能不能开工"的事实收集，不发包、不联网、不读密钥明文——
 * 密钥类只报告"有没有配置"，绝不回显值。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR, PACKS_DIR, labModeOn } from "./packs.ts";

export interface Check {
	id: string;
	label: string;
	ok: boolean;
	detail: string;
	/** 缺了会影响什么 */
	impact?: string;
	hint?: string;
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

/** 红队链路里真正要落地的二进制，按阶段分组 */
const BINARIES: Array<{ name: string; stage: string; required: boolean }> = [
	{ name: "nmap", stage: "信息收集", required: false },
	{ name: "nuclei", stage: "漏洞发现", required: false },
	{ name: "ffuf", stage: "目录爆破", required: false },
	{ name: "fscan", stage: "内网扫描", required: false },
	{ name: "gogo", stage: "内网扫描", required: false },
	{ name: "suo5", stage: "隧道", required: false },
	{ name: "chisel", stage: "隧道", required: false },
	{ name: "frpc", stage: "隧道", required: false },
	{ name: "impacket-psexec", stage: "横向", required: false },
];

const ENV_KEYS: Array<{ key: string; stage: string; hint: string }> = [
	{ key: "FOFA_KEY", stage: "资产测绘", hint: "FOFA API key；缺失时可用 crt.sh / subfinder 降级" },
	{ key: "RT_VPS_HOST", stage: "反弹 Shell", hint: "演练 VPS 地址；缺失时只能做不需要落地 shell 的成果" },
];

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
	if (!existsSync(dir)) return 0;
	try {
		return readdirSync(dir, { withFileTypes: true }).filter(
			(e) => e.isDirectory() && (!prefix || e.name.startsWith(prefix)),
		).length;
	} catch {
		return 0;
	}
}

export function runPreflight(opts: { cwd?: string; mcpServers?: string[] } = {}): PreflightReport {
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
		});
	}

	for (const item of BINARIES) {
		const path = which(item.name);
		checks.push({
			id: `bin:${item.name}`,
			label: `二进制 ${item.name}（${item.stage}）`,
			ok: Boolean(path),
			detail: path || "PATH 中找不到",
			impact: item.stage,
			hint: path ? undefined : `装上 ${item.name}，或用同阶段其它工具替代并在汇报里说明降级`,
		});
	}

	const packs = existsSync(PACKS_DIR) ? readdirSync(PACKS_DIR).filter((f) => f.endsWith(".md")).length : 0;
	checks.push({
		id: "packs",
		label: "提示词包",
		ok: packs > 0,
		detail: `${packs} 个（${PACKS_DIR}）`,
		hint: packs > 0 ? undefined : "跑一次 `node pi/bin/install.mjs install` 生成内置包",
	});

	const skills = countDirs(join(AGENT_DIR, "skills"), "redteam-");
	checks.push({
		id: "skills",
		label: "红队技能",
		ok: skills > 0,
		detail: skills > 0 ? `${skills} 个已安装` : "未安装",
		hint: skills > 0 ? undefined : "`node pi/bin/install.mjs install` 会把 23 个技能落到 ~/.pi/agent/skills",
	});

	const mcp = opts.mcpServers ?? [];
	checks.push({
		id: "mcp",
		label: "MCP 服务",
		ok: mcp.length > 0,
		detail: mcp.length > 0 ? mcp.join(", ") : "本会话未挂载 MCP",
		hint: mcp.length > 0 ? undefined : "需要浏览器/扫描器类能力时，先 `pi mcp` 配好再用",
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
	const optional = report.checks.filter((c) => !c.ok && c.hint).map((c) => `- ${c.label} → ${c.hint}`);
	return [
		`purge 预检  cwd=${report.cwd}  ${report.platform}  node=${report.node}`,
		...lines,
		optional.length ? `\n补齐建议：\n${optional.join("\n")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
