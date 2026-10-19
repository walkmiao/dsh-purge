#!/usr/bin/env node
/**
 * 把仓库里的 dsh 资产转换成 pi 资产。
 *
 *   lib/default-prompt-inject.{zh,en}.md  → pi/generated/packs/{zh,en}-default.md
 *   skills/redteam/*.md                   → pi/generated/skills/redteam-<name>/SKILL.md
 *
 * 之所以要转：
 *   · dsh 的提示词文件带 ChatML 外壳（<|im_start|>system:），pi 不认，必须剥；
 *   · dsh 技能是扁平 <name>.md，frontmatter 用 whenToUse/role/enabled，pi 要
 *     <name>/SKILL.md 且只认 name/description——role 是红队调度键，不能丢，折进正文。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const OUT = join(ROOT, "pi", "generated");

const args = new Set(process.argv.slice(2));
const check = args.has("--check");

/** 剥掉 dsh 的 ChatML 外壳：首行 <|im_start|>system:<tag> + 可能的 <|im_end|> */
function peelChatml(raw) {
	let text = raw.replace(/^\uFEFF/, "");
	text = text.replace(/^\s*<\|im_start\|>[^\n]*\n?/, "");
	text = text.replace(/<\|im_end\|>\s*$/g, "");
	return text.trim();
}

function writeOut(relPath, content) {
	const abs = join(OUT, relPath);
	if (check) {
		const prev = existsSync(abs) ? readFileSync(abs, "utf8") : null;
		if (prev !== content) {
			console.error(`✗ 过期：${relPath}`);
			return false;
		}
		return true;
	}
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf8");
	return true;
}

// ── 1. 提示词包 ──────────────────────────────────────────────────────────────

const PACKS = [
	{ src: "lib/default-prompt-inject.zh.md", id: "zh-default", name: "破甲底座（中文）" },
	{ src: "lib/default-prompt-inject.en.md", id: "en-default", name: "破甲底座（English）" },
];

let stale = 0;

for (const pack of PACKS) {
	const src = join(ROOT, pack.src);
	if (!existsSync(src)) continue;
	const body = peelChatml(readFileSync(src, "utf8"));
	const out = `---\nname: ${pack.name}\nsource: ${pack.src}\n---\n\n${body}\n`;
	if (!writeOut(join("packs", `${pack.id}.md`), out)) stale += 1;
	console.log(`· pack ${pack.id}  ${body.length}B  ← ${pack.src}`);
}

// ── 2. 红队技能 ──────────────────────────────────────────────────────────────

const SKILLS_DIR = join(ROOT, "skills", "redteam");
const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(raw) {
	const m = FM.exec(raw);
	const meta = {};
	if (!m) return { meta, body: raw.trim() };
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (kv) meta[kv[1]] = kv[2].trim();
	}
	return { meta, body: raw.slice(m[0].length).trim() };
}

const ROLE_LABEL = {
	recon: "信息收集",
	assess: "资产梳理",
	"vuln-scan": "漏洞发现",
	exploit: "漏洞利用",
	internal: "内网渗透",
};

const skillManifest = [];
if (existsSync(SKILLS_DIR)) {
	for (const file of readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md")).sort()) {
		const raw = readFileSync(join(SKILLS_DIR, file), "utf8");
		const { meta, body } = parseFrontmatter(raw);
		const base = file.replace(/\.md$/, "");
		const role = meta.role && ROLE_LABEL[meta.role] ? meta.role : "";
		const descParts = [meta.description || base];
		if (meta.whenToUse) descParts.push(`适用：${meta.whenToUse}`);

		const outMeta = [
			"---",
			`name: redteam-${base}`,
			`description: ${JSON.stringify(descParts.join("；"))}`,
			"---",
			"",
		].join("\n");

		const metaBlock = [
			role ? `> 红队角色：\`${role}\`（${ROLE_LABEL[role]}）· 由 dsh-purge 技能库转换` : "> 由 dsh-purge 技能库转换",
			"",
			"",
		].join("\n");

		const out = `${outMeta}${metaBlock}${body}\n`;
		if (!writeOut(join("skills", `redteam-${base}`, "SKILL.md"), out)) stale += 1;
		skillManifest.push({ name: `redteam-${base}`, role, bytes: body.length });
	}
	console.log(`· skills ${skillManifest.length} 个 ← skills/redteam/`);
}

// ── 3. manifest ─────────────────────────────────────────────────────────────

// 不写时间戳：manifest 是给人和 --check 看的，带时间戳每次 build 都脏
const manifest = {
	packs: PACKS.map((p) => p.id),
	skills: skillManifest,
};
if (!writeOut("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`)) stale += 1;

if (check) {
	if (stale > 0) {
		console.error(`\n有 ${stale} 个文件与仓库不一致，跑 node pi/bin/build.mjs 重新生成。`);
		process.exit(1);
	}
	console.log("\n✓ 生成物与仓库一致");
} else {
	console.log(`\n✓ 输出到 ${OUT}`);
}
