#!/usr/bin/env node
// 依存更新で新しく入る版を、npm のメタデータで確かめる。dependency-check.mjs から呼ぶ。
// usage: node publisher-check.mjs <base ref>（push される HEAD のコミットを見る）
// 終了コード: 0 通過 / 1 失敗 / 2 npm に問い合わせられなかった
//
// base と HEAD の lockfile を比べ、新しく入った「名前@版」ごとに references/dependency-triage.md の
// 「公開日と中身の確かめ方」を当てる。前の版は、base にあった同じ名前のいちばん新しい版。
//   - install script（preinstall・install・postinstall）が前の版になかった、または変わった。前の版がない名前は、あれば失敗。
//     前の版と同じものは通す（required check で毎回止めないため。巡回は triage のとおりこれも要判断にする）
//   - 公開者: 新しい版の _npmUser が前の版の maintainers にいない / provenance がなくなった / trusted publishing から人の公開に変わった。
//     人から trusted publishing への移行（provenance あり）と、trusted publishing どうしは通す。前の版がない名前は見ない
//   - 公開から 4 日未満

import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { npmResolutions, pnpmResolutions } from "./lockfile.mjs";

const MIN_AGE_DAYS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];
const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
]);
const TRUSTED_PUBLISHER = "GitHub Actions";
const REGISTRY = "https://registry.npmjs.org/";

const [base] = process.argv.slice(2);
if (!base) {
  console.error("usage: node publisher-check.mjs <base ref>");
  process.exit(64);
}

const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

process.chdir(git("rev-parse", "--show-toplevel").trim());
const mergeBase = git("merge-base", base, "HEAD").trim();
const lockfiles = git("diff", "--name-only", mergeBase, "HEAD")
  .split("\n")
  .filter((file) => LOCKFILES.has(path.basename(file)));

// 名前 → レジストリから解決する版の集合と、名前と版を読めない鍵。レジストリ以外の解決は check-diff が止める
function versionsAt(ref, file) {
  let text;
  try {
    text = git("show", `${ref}:${file}`);
  } catch {
    return { byName: new Map(), unreadable: new Set() };
  }
  const isPnpm = path.basename(file) === "pnpm-lock.yaml";
  const resolutions = isPnpm ? pnpmResolutions(text) : npmResolutions(text);
  const byName = new Map();
  const unreadable = new Set();
  for (const [key, { registry, name, version }] of resolutions ?? []) {
    if (!registry) continue;
    if (!name || !/^\d+\.\d+\.\d+/.test(version ?? "")) {
      unreadable.add(key);
      continue;
    }
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(version);
  }
  return { byName, unreadable };
}

function compareVersions(a, b) {
  const parts = (version) => version.split(/[.+-]/).slice(0, 3).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

// _npmUser と maintainers は「名前 <メール>」の文字列か { name, email }
const personName = (person) =>
  (typeof person === "string" ? person : (person?.name ?? ""))
    .replace(/\s*<[^>]*>\s*$/, "")
    .trim();

// 項目を指定せずに 1 つの版を頼むと、npm view はその版のメタデータを 1 つのオブジェクトで返す。
// PR のチェックアウトの .npmrc を読まないよう、チェックアウトの外で、レジストリを決めて呼ぶ
function view(spec) {
  const out = execFileSync(
    "npm",
    ["view", spec, "--json", `--registry=${REGISTRY}`],
    { cwd: os.tmpdir(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const data = out === "" ? null : JSON.parse(out);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${spec} のメタデータが 1 つの版の形ではない`);
  }
  return data;
}

const added = new Map();
// 読めない鍵を黙って通さない（base から読めなかったものは、この PR の問題ではないので除く）
const unreadable = [];
for (const file of lockfiles) {
  const before = versionsAt(mergeBase, file);
  const after = versionsAt("HEAD", file);
  for (const key of after.unreadable) {
    if (!before.unreadable.has(key)) unreadable.push(`${file}: ${key}`);
  }
  for (const [name, versions] of after.byName) {
    for (const version of versions) {
      if (before.byName.get(name)?.has(version)) continue;
      const previous = [...(before.byName.get(name) ?? [])]
        .sort(compareVersions)
        .at(-1);
      added.set(`${name}@${version}`, { name, version, previous });
    }
  }
}

const problems = [];
try {
  for (const [spec, { name, version, previous }] of added) {
    const next = view(spec);
    const prev = previous ? view(`${name}@${previous}`) : null;

    for (const hook of INSTALL_SCRIPTS) {
      const command = next.scripts?.[hook];
      if (command !== undefined && command !== prev?.scripts?.[hook]) {
        problems.push(
          `${spec}: ${hook} が${prev ? `前の版（${previous}）から増えた・変わった` : "ある"}（${command}）`,
        );
      }
    }

    const published = Date.parse(next.time?.[version] ?? "");
    if (Number.isNaN(published)) {
      problems.push(`${spec}: 公開日が分からない`);
    } else if (Date.now() - published < MIN_AGE_DAYS * DAY_MS) {
      problems.push(
        `${spec}: 公開から ${MIN_AGE_DAYS} 日たっていない（${new Date(published).toISOString()}）`,
      );
    }

    if (prev) {
      const user = personName(next._npmUser);
      const trusted = user === TRUSTED_PUBLISHER;
      const prevTrusted = personName(prev._npmUser) === TRUSTED_PUBLISHER;
      const provenance = Boolean(next.dist?.attestations);
      const prevProvenance = Boolean(prev.dist?.attestations);
      if (!(trusted && provenance)) {
        if (prevTrusted && !trusted) {
          problems.push(
            `${spec}: 前の版は trusted publishing だったのに、${user || "公開者が分からない"} が公開している`,
          );
        } else if (
          !trusted &&
          !(prev.maintainers ?? []).map(personName).includes(user)
        ) {
          problems.push(
            `${spec}: 公開者 ${user || "（不明）"} が前の版（${previous}）の maintainers にいない`,
          );
        }
        if (prevProvenance && !provenance) {
          problems.push(`${spec}: 前の版にあった provenance がない`);
        }
      }
    }
  }
} catch (error) {
  console.error(`npm に問い合わせられなかった: ${error.message}`);
  process.exit(2);
}

for (const key of unreadable) {
  problems.push(`${key}: lockfile の鍵から名前と版を読めない`);
}
console.log(`新しく入る版: ${added.size} 件`);
if (problems.length > 0) {
  console.log("確かめが要る版がある:");
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}
console.log("公開者・install script・公開日に問題はない");
