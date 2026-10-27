# repo-patrol の設定

## リポジトリ

logical-fabrics/rev-store

## Slack チャンネル

`#rising-rev`

## CI で待つワークフロー

なし（`wait-checks.sh` には `-` を渡す）

PR に付くチェックはない。巡回 PR の `wait-checks.sh` が exit 5（チェックがない）で終わるのは、このリポジトリでは正常。報告には CI の代わりにセットアップの結果を書く。

## lockfile の場所

- `pnpm-lock.yaml`

pnpm は cloud environment の setup script で、`package.json` の `packageManager` と同じ版を入れてある（corepack は使わない）。

## セットアップ

- `pnpm install --frozen-lockfile --ignore-scripts`

依存に install script はなく、検証もないので、依存の install script は動かさない。lockfile と `package.json` の食い違いは `--frozen-lockfile` で分かる。

## 事前検査

なし

## 検証

なし。このリポジトリには CI・テスト・lint がない。

## 差分に含めてよい追加のパス

なし

## 判断基準

`references/dependency-triage.md` に従う。このリポジトリは npm に公開しているライブラリで、`dependencies` の版は利用側の依存の解決にも効く。

## 巡回で許す操作

このリポジトリに AGENTS.md・CLAUDE.md はない。巡回では、次の操作をしてよい: 依存の版の更新、`claude/patrol-deps` への push、巡回 PR の作成と更新、Dependabot の PR への見送り理由のコメント、30 日を過ぎた Issue / PR の close。
