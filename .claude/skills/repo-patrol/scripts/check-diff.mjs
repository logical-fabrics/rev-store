#!/usr/bin/env node
// 巡回 PR の差分が「既存の依存の版の更新」だけかを確かめる。
// usage: node check-diff.mjs <base ref> [--head] [追加で許すパスのパターン ...]
//   既定は作業ツリー（コミット前のものを含む）を見る。--head は push される HEAD のコミットを見る（guard が push の前に使う）
//   パターンの * は / 以外、** は任意の文字列に一致する（例: biome.json、apps/*/tsconfig.json）
// 終了コード: 0 既存の依存の版の更新だけ / 1 それ以外を含む / 3 差分がない
//
// 見ること:
//   - 変わったファイルが package.json・pnpm / npm の lockfile・パターンで許したものだけか
//   - package.json は、既存の依存と overrides の版の値だけが変わっているか。
//     版は ^1.2.3・~1.2.3・1.2.3（npm alias なら同じ alias 先）の形で、記号を変えず、下げず、prerelease にしていないか。
//     作業ツリーでは記号を外した版（^1.2.3 → 1.2.4）も認める。範囲のまま上げると範囲内の最新に解決されるので、
//     いったん exact で lockfile を更新してから記号を戻す。push される HEAD では元の記号に戻っている必要がある。
//     scripts などが変わると、CI の install で任意のコードが secrets 付きで動くため
//   - lockfile の各パッケージの解決が、レジストリの integrity だけか。同じ版の解決が変わっていないか。
//     pnpm-lock.yaml は、追加・変更された行が pnpm の書く形だけか（書式を変えて検査をすり抜けさせない）

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
]);
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const OVERRIDE_PATHS = [["overrides"], ["resolutions"], ["pnpm", "overrides"]];
// 1: npm alias の名前、2: 範囲の記号、3: 版、4: prerelease
const SIMPLE_SPEC =
  /^(?:npm:((?:@[\w.-]+\/)?[\w.-]+)@)?([\^~]?)(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/;
const REGISTRY_URL = /^https:\/\/registry\.npmjs\.org\//;

// pnpm-lock.yaml で追加・変更されてよい行の形（pnpm の書く形）。
const PNPM_TOP_LEVEL = /^[A-Za-z]+:(?: (.+))?$/;
const PNPM_FLOW_LINES = [
  /^ {4,}resolution: \{integrity: [A-Za-z0-9+/=-]+\}$/,
  /^ {4,}engines: \{[^{}[\]]*\}$/,
  /^ {4,}(?:cpu|os|libc): \[[^{}[\]]*\]$/,
];
// 鍵: 引用符付きか、YAML の記号で始まらない語。値は「鍵: 値」の値の部分。
// 鍵は最初の「: 」か行末の「:」まで（overrides の鍵は「jws@>=4.0.0 <4.0.1」のように空白を含む）。
const PNPM_KEY_VALUE =
  /^ {2,}('(?:[^'{}[\]]|'')+'|[\w.@/()+-][^'"{}[\]&*!|%`#,]*?):(?: (.+))?$/;
const PNPM_LIST_ITEM = /^ {4,}- (.+)$/;
// 引用符付きの文字列か、YAML の特殊記法（アンカー・タグ・ブロック・フロー・コメント）を含まない値。
const YAML_SCALAR =
  /^(?:'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[\w^~.=/][^{}[\]#]*)$/;
// resolution は PNPM_FLOW_LINES の 1 行の形（integrity だけ）以外を認めない。
// ブロック形式の resolution: を拒否すれば、その下に tarball: などは書けない。
const SOURCE_KEYS = new Set(["resolution"]);
const SOURCE_VALUE =
  /^(?:link:|file:|workspace:|git\+|git:|github:|gitlab:|bitbucket:|https?:\/\/|ssh:\/\/|[./])/i;
// 別名（name@version）。name に括弧を含むものは peer の付いた版（1.2.3(react@19.0.0)）なので別名ではない。
const ALIAS_VALUE = /^(@?[^@\s()]+)@(\d\S*)$/;

// 版と、その後ろの peer の括弧（入れ子あり。例: 1.1.15(@types/react-dom@19.1.7(@types/react@19.1.10))）だけか。
function isPlainVersion(text) {
  const version = text.match(/^\d+\.\d+\.\d+[\w.+-]*/);
  if (!version) return false;
  let depth = 0;
  for (const ch of text.slice(version[0].length)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 || /\s/.test(ch)) return false;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const args = process.argv.slice(2);
const head = args.includes("--head");
const [base, ...patterns] = args.filter((arg) => arg !== "--head");
if (!base) {
  console.error(
    "usage: node check-diff.mjs <base ref> [--head] [パターン ...]",
  );
  process.exit(64);
}

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

const root = git("rev-parse", "--show-toplevel").trim();
process.chdir(root);
const mergeBase = git("merge-base", base, "HEAD").trim();

const changed = [
  ...new Set(
    (head
      ? git("diff", "--name-only", mergeBase, "HEAD").split("\n")
      : [
          ...git("diff", "--name-only", mergeBase).split("\n"),
          ...git("ls-files", "--others", "--exclude-standard").split("\n"),
        ]
    ).filter(Boolean),
  ),
].sort();

if (changed.length === 0) {
  console.log("差分がない");
  process.exit(3);
}

const allowedPatterns = patterns.map(
  (pattern) =>
    new RegExp(
      `^${pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\0")
        .replace(/\*/g, "[^/]*")
        .replace(/\0/g, ".*")}$`,
    ),
);

const problems = [];
for (const file of changed) {
  const name = path.basename(file);
  if (allowedPatterns.some((pattern) => pattern.test(file))) {
    console.log(`  ${file}（設定で許可）`);
  } else if (name === "package.json") {
    console.log(`  ${file}`);
    problems.push(...checkPackageJson(file).map((p) => `${file}: ${p}`));
  } else if (LOCKFILES.has(name)) {
    console.log(`  ${file}`);
    problems.push(...checkLockfile(file).map((p) => `${file}: ${p}`));
  } else {
    console.log(`  ${file}`);
    problems.push(`${file}: 依存ファイルではない`);
  }
}

if (problems.length > 0) {
  console.log("既存の依存の版の更新以外の変更がある:");
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}
console.log("既存の依存の版の更新だけ");

function readAt(ref, file) {
  try {
    return git("show", `${ref}:${file}`);
  } catch {
    return null;
  }
}

function readCurrent(file) {
  if (head) return readAt("HEAD", file);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function readBoth(file, parse) {
  const beforeText = readAt(mergeBase, file);
  if (beforeText === null) return { problem: "新しいファイル" };
  const afterText = readCurrent(file);
  if (afterText === null) return { problem: "ファイルが消えている" };
  try {
    return {
      before: parse(beforeText),
      after: parse(afterText),
      beforeText,
      afterText,
    };
  } catch {
    return { problem: "読めない" };
  }
}

function checkPackageJson(file) {
  const { before, after, problem } = readBoth(file, JSON.parse);
  if (problem) return [problem];

  const problems = [];
  if (
    canonical(withoutVersions(before)) !== canonical(withoutVersions(after))
  ) {
    problems.push(
      "版の値以外（scripts・設定・依存や overrides の追加と削除など）が変わっている",
    );
  }
  const maps = [
    ...DEPENDENCY_SECTIONS.map((section) => [section]),
    ...OVERRIDE_PATHS,
  ];
  for (const keys of maps) {
    const old = pick(before, keys) ?? {};
    const next = pick(after, keys) ?? {};
    for (const [name, spec] of Object.entries(next)) {
      if (!(name in old) || old[name] === spec) continue;
      problems.push(...checkSpec(`${keys.join(".")}.${name}`, old[name], spec));
    }
  }
  return problems;
}

function checkSpec(label, oldSpec, newSpec) {
  const old = typeof oldSpec === "string" ? oldSpec.match(SIMPLE_SPEC) : null;
  const next = typeof newSpec === "string" ? newSpec.match(SIMPLE_SPEC) : null;
  if (!old) {
    return [
      `${label} は ${JSON.stringify(oldSpec)} の形なので巡回では変えない`,
    ];
  }
  if (!next) {
    return [`${label} が版の指定ではない（${JSON.stringify(newSpec)}）`];
  }
  if (old[1] !== next[1]) {
    return [`${label} の alias 先が変わる（${oldSpec} → ${newSpec}）`];
  }
  if (old[2] !== next[2] && (head || next[2] !== "")) {
    return [`${label} の範囲の記号が変わる（${oldSpec} → ${newSpec}）`];
  }
  if (next[4] && !old[4]) {
    return [`${label} を prerelease にしない（${oldSpec} → ${newSpec}）`];
  }
  if (compareVersions(next[3], old[3]) < 0) {
    return [`${label} の版が下がる（${oldSpec} → ${newSpec}）`];
  }
  return [];
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

// 依存と overrides の版の値だけを取り除いたもの。名前（追加・削除）は残して比べる。
function withoutVersions(packageJson) {
  const copy = structuredClone(packageJson);
  const maps = [
    ...DEPENDENCY_SECTIONS.map((section) => [section]),
    ...OVERRIDE_PATHS,
  ];
  for (const keys of maps) {
    const map = pick(copy, keys);
    if (!map || typeof map !== "object") continue;
    for (const key of Object.keys(map)) map[key] = null;
  }
  return copy;
}

function pick(object, keys) {
  return keys.reduce((value, key) => value?.[key], object);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkLockfile(file) {
  const isPnpm = path.basename(file) === "pnpm-lock.yaml";
  const { before, after, afterText, beforeText, problem } = readBoth(
    file,
    isPnpm ? pnpmResolutions : npmResolutions,
  );
  if (problem) return [problem];
  if (before === null || after === null) {
    return ["この形式の lockfile は巡回で扱わない"];
  }

  const problems = isPnpm ? checkPnpmLines(beforeText, afterText) : [];
  for (const [key, resolution] of after) {
    const previous = before.get(key);
    if (previous === undefined) {
      if (!resolution.registry) {
        problems.push(
          `${key} がレジストリ以外から解決される（${resolution.text}）`,
        );
      }
    } else if (previous.text !== resolution.text) {
      problems.push(
        `${key} の解決が同じ版のまま変わっている（${previous.text} → ${resolution.text}）`,
      );
    }
  }
  for (const key of before.keys()) {
    if (after.has(key)) continue;
    // 版を上げると古い鍵は消えるので問題にしない。ただし resolution だけが消えた鍵は問題にする
    if (
      afterText.includes(`\n  ${key}:`) ||
      afterText.includes(`\n  '${key}':`)
    ) {
      problems.push(`${key} の resolution が消えている`);
    }
  }
  return problems;
}

// 追加・変更された行（before になかった行）が、pnpm の書く形だけかを見る。
function checkPnpmLines(beforeText, afterText) {
  const existing = new Set(beforeText.split("\n"));
  const aliases = new Set();
  for (const entry of pnpmLines(beforeText)) {
    const target = aliasTarget(entry);
    if (target) aliases.add(aliasId(entry, target));
  }
  const problems = [];
  for (const entry of pnpmLines(afterText)) {
    const { line } = entry;
    if (line.trim() === "" || existing.has(line)) continue;
    const reason = pnpmLineProblem(line) ?? aliasProblem(entry, aliases);
    if (reason) problems.push(`${reason}: ${line.trim()}`);
  }
  return problems;
}

// pnpm-lock.yaml の各行を、節・親（節の直下の鍵の名前）・鍵・値・直前の specifier と一緒に返す。
function* pnpmLines(text) {
  let section = null;
  let parent = null;
  let specifier = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) section = line.split(":")[0];
    const keyValue = line.match(PNPM_KEY_VALUE);
    const key = keyValue ? unquote(keyValue[1]) : null;
    const value = keyValue?.[2];
    // 親の版と peer の括弧は外す（依存の版を上げると親の鍵の peer も変わる）
    if (/^ {2}\S/.test(line)) parent = key?.match(/^@?[^@]*/)[0] ?? null;
    // importers の依存は「名前: / specifier: / version:」の順に並ぶ。鍵だけの行で区切る
    if (key === "specifier") specifier = unquote(value ?? "");
    else if (keyValue && value === undefined) specifier = null;
    yield { line, section, parent, key, value, specifier };
  }
}

// 依存の版の値が、鍵と別の名前のパッケージ（name@version）を指していれば、その名前。
function aliasTarget({ key, value }) {
  if (key === null || value === undefined) return null;
  if (key === "specifier" || key === "deprecated") return null;
  const alias = unquote(value).match(ALIAS_VALUE);
  return alias && alias[1] !== key ? alias[1] : null;
}

// 別名は、同じ親の同じ鍵が同じパッケージを指していれば、版や peer の括弧が変わっても同じものとみなす。
function aliasId({ section, parent, key }, target) {
  return [section, parent, key, target].join("\0");
}

// 依存の版の値が、別のパッケージ（name@version）を指していないか。
function aliasProblem(entry, aliases) {
  const { section, key, value, specifier } = entry;
  if (section === "importers" && key === "version" && value !== undefined) {
    const text = unquote(value);
    if (isPlainVersion(text)) return null;
    // package.json が npm: alias のときだけ、importers の版は alias 先の名前付きになる
    const alias = text.match(ALIAS_VALUE);
    if (alias && specifier?.startsWith(`npm:${alias[1]}@`)) return null;
    return "package.json の指定と別のパッケージを指す版がある";
  }
  const target = aliasTarget(entry);
  return target && !aliases.has(aliasId(entry, target))
    ? "別名の依存が増えている（要判断）"
    : null;
}

function unquote(value) {
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"')) return value.slice(1, -1);
  return value;
}

function pnpmLineProblem(line) {
  if (/^\S/.test(line)) {
    const topLevel = line.match(PNPM_TOP_LEVEL);
    if (!topLevel) return "pnpm の書く形ではない行がある";
    const value = topLevel[1];
    return value === undefined ||
      (YAML_SCALAR.test(value) && !SOURCE_VALUE.test(unquote(value)))
      ? null
      : "pnpm の書く形ではない値がある";
  }
  if (PNPM_FLOW_LINES.some((pattern) => pattern.test(line))) return null;

  const listItem = line.match(PNPM_LIST_ITEM);
  if (listItem) {
    return YAML_SCALAR.test(listItem[1]) &&
      !SOURCE_VALUE.test(unquote(listItem[1]))
      ? null
      : "pnpm の書く形ではない行がある";
  }

  const keyValue = line.match(PNPM_KEY_VALUE);
  if (!keyValue) return "pnpm の書く形ではない行がある";
  const key = unquote(keyValue[1]);
  const value = keyValue[2];
  if (SOURCE_KEYS.has(key)) return "解決先を書き換える行がある";
  // snapshots の依存のないパッケージは「'name@1.0.0': {}」と書かれる
  if (value === undefined || value === "{}") return null;
  if (!YAML_SCALAR.test(value)) return "pnpm の書く形ではない値がある";
  // deprecated の説明文には URL が入ることがあるので、解決先の判定から外す
  if (key !== "deprecated" && SOURCE_VALUE.test(unquote(value))) {
    return "レジストリ以外を指す値がある";
  }
  return null;
}

// pnpm-lock.yaml の packages: から「パッケージの鍵 → resolution」を取り出す。
function pnpmResolutions(text) {
  const resolutions = new Map();
  let inPackages = false;
  let key = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line.trim() === "packages:";
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const keyMatch = line.match(/^ {2}(\S.*):\s*$/);
    if (keyMatch) {
      key = keyMatch[1].replace(/^'(.*)'$/, "$1");
      // resolution の行がなければこのまま残り、レジストリ以外の扱いになる
      resolutions.set(key, { text: "（resolution がない）", registry: false });
      continue;
    }
    const resolutionMatch = line.match(/^ {3,}resolution:\s*(.*)$/);
    if (key && resolutionMatch) {
      const value = resolutionMatch[1].trim();
      resolutions.set(key, {
        text: value,
        registry: /^\{integrity: [A-Za-z0-9+/=-]+\}$/.test(value),
      });
    }
  }
  return resolutions;
}

// package-lock.json の packages から「パスと版 → resolved と integrity」を取り出す。古い形式は null。
function npmResolutions(text) {
  const lock = JSON.parse(text);
  if (!lock.packages) return null;
  const resolutions = new Map();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;
    const value = entry.link
      ? `link:${entry.resolved}`
      : `${entry.version}|${entry.resolved ?? ""}|${entry.integrity ?? ""}`;
    resolutions.set(`${key}@${entry.version ?? ""}`, {
      text: value,
      registry:
        !entry.link &&
        typeof entry.integrity === "string" &&
        REGISTRY_URL.test(entry.resolved ?? ""),
    });
  }
  return resolutions;
}
