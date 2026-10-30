#!/usr/bin/env node
// 公開から 4 日未満の版で落ちた依存の検査を、4 日たったら 1 回だけ再実行する。
// usage: node recheck.mjs <owner/repo>（workflows/repo-patrol-dependency-check.yml の schedule から呼ぶ）
// 終了コード: 0 成功 / 1 取得か再実行の失敗
//
// Dependabot の cooldown は更新する直接の依存にしか効かないので、グループの PR は作られた日に
// 推移依存の新しい版で落ちやすい。lockfile の版はどれも head のコミットより前に公開されているので、
// コミットから 4 日たてばすべて 4 日を過ぎている。次のすべてに当たる dependency-check を再実行する:
//   - Dependabot の PR（このリポジトリのブランチから）の head のコミットの、いちばん新しい check run が失敗
//   - head のコミットから 4 日たっている
//   - その check run が、コミットから 4 日たつ前に始まった（同じ失敗を毎日再実行しない）
// ほかの理由で落ちたものも 1 回だけ再実行されるが、同じ理由でまた落ちるだけ。

import { execFileSync } from "node:child_process";

const MIN_AGE_DAYS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_NAME = "dependency-check";

const [repo] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
  console.error("usage: node recheck.mjs <owner/repo>");
  process.exit(64);
}

const gh = (...args) =>
  execFileSync("gh", ["api", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
const read = (endpoint, ...args) => JSON.parse(gh(...args, endpoint));

let pulls;
try {
  pulls = read(
    `repos/${repo}/pulls?state=open&per_page=100`,
    "--paginate",
    "--slurp",
  ).flat();
} catch (error) {
  console.error(`open の PR を読めなかった: ${error.message}`);
  process.exit(1);
}

let failed = false;
for (const pull of pulls) {
  if (
    pull.user?.login !== "dependabot[bot]" ||
    pull.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()
  ) {
    continue;
  }
  const sha = pull.head.sha;
  try {
    const committed = Date.parse(
      read(`repos/${repo}/commits/${sha}`).commit.committer.date,
    );
    const ready = committed + MIN_AGE_DAYS * DAY_MS;
    if (Date.now() < ready) continue;
    const latest = read(
      `repos/${repo}/commits/${sha}/check-runs?check_name=${CHECK_NAME}&per_page=100`,
    )
      .check_runs.filter((run) => run.app?.slug === "github-actions")
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
    if (
      latest?.conclusion !== "failure" ||
      Date.parse(latest.started_at) >= ready
    ) {
      continue;
    }
    // Actions の check run の id はジョブの id
    gh("-X", "POST", `repos/${repo}/actions/jobs/${latest.id}/rerun`);
    console.log(`rerun\t#${pull.number}\t${latest.id}`);
  } catch (error) {
    failed = true;
    console.error(`#${pull.number} を確かめられなかった: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
