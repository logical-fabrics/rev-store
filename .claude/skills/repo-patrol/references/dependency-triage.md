# 依存更新の判断基準

リポジトリの設定（`.claude/repo-patrol.md` の「判断基準」）が別の文書を指していれば、そちらを優先する。この文書は、指定がないときの既定。

## 種類ごとの扱い

| 種類 | 扱い |
|---|---|
| npm 系以外（GitHub Actions・cargo・docker など） | CI の状態を添えてマージ待ちとして報告し、人がそのままマージする |
| npm 系の patch / minor（groups で 1 本にまとまる） | CI と dependency-check が通っていればマージ待ちとして報告する。dependency-check が公開から 4 日未満で落ちていれば見送り中にする（head のコミットから 4 日たつと、検査の workflow が自動で再実行する） |
| npm 系のメジャー | マージ待ちにしない。理由（移行が必要か、peer 依存の都合か）を 1 回だけコメントし、見送り中として報告する |
| セキュリティ（アラート・audit・本文に GHSA / CVE） | 直す Dependabot の PR（セキュリティ更新は cooldown を待たずに来る）があれば、それを見る。なければ下の「推移依存の脆弱性」に沿って見込みを書き、要判断（`security: true`）にする |
| グループ PR（複数の依存をまとめたもの） | 中身を 1 つずつ上の基準で判断する。範囲内の最新化で新しく入った版も、dependency-check が 1 つずつ公開者・install script・公開日を確かめる |
| 設定の見送り表にあるもの | 見直す条件を満たしていなければ、見送り中として報告するだけ |

## 公開日と中身の確かめ方

- 公開日: `npm view <name> time --json` で各版の公開時刻を見る。境界ちょうどの版は避ける。4 日待つのは、乗っ取りやワームで公開された悪意ある版の多くが数時間〜数日で見つかって取り下げられ（npm も公開から 72 時間は作者が取り下げられる）、それより長く待っても安全があまり増えないため
- インストールスクリプト: `npm view <name>@<version> scripts --json` に `preinstall` / `install` / `postinstall` があれば、マージ待ちにせず要判断にする（前の版と同じ install script は dependency-check は通すが、巡回は人に見せる）
- 公開者: `npm view <name>@<version> _npmUser maintainers dist.attestations --json` を、今の版と新しい版で比べる。次のどれかなら要判断にする
  - 新しい版の `_npmUser` が、今の版の `maintainers` にいない
  - 今の版に provenance（`dist.attestations`）があるのに、新しい版にない
  - 今の版は trusted publishing（`_npmUser` が `GitHub Actions` か `GitLab CI/CD`）で公開されているのに、新しい版は人が公開している

  人から trusted publishing に変わり、新しい版に provenance があるもの（trusted publishing への移行）は通す。trusted publishing の版は、npm 側に登録したリポジトリとワークフロー（パイプライン）からしか出せないので、盗まれたトークンで人の名前で公開される版より確かめやすい

## 推移依存の脆弱性

package.json に書かれていない依存（推移依存）の advisory で、直す Dependabot の PR がないものは、巡回は直さずに見込みを書いて要判断にする。人が直す。

pnpm は推移依存に版を指定できず、範囲内の最新に解決する。見込みは読み取りで出す。

1. `pnpm why <name>` で、その依存を使う親と版を出す
2. 親ごとに `npm view <親>@<版> dependencies --json` で範囲を見て、`npm view <name> time --json` から範囲内の最新の版と公開日を出す
3. それが修正版に届いていて公開から 4 日を満たすなら、「`pnpm update <name> --lockfile-only` で <版> に上がる見込み」と書く。4 日未満なら、4 日を満たす日を書く
4. 届かなければ、親の更新か overrides が要ると書く

## よくある落とし穴

- 同じ依存を複数の package.json で宣言している monorepo では、すべて同じ版にそろえる
- 同じ advisory が別の lockfile（サブディレクトリの独立したプロジェクトなど）にもあることがある。設定の「lockfile の場所」をすべて見る
- biome を上げる PR は `biome.json` の `$schema` が古いまま残る。CI が落ちていれば、それを要判断に書く（設定で `biome.json` を追加パスとして許していれば、人がその PR に足しても dependency-check は通る）
- 対で上げる依存（同じスコープの関連パッケージなど）は、片方だけ上げない
