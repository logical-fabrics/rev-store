#!/usr/bin/env node
// 巡回の報告（JSON）を検証し、chat.postMessage に送る JSON にする。slack-post.sh から呼ぶ。
// usage: node slack-message.mjs <報告の JSON> <チャンネル> <owner/name>
// 出力: {"rich": Block Kit の本文, "plain": 文字だけの本文, "reply": スレッドの返信の {rich, plain} か null}。
//   投稿しない日（items が空で月曜でない日）は null。
//   Block Kit が拒否されたら、slack-post.sh が plain で送り直す。ブロックが 50 を超えるときは rich も文字だけにする
// 親の投稿は、深刻さの印（🔴 CI 失敗・🟡 要判断・🟢 それ以外）を付けた見出し、件数の欄、種類ごとに 5 件までの 1 件 1 行。
// 5 件を超えた分・見送り中・既定ブランチの CI・実行ログは、スレッドの返信に並べる。
// 報告の形は SKILL.md の手順 6。巡回は事実だけを書き、件数・色・並び・@channel・投稿するかはここで決める。
// 形に合わなければ、理由を標準エラーに出して exit 1（巡回は直して呼び直す）。前の日にコメントした見送りの要判断は、外して標準エラーに書く
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
// claude.ai のセッションか、Actions の実行（session-url.sh の出力）
const SESSION_URL =
  /^(?:https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+)$/;
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

// mentions は、どれかが true なら @channel を付けるキー
const KINDS = {
  ci_failure: {
    fields: { workflow: "text", url: "text", isNew: "boolean" },
    mentions: ["isNew"],
  },
  decision: {
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

// 見送り中のものを要判断にも並べるのは、今回コメントした日と、セキュリティの理由があるときだけ。
// 設定が「要判断」と書いた PR を巡回が毎日要判断にしても、報告ごと落とさずに要判断から外す（見送り中には残る）
function withoutStaleDeferrals(report) {
  const deferred = new Set(
    (report.notes?.deferred ?? []).map((entry) => entry.number),
  );
  const items = report.items.filter((item) => {
    const stale =
      item.kind === "decision" &&
      item.number !== undefined &&
      deferred.has(item.number) &&
      !item.commentedNow &&
      !item.security;
    if (stale) {
      console.error(
        `#${item.number} は見送り中（notes.deferred）にあり、今回コメントしていないので、要判断から外した`,
      );
    }
    return !stale;
  });
  return { ...report, items };
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

const MAX_LINES = 5;
// Slack の text の上限（40,000 文字）より短く
const MESSAGE_LIMIT = 39000;
// 見出しの先頭の印で深刻さを示す（attachments の色の帯は、長いと Slack が「もっと表示する」で畳むので使わない）
const MARKS = { failure: "🔴", decision: "🟡", ok: "🟢" };
const MERGE_ICONS = {
  success: "✅",
  pending: "⏳",
  unknown: "❔",
  failure: "❌",
};

// 実行ログの URL。報告になければ、Actions の上では今の実行の URL を使う
function runUrl(report, repo) {
  if (report.sessionUrl) return report.sessionUrl;
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL === "https://github.com" &&
    GITHUB_REPOSITORY?.toLowerCase() === repo.toLowerCase() &&
    /^\d+$/.test(GITHUB_RUN_ID ?? "")
    ? `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : null;
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
  const base = report.base ?? "既定ブランチ";
  const lines = {
    ci_failure: (item) =>
      actionsRun.test(item.url)
        ? `❌ ${mrkdwn(`${base} の CI`)}: <${item.url}|${escapeMarkup(oneLine(item.workflow))}>`
        : `❌ ${mrkdwn(`${base} の CI: ${item.workflow}（${item.url}）`)}`,
    decision: (item) =>
      `🤔 ${mrkdwn(`${ref(item.number)}${item.label}: ${item.reason}`)}`,
    // アイコンが CI の状態を表すので、成功のときは文字で書かない
    merge: (item) =>
      `${MERGE_ICONS[item.ci]} ${mrkdwn(
        [
          `${ref(item.number)}${item.label}`,
          ...(item.ageDays > 0 ? [`作成から ${item.ageDays} 日`] : []),
          ...(item.ci === "success" ? [] : [`CI ${CI_STATES[item.ci]}`]),
        ].join("・"),
      )}`,
    closing_soon: (item) => `⌛ ${mrkdwn(`${ref(item.number)}${item.title}`)}`,
  };

  const { items } = report;
  const notes = report.notes ?? {};
  const of = (test) => items.filter(test);
  // 並びは深刻な順。CI が落ちた Dependabot の PR は、マージ待ちではなく CI 失敗に入れる
  const groups = [
    [
      "CI 失敗",
      [
        ...of((item) => item.kind === "ci_failure"),
        ...of((item) => item.kind === "merge" && item.ci === "failure"),
      ],
    ],
    ["要判断", of((item) => item.kind === "decision")],
    [
      "マージ待ち",
      of((item) => item.kind === "merge" && item.ci !== "failure"),
    ],
    ["閉じる予定", of((item) => item.kind === "closing_soon")],
  ];
  const mark =
    groups[0][1].length > 0
      ? MARKS.failure
      : groups[1][1].length > 0
        ? MARKS.decision
        : MARKS.ok;

  const mention = items.some((item) =>
    KINDS[item.kind].mentions.some((key) => item[key] === true),
  );
  const status = items.length > 0 ? `要対応 ${items.length} 件` : "異常なし";
  const [, month, day] = report.date.split("-").map(Number);
  const title = `${mark} ${repo.split("/")[1]} の巡回（${month}/${day}）: ${status}`;
  const heading = `${mention ? "<!channel> " : ""}${escapeMarkup(title)}`;
  const counts = groups.map(([label, list]) => `${label} ${list.length}`);

  // 種類ごとに 5 件まで。残りはスレッドに並べる
  const shown = [];
  const overflow = [];
  for (const [, list] of groups) {
    if (list.length === 0) continue;
    const texts = list
      .slice(0, MAX_LINES)
      .map((item) => lines[item.kind](item));
    if (list.length > MAX_LINES) {
      texts.push(`他 ${list.length - MAX_LINES} 件（スレッドに一覧）`);
      overflow.push(
        ...list.slice(MAX_LINES).map((item) => lines[item.kind](item)),
      );
    }
    shown.push(texts);
  }

  const section = (text) => ({
    type: "section",
    text: { type: "mrkdwn", text, verbatim: true },
  });
  const message = { channel, unfurl_links: false, unfurl_media: false };
  // 文字だけの本文。chunk しない分、Slack の text の上限で切る
  const plainMessage = (texts) => ({
    ...message,
    text: truncate(texts.join("\n"), MESSAGE_LIMIT),
  });
  // ブロックが 50 を超えるときは文字だけにする
  const richMessage = (blocks, text, fallback) =>
    blocks.length <= BLOCK_LIMIT ? { ...message, text, blocks } : fallback;

  const plain = plainMessage([
    heading,
    counts.join("・"),
    ...shown.flatMap((texts) => ["", ...texts]),
  ]);
  const rich = richMessage(
    [
      {
        type: "header",
        text: { type: "plain_text", text: plainText(title), emoji: true },
      },
      ...(mention ? [section("<!channel>")] : []),
      {
        type: "section",
        fields: groups.map(([label, list]) => ({
          type: "mrkdwn",
          text: `*${label}*\n${list.length}`,
          verbatim: true,
        })),
      },
      ...(shown.length > 0 ? [{ type: "divider" }] : []),
      ...shown.flatMap((texts) => chunk(texts).map(section)),
    ],
    // モバイルの通知は text だけを使うので、text には見出しとメンションを入れる
    heading,
    plain,
  );

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
  const url = runUrl(report, repo);
  if (url) context.push(`<${url}|実行ログ>`);

  let reply = null;
  if (overflow.length > 0 || context.length > 0) {
    const overflowTexts =
      overflow.length > 0 ? ["*親の投稿に入らなかった項目*", ...overflow] : [];
    const replyPlain = plainMessage([
      ...overflowTexts,
      ...(overflowTexts.length > 0 && context.length > 0 ? [""] : []),
      ...context,
    ]);
    const replyBlocks = [
      ...chunk(overflowTexts).map(section),
      ...chunk(context).map((text) => ({
        type: "context",
        elements: [{ type: "mrkdwn", text, verbatim: true }],
      })),
    ];
    reply = {
      rich: richMessage(replyBlocks, escapeMarkup(title), replyPlain),
      plain: replyPlain,
    };
  }
  return { rich, plain, reply };
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
  report = withoutStaleDeferrals(report);
  // 報告することがない日も月曜は投稿し、投稿が途絶えたら巡回が止まっていると分かるようにする
  const monday = new Date(`${report.date}T00:00:00Z`).getUTCDay() === 1;
  const messages =
    report.items.length > 0 || monday ? render(report, channel, repo) : null;
  process.stdout.write(`${JSON.stringify(messages)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
