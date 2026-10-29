#!/usr/bin/env bash
# PR の CI が終わるのを待つ。gh api の REST だけを使う（クラウドでは GraphQL が 403 になる）。
# usage: wait-checks.sh <owner/repo> <PR 番号> <待つワークフロー名（カンマ区切り。CI がなければ ->）> [分（既定 9）]
# 終了コード: 0 成功 / 1 失敗 / 3 時間切れ（まだ動いている。巡回は呼び直さず、翌日の実行でまた見る）/ 4 コンフリクト / 5 チェックが 1 つもない
#             6 GitHub API の呼び出しに失敗した（CI の結果は分からない）
# 待つワークフローが skipped で終わったときは失敗として扱う（何も検証されていないため）。
# クラウドの前面コマンドは 10 分までなので、既定は 9 分で返す。
set -euo pipefail

repo=$1
pr=$2
workflows=$3
minutes=${4:-9}

deadline=$(($(date +%s) + minutes * 60))
# コミットからワークフローが出そろうまで待つ秒数。過ぎても出ていなければ「起動していない」とみなす。
# 待つワークフローがない（-）ときに出てくるのは外部のチェック（Vercel など）だけで、push の直後に付くので短くする。
if [ "$workflows" = - ]; then
  grace=120
else
  grace=600
fi

api() {
  gh api "$@" || {
    echo "GitHub API の呼び出しに失敗した: $*" >&2
    exit 6
  }
}

while :; do
  pull=$(api "repos/$repo/pulls/$pr")
  mergeable=$(jq -r '.mergeable_state // "unknown"' <<<"$pull")
  sha=$(jq -r '.head.sha' <<<"$pull")
  echo "PR #$pr state=$(jq -r .state <<<"$pull") mergeable_state=$mergeable head=${sha:0:7}"
  if [ "$mergeable" = dirty ]; then
    echo "コンフリクトしている。既定ブランチから作り直す"
    exit 4
  fi

  pushed_at=$(api "repos/$repo/commits/$sha" --jq '.commit.committer.date | fromdateiso8601')
  runs=$(api "repos/$repo/actions/runs?head_sha=$sha&per_page=100" --jq '.workflow_runs')
  checks=$(api "repos/$repo/commits/$sha/check-runs?per_page=100" --jq '.check_runs')
  status=$(api "repos/$repo/commits/$sha/status")

  verdict=$(jq -rn \
    --argjson runs "$runs" \
    --argjson checks "$checks" \
    --argjson status "$status" \
    --arg workflows "$workflows" \
    --argjson pushed_at "$pushed_at" \
    --argjson grace "$grace" '
    def failed: . as $c | ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"] | index($c) != null;
    ($workflows | if . == "-" then [] else split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != "")) end) as $expected
    | (now - $pushed_at > $grace) as $grace_over
    | [ $expected[] as $name
        | ([ $runs[] | select(.name == $name) ] | sort_by(.created_at) | last) as $run
        | if $run == null then
            { name: $name, state: (if $grace_over then "failure" else "pending" end), detail: "ワークフローが起動していない" }
          elif $run.status != "completed" then
            { name: $name, state: "pending", detail: $run.status, url: $run.html_url }
          elif ($run.conclusion | failed) or $run.conclusion == "skipped" then
            { name: $name, state: "failure", detail: $run.conclusion, url: $run.html_url }
          else
            { name: $name, state: "success", detail: $run.conclusion, url: $run.html_url }
          end ] as $workflow_items
    | [ $checks[]
        | if .status != "completed" then
            { name: "check: \(.name)", state: "pending", detail: .status, id: .id }
          elif (.conclusion | failed) then
            { name: "check: \(.name)", state: "failure", detail: .conclusion, url: .html_url, id: .id }
          else
            { name: "check: \(.name)", state: "success", detail: .conclusion, id: .id }
          end ] as $check_items
    | [ $status.statuses[]?
        | { name: "status: \(.context)", state: (if .state == "pending" then "pending" elif .state == "success" then "success" else "failure" end), detail: .state, url: .target_url } ] as $status_items
    | ($workflow_items + $check_items + $status_items) as $items
    | (if ($items | length) == 0 then (if $grace_over then "none" else "pending" end)
       elif any($items[]; .state == "failure") then "failure"
       elif any($items[]; .state == "pending") then "pending"
       else "success" end) as $overall
    | ([ $items[] | "  \(.state)\t\(.name)\t\(.detail)\(if .url then "\t\(.url)" else "" end)\(if .id then "\tcheck_run_id=\(.id)" else "" end)" ] | join("\n")) as $lines
    | "\($overall)\n\($lines)"
  ')

  overall=$(head -n 1 <<<"$verdict")
  tail -n +2 <<<"$verdict"
  case $overall in
  success)
    echo "CI はすべて成功"
    exit 0
    ;;
  failure)
    echo "CI が失敗した。check_run_id の annotations（repos/$repo/check-runs/<id>/annotations）で原因を見る"
    exit 1
    ;;
  none)
    echo "この PR にはチェックが 1 つもない"
    exit 5
    ;;
  esac

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "まだ実行中。呼び直さない（翌日の巡回でまた見る）"
    exit 3
  fi
  sleep 30
done
