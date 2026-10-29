#!/usr/bin/env bash
# この実行のセッション URL を出す（PR 本文・コメント・Slack に載せる）。
# guard が変数展開を許さないので、スクリプトにまとめている。
set -euo pipefail

# Actions で動いているときは、その実行の URL
if [ -n "${GITHUB_RUN_ID:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  echo "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  exit 0
fi
if [ -z "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ]; then
  echo "CLAUDE_CODE_REMOTE_SESSION_ID も GITHUB_RUN_ID もない（クラウドのセッションでも Actions でもない）" >&2
  exit 1
fi
echo "https://claude.ai/code/${CLAUDE_CODE_REMOTE_SESSION_ID/#cse_/session_}"
