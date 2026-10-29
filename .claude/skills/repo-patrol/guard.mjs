#!/usr/bin/env node
// repo-patrol の PreToolUse hook。REPO_PATROL=1 のときだけ判定する。
// 巡回が使うコマンドの形だけを通す許可リスト。変数展開・グロブ・サブシェルなどのシェルの機能は使わせない。
// 誤操作と「読んだ文章の指示に従ってしまう」ことを防ぐ歯止めで、境界ではない。
// 見えるのは Claude のツール呼び出しだけで、そこから起動されたプロセス（依存パッケージのコードなど）は止められない。
// マージや secrets の保護は GitHub 側（ruleset・environment）で行う。

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDABOT = "dependabot[bot]";
const PATROL_TMP = "/tmp/repo-patrol";
// 書き込みの件数を session_id ごとに数える場所。巡回が書けるのは PATROL_TMP の中だけなので、ここは書き換えられない
const WRITE_COUNT_DIR = "/tmp/repo-patrol-guard";
// 1 回の実行で通す書き込みの上限（SKILL.md の「守ること」）。通した時点で数え、あとで失敗しても戻さない
const WRITE_LIMITS = {
  comment: { limit: 20, label: "コメント" },
  slack: { limit: 1, label: "Slack への投稿" },
};

const PROTECTED_SEGMENTS = new Set([".claude", ".github", ".git"]);

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
    path: (repo) =>
      new RegExp(`^repos/${escapeRegExp(repo)}/issues/\\d+/comments$`, "i"),
    keys: ["body"],
    counts: "comment",
    // 巡回がコメントするのは、取り込まない Dependabot の PR への見送り理由だけ
    check: (_data, endpoint, ctx) => {
      const pull = ctx.fetchPull(
        endpoint.replace(/\/issues\/(\d+)\/comments$/i, "/pulls/$1"),
      );
      return pull?.author === DEPENDABOT && pull.headRepo === pull.baseRepo
        ? null
        : "コメントできるのは Dependabot の PR だけ";
    },
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
    case "MultiEdit": {
      const text = [
        toolInput.content,
        toolInput.new_string,
        ...(Array.isArray(toolInput.edits)
          ? toolInput.edits.map((edit) => edit?.new_string)
          : []),
      ].filter((value) => typeof value === "string");
      return (
        secretProblem(text.join("\n"), ctx) ??
        checkWritePath(toolInput.file_path, ctx)
      );
    }
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
  return {
    cwd,
    root,
    repo: config?.repo ?? null,
    sessionId: input?.session_id,
    // 観察モード（Actions の workflow を scheduled task と並行して動かす間）は GitHub に書かない
    observe: overrides.observe ?? process.env.REPO_PATROL_OBSERVE === "1",
    // Actions では Slack への投稿は workflow の別の step が行う（Claude には Slack のトークンを渡さない）
    actions: overrides.actions ?? process.env.GITHUB_ACTIONS === "true",
    writeCountDir: overrides.writeCountDir ?? WRITE_COUNT_DIR,
    // このコマンドの中の数える書き込み（checkCommand が最後にまとめて数える）
    writes: [],
    fetchPull: overrides.fetchPull ?? ((endpoint) => fetchPull(endpoint, root)),
    secrets: overrides.secrets ?? secretValues(process.env),
  };
}

// hook は巡回と同じ環境変数を受け継ぐ。トークンらしい値（名前に TOKEN・SECRET・KEY・PASSWORD を含み、20 文字以上）を集める
function secretValues(env) {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        /TOKEN|SECRET|KEY|PASSWORD/i.test(name) &&
        typeof value === "string" &&
        value.length >= 20,
    )
    .map(([, value]) => value);
}

// 書き込む本文やコメントにトークンの値が入っていたら止める（読めてしまった値を外へ出さない）
function secretProblem(text, ctx) {
  return ctx.secrets.some((secret) => text.includes(secret))
    ? block("書き込む内容に環境変数のトークンの値が入っている")
    : null;
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

// 書き込めるのは作業ディレクトリだけ。依存の更新は Dependabot が行う。
function checkWritePath(filePath, ctx) {
  if (typeof filePath !== "string" || filePath === "") {
    return block("書き込み先を読めない");
  }
  const absolute = path.resolve(ctx.cwd, filePath);
  if (isUnder(absolute, PATROL_TMP) && !absolute.split("/").includes("..")) {
    return ALLOW;
  }
  return block(
    `${absolute} には書き込まない（書けるのは ${PATROL_TMP}/ だけ）`,
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
  if (ctx.writes.length > 1) {
    return block(
      "PR の作成・コメント・Slack への投稿は、1 つずつ単独で実行する",
    );
  }
  if (ctx.writes.length === 1) return countWrite(ctx.writes[0], ctx) ?? ALLOW;
  return ALLOW;
}

// 1 件ごとに番号のファイルを排他的に作って数える（並列のツール呼び出しでも上限を越えない）。
function countWrite(kind, ctx) {
  const { limit, label } = WRITE_LIMITS[kind];
  if (typeof ctx.sessionId !== "string" || !/^[\w-]+$/.test(ctx.sessionId)) {
    return block(`hook の入力に session_id がないので、${label}を数えられない`);
  }
  const dir = path.join(ctx.writeCountDir, ctx.sessionId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let n = 1; n <= limit; n++) {
      try {
        writeFileSync(path.join(dir, `${kind}-${n}`), "", { flag: "wx" });
        return null;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
  } catch {
    return block(`${label}の件数を ${dir} に記録できない`);
  }
  return block(`${label}は 1 回の実行で ${limit} 件まで（超えたので止めた）`);
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
    const relative = relativeInside(realRoot, real);
    if (relative === null) {
      return block(
        `${arg} は読まない（読めるのはリポジトリと ${PATROL_TMP}/ の中だけ）`,
      );
    }
    // .git/config などには、Actions で git の認証情報が入ることがある
    if (relative.split(path.sep).includes(".git")) {
      return block(`${arg} は読まない（.git の中は読まない）`);
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
    // close は Actions の workflow（workflows/repo-patrol-stale.yml）が行う
    if (parts[4] === "stale.sh" && (args.length !== 2 || args[1] !== "list")) {
      return block(
        "stale.sh は list だけ（close は Actions の workflow が行う）",
      );
    }
  }
  if (parts[2] === "repo-patrol" && parts[4] === "slack-post.sh") {
    // --check は投稿せずに検証するだけなので数えない
    const check = args[0] === "--check";
    const files = check ? args.slice(1) : args;
    const target = path.resolve(ctx.cwd, files[0] ?? "");
    if (files.length !== 1 || !isUnder(target, PATROL_TMP)) {
      return block(
        `slack-post.sh に渡せるのは [--check] と ${PATROL_TMP}/ のファイルだけ`,
      );
    }
    if (!check && ctx.actions) {
      return block(
        "Actions では slack-post.sh は --check だけ（投稿は workflow のあとの step が行う）",
      );
    }
    if (!check) ctx.writes.push("slack");
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
      return /^set-head origin (?:-a|--auto)$/.test(joined)
        ? null
        : block("git remote は set-head origin -a だけ");
    default:
      // 依存の更新は Dependabot が行うので、巡回はブランチやコミットを作らず push もしない
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
  if (ctx.observe) {
    return block(
      "観察モードなので GitHub に書かない（書くはずだったものは、書いたものとして報告する）",
    );
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

  let raw;
  let data;
  try {
    raw = readFileSync(path.resolve(ctx.cwd, input), "utf8");
    data = JSON.parse(raw);
  } catch {
    return block(`--input の ${input} を JSON として読めない`);
  }
  const secret = secretProblem(raw, ctx);
  if (secret) return secret;
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
  if (reason) return block(reason);
  if (rule.counts) ctx.writes.push(rule.counts);
  return null;
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
  // install・update・run は依存のコードを動かしうる。依存の更新は Dependabot が行う
  return block(
    `pnpm ${subcommand ?? ""} は使わない（読み取りは audit と why だけ）`,
  );
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
  return block(
    `npm ${subcommand ?? ""} は使わない（読み取りは view と audit だけ）`,
  );
}

function isInsideRepo(target, ctx) {
  const relative = relativeInside(ctx.root, path.resolve(ctx.cwd, target));
  return relative !== null && !hasProtectedSegment(relative);
}

function fetchPull(endpoint, cwd) {
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        endpoint,
        "--jq",
        '[.head.ref, (.head.repo.full_name // ""), .base.repo.full_name, .user.login] | @tsv',
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const [headRef, headRepo, baseRepo, author] = out.split("\t");
    return { headRef, headRepo, baseRepo, author };
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
