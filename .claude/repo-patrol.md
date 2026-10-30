# repo-patrol の設定

## リポジトリ

logical-fabrics/rev-store

## Slack チャンネル

`#rising-rev`

## CI で待つワークフロー

CI

## lockfile の場所

- `pnpm-lock.yaml`

pnpm は、Actions の巡回では corepack が `package.json` の `packageManager` の版を使う。

## 差分に含めてよい追加のパス

なし

## 判断基準

`references/dependency-triage.md` に従う。このリポジトリは npm に公開しているライブラリで、`dependencies` の版は利用側の依存の解決にも効く。

## 巡回で許す操作

このリポジトリに AGENTS.md・CLAUDE.md はない。巡回では、次の操作をしてよい: Dependabot の PR への見送り理由のコメント。
