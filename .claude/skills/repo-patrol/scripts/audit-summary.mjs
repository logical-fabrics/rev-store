#!/usr/bin/env node
// pnpm audit --json / npm audit --json の結果を、advisory ごとに「入っている版」と「直接依存か推移依存か」で並べる。
// 同じ advisory が直接依存と推移依存の両方に当たることがある。findings の先頭だけを見ると、直接依存を見落とす。
// usage: node audit-summary.mjs <audit の JSON ファイル>
// 終了コード: 0 要約した（指摘が 0 件でも） / 2 audit の結果として読めない
//
// 出力（advisory の行に続けて、入っている版ごとの行）:
//   zod	high	GHSA-mrhx-c7xc-m3w5	対象: <4.6.6	修正: >=4.6.6	<題名>
//     4.4.3	直接	.>zod
//     3.25.76	推移	apps__mobile>expo>@expo/cli>zod
// pnpm の経路は「ワークスペース>依存>…」で、2 段なら直接依存（`.` は root、`apps__web` は apps/web）。
// npm は入っている版を出さないので、版の欄は `?` にする。版は lockfile の `node_modules/<名前>` の項目で確かめる。

import { readFileSync } from "node:fs";

const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info"];
const MAX_PATHS = 3;

function fail(message) {
  console.error(message);
  process.exit(2);
}

const isDirectPath = (dependencyPath) => dependencyPath.split(">").length === 2;

// pnpm（と npm 6 の形式）。同じパッケージと GHSA の組は 1 つにまとめる。
function fromAdvisories(advisories) {
  const groups = new Map();
  for (const advisory of Object.values(advisories)) {
    const id = advisory.github_advisory_id ?? `id ${advisory.id}`;
    const key = `${advisory.module_name}\t${id}`;
    const group = groups.get(key) ?? {
      name: advisory.module_name,
      id,
      severity: advisory.severity,
      range: advisory.vulnerable_versions,
      fix: advisory.patched_versions,
      title: advisory.title,
      versions: new Map(),
    };
    groups.set(key, group);
    for (const finding of advisory.findings ?? []) {
      const paths = group.versions.get(finding.version) ?? new Set();
      for (const dependencyPath of finding.paths ?? []) {
        paths.add(dependencyPath);
      }
      group.versions.set(finding.version, paths);
    }
  }
  return [...groups.values()].map(({ versions, ...group }) => ({
    ...group,
    rows: [...versions].map(([version, paths]) => {
      const direct = [...paths].filter(isDirectPath);
      return {
        version,
        direct: direct.length > 0,
        paths: [...direct, ...[...paths].filter((p) => !isDirectPath(p))],
      };
    }),
  }));
}

// npm 7 以降の形式。via の文字列は「依存先が脆弱」という意味で、依存先の項目にも同じ advisory が出るので数えない。
function fromVulnerabilities(vulnerabilities) {
  return Object.values(vulnerabilities).flatMap((vulnerability) =>
    (vulnerability.via ?? [])
      .filter((via) => typeof via === "object")
      .map((via) => ({
        name: vulnerability.name,
        id: via.url?.match(/GHSA-[\w-]+/)?.[0] ?? `source ${via.source}`,
        severity: via.severity,
        range: via.range,
        title: via.title,
        rows: [
          {
            version: "?",
            direct: vulnerability.isDirect === true,
            paths: vulnerability.nodes ?? [],
          },
        ],
      })),
  );
}

const file = process.argv[2];
if (!file) fail("usage: node audit-summary.mjs <audit の JSON ファイル>");

let report;
try {
  report = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  fail(`audit の JSON として読めない: ${error.message}`);
}
if (report?.error) {
  fail(`audit が失敗している: ${JSON.stringify(report.error)}`);
}

let entries;
if (report?.advisories) {
  entries = fromAdvisories(report.advisories);
} else if (report?.vulnerabilities) {
  entries = fromVulnerabilities(report.vulnerabilities);
} else {
  fail("advisories（pnpm）も vulnerabilities（npm）もない");
}

const rank = (severity) => {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
};
entries.sort(
  (a, b) =>
    rank(a.severity) - rank(b.severity) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id),
);

for (const entry of entries) {
  const columns = [entry.name, entry.severity, entry.id];
  if (entry.range) columns.push(`対象: ${entry.range}`);
  if (entry.fix) columns.push(`修正: ${entry.fix}`);
  if (entry.title) columns.push(entry.title);
  console.log(columns.join("\t"));
  for (const row of entry.rows.sort((a, b) => b.direct - a.direct)) {
    const shown = row.paths.slice(0, MAX_PATHS).join(" ; ");
    const rest = row.paths.length - MAX_PATHS;
    console.log(
      `  ${row.version}\t${row.direct ? "直接" : "推移"}\t${shown}${rest > 0 ? ` ほか ${rest} 件` : ""}`,
    );
  }
}
const directCount = entries.filter((entry) =>
  entry.rows.some((row) => row.direct),
).length;
console.log(
  `advisory ${entries.length} 件（直接依存に当たるもの ${directCount} 件）`,
);
