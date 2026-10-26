#!/usr/bin/env bash
# 30 日を過ぎた Issue / PR を一覧する、または閉じる。gh api の REST だけを使う。
# usage: stale.sh <owner/repo> list
#        stale.sh <owner/repo> close [--max 件数]
#
# 判定:
#   - Issue と人の PR は更新日時、Dependabot の PR は作成日時で数える（Dependabot は rebase のたびに更新日時を変えるため）
#   - keep ラベル付きと巡回 PR（このリポジトリの claude/patrol- ブランチからの PR）は対象外
#   - 本文に GHSA- か CVE- を含む Dependabot の PR は閉じずに hold として出す（セキュリティ更新を見えなくしないため）
# list の出力（TSV）: 区分 番号 種類 経過日数 基準 タイトル
#   区分: close（閉じる）/ notice（7 日以内に閉じる予定）/ notice-first（今日 notice に入った）/ hold（閉じない）
# close は判定をやり直してから、閉じる → patrol-closed ラベル → 理由のコメント、の順に行う。
# 閉じるのは 1 日（UTC）10 件まで（失敗した試行も数える）。--max で減らせるが増やせない。
# 終了コード: 0 成功 / 1 取得や close の失敗 / 2 閉じたがラベルかコメントに失敗したものがある
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

STALE_DAYS=30
NOTICE_DAYS=7
DAILY_CLOSE_LIMIT=10
KEEP_LABEL=keep
CLOSED_LABEL=patrol-closed
PATROL_PREFIX=claude/patrol-

repo=$1
mode=$2
max=$DAILY_CLOSE_LIMIT
if [ "${3:-}" = --max ]; then
  requested=${4:?--max には件数を渡す}
  if [ "$requested" -lt "$max" ]; then
    max=$requested
  fi
fi

classify() {
  local issues heads
  issues=$(gh api --paginate "repos/$repo/issues?state=open&per_page=100" | jq -s 'add // []') || return 1
  heads=$(gh api --paginate "repos/$repo/pulls?state=open&per_page=100" |
    jq -s 'add // [] | map({ key: (.number | tostring), value: { ref: .head.ref, repo: (.head.repo.full_name // "") } }) | from_entries') || return 1
  jq -r \
    --argjson heads "$heads" \
    --argjson stale "$STALE_DAYS" \
    --argjson notice "$NOTICE_DAYS" \
    --arg keep "$KEEP_LABEL" \
    --arg prefix "$PATROL_PREFIX" \
    --arg repo "$repo" '
    now as $now
    | .[]
    | select(([.labels[].name] | index($keep)) == null)
    | ($heads[(.number | tostring)] // { ref: "", repo: "" }) as $head
    | select((($head.ref | startswith($prefix)) and ($head.repo | ascii_downcase) == ($repo | ascii_downcase)) | not)
    | (.user.login == "dependabot[bot]") as $dependabot
    | (if $dependabot then .created_at else .updated_at end) as $basis_at
    | ((($now - ($basis_at | fromdateiso8601)) / 86400) | floor) as $age
    | ($dependabot and ((.body // "") | test("GHSA-|CVE-[0-9]"))) as $security
    | (if $security then (if $age >= $stale then "hold" else empty end)
       elif $age >= $stale then "close"
       elif $age == ($stale - $notice) then "notice-first"
       elif $age > ($stale - $notice) then "notice"
       else empty end) as $category
    | [ $category,
        .number,
        (if $dependabot then "dependabot" elif .pull_request then "pr" else "issue" end),
        $age,
        (if $dependabot then "created" else "updated" end),
        (.title | gsub("[\t\r\n]"; " ")) ]
    | @tsv
  ' <<<"$issues"
}

comment_body() {
  local kind=$1 footer="— repo-patrol"
  if [ -n "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ]; then
    footer="$footer ・ 実行ログ: https://claude.ai/code/${CLAUDE_CODE_REMOTE_SESSION_ID/#cse_/session_}"
  fi
  if [ "$kind" = dependabot ]; then
    printf '作成から %s 日たっても取り込まれていないため、巡回で閉じました。新しい版が出ると Dependabot が改めて PR を作ります。この版が必要なら reopen してください。\n\n%s\n' "$STALE_DAYS" "$footer"
  else
    # shellcheck disable=SC2016 # バッククォートは GitHub のコメントでのコード表記
    printf '%s 日間更新がないため、巡回で閉じました。まだ必要なら reopen してください。巡回の対象から外すには `%s` ラベルを付けてください。\n\n%s\n' "$STALE_DAYS" "$KEEP_LABEL" "$footer"
  fi
}

# 0: すべて成功 / 1: 閉じられなかった / 2: 閉じたがラベルかコメントに失敗した
close_one() {
  local number=$1 kind=$2 body status=0
  if [ "$kind" = issue ]; then
    gh api -X PATCH "repos/$repo/issues/$number" -f state=closed -f state_reason=not_planned >/dev/null || return 1
  else
    gh api -X PATCH "repos/$repo/pulls/$number" -f state=closed >/dev/null || return 1
  fi
  gh api -X POST "repos/$repo/issues/$number/labels" -f "labels[]=$CLOSED_LABEL" >/dev/null || status=2
  body=$(mktemp)
  comment_body "$kind" >"$body"
  gh api -X POST "repos/$repo/issues/$number/comments" -F "body=@$body" >/dev/null || status=2
  rm -f "$body"
  return "$status"
}

case $mode in
list)
  classify
  ;;
close)
  if ! gh api "repos/$repo/labels/$CLOSED_LABEL" >/dev/null 2>&1; then
    echo "ラベル $CLOSED_LABEL がない。人が作ってから実行する" >&2
    exit 1
  fi
  today=$(jq -rn 'now | strftime("%Y-%m-%dT00:00:00Z")')
  closed_today=$(gh api --paginate "repos/$repo/issues?state=closed&labels=$CLOSED_LABEL&since=$today&per_page=100" |
    jq -s --arg today "$today" '[add // [] | .[] | select(.closed_at >= $today)] | length')
  if [ $((DAILY_CLOSE_LIMIT - closed_today)) -lt "$max" ]; then
    max=$((DAILY_CLOSE_LIMIT - closed_today))
  fi
  if ! all=$(classify); then
    echo "Issue / PR の取得に失敗した" >&2
    exit 1
  fi
  targets=$(awk -F'\t' '$1 == "close"' <<<"$all")
  total=$(grep -c . <<<"$targets" || true)
  attempted=0
  closed=0
  partial=0
  failed=0
  while IFS=$'\t' read -r _ number kind age _ title; do
    [ -n "${number:-}" ] || continue
    [ "$attempted" -lt "$max" ] || break
    attempted=$((attempted + 1))
    status=0
    close_one "$number" "$kind" || status=$?
    case $status in
    0)
      closed=$((closed + 1))
      result=closed
      ;;
    2)
      partial=$((partial + 1))
      result="closed-partial"
      ;;
    *)
      failed=$((failed + 1))
      result=failed
      ;;
    esac
    printf '%s\t%s\t%s\t%s\t%s\n' "$result" "$number" "$kind" "$age" "$title"
  done <<<"$targets"
  printf 'summary\tclosed=%s\tclosed_partial=%s\tfailed=%s\tremaining=%s\n' \
    "$closed" "$partial" "$failed" "$((total - attempted))"
  if [ "$failed" -gt 0 ]; then
    exit 1
  fi
  if [ "$partial" -gt 0 ]; then
    exit 2
  fi
  ;;
*)
  echo "usage: stale.sh <owner/repo> list | close [--max N]" >&2
  exit 64
  ;;
esac
