// lockfile から、パッケージごとの解決（どこから取るか）と、実際に入るパッケージの名前と版を読む。
// check-diff.mjs と publisher-check.mjs が使う。名前と版が読めない鍵は name が null になる。

// pnpm の鍵は「名前@版」。古い形式は先頭に /、lockfile v6 は peer を括弧で後ろに付ける（/a@1.0.0(react@18.2.0)）
function pnpmPackage(key) {
  const id = key.replace(/^\//, "").replace(/\(.*\)$/, "");
  const at = id.lastIndexOf("@");
  return at > 0
    ? { name: id.slice(0, at), version: id.slice(at + 1) }
    : { name: null, version: null };
}

// npm のレジストリの tarball。scope 付きは、ファイル名が scope を除いた名前になる
const registryTarball = (name, version) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;

// pnpm-lock.yaml の packages: から「パッケージの鍵 → resolution」を取り出す。
export function pnpmResolutions(text) {
  const resolutions = new Map();
  let inPackages = false;
  let key = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line.trim() === "packages:";
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const keyMatch = line.match(/^ {2}(\S.*):\s*$/);
    if (keyMatch) {
      key = keyMatch[1].replace(/^'(.*)'$/, "$1");
      // resolution の行がなければこのまま残り、レジストリ以外の扱いになる
      resolutions.set(key, {
        text: "（resolution がない）",
        registry: false,
        ...pnpmPackage(key),
      });
      continue;
    }
    const resolutionMatch = line.match(/^ {3,}resolution:\s*(.*)$/);
    if (key && resolutionMatch) {
      const value = resolutionMatch[1].trim();
      resolutions.set(key, {
        text: value,
        registry: /^\{integrity: [A-Za-z0-9+/=-]+\}$/.test(value),
        ...pnpmPackage(key),
      });
    }
  }
  return resolutions;
}

// package-lock.json の packages から「パスと版 → resolved と integrity」を取り出す。古い形式は null。
export function npmResolutions(text) {
  const lock = JSON.parse(text);
  if (!lock.packages) return null;
  const resolutions = new Map();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;
    const value = entry.link
      ? `link:${entry.resolved}`
      : `${entry.version}|${entry.resolved ?? ""}|${entry.integrity ?? ""}`;
    // 別名（"x": "npm:y@1.0.0"）では鍵のパスの名前は別名で、実際のパッケージは entry.name
    const marker = key.lastIndexOf("node_modules/");
    const name =
      entry.name ??
      (marker === -1 ? null : key.slice(marker + "node_modules/".length));
    resolutions.set(`${key}@${entry.version ?? ""}`, {
      text: value,
      name,
      version: entry.version ?? null,
      // resolved がその名前と版の tarball そのものでなければ、レジストリから取るものとして扱わない
      registry:
        !entry.link &&
        typeof entry.integrity === "string" &&
        name !== null &&
        entry.resolved === registryTarball(name, entry.version),
    });
  }
  return resolutions;
}
