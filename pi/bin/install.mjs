#!/usr/bin/env node
/**
 * 把 dsh-purge 的 pi 资产装进本机 pi：扩展 / 提示词包 / 23 个红队技能 / 5 个红队角色。
 *
 *   node pi/bin/install.mjs install      # 安装（默认）
 *   node pi/bin/install.mjs status       # 看装了什么
 *   node pi/bin/install.mjs uninstall    # 卸载（只删 manifest 里记过的路径）
 *
 * 选项：
 *   --home <dir>   覆盖 HOME（测试/便携安装用）
 *   --dry-run      只打印要做什么
 *   --force        覆盖已存在的用户改动（默认提示词包与技能会被内置版本覆盖）
 *
 * 卸载纪律：只删除 .installed.json 里记录的路径，绝不递归清理用户目录。
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const PI_SRC = join(ROOT, "pi");
const GENERATED = join(PI_SRC, "generated");

const argv = process.argv.slice(2);
const command = (argv[0] && !argv[0].startsWith("-") ? argv[0] : "install").toLowerCase();
const flag = (name, hasValue = false) => {
	const i = argv.indexOf(`--${name}`);
	if (i === -1) return hasValue ? undefined : false;
	return hasValue ? argv[i + 1] : true;
};
const HOME = flag("home", true) ? resolve(flag("home", true)) : homedir();
const AGENT = join(HOME, ".pi", "agent");
const DRY = flag("dry-run");
const FORCE = flag("force");

const TARGETS = {
	extension: join(AGENT, "extensions", "dsh-purge-pi"),
	packs: join(AGENT, "purge", "packs"),
	skills: join(AGENT, "skills"),
	agents: join(AGENT, "agents"),
	state: join(AGENT, "purge", "state.json"),
	manifest: join(AGENT, "purge", ".installed.json"),
};

const log = (msg) => console.log(`${DRY ? "[dry] " : ""}${msg}`);

function ensureBuilt() {
	if (existsSync(join(GENERATED, "manifest.json"))) return;
	log("generated/ 不存在，先跑 build …");
	const r = spawnSync(process.execPath, [join(PI_SRC, "bin", "build.mjs")], { stdio: "inherit" });
	if (r.status !== 0) process.exit(r.status ?? 1);
}

function copyDir(src, dst, installed) {
	if (!existsSync(src)) return;
	log(`复制 ${src} → ${dst}`);
	if (DRY) return;
	mkdirSync(dst, { recursive: true });
	cpSync(src, dst, { recursive: true, force: true });
	// 记录目录本身而不是里面每个文件：卸载时整目录清掉，不留空壳
	installed.push(dst);
}

function copyFileInto(src, dstDir, installed) {
	if (!existsSync(src)) return;
	log(`复制 ${src} → ${dstDir}/`);
	if (DRY) return;
	mkdirSync(dstDir, { recursive: true });
	const dst = join(dstDir, relBase(src));
	cpSync(src, dst, { force: true });
	installed.push(dst);
}

function relBase(p) {
	return p.split(/[\\/]/).pop();
}

function writeStateIfMissing() {
	if (existsSync(TARGETS.state)) {
		log(`保留已有状态 ${TARGETS.state}`);
		return;
	}
	const state = {
		active: "zh-default",
		byModel: {},
		mode: "section",
		onlyInLabMode: false,
		enabled: true,
		capabilityProtocol: true,
	};
	log(`写入默认状态 ${TARGETS.state}`);
	if (!DRY) {
		mkdirSync(dirname(TARGETS.state), { recursive: true });
		writeFileSync(TARGETS.state, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	}
}

function doInstall() {
	ensureBuilt();
	if (!existsSync(join(GENERATED, "manifest.json"))) {
		console.error("generated/ 仍然缺失，跑 `node pi/bin/build.mjs` 看看报错。");
		process.exit(1);
	}

	const installed = { version: 1, installedAt: new Date().toISOString(), paths: [] };

	// 1. 扩展本体
	copyDir(join(PI_SRC, "src"), TARGETS.extension, installed.paths);

	// 2. 提示词包（内置包覆盖，用户自建包不动）
	const packDir = join(GENERATED, "packs");
	if (existsSync(packDir)) {
		for (const file of readdirSync(packDir).filter((f) => f.endsWith(".md"))) {
			copyFileInto(join(packDir, file), TARGETS.packs, installed.paths);
		}
	}

	// 3. 红队技能 → ~/.pi/agent/skills/redteam-<name>/SKILL.md
	const skillRoot = join(GENERATED, "skills");
	if (existsSync(skillRoot)) {
		for (const dir of readdirSync(skillRoot)) {
			copyDir(join(skillRoot, dir), join(TARGETS.skills, dir), installed.paths);
		}
	}

	// 4. 红队角色 → ~/.pi/agent/agents/（pi-subagents 用户级目录）
	const agentDir = join(PI_SRC, "agents");
	if (existsSync(agentDir)) {
		for (const file of readdirSync(agentDir).filter((f) => f.endsWith(".md"))) {
			copyFileInto(join(agentDir, file), TARGETS.agents, installed.paths);
		}
	}

	writeStateIfMissing();

	if (!DRY) {
		mkdirSync(dirname(TARGETS.manifest), { recursive: true });
		writeFileSync(TARGETS.manifest, `${JSON.stringify(installed, null, 2)}\n`, "utf8");
	}

	const skills = installed.paths.filter((p) => p.includes(`${join("skills", "redteam-")}`)).length;
	const agents = installed.paths.filter((p) => p.includes(`${join("agents", "redteam-")}`)).length;
	console.log(`
✓ 安装完成
  扩展    ${TARGETS.extension}
  提示词包 ${TARGETS.packs}
  技能     ${skills} 项
  角色     ${agents} 项
  状态     ${TARGETS.state}

下一步：重启 pi 会话 → 发 /purge 看状态 → /purge doctor 做本机预检。
`);
	if (FORCE) console.log("（--force：内置资产已覆盖同名文件）");
}

function doUninstall() {
	if (!existsSync(TARGETS.manifest)) {
		console.log(`没有找到 ${TARGETS.manifest}，这个仓库没通过 install.mjs 装过东西，什么都没删。`);
		return;
	}
	const manifest = JSON.parse(readFileSync(TARGETS.manifest, "utf8"));
	const paths = Array.isArray(manifest.paths) ? manifest.paths : [];
	let removed = 0;
	for (const p of paths) {
		if (!p.startsWith(AGENT)) continue; // 只允许删 pi 目录内
		if (!existsSync(p)) continue;
		log(`删除 ${p}`);
		if (!DRY) rmSync(p, { recursive: true, force: true });
		removed += 1;
	}
	if (!DRY) rmSync(TARGETS.manifest, { force: true });
	console.log(`✓ 已移除 ${removed} 项（状态文件与你自己加的包保留：${TARGETS.state}）`);
}

function doStatus() {
	const exists = (p) => (existsSync(p) ? "✓" : "✗");
	const count = (dir, prefix) => {
		if (!existsSync(dir)) return 0;
		try {
			return readdirSync(dir).filter((n) => !prefix || n.startsWith(prefix)).length;
		} catch {
			return 0;
		}
	};
	const state = existsSync(TARGETS.state) ? JSON.parse(readFileSync(TARGETS.state, "utf8")) : null;
	console.log(`pi-purge 安装状态（HOME=${HOME}）
  ${exists(TARGETS.extension)} 扩展    ${TARGETS.extension}
  ${exists(TARGETS.packs)} 提示词包 ${count(TARGETS.packs)} 个
  ${exists(TARGETS.skills)} 技能     ${count(join(TARGETS.skills), "redteam-")} 个
  ${exists(TARGETS.agents)} 角色     ${count(TARGETS.agents, "redteam-")} 个
  ${exists(TARGETS.state)} 状态     ${state ? `active=${state.active} mode=${state.mode} enabled=${state.enabled}` : TARGETS.state}
`);
}

switch (command) {
	case "install":
		doInstall();
		break;
	case "uninstall":
	case "remove":
		doUninstall();
		break;
	case "status":
		doStatus();
		break;
	default:
		console.error(`未知命令 ${command}\n用法：node pi/bin/install.mjs [install|status|uninstall] [--home <dir>] [--dry-run] [--force]`);
		process.exit(1);
}
