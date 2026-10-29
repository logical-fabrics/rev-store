#!/usr/bin/env node
// 巡回の報告（JSON）を検証し、chat.postMessage に送る JSON にする。slack-post.sh から呼ぶ。
// usage: node slack-message.mjs <報告の JSON> <チャンネル> <owner/name>
// 出力: {"rich": Block Kit の本文, "plain": 文字だけの本文}。投稿しない日（items が空で月曜でない日）は null
//   Block Kit が拒否されたら、slack-post.sh が plain で送り直す。ブロックが 50 を超えるときは rich も文字だけにする
// 報告の形は SKILL.md の手順 7。巡回は事実だけを書き、件数・@channel・投稿するかはここで決める。
// 形に合わなければ、理由を標準エラーに出して exit 1（巡回は直して呼び直す）
//
// 報告には Issue の題名など外から来た文字が入るので:
//   - & < > はすべてエスケープする（<!channel> やリンク記法を無効にする）
//   - リンクにするのは、#番号（設定のリポジトリの Issue / PR）、そのリポジトリの Actions の実行 URL、実行ログの URL だけ
//   - メンションは、ここが付ける @channel だけ
//   - mrkdwn は verbatim にする（Slack が素の URL・チャンネル名・メンションを自動で解釈しないように）

import { readFileSync } from "node:fs";

const HEADER_LIMIT = 150;
const TEXT_LIMIT = 3000;
// 1 行の上限。箇条書きの記号や太字の記号を足しても TEXT_LIMIT に収まるようにする
const LINE_LIMIT = 2900;
const BLOCK_LIMIT = 50;
const STRING_LIMIT = 300;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SESSION_URL = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+$/;
// 英数字・/・#・`、エスケープした文字（&amp; など）の直後の # は番号として扱わない（URL の断片やコードの中を避ける）
const ISSUE_REF = /(?<![\w/&;#`])#(\d+)(?!\w)/g;

const CI_STATES = {
  success: "成功",
  failure: "失敗",
  pending: "実行中",
  unknown: "確認できなかった",
};

const TYPES = {
  text: {
    test: (value) =>
      typeof value === "string" &&
      value.trim() !== "" &&
      value.length <= STRING_LIMIT,
    expected: `空でない ${STRING_LIMIT} 文字以内の文字列`,
  },
  number: {
    test: (value) => Number.isInteger(value) && value > 0,
    expected: "正の整数",
  },
  count: {
    test: (value) => Number.isInteger(value) && value >= 0,
    expected: "0 以上の整数",
  },
  boolean: {
    test: (value) => typeof value === "boolean",
    expected: "true か false",
  },
  date: {
    test: (value) =>
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
    expected: "YYYY-MM-DD の日付",
  },
  sessionUrl: {
    test: (value) => typeof value === "string" && SESSION_URL.test(value),
    expected: "session-url.sh が出した URL",
  },
  ci: {
    test: (value) => Object.hasOwn(CI_STATES, value),
    expected: Object.keys(CI_STATES).join("・"),
  },
  baseCi: {
    test: (value) => value === "success" || value === "unknown",
    expected: "success か unknown（失敗は items の ci_failure に書く）",
  },
  list: { test: Array.isArray, expected: "配列" },
  object: {
    test: (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value),
    expected: "オブジェクト",
  },
};

const REPORT_FIELDS = {
  date: "date",
  base: "text?",
  sessionUrl: "sessionUrl?",
  items: "list",
  notes: "object?",
};

// 並びは深刻な順。mentions は、どれかが true なら @channel を付けるキー
const KINDS = {
  ci_failure: {
    heading: (base) => `:x: ${base} の CI が失敗`,
    fields: { workflow: "text", url: "text", isNew: "boolean" },
    mentions: ["isNew"],
  },
  decision: {
    heading: () => ":thinking_face: 要判断",
    fields: {
      number: "number?",
      label: "text",
      reason: "text",
      commentedNow: "boolean",
      security: "boolean",
    },
    mentions: ["commentedNow", "security"],
  },
  merge: {
    heading: () => ":eyes: マージしてください",
    fields: {
      number: "number",
      label: "text",
      ci: "ci",
      ageDays: "count?",
      isNew: "boolean",
      nudge: "boolean",
    },
    mentions: ["isNew", "nudge"],
  },
  closing_soon: {
    heading: () => ":hourglass_flowing_sand: 7 日以内に閉じる予定",
    fields: { number: "number", title: "text", firstNotice: "boolean" },
    mentions: ["firstNotice"],
  },
};

const NOTES_FIELDS = {
  deferred: "list?",
  baseCi: "baseCi?",
};
const DEFERRED_FIELDS = { number: "number?", label: "text", reason: "text" };

function checkFields(value, fields, where, errors) {
  if (!TYPES.object.test(value)) {
    errors.push(`${where} はオブジェクトにする`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) {
      errors.push(`${where}.${key} は使わないキー`);
    }
  }
  for (const [key, spec] of Object.entries(fields)) {
    const type = TYPES[spec.replace(/\?$/, "")];
    if (value[key] === undefined) {
      if (!spec.endsWith("?")) errors.push(`${where}.${key} がない`);
    } else if (!type.test(value[key])) {
      errors.push(`${where}.${key} の形が違う（${type.expected}）`);
    }
  }
  return true;
}

function validate(report) {
  const errors = [];
  if (!checkFields(report, REPORT_FIELDS, "報告", errors)) return errors;
  if (Array.isArray(report.items)) {
    report.items.forEach((item, index) => {
      const where = `items[${index}]`;
      if (!Object.hasOwn(KINDS, item?.kind)) {
        errors.push(
          `${where}.kind は ${Object.keys(KINDS).join("・")} のどれか`,
        );
        return;
      }
      checkFields(
        item,
        { kind: "text", ...KINDS[item.kind].fields },
        where,
        errors,
      );
    });
  }
  const notes = report.notes;
  if (TYPES.object.test(notes)) {
    checkFields(notes, NOTES_FIELDS, "notes", errors);
    if (Array.isArray(notes.deferred)) {
      notes.deferred.forEach((entry, index) => {
        checkFields(entry, DEFERRED_FIELDS, `notes.deferred[${index}]`, errors);
      });
    }
  }
  return errors;
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit - 1);
  // サロゲートペアの片割れを残さない
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const oneLine = (text) => text.replace(/\s+/g, " ").trim();

const escapeMarkup = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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

function render(report, channel, repo) {
  const mrkdwn = (text) => {
    // Slack は空白以外（「（」や「・」など）に続くバッククォートをコードにしないので、前に空白を入れる
    const escaped = escapeMarkup(oneLine(text)).replace(
      /`[^`]+`/g,
      (code, offset, whole) =>
        offset > 0 && !/\s/.test(whole[offset - 1]) ? ` ${code}` : code,
    );
    const linked = escaped.replace(
      ISSUE_REF,
      (_, number) => `<https://github.com/${repo}/issues/${number}|#${number}>`,
    );
    // リンクを途中で切らないよう、長すぎる行はリンクにしない
    return linked.length <= LINE_LIMIT ? linked : truncate(escaped, LINE_LIMIT);
  };
  const ref = (number) => (number === undefined ? "" : `#${number} `);
  const actionsRun = new RegExp(
    `^https://github\\.com/${repo.replaceAll(".", "\\.")}/actions/runs/\\d+(?:/job/\\d+)?$`,
    "i",
  );
  const lines = {
    ci_failure: (item) =>
      actionsRun.test(item.url)
        ? `<${item.url}|${escapeMarkup(oneLine(item.workflow))}>`
        : mrkdwn(`${item.workflow}: ${item.url}`),
    decision: (item) =>
      mrkdwn(`${ref(item.number)}${item.label}: ${item.reason}`),
    merge: (item) =>
      mrkdwn(
        [
          `${ref(item.number)}${item.label}`,
          ...(item.ageDays > 0 ? [`作成から ${item.ageDays} 日`] : []),
          `CI ${CI_STATES[item.ci]}`,
        ].join("・"),
      ),
    closing_soon: (item) => mrkdwn(`${ref(item.number)}${item.title}`),
  };

  const base = report.base ?? "既定ブランチ";
  const { items } = report;
  const notes = report.notes ?? {};
  const mention = items.some((item) =>
    KINDS[item.kind].mentions.some((key) => item[key] === true),
  );
  const status = items.length > 0 ? `要対応 ${items.length} 件` : "異常なし";
  const title = `${repo.split("/")[1]} の巡回（${report.date}）: ${status}`;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: plainText(title), emoji: true },
    },
  ];
  if (mention) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "<!channel>", verbatim: true },
    });
  }
  const fallback = [`${mention ? "<!channel> " : ""}${escapeMarkup(title)}`];

  for (const [kind, { heading }] of Object.entries(KINDS)) {
    const matching = items.filter((item) => item.kind === kind);
    if (matching.length === 0) continue;
    const texts = [
      `*${mrkdwn(heading(base))}*`,
      ...matching.map((item) => `• ${lines[kind](item)}`),
    ];
    for (const text of chunk(texts)) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text, verbatim: true },
      });
    }
    fallback.push("", ...texts);
  }

  const context = [];
  if (notes.deferred?.length > 0) {
    const entries = notes.deferred.map(
      (entry) => `${ref(entry.number)}${entry.label}（${entry.reason}）`,
    );
    context.push(mrkdwn(`:zzz: 見送り中: ${entries.join("・")}`));
  }
  if (notes.baseCi === "success") {
    context.push(mrkdwn(`:white_check_mark: ${base} の CI: 成功`));
  } else if (notes.baseCi === "unknown") {
    context.push(mrkdwn(`:grey_question: ${base} の CI: 確認できなかった`));
  }
  if (report.sessionUrl) context.push(`<${report.sessionUrl}|実行ログ>`);
  if (context.length > 0) {
    blocks.push({ type: "divider" });
    for (const text of chunk(context)) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text, verbatim: true }],
      });
    }
    fallback.push("", ...context);
  }

  const message = { channel, unfurl_links: false, unfurl_media: false };
  const plain = { ...message, text: fallback.join("\n") };
  // モバイルの通知は text だけを使うので、text には見出しとメンションを入れる
  const rich =
    blocks.length <= BLOCK_LIMIT
      ? { ...message, text: fallback[0], blocks }
      : plain;
  return { rich, plain };
}

function main([file, channel, repo]) {
  if (!REPO.test(repo ?? "")) {
    console.error("設定の「## リポジトリ」を owner/name の形で読めない");
    return 1;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`報告を JSON として読めない: ${error.message}`);
    return 1;
  }
  const errors = validate(report);
  if (errors.length > 0) {
    console.error(
      `報告の形が違う:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
    return 1;
  }
  // 報告することがない日も月曜は投稿し、投稿が途絶えたら巡回が止まっていると分かるようにする
  const monday = new Date(`${report.date}T00:00:00Z`).getUTCDay() === 1;
  const messages =
    report.items.length > 0 || monday ? render(report, channel, repo) : null;
  process.stdout.write(`${JSON.stringify(messages)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
