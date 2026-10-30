// 依存の検査が落ちた理由を、GitHub Actions の annotations にも出す。check-diff.mjs と publisher-check.mjs が使う。
// 巡回は check run の annotations で理由を読む（ジョブのログを読まずに済む）。
// 出すのは REPO_PATROL_ANNOTATE=1 のときだけ（検査の workflow が付ける。このリポジトリの CI のテストでは出さない）。
// annotations は 1 つのステップで error が 10 件までなので、理由の種類ごとに 1 件にまとめ、先頭の数件だけを書く
// （種類は check-diff が 1 つ、publisher-check が多くて 7 つ）

const SHOWN = 3;
const ITEM_LIMIT = 120;

const truncate = (text) =>
  text.length <= ITEM_LIMIT ? text : `${text.slice(0, ITEM_LIMIT - 1)}…`;

// workflow command の値。改行を残すと、PR の lockfile の文字が別のコマンドとして読まれうる
const escapeData = (text) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

// groups: [理由の種類, 項目の配列] の並び（Map でもよい）。title は呼び出し側の固定の英数字
export function annotateFailures(title, groups) {
  if (process.env.REPO_PATROL_ANNOTATE !== "1") return;
  for (const [kind, items] of groups) {
    const shown = items.slice(0, SHOWN).map(truncate).join("・");
    const more = items.length > SHOWN ? " ほか" : "";
    console.log(
      `::error title=${title}::${escapeData(`${kind}: ${items.length} 件（${shown}${more}）`)}`,
    );
  }
}
