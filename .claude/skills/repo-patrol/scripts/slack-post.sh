#!/usr/bin/env bash
# 巡回の報告を Slack に 1 回投稿する。
# usage: slack-post.sh [--check] <報告の JSON>
#
# - 宛先は、リポジトリの .claude/repo-patrol.md の「## Slack チャンネル」に書いたチャンネル ID か #チャンネル名だけ
#   （巡回は .claude を書き換えられないので、宛先を変えられない）。トークンは、cloud environment では network secret（host slack.com）が付け、
#   Actions では workflow の投稿の step が環境変数 SLACK_BOT_TOKEN で渡す
# - 報告は slack-message.mjs が検証して Block Kit にする（件数・メンション・投稿するか・エスケープ・リンクの決まりはそちらに書いた）。
#   #番号は「## リポジトリ」の Issue / PR へのリンクになる。報告の形が違えば exit 1
# - 投稿することがない日は、投稿せずに exit 0
# - Block Kit が拒否されたら（invalid_blocks など）、同じ内容を文字だけで送り直す
# - --check か、REPO_PATROL=1 でなければ、投稿せずに宛先と送る本文を表示する（guard は --check を投稿の回数に数えない）
# - 一時的なエラー（HTTP 429・5xx・通信の失敗・ratelimited など）だけ Retry-After を守って 3 回まで試し、だめなら exit 1
set -euo pipefail

check=0
if [ "${1:-}" = --check ]; then
  check=1
  shift
fi
file=$1
scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
config="$(git rev-parse --show-toplevel)/.claude/repo-patrol.md"

# 設定の「## <名前>」の節にある、最初の空でない行（バッククォートと空白を除く）
config_value() {
  awk -v heading="## $1" '
    /^## / { line = $0; sub(/[[:space:]]+$/, "", line); in_section = (line == heading); next }
    in_section && NF { gsub(/[`[:space:]]/, ""); print; exit }
  ' "$config" 2>/dev/null || true
}

channel=$(config_value "Slack チャンネル")
if ! [[ $channel =~ ^([CG][A-Z0-9]{6,}|#[a-z0-9][a-z0-9._-]{0,79})$ ]]; then
  echo "$config の「## Slack チャンネル」にチャンネル ID か #チャンネル名がない: '$channel'" >&2
  exit 1
fi
repo=$(config_value "リポジトリ")

messages=$(node "$scripts/slack-message.mjs" "$file" "$channel" "$repo")

if [ "$messages" = null ]; then
  echo "報告することがないので投稿しなかった"
  exit 0
fi

if [ "$check" = 1 ] || [ "${REPO_PATROL:-}" != 1 ]; then
  echo "（投稿しない。宛先: ${channel}。送る本文:）"
  jq -r .plain.text <<<"$messages"
  echo "（Block Kit:）"
  jq .rich.blocks <<<"$messages"
  exit 0
fi

payload=$(jq -c .rich <<<"$messages")
plain=$(jq -c .plain <<<"$messages")

# set -u の bash 3.2 は空の配列を展開できないので、${auth[@]+...} で展開する
auth=()
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer ${SLACK_BOT_TOKEN}")
fi

headers=$(mktemp)
body=$(mktemp)
trap 'rm -f "$headers" "$body"' EXIT

error=unknown
for attempt in 1 2 3; do
  code=$(curl -sS -D "$headers" -o "$body" -w '%{http_code}' -X POST https://slack.com/api/chat.postMessage \
    -H 'Content-Type: application/json; charset=utf-8' ${auth[@]+"${auth[@]}"} \
    --data-binary "$payload") || code=000
  if [ "$(jq -r '.ok // false' "$body" 2>/dev/null || echo false)" = true ]; then
    echo "投稿した（ts=$(jq -r .ts "$body")）"
    exit 0
  fi
  error=$(jq -r '.error // empty' "$body" 2>/dev/null || true)
  error="${error:-http_$code}"
  case $error in
  invalid_blocks | invalid_blocks_format | msg_blocks_too_long)
    if [ "$payload" != "$plain" ]; then
      echo "Block Kit が拒否された（${error}）ので、文字だけで送り直す" >&2
      payload=$plain
      continue
    fi
    ;;
  esac
  transient=0
  case $code in
  000 | 429 | 5??) transient=1 ;;
  esac
  case $error in
  ratelimited | internal_error | fatal_error | service_unavailable | request_timeout) transient=1 ;;
  esac
  if [ "$transient" -eq 0 ]; then
    echo "Slack への投稿に失敗した: $error" >&2
    exit 1
  fi
  [ "$attempt" -lt 3 ] || break
  wait=$(awk 'tolower($1) == "retry-after:" { print $2 + 0 }' "$headers")
  sleep "${wait:-5}"
done
echo "Slack への投稿に失敗した: ${error}（3 回試した）" >&2
exit 1
