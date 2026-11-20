#!/usr/bin/env node
// Actions の巡回を、API キーのときに Agent SDK で動かす（workflows/repo-patrol.yml の Patrol の step）。
// Console のプロモーションクレジットは Claude Code（claude-code-action）には使えず、Agent SDK には使えることがあるため。
// 道具・hook・prompt は claude-code-action の step と同じにする。報告の本文はログに出さない（job summary に出る）

import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt = process.env.PATROL_PROMPT;
if (!prompt?.trim()) {
  console.error("PATROL_PROMPT がない");
  process.exit(1);
}

let result;
for await (const message of query({
  prompt,
  options: {
    cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    // 既定の Opus より安い。巡回 1 回の費用は Sonnet で見積もってある
    model: "claude-sonnet-5-5",
    systemPrompt: { type: "preset", preset: "claude_code" },
    // .claude/settings.json の guard の hook を読む。runner のユーザー設定は読まない
    settingSources: ["project"],
    // guard の hook を通らない読み取りのツールは使わせない（/proc などからトークンを読めないように）
    allowedTools: ["Bash", "Write", "Edit"],
    disallowedTools: [
      "Read",
      "Glob",
      "Grep",
      "NotebookEdit",
      "Task",
      "WebFetch",
      "WebSearch",
    ],
  },
})) {
  if (message.type === "result") result = message;
}

if (!result) {
  console.error("巡回の結果が返らなかった");
  process.exit(1);
}
const { subtype, is_error, num_turns, total_cost_usd } = result;
console.log(JSON.stringify({ subtype, is_error, num_turns, total_cost_usd }));
if (subtype !== "success" || is_error) {
  // 失敗のときだけ理由を出す（API のエラーの文や、止まった理由）
  console.error(result.result ?? result.errors?.join("\n") ?? subtype);
  process.exit(1);
}
