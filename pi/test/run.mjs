#!/usr/bin/env node
/**
 * pi 支持层自测（无第三方依赖，node 直接跑）。
 *
 *   node pi/test/run.mjs
 *
 * 覆盖：
 *   1. build 产物：ChatML 剥壳、技能 frontmatter 转换、角色保留
 *   2. install 到临时 HOME：扩展 / 包 / 技能 / 角色落地，卸载只删自己的
 *   3. 扩展运行时：before_agent_start 的 section/lead/off/lab 闸门、模型路由、命令注册
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const PI = join(ROOT, "pi");

let pass = 0;
let fail = 0;

function ok(name, cond, extra = "") {
	if (cond) {
		pass += 1;
		console.log(`  ✓ ${name}`);
	} else {
		fail += 1;
		console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ""}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

// ── 1. build ────────────────────────────────────────────────────────────────

section("1. build 产物");

execFileSync(process.execPath, [join(PI, "bin", "build.mjs")], { stdio: "pipe" });

const packPath = join(PI, "generated", "packs", "zh-default.md");
ok("zh-default 包存在", existsSync(packPath));
const packRaw = existsSync(packPath) ? readFileSync(packPath, "utf8") : "";
ok("已剥掉 ChatML 外壳", !packRaw.includes("<|im_start|>") && !packRaw.includes("<|im_end|>"));
ok("包体量像话（>10KB）", packRaw.length > 10_000, `实际 ${packRaw.length}B`);
ok("包带 frontmatter", packRaw.startsWith("---\nname:"));

const skillDirs = existsSync(join(PI, "generated", "skills"))
	? readdirSync(join(PI, "generated", "skills")).filter((d) => d.startsWith("redteam-"))
	: [];
ok("23 个技能全部转换", skillDirs.length === 23, `实际 ${skillDirs.length}`);

const suo5 = join(PI, "generated", "skills", "redteam-suo5-tunnel", "SKILL.md");
ok("技能目录结构符合 pi 规范", existsSync(suo5));
if (existsSync(suo5)) {
	const text = readFileSync(suo5, "utf8");
	ok("技能 frontmatter 有 name/description", /^---[\s\S]*name: redteam-suo5-tunnel[\s\S]*description:/.test(text));
	ok("role 没丢（折进正文）", text.includes("红队角色") && text.includes("internal"));
	ok("whenToUse 并进 description", text.includes("适用："));
}

// ── 2. install / uninstall ──────────────────────────────────────────────────

section("2. install / uninstall（临时 HOME）");

const home = mkdtempSync(join(tmpdir(), "dsh-purge-pi-"));
const agent = join(home, ".pi", "agent");
try {
	execFileSync(process.execPath, [join(PI, "bin", "install.mjs"), "install", "--home", home], { stdio: "pipe" });

	ok("扩展落地", existsSync(join(agent, "extensions", "dsh-purge-pi", "index.ts")));
	ok("扩展依赖模块一并落地", existsSync(join(agent, "extensions", "dsh-purge-pi", "packs.ts")));
	ok("提示词包落地", existsSync(join(agent, "purge", "packs", "zh-default.md")));
	ok("技能落地", existsSync(join(agent, "skills", "redteam-suo5-tunnel", "SKILL.md")));
	ok("角色落地", existsSync(join(agent, "agents", "redteam-recon.md")));
	ok("状态文件落地", existsSync(join(agent, "purge", "state.json")));

	const state = JSON.parse(readFileSync(join(agent, "purge", "state.json"), "utf8"));
	ok("默认包指向 zh-default", state.active === "zh-default", JSON.stringify(state.active));

	// 用户自建内容不能被卸载误伤
	mkdirSync(join(agent, "purge", "packs"), { recursive: true });
	writeFileSync(join(agent, "purge", "packs", "mine.md"), "user pack", "utf8");

	execFileSync(process.execPath, [join(PI, "bin", "install.mjs"), "uninstall", "--home", home], { stdio: "pipe" });

	ok("卸载后扩展已移除", !existsSync(join(agent, "extensions", "dsh-purge-pi")));
	ok("卸载后技能已移除", !existsSync(join(agent, "skills", "redteam-suo5-tunnel")));
	ok("卸载不动用户自建包", existsSync(join(agent, "purge", "packs", "mine.md")));
	ok("卸载保留状态文件", existsSync(join(agent, "purge", "state.json")));
} finally {
	rmSync(home, { recursive: true, force: true });
}

// ── 3. 核心逻辑运行时 ────────────────────────────────────────────────────────

section("3. 核心逻辑（applyPrompt / runCommand / preflight）");

const home2 = mkdtempSync(join(tmpdir(), "dsh-purge-pi-rt-"));
try {
	const agent2 = join(home2, ".pi", "agent");
	mkdirSync(join(agent2, "purge", "packs"), { recursive: true });

	writeFileSync(join(agent2, "purge", "packs", "alpha.md"), "---\nname: Alpha\n---\nALPHA-BODY", "utf8");
	writeFileSync(join(agent2, "purge", "packs", "beta.md"), "---\nname: Beta\nlead: true\n---\nBETA-BODY", "utf8");
	writeFileSync(
		join(agent2, "purge", "state.json"),
		JSON.stringify({
			active: "alpha",
			byModel: { "prov/*": "beta" },
			mode: "section",
			onlyInLabMode: false,
			enabled: true,
			capabilityProtocol: true,
		}),
		"utf8",
	);

	// packs.ts 在模块加载时算路径，必须在 import 之前切 HOME
	process.env.HOME = home2;
	const core = await import(pathToFileURL(join(PI, "src", "core.ts")).href);

	const ref = (provider, model) => ({ provider, model });
	const run = (r) => {
		const ev = { systemPrompt: "BASE", systemPromptOptions: { sections: {} } };
		const ret = core.applyPrompt(ev, r);
		return { ret, sections: ev.systemPromptOptions.sections };
	};

	let out = run(ref("other", "m"));
	ok("section 模式：不整段覆盖", !out.ret);
	ok("section 模式：默认包注入", out.sections.purge_pack === "ALPHA-BODY", String(out.sections.purge_pack));
	ok("section 模式：能力协议段注入", Boolean(out.sections.purge_capability));

	out = run(ref("prov", "x"));
	ok("模型路由命中 byModel", out.ret?.systemPrompt?.startsWith("BETA-BODY"), String(out.ret?.systemPrompt?.slice(0, 20)));
	ok("lead 包整段置顶且保留原提示词", Boolean(out.ret?.systemPrompt?.endsWith("BASE")));

	ok("off：完全不注入", (() => {
		core.runCommand("off", ref("other", "m"));
		const r = run(ref("other", "m"));
		const clean = !r.ret && !r.sections.purge_pack;
		core.runCommand("on", ref("other", "m"));
		return clean;
	})());

	core.runCommand("lab on", ref("other", "m"));
	ok("lab 闸门：无 flag 不注入", !run(ref("other", "m")).sections.purge_pack);
	writeFileSync(join(agent2, "lab-mode.flag"), "1", "utf8");
	ok("lab 闸门：有 flag 才注入", run(ref("other", "m")).sections.purge_pack === "ALPHA-BODY");
	core.runCommand("lab off", ref("other", "m"));

	const status = core.runCommand("status", ref("other", "m")).message;
	ok("status 能看到命中包", status.includes("alpha") || status.includes("《Alpha》"));
	ok("status 报出模型路由", status.includes("prov/*"));

	core.runCommand("use beta", ref("other", "m"));
	ok("use 切默认包", JSON.parse(readFileSync(join(agent2, "purge", "state.json"), "utf8")).active === "beta");

	core.runCommand("mode lead", ref("other", "m"));
	ok("mode lead 落盘", JSON.parse(readFileSync(join(agent2, "purge", "state.json"), "utf8")).mode === "lead");

	core.runCommand("model deepseek/* alpha", ref("other", "m"));
	ok("model 路由落盘", JSON.parse(readFileSync(join(agent2, "purge", "state.json"), "utf8")).byModel["deepseek/*"] === "alpha");

	ok("未知子命令给提示而不是崩", core.runCommand("bogus", ref("a", "b")).message.includes("子命令"));

	const pf = core.preflight([]);
	ok("preflight 返回结构化 checks", pf.report.checks.length >= 5);
	ok("preflight 文本可读", pf.text.includes("purge 预检"));
	ok("preflight 不回显密钥明文", !(process.env.FOFA_KEY && pf.text.includes(process.env.FOFA_KEY)));
} finally {
	rmSync(home2, { recursive: true, force: true });
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
