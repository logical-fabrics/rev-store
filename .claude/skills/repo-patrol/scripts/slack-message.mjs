#!/usr/bin/env node
// 巡回の報告の本文を、chat.postMessage に送る JSON にする。slack-post.sh から呼ぶ。
// usage: node slack-message.mjs <本文ファイル> <チャンネル> [<owner/name>]
// 出力: {"rich": Block Kit の本文, "plain": 文字だけの本文}
//   Block Kit が拒否されたら、slack-post.sh が plain で送り直す。ブロックが 50 を超えるときは rich も文字だけにする
//
// 本文の書式（Markdown の一部）:
//   1 行目          見出し（header ブロック）。先頭の {{mention}} は @channel にする
//   ## 小見出し     太字の小見出しで始まる節。空行では区切らない
//   - 項目          箇条書き
//   > 補足          小さな灰色の文字（context ブロック）。続く行はまとめる
//   ---             区切り線
//   実行ログ: URL   claude.ai のセッション URL ならリンクにする（補足と同じ扱い）
//   ほかの行        ふつうの文。空行で節を区切る
//
// 本文には Issue の題名など外から来た文字が入るので:
//   - & < > はすべてエスケープする（<!channel> やリンク記法を無効にする）
//   - リンクにするのは、#番号（設定のリポジトリの Issue / PR）と実行ログの URL だけ
//   - メンションは、本文の先頭にある {{mention}} を @channel にしたものだけ

import { readFileSync } from "node:fs";

const MENTION = "{{mention}}";
const HEADER_LIMIT = 150;
const TEXT_LIMIT = 3000;
// 1 行の上限。箇条書きの記号や太字の記号を足しても TEXT_LIMIT に収まるようにする
const LINE_LIMIT = 2900;
const BLOCK_LIMIT = 50;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SESSION_URL = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+$/;
// 英数字・/・#・`、エスケープした文字（&amp; など）の直後の # は番号として扱わない（URL の断片やコードの中を避ける）
const ISSUE_REF = /(?<![\w/&;#`])#(\d+)(?!\w)/g;

const [file, channel, repo = ""] = process.argv.slice(2);
const source = readFileSync(file, "utf8");
const mention = source.startsWith(MENTION);
const lines = (mention ? source.slice(MENTION.length) : source)
  .split(/\r?\n/)
  .map((line) => line.trimEnd());
const titleIndex = lines.findIndex((line) => line.trim() !== "");
if (titleIndex === -1) {
  console.error("本文が空");
  process.exit(1);
}
const title = lines[titleIndex].trim();

function truncate(text, limit) {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit - 1);
  // サロゲートペアの片割れを残さない
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const escapeMarkup = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function mrkdwn(text) {
  // Slack は空白以外（「（」や「・」など）に続くバッククォートをコードにしないので、前に空白を入れる
  const escaped = escapeMarkup(text).replace(
    /`[^`]+`/g,
    (code, offset, whole) =>
      offset > 0 && !/\s/.test(whole[offset - 1]) ? ` ${code}` : code,
  );
  const linked = REPO.test(repo)
    ? escaped.replace(
        ISSUE_REF,
        (_, number) =>
          `<https://github.com/${repo}/issues/${number}|#${number}>`,
      )
    : escaped;
  // リンクを途中で切らないよう、長すぎる行はリンクにしない
  return linked.length <= LINE_LIMIT ? linked : truncate(escaped, LINE_LIMIT);
}

// plain_text は書式を解釈しないので、エスケープせず全角に置き換えて見たままにする
const plainText = (text) =>
  truncate(
    text.replaceAll("&", "＆").replaceAll("<", "＜").replaceAll(">", "＞"),
    HEADER_LIMIT,
  );

// 行を TEXT_LIMIT 以内のかたまりに分ける
function chunk(texts) {
  const chunks = [];
  for (const text of texts) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + text.length <= TEXT_LIMIT) {
      chunks[chunks.length - 1] = `${last}\n${text}`;
    } else {
      chunks.push(text);
    }
  }
  return chunks;
}

const blocks = [
  {
    type: "header",
    text: { type: "plain_text", text: plainText(title), emoji: true },
  },
];
if (mention) {
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "<!channel>" },
  });
}
const fallback = [`${mention ? "<!channel> " : ""}${mrkdwn(title)}`];

let section = null; // { texts, headingOnly }
let context = null; // texts

function closeSection() {
  if (section === null) return;
  for (const text of chunk(section.texts)) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
  }
  section = null;
}

function closeContext() {
  if (context === null) return;
  for (const text of chunk(context)) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text }] });
  }
  context = null;
}

function addToSection(text) {
  closeContext();
  section ??= { texts: [], headingOnly: false };
  section.texts.push(text);
  section.headingOnly = false;
  fallback.push(text);
}

function addToContext(text) {
  closeSection();
  context ??= [];
  context.push(text);
  fallback.push(text);
}

for (const line of lines.slice(titleIndex + 1)) {
  const heading = line.match(/^#{1,6}\s+(.+)$/);
  const item = line.match(/^[-•*]\s+(.+)$/);
  const note = line.match(/^>\s?(.*)$/);
  const log = line.match(/^実行ログ[:：]\s*(\S+)$/);
  if (line.trim() === "") {
    if (section !== null && !section.headingOnly) closeSection();
    closeContext();
    if (fallback.at(-1) !== "") fallback.push("");
  } else if (/^-{3,}$/.test(line)) {
    closeSection();
    closeContext();
    blocks.push({ type: "divider" });
  } else if (heading) {
    closeSection();
    closeContext();
    const text = `*${mrkdwn(heading[1])}*`;
    section = { texts: [text], headingOnly: true };
    fallback.push(text);
  } else if (item) {
    addToSection(`• ${mrkdwn(item[1])}`);
  } else if (note) {
    // 空の text は Slack に拒否されるので、中身のない補足の行は捨てる
    if (note[1].trim() !== "") addToContext(mrkdwn(note[1]));
  } else if (log && SESSION_URL.test(log[1])) {
    addToContext(`<${log[1]}|実行ログ>`);
  } else {
    addToSection(mrkdwn(line));
  }
}
closeSection();
closeContext();

const base = { channel, unfurl_links: false, unfurl_media: false };
const plain = {
  ...base,
  text: fallback.join("\n").trim(),
};
// モバイルの通知は text だけを使うので、text には見出しとメンションを入れる
const rich =
  blocks.length <= BLOCK_LIMIT ? { ...base, text: fallback[0], blocks } : plain;

process.stdout.write(`${JSON.stringify({ rich, plain })}\n`);
