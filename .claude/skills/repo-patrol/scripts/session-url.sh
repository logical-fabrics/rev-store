#!/usr/bin/env bash
# この実行のセッション URL を出す（PR 本文・コメント・Slack に載せる）。
# guard が変数展開を許さないので、スクリプトにまとめている。
set -euo pipefail

if [ -z "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ]; then
  echo "CLAUDE_CODE_REMOTE_SESSION_ID がない（クラウドのセッションではない）" >&2
  exit 1
fi
echo "https://claude.ai/code/${CLAUDE_CODE_REMOTE_SESSION_ID/#cse_/session_}"
