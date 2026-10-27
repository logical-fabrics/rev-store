#!/usr/bin/env node
// repo-patrol の PreToolUse hook。REPO_PATROL=1 のときだけ判定する。
// 巡回が使うコマンドの形だけを通す許可リスト。変数展開・グロブ・サブシェルなどのシェルの機能は使わせない。
// 誤操作と「読んだ文章の指示に従ってしまう」ことを防ぐ歯止めで、境界ではない。
// 見えるのは Claude のツール呼び出しだけで、そこから起動されたプロセス（依存パッケージのコードなど）は止められない。
// マージや secrets の保護は GitHub 側（ruleset・environment）で行う。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PATROL_BRANCH = "claude/patrol-deps";
const PATROL_TMP = "/tmp/repo-patrol";
const CHECK_DIFF = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "scripts",
  "check-diff.mjs",
);

const PROTECTED_SEGMENTS = new Set([".claude", ".github", ".git"]);
const DEPENDENCY_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
]);

// 書き込みや実行のオプションを持たないコマンド。読めるのはリポジトリと作業ディレクトリの中だけにする。
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "wc",
  "cut",
  "tr",
  "jq",
  "ls",
  "echo",
  "printf",
  "date",
  "test",
  "true",
  "false",
  "sleep",
  "diff",
  "comm",
  "basename",
  "dirname",
  "pwd",
]);

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "time",
  "coproc",
  "[[",
  "]]",
]);

const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "merge-base",
  "ls-files",
  "cat-file",
]);

const API_WRITES = [
  {
    method: "POST",
    path: (repo) => new RegExp(`^repos/${escapeRegExp(repo)}/pulls$`, "i"),
    keys: ["title", "body", "head", "base", "draft", "maintainer_can_modify"],
    check: (data) =>
      data.head === PATROL_BRANCH
        ? null
        : `PR の head は ${PATROL_BRANCH} だけ`,
  },
  {
    method: "PATCH",
    path: (repo) => new RegExp(`^repos/${escapeRegExp(repo)}/pulls/\\d+$`, "i"),
    keys: ["title", "body"],
    check: (_data, endpoint, ctx) => {
      const pull = ctx.fetchPull(endpoint);
      if (!pull) return "PR を確認できない";
      return pull.headRef === PATROL_BRANCH && pull.headRepo === pull.baseRepo
        ? null
        : "書き換えてよいのは巡回 PR だけ";
    },
  },
  {
    method: "POST",
    path: (repo) =>
      new RegExp(`^repos/${escapeRegExp(repo)}/issues/\\d+/comments$`, "i"),
    keys: ["body"],
  },
];

const ALLOW = { allow: true };

function block(reason) {
  return { allow: false, reason };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUnder(target, directory) {
  return target === directory || target.startsWith(`${directory}/`);
}

function hasProtectedSegment(target) {
  return target.split("/").some((segment) => PROTECTED_SEGMENTS.has(segment));
}

function relativeInside(root, target) {
  const relative = path.relative(root, target);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? null
    : relative;
}

export function evaluate(input, overrides = {}) {
  const ctx = createContext(input, overrides);
  const toolName = input?.tool_name;
  const toolInput = input?.tool_input ?? {};

  switch (toolName) {
    case "Bash":
    case "Monitor":
      if (typeof toolInput.command !== "string") {
        return block("コマンドを読めない");
      }
      return checkCommand(toolInput.command, ctx);
    case "Edit":
    case "Write":
    case "MultiEdit":
      return checkWritePath(toolInput.file_path, ctx);
    case "NotebookEdit":
      return checkWritePath(toolInput.notebook_path, ctx);
    default:
      return block(
        `${toolName ?? "不明なツール"} は巡回中に使えない（guard の matcher に入れたツールは既定で止める）`,
      );
  }
}

function createContext(input, overrides) {
  const cwd =
    overrides.cwd ??
    input?.cwd ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();
  const root = overrides.root ?? process.env.CLAUDE_PROJECT_DIR ?? cwd;
  const config =
    overrides.config !== undefined ? overrides.config : readConfig(root);
  const extras = config?.extras ?? [];
  return {
    cwd,
    root,
    repo: config?.repo ?? null,
    extras,
    fetchPull: overrides.fetchPull ?? ((endpoint) => fetchPull(endpoint, root)),
    checkDiff:
      overrides.checkDiff ?? ((mode) => checkDiffProblems(root, extras, mode)),
    defaultBranch: overrides.defaultBranch ?? (() => defaultBranch(root)),
    isTracked: overrides.isTracked ?? ((relative) => isTracked(root, relative)),
  };
}

// .claude/repo-patrol.md の「リポジトリ」と「差分に含めてよい追加のパス」を読む。
export function readConfig(root) {
  let text;
  try {
    text = readFileSync(path.join(root, ".claude", "repo-patrol.md"), "utf8");
  } catch {
    return null;
  }
  const section = (title) =>
    text.match(
      new RegExp(
        `^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
        "m",
      ),
    )?.[1] ?? "";
  const repo =
    section("リポジトリ")
      .split("\n")
      .map((line) => line.replaceAll("`", "").trim())
      .find((line) => /^[\w.-]+\/[\w.-]+$/.test(line)) ?? null;
  const extras = [
    ...section("差分に含めてよい追加のパス").matchAll(/^- `([^`]+)`/gm),
  ].map((match) => match[1]);
  return { repo, extras };
}

function globToRegExp(pattern) {
  return new RegExp(
    `^${pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\0/g, ".*")}$`,
  );
}

function isDependencyFile(relative, extras) {
  return (
    DEPENDENCY_FILES.has(path.basename(relative)) ||
    extras.some((pattern) => globToRegExp(pattern).test(relative))
  );
}

// 書き込めるのは、作業ディレクトリと、リポジトリで追跡している依存ファイル（と設定で許したファイル）だけ。
function checkWritePath(filePath, ctx) {
  if (typeof filePath !== "string" || filePath === "") {
    return block("書き込み先を読めない");
  }
  const absolute = path.resolve(ctx.cwd, filePath);
  if (isUnder(absolute, PATROL_TMP) && !absolute.split("/").includes("..")) {
    return ALLOW;
  }
  let realParent;
  let realRoot;
  try {
    realParent = realpathSync(path.dirname(absolute));
    realRoot = realpathSync(ctx.root);
  } catch {
    return block(`${absolute} の場所を確かめられない`);
  }
  const relative = relativeInside(
    realRoot,
    path.join(realParent, path.basename(absolute)),
  );
  if (
    relative !== null &&
    !hasProtectedSegment(relative) &&
    isDependencyFile(relative, ctx.extras) &&
    ctx.isTracked(relative)
  ) {
    return ALLOW;
  }
  return block(
    `${absolute} には書き込まない（書けるのは ${PATROL_TMP}/ と、追跡済みの依存ファイル・設定で許したファイルだけ）`,
  );
}

// シェルのごく一部だけを読む。単語・引用符・; && || | 改行・出力のリダイレクト・コメント。
// それ以外（変数展開、コマンド置換、グロブ、ブレース展開、サブシェル、ヒアドキュメント、& など）はエラーにする。
export function parseShell(command) {
  const commands = [];
  let current = { words: [], redirects: [] };
  let word = "";
  let inWord = false;
  let pendingRedirect = null;

  const pushWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      current.redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else {
      current.words.push(word);
    }
    word = "";
    inWord = false;
  };
  // next は次のコマンドとのつなぎ方（; && || | か、最後なら null）
  const endCommand = (next = null) => {
    pushWord();
    if (pendingRedirect) return "リダイレクト先がない";
    if (current.words.length > 0 || current.redirects.length > 0) {
      commands.push({ ...current, next });
    }
    current = { words: [], redirects: [] };
    return null;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return { error: "引用符が閉じていない" };
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if ("$`\\".includes(command[j])) {
          return {
            error:
              "ダブルクォートの中で $・`・\\ を使わない（単一引用符を使う）",
          };
        }
        word += command[j];
      }
      if (j >= command.length) return { error: "引用符が閉じていない" };
      inWord = true;
      i = j;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushWord();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      const error = endCommand(";");
      if (error) return { error };
      continue;
    }
    if (ch === "|") {
      const next = command[i + 1] === "|" ? "||" : "|";
      if (next === "||") i++;
      const error = endCommand(next);
      if (error) return { error };
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        i++;
        const error = endCommand("&&");
        if (error) return { error };
        continue;
      }
      if (command[i + 1] === ">") {
        pushWord();
        const append = command[i + 2] === ">";
        pendingRedirect = append ? "&>>" : "&>";
        i += append ? 2 : 1;
        continue;
      }
      return { error: "& でバックグラウンド実行しない" };
    }
    if (ch === ">") {
      let fd = "";
      if (inWord && /^[12]$/.test(word) && command[i - 1] === word) {
        fd = word;
        word = "";
        inWord = false;
      } else {
        pushWord();
      }
      if (pendingRedirect) return { error: "リダイレクト先がない" };
      let op = `${fd}>`;
      if (command[i + 1] === ">") {
        op += ">";
        i++;
      }
      if (command[i + 1] === "&") {
        const duplicated = command[i + 2];
        if (!/^[12]$/.test(duplicated ?? "")) {
          return { error: "リダイレクトの形を読めない" };
        }
        current.redirects.push({ op: `${op}&`, target: duplicated });
        i += 2;
        continue;
      }
      pendingRedirect = op;
      continue;
    }
    if (ch === "#" && !inWord) {
      const newline = command.indexOf("\n", i);
      i = newline === -1 ? command.length : newline - 1;
      continue;
    }
    if (ch === "~" && !inWord) {
      return { error: "~ を使わない（パスはそのまま書く）" };
    }
    if ("<(){}$`\\*?[!".includes(ch)) {
      return {
        error: `${ch} は使わない（変数展開・グロブ・サブシェル・入力のリダイレクトは使えない）`,
      };
    }
    word += ch;
    inWord = true;
  }
  const error = endCommand();
  if (error) return { error };
  return { commands };
}

function checkCommand(command, ctx) {
  const parsed = parseShell(command);
  if (parsed.error) return block(parsed.error);
  // 同じ行の cd は、&& と ; でつないだ後ろのコマンドのパスの解決に効くので、順に追う（パイプの中の cd は効かない）。
  let cwd = ctx.cwd;
  for (const simple of parsed.commands) {
    const result = checkSimpleCommand(simple, { ...ctx, cwd });
    if (result) return result;
    if (simple.words[0] === "cd" && ["&&", ";"].includes(simple.next)) {
      cwd = path.resolve(cwd, simple.words[1]);
    }
  }
  return ALLOW;
}

function checkSimpleCommand({ words, redirects }, ctx) {
  for (const redirect of redirects) {
    if (redirect.op.endsWith("&")) continue;
    const target = path.resolve(ctx.cwd, redirect.target);
    if (target !== "/dev/null" && !isUnder(target, PATROL_TMP)) {
      return block(
        `リダイレクト先は ${PATROL_TMP}/ か /dev/null だけ（${redirect.target}）`,
      );
    }
  }

  const [name, ...args] = words;
  if (name === undefined) return null;
  if (name.includes("=")) return block("環境変数を付けて実行しない");
  if (SHELL_KEYWORDS.has(name)) {
    return block(`${name} は使わない（コマンドを 1 つずつ実行する）`);
  }
  if (name.includes("/")) return checkOwnScript(name, args, ctx);

  switch (name) {
    case "git":
      return checkGit(args, ctx);
    case "gh":
      return checkGh(args, ctx);
    case "pnpm":
      return checkPnpm(args, ctx);
    case "npm":
      return checkNpm(args, ctx);
    case "corepack":
      return args.length === 1 && args[0] === "enable"
        ? null
        : block("corepack は enable だけ");
    case "node":
    case "bash":
    case "sh":
      if (args.length === 0 || args[0].startsWith("-")) {
        return block(
          `${name} はオプションなしでスキルのスクリプトを渡すときだけ使う`,
        );
      }
      return checkOwnScript(args[0], args.slice(1), ctx);
    case "mkdir":
      return args
        .filter((arg) => !arg.startsWith("-"))
        .every((arg) => isUnder(path.resolve(ctx.cwd, arg), PATROL_TMP))
        ? null
        : block(`mkdir は ${PATROL_TMP}/ の中だけ`);
    case "cd":
      return args.length === 1 && isInsideRepo(args[0], ctx)
        ? null
        : block("cd はリポジトリの中（.claude・.github・.git 以外）だけ");
    default:
      if (!READ_ONLY_COMMANDS.has(name)) {
        return block(`${name} は巡回で使わない`);
      }
      if (name === "jq" && args.some((arg) => /\benv\b|\$ENV/.test(arg))) {
        return block("jq で環境変数を読まない");
      }
      return checkReadPaths(args, ctx);
  }
}

// 引数のうちパスになりうる部分。--file=x の x と、-fx（短いオプションに続けた値）の x も見る。
function pathCandidates(arg) {
  if (!arg.startsWith("-")) return [arg];
  const equals = arg.indexOf("=");
  if (equals !== -1) return [arg.slice(equals + 1)];
  if (/^-[A-Za-z]./.test(arg)) return [arg.slice(2)];
  return [];
}

// 引数のうち実在するパスは、リポジトリか作業ディレクトリの中だけにする（環境変数や手元の設定ファイルを読ませない）。
function checkReadPaths(args, ctx) {
  for (const arg of args.flatMap(pathCandidates)) {
    if (arg === "") continue;
    const target = path.resolve(ctx.cwd, arg);
    if (!existsSync(target)) continue;
    if (isUnder(target, PATROL_TMP) || isUnder(target, "/dev/null")) continue;
    let real;
    let realRoot;
    try {
      real = realpathSync(target);
      realRoot = realpathSync(ctx.root);
    } catch {
      return block(`${arg} を確かめられない`);
    }
    if (relativeInside(realRoot, real) === null) {
      return block(
        `${arg} は読まない（読めるのはリポジトリと ${PATROL_TMP}/ の中だけ）`,
      );
    }
  }
  return null;
}

// リポジトリにコミットされた .claude/skills/<skill>/scripts/ のスクリプトだけを実行させる。
function checkOwnScript(scriptPath, args, ctx) {
  let real;
  let rootReal;
  try {
    real = realpathSync(path.resolve(ctx.cwd, scriptPath));
    rootReal = realpathSync(ctx.root);
  } catch {
    return block(`${scriptPath} が見つからない`);
  }
  const parts = path.relative(rootReal, real).split(path.sep);
  const isOwn =
    parts.length === 5 &&
    parts[0] === ".claude" &&
    parts[1] === "skills" &&
    parts[3] === "scripts";
  if (!isOwn) {
    return block(
      `${scriptPath} は実行しない（実行してよいのは .claude/skills/<skill>/scripts/ のスクリプトだけ）`,
    );
  }
  if (
    parts[2] === "repo-patrol" &&
    (parts[4] === "stale.sh" || parts[4] === "wait-checks.sh")
  ) {
    if (!ctx.repo || args[0]?.toLowerCase() !== ctx.repo.toLowerCase()) {
      return block(`${parts[4]} には設定のリポジトリ（${ctx.repo}）を渡す`);
    }
  }
  if (parts[2] === "repo-patrol" && parts[4] === "slack-post.sh") {
    const target = path.resolve(ctx.cwd, args[0] ?? "");
    if (args.length !== 1 || !isUnder(target, PATROL_TMP)) {
      return block(`slack-post.sh に渡せるのは ${PATROL_TMP}/ のファイルだけ`);
    }
  }
  return checkReadPaths(args, ctx);
}

function checkGit(args, ctx) {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand.startsWith("-")) {
    return block("git のグローバルオプション（-c・-C など）は使わない");
  }
  const joined = rest.join(" ");

  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    if (rest.some((arg) => /^--(?:output|ext-diff|no-index)/.test(arg))) {
      return block("git の --output・--ext-diff・--no-index は使わない");
    }
    return checkReadPaths(rest, ctx);
  }

  switch (subcommand) {
    case "fetch": {
      const positional = rest.filter((arg) => !arg.startsWith("-"));
      const options = rest.filter((arg) => arg.startsWith("-"));
      return positional[0] === "origin" &&
        positional.slice(1).every((ref) => /^[\w./-]+$/.test(ref)) &&
        options.every((option) =>
          ["-q", "--quiet", "--prune", "--no-tags"].includes(option),
        )
        ? null
        : block("git fetch は origin から、決まったオプションだけ");
    }
    case "remote":
      return /^(?:set-head origin (?:-a|--auto)|-v|get-url origin)$/.test(
        joined,
      )
        ? null
        : block("git remote は set-head origin -a と読み取りだけ");
    case "checkout": {
      const base = ctx.defaultBranch();
      if (!base) {
        return block(
          "既定ブランチを確かめられない。git remote set-head origin -a を実行してから使う",
        );
      }
      return new RegExp(
        `^(?:-q )?-B ${escapeRegExp(PATROL_BRANCH)} ${escapeRegExp(base)}$`,
      ).test(joined)
        ? null
        : block(`git checkout は -B ${PATROL_BRANCH} ${base} だけ`);
    }
    // check-diff を通らなかった更新を戻すため。install は check-diff で止まるので、ほかに戻す手段がない
    case "restore": {
      const paths = rest.filter(
        (arg) => !["--staged", "--worktree", "-S", "-W", "--"].includes(arg),
      );
      return paths.length > 0 &&
        paths.every((arg) => {
          const relative = relativeInside(ctx.root, path.resolve(ctx.cwd, arg));
          return (
            /^[\w.@][\w./@-]*$/.test(arg) &&
            relative !== null &&
            !hasProtectedSegment(relative) &&
            isDependencyFile(relative, ctx.extras) &&
            ctx.isTracked(relative)
          );
        })
        ? null
        : block(
            "git restore は [--staged] [--worktree] と追跡済みの依存ファイルだけ",
          );
    }
    case "add":
      return rest.every(
        (arg) =>
          ["-A", "--all", "-u"].includes(arg) ||
          (!arg.startsWith("-") &&
            !hasProtectedSegment(
              path.relative(ctx.root, path.resolve(ctx.cwd, arg)),
            )),
      )
        ? null
        : block("git add で .claude・.github・.git を扱わない");
    case "commit": {
      const match = joined.match(/^(?:-q )?-F (\S+)$/);
      return match && isUnder(path.resolve(ctx.cwd, match[1]), PATROL_TMP)
        ? null
        : block(`git commit は -F ${PATROL_TMP}/<ファイル> だけ`);
    }
    case "push": {
      if (
        !new RegExp(
          `^(?:(?:-u|--force-with-lease) )*origin HEAD:refs/heads/${escapeRegExp(PATROL_BRANCH)}$`,
        ).test(joined)
      ) {
        return block(
          `push は git push [-u] [--force-with-lease] origin HEAD:refs/heads/${PATROL_BRANCH} の形だけ`,
        );
      }
      const problems = ctx.checkDiff("head");
      return problems
        ? block(`push する内容が check-diff を通らない: ${problems}`)
        : null;
    }
    case "config":
      return /^(?:user\.(?:name|email) \S.*|--get(?:-all)? \S+|--list|-l)$/.test(
        joined,
      )
        ? null
        : block("git config は user.name・user.email と読み取りだけ");
    default:
      return block(`git ${subcommand} は使わない`);
  }
}

function checkGh(args, ctx) {
  if (args[0] !== "api") {
    return block("gh は api だけ使う（gh pr・gh issue はクラウドで使えない）");
  }
  let method = null;
  let input = null;
  const endpoints = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const methodMatch = arg.match(/^(?:-X|--method=?)(.*)$/);
    if (methodMatch) {
      method = (methodMatch[1] || args[++i] || "").toUpperCase();
      continue;
    }
    if (arg === "--input") {
      input = args[++i];
      continue;
    }
    if (arg === "--jq" || arg === "-q") {
      i++;
      continue;
    }
    if (arg === "-H" || arg === "--header") {
      const header = args[++i] ?? "";
      if (!/^Accept: application\/vnd\.github\.[\w.+-]+$/.test(header)) {
        return block("gh api のヘッダーは Accept だけ");
      }
      continue;
    }
    if (
      ["--paginate", "--slurp", "-i", "--include", "--silent"].includes(arg)
    ) {
      continue;
    }
    if (arg.startsWith("-")) {
      return block(`gh api の ${arg} は使わない（書き込みは --input で渡す）`);
    }
    endpoints.push(arg);
  }
  if (endpoints.length !== 1) {
    return block("gh api にはエンドポイントを 1 つ渡す");
  }
  const endpoint = endpoints[0].replace(/^\//, "");
  if (/\.\.|%2e|\/\//i.test(endpoint.split("?")[0])) {
    return block("gh api のエンドポイントに .. や // を使わない");
  }

  if (method === null || method === "GET") {
    if (input !== null) return block("GET に --input は使わない");
    if (endpoint === "user") return null;
    if (!ctx.repo) {
      return block("設定（.claude/repo-patrol.md）のリポジトリを読めない");
    }
    return new RegExp(`^repos/${escapeRegExp(ctx.repo)}(?:[/?]|$)`, "i").test(
      endpoint,
    )
      ? null
      : block(`gh api で読めるのは repos/${ctx.repo}/ と user だけ`);
  }

  if (!ctx.repo) {
    return block("設定（.claude/repo-patrol.md）のリポジトリを読めない");
  }
  const rule = API_WRITES.find(
    (candidate) =>
      candidate.method === method && candidate.path(ctx.repo).test(endpoint),
  );
  if (!rule) {
    return block(`${method} ${endpoint} は巡回で許していない書き込み`);
  }
  if (!input || !isUnder(path.resolve(ctx.cwd, input), PATROL_TMP)) {
    return block(`書き込みの本文は ${PATROL_TMP}/ の JSON を --input で渡す`);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(path.resolve(ctx.cwd, input), "utf8"));
  } catch {
    return block(`--input の ${input} を JSON として読めない`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return block("--input の JSON はオブジェクトにする");
  }
  const extraKeys = Object.keys(data).filter((key) => !rule.keys.includes(key));
  if (extraKeys.length > 0) {
    return block(
      `${method} ${endpoint} に渡せるのは ${rule.keys.join(", ")} だけ（${extraKeys.join(", ")} は不可）`,
    );
  }
  for (const key of ["title", "body"]) {
    if (typeof data[key] === "string" && hasMention(data[key])) {
      return block(
        `${key} に @ で始まる語を書かない（メンションや @dependabot へのコマンドになる。パッケージ名はバッククォートで囲む）`,
      );
    }
  }
  const reason = rule.check?.(data, endpoint, ctx);
  return reason ? block(reason) : null;
}

// @dependabot はどこにあっても拒否する。ほかは、コードとして囲んだ部分と HTML コメントを除いて
// @ で始まる語があるか見る。pkg@1.2.3 やメールアドレスは対象外。
export function hasMention(text) {
  if (/@dependabot/i.test(text)) return true;
  const visible = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  return /(?:^|[^\w])@[A-Za-z0-9]/.test(visible);
}

function checkPnpm(args, ctx) {
  let rest = args;
  while (["--filter", "-C", "--dir"].includes(rest[0])) {
    const value = rest[1];
    if (!value || value.startsWith("-")) return block(`${rest[0]} に値がない`);
    if (rest[0] === "--filter") {
      if (!/^[\w@./-]+$/.test(value) || value.includes("..")) {
        return block("--filter の値を読めない");
      }
    } else if (!isInsideRepo(value, ctx)) {
      return block(`${rest[0]} はリポジトリの中だけ`);
    }
    rest = rest.slice(2);
  }
  const [subcommand, ...more] = rest;
  const flags = more.join(" ");

  if (subcommand === "-v" || subcommand === "--version") {
    return more.length === 0 ? null : block("pnpm --version に引数はいらない");
  }
  if (subcommand === "audit") {
    return more.every((arg) => ["--json", "--prod", "--dev"].includes(arg))
      ? null
      : block("pnpm audit のオプションは --json・--prod・--dev だけ");
  }
  if (subcommand === "why") {
    return more.every(
      (arg) =>
        ["--json", "-r", "--recursive"].includes(arg) ||
        /^[@\w][@\w./-]*$/.test(arg),
    )
      ? null
      : block("pnpm why にはパッケージ名を渡す");
  }
  if (subcommand === "install" || subcommand === "i") {
    if (
      ![
        "--frozen-lockfile",
        "--frozen-lockfile --ignore-scripts",
        "--lockfile-only --ignore-scripts",
      ].includes(flags)
    ) {
      return block(
        "pnpm install は --frozen-lockfile か --lockfile-only --ignore-scripts だけ",
      );
    }
    return gate(ctx);
  }
  // 推移依存を lockfile だけで範囲内の最新にする。版や範囲は推移依存には付けられない
  if (subcommand === "update") {
    const names = more.slice(0, -3);
    if (
      names.length === 0 ||
      more.slice(-3).join(" ") !==
        "--no-save --lockfile-only --ignore-scripts" ||
      !names.every((name) => /^(?:@[\w][\w.-]*\/)?[\w][\w.-]*$/.test(name))
    ) {
      return block(
        "pnpm update は「パッケージ名 ... --no-save --lockfile-only --ignore-scripts」だけ（版や範囲は付けない）",
      );
    }
    return gate(ctx);
  }
  if (subcommand === "run") {
    if (more.length !== 1 || !/^[A-Za-z0-9][\w:.-]*$/.test(more[0])) {
      return block(
        "pnpm run にはスクリプト名だけを渡す（オプションや引数は付けない）",
      );
    }
    return gate(ctx);
  }
  return block(`pnpm ${subcommand ?? ""} は使わない`);
}

function checkNpm(args, ctx) {
  let rest = args;
  if (rest[0] === "--prefix") {
    if (!rest[1] || !isInsideRepo(rest[1], ctx)) {
      return block("--prefix はリポジトリの中だけ");
    }
    rest = rest.slice(2);
  }
  const [subcommand, ...more] = rest;
  const flags = more.join(" ");

  if (subcommand === "-v" || subcommand === "--version") {
    return more.length === 0 ? null : block("npm --version に引数はいらない");
  }
  if (["view", "info", "show"].includes(subcommand)) {
    return more.every(
      (arg) => arg === "--json" || /^[@\w][@\w./^~=*-]*$/.test(arg),
    )
      ? null
      : block("npm view にはパッケージ名と項目を渡す");
  }
  if (subcommand === "audit") {
    return more.every((arg) =>
      ["--json", "--omit=dev", "--package-lock-only"].includes(arg),
    )
      ? null
      : block(
          "npm audit のオプションは --json・--omit=dev・--package-lock-only だけ",
        );
  }
  if (subcommand === "install" || subcommand === "ci") {
    const allowed =
      subcommand === "install"
        ? ["--package-lock-only --ignore-scripts"]
        : ["", "--ignore-scripts"];
    if (!allowed.includes(flags)) {
      return block(
        "npm は install --package-lock-only --ignore-scripts か ci だけ",
      );
    }
    return gate(ctx);
  }
  return block(`npm ${subcommand ?? ""} は使わない`);
}

function isInsideRepo(target, ctx) {
  const relative = relativeInside(ctx.root, path.resolve(ctx.cwd, target));
  return relative !== null && !hasProtectedSegment(relative);
}

// install や run の前に check-diff を通す（作業ツリーが既存の依存の版の更新だけか）。
function gate(ctx) {
  const problems = ctx.checkDiff("worktree");
  return problems
    ? block(`install や run の前の check-diff が通らない: ${problems}`)
    : null;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function defaultBranch(root) {
  try {
    const ref = git(["rev-parse", "--abbrev-ref", "origin/HEAD"], root).trim();
    return /^origin\/[\w./-]+$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

function isTracked(root, relative) {
  try {
    git(["ls-files", "--error-unmatch", "--", relative], root);
    return true;
  } catch {
    return false;
  }
}

// check-diff を実行する。worktree は作業ツリー、head は push される HEAD を見る。
// 問題がなければ null、あれば出力の要約を返す。worktree で差分がない（exit 3）のは問題にしない。
export function checkDiffProblems(root, extras, mode) {
  const args = [
    CHECK_DIFF,
    "origin/HEAD",
    ...(mode === "head" ? ["--head"] : []),
    ...extras,
  ];
  try {
    execFileSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (error) {
    if (mode === "worktree" && error.status === 3) return null;
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    return output.split("\n").slice(-5).join(" / ") || "check-diff が失敗した";
  }
}

function fetchPull(endpoint, cwd) {
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        endpoint,
        "--jq",
        '[.head.ref, (.head.repo.full_name // ""), .base.repo.full_name] | @tsv',
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const [headRef, headRepo, baseRepo] = out.split("\t");
    return { headRef, headRepo, baseRepo };
  } catch {
    return null;
  }
}

function main() {
  if (process.env.REPO_PATROL !== "1") return 0;

  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("repo-patrol guard: hook の入力を読めない\n");
    return 2;
  }

  let result;
  try {
    result = evaluate(input);
  } catch (error) {
    result = block(`判定中にエラーが起きた（${error.message}）`);
  }
  if (result.allow) return 0;
  process.stderr.write(`repo-patrol guard: ${result.reason}\n`);
  return 2;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exitCode = main();
}
