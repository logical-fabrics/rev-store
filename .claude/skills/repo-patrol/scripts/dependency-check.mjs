#!/usr/bin/env node
// 依存更新の PR の required check。workflows/repo-patrol-dependency-check.yml から呼ぶ。
// usage: node dependency-check.mjs <base ref>（作業ディレクトリは PR のチェックアウト）
// 終了コード: 0 通過 / 1 失敗
//
// check-diff.mjs --head（既存の依存の版の更新だけか）と publisher-check.mjs（新しい版の公開者・install script・公開日）を流す。
// workflow は base のコミットからこのスクリプトと .claude/repo-patrol.md を取り出して動かすので、
// 検査も「差分に含めてよい追加のパス」も、PR が書き換えたものではなく base のものになる。

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../guard.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const [base] = process.argv.slice(2);
if (!base) {
  console.error("usage: node dependency-check.mjs <base ref>");
  process.exit(64);
}

const config = readConfig(path.resolve(scripts, "../../../.."));
if (!config) {
  console.error("設定（.claude/repo-patrol.md）を読めない");
  process.exit(1);
}

const run = (script, args) => {
  console.log(`== ${script}`);
  return spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    stdio: "inherit",
  }).status;
};
const diff = run("check-diff.mjs", [base, "--head", ...config.extras]);
const publish = run("publisher-check.mjs", [base]);
// check-diff の 3 は差分がない（確かめるものがない）
process.exit((diff === 0 || diff === 3) && publish === 0 ? 0 : 1);
