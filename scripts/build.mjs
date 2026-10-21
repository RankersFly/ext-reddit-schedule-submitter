#!/usr/bin/env node
// Zero-dependency build for the extension.
//
//   node scripts/build.mjs check                validate manifest, files and JS syntax
//   node scripts/build.mjs build                production: minified JS/CSS/HTML + zip (Web Store safe)
//   node scripts/build.mjs build --protected    production + obfuscated JS + zip (NOT for the Web Store)
//   node scripts/build.mjs build --dev          readable copy, no zip
//   node scripts/build.mjs clean                remove dist/
//   node scripts/build.mjs bump [patch|minor|major]   bump version in manifest + package.json
//
// The Chrome Web Store allows minified code but rejects obfuscated code
// ("Code Readability Requirements"), so --protected is for private installs only.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

// Everything the extension needs at runtime. Samples, docs and tooling stay out of the package.
const INCLUDE = ["manifest.json", "background.js", "content.js", "dashboard.html", "dashboard.js", "icons"];

const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const writeJSON = (p, v) => writeFileSync(join(ROOT, p), JSON.stringify(v, null, 2) + "\n");

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walkFiles(p) : [p];
  });
}

// ---------- check ----------

function check() {
  const errors = [];
  const pkg = readJSON("package.json");
  let manifest;
  try {
    manifest = readJSON("manifest.json");
  } catch (e) {
    errors.push(`manifest.json is not valid JSON: ${e.message}`);
  }

  if (manifest) {
    if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
    if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || "")) errors.push(`manifest version "${manifest.version}" is not a valid Chrome version`);
    if (manifest.version !== pkg.version) errors.push(`version mismatch: manifest ${manifest.version} vs package.json ${pkg.version} (run: npm run bump)`);

    // Every file the manifest points at must exist.
    const refs = [
      manifest.background?.service_worker,
      ...Object.values(manifest.icons || {}),
      ...Object.values(manifest.action?.default_icon || {}),
      manifest.action?.default_popup,
    ].filter(Boolean);
    for (const ref of refs) if (!existsSync(join(ROOT, ref))) errors.push(`manifest references missing file: ${ref}`);
  }

  // Files the dashboard loads at runtime.
  const html = readFileSync(join(ROOT, "dashboard.html"), "utf8");
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    if (!existsSync(join(ROOT, ref))) errors.push(`dashboard.html references missing file: ${ref}`);
  }
  for (const [, ref] of readFileSync(join(ROOT, "dashboard.js"), "utf8").matchAll(/files:\s*\[\s*"([^"]+)"/g)) {
    if (!existsSync(join(ROOT, ref))) errors.push(`dashboard.js injects missing file: ${ref}`);
  }

  for (const entry of INCLUDE) if (!existsSync(join(ROOT, entry))) errors.push(`missing: ${entry}`);

  // JS syntax.
  for (const f of INCLUDE.filter((f) => f.endsWith(".js"))) {
    try {
      execFileSync(process.execPath, ["--check", join(ROOT, f)], { stdio: "pipe" });
    } catch (e) {
      errors.push(`syntax error in ${f}:\n${e.stderr.toString().trim()}`);
    }
  }

  if (errors.length) {
    console.error(c.bad("✖ check failed"));
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  console.log(c.ok("✔ check passed") + c.dim(` (v${manifest.version})`));
  return manifest;
}

// ---------- zip (store + deflate, no dependencies) ----------

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zipDir(srcDir, outFile) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of walkFiles(srcDir).sort()) {
    const name = Buffer.from(relative(srcDir, file).split(sep).join("/"));
    const data = readFileSync(file);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(statSync(file).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                    // version needed
    local.writeUInt16LE(0x0800, 6);                // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);    // method
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);                  // version made by
    central.writeUInt16LE(20, 6);                  // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  writeFileSync(outFile, Buffer.concat([...locals, ...centrals, end]));
}

// ---------- minify / obfuscate ----------

async function loadTool(name) {
  try {
    return (await import(name)).default ?? (await import(name));
  } catch {
    console.error(c.bad(`✖ "${name}" is not installed. Run: npm install`));
    process.exit(1);
  }
}

// Files whose code is fully self-contained and safe to obfuscate.
// dashboard.js is minified only: it passes functions to chrome.scripting.executeScript,
// which serialises them with toString() and runs them inside the Reddit page. The
// obfuscator rewrites those functions to call helpers that only exist in the dashboard,
// so they would crash on Reddit.
const OBFUSCATE = ["content.js", "background.js"];

const OBFUSCATOR_OPTIONS = {
  target: "browser",
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,            // keep window.__redditScheduler reachable from the dashboard
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  numbersToExpressions: true,
  simplify: true,
  selfDefending: false,            // breaks under some CSPs; not worth the risk
  debugProtection: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
};

async function minifyAll(outDir, { protect }) {
  const esbuild = await loadTool("esbuild");
  const obfuscator = protect ? await loadTool("javascript-obfuscator") : null;

  for (const file of walkFiles(outDir)) {
    const name = relative(outDir, file).split(sep).join("/");
    const src = readFileSync(file, "utf8");
    let out = src;

    if (name.endsWith(".js")) {
      // format "iife" wraps each script in its own scope so top-level names get mangled too.
      out = (await esbuild.transform(src, { loader: "js", format: "iife", minify: true, target: "chrome110", legalComments: "none", charset: "utf8" })).code;
      if (protect && OBFUSCATE.includes(name)) out = obfuscator.obfuscate(out, OBFUSCATOR_OPTIONS).getObfuscatedCode();
    } else if (name.endsWith(".html")) {
      out = await minifyHtml(src, esbuild);
    } else if (name.endsWith(".json")) {
      out = JSON.stringify(JSON.parse(src));
    } else continue;

    writeFileSync(file, out);
    const pct = Math.round((1 - Buffer.byteLength(out) / Buffer.byteLength(src)) * 100);
    const tag = protect && OBFUSCATE.includes(name) ? "obfuscated" : "minified";
    console.log(c.dim(`  ${tag.padEnd(10)} ${name.padEnd(16)} ${(Buffer.byteLength(src) / 1024).toFixed(1)} KB → ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB (${pct >= 0 ? "-" : "+"}${Math.abs(pct)}%)`));
  }
}

// Minifies inline <style> with esbuild, drops comments and indentation.
async function minifyHtml(html, esbuild) {
  const styles = [];
  for (const [, css] of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    styles.push((await esbuild.transform(css, { loader: "css", minify: true })).code.trim());
  }
  let i = 0;
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, () => `<style>${styles[i++]}</style>`)
    .replace(/<!--(?!\[)[\s\S]*?-->/g, "")
    .replace(/^\s+/gm, "")
    .replace(/\n{2,}/g, "\n");
}

// Loads the built content script in a stub window to make sure it still runs.
function smokeTest(outDir) {
  const code = readFileSync(join(outDir, "content.js"), "utf8");
  const window = {};
  new Function("window", code)(window);
  const api = window.__redditScheduler;
  for (const fn of ["run", "inspect", "status"]) {
    if (typeof api?.[fn] !== "function") throw new Error(`built content.js no longer exposes window.__redditScheduler.${fn}`);
  }
  for (const f of INCLUDE.filter((f) => f.endsWith(".js"))) {
    execFileSync(process.execPath, ["--check", join(outDir, f)], { stdio: "pipe" });
  }
  console.log(c.ok("✔ smoke test") + c.dim(" built scripts parse and content.js exposes its API"));
}

// ---------- build ----------

async function build({ dev, protect }) {
  const manifest = check();
  const pkg = readJSON("package.json");
  const suffix = dev ? "-dev" : protect ? "-protected" : "";
  const outDir = join(DIST, pkg.name + suffix);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const entry of INCLUDE) cpSync(join(ROOT, entry), join(outDir, entry), { recursive: true });

  const files = walkFiles(outDir);
  const size = files.reduce((n, f) => n + statSync(f).size, 0);
  console.log(c.ok("✔ copied") + ` ${files.length} files ` + c.dim(`(${(size / 1024).toFixed(1)} KB) → ${relative(ROOT, outDir)}/`));

  if (dev) {
    console.log(c.dim("  --dev: readable code, no zip. Load the folder above via chrome://extensions → Load unpacked."));
    return;
  }

  console.log(c.ok(protect ? "✔ minifying + obfuscating" : "✔ minifying"));
  await minifyAll(outDir, { protect });
  smokeTest(outDir);

  const zipPath = join(DIST, `${pkg.name}-v${manifest.version}${suffix}.zip`);
  zipDir(outDir, zipPath);
  console.log(c.ok("✔ packaged") + ` ${relative(ROOT, zipPath)} ` + c.dim(`(${(statSync(zipPath).size / 1024).toFixed(1)} KB)`));
  if (protect) console.log(c.bad("  ⚠ obfuscated build: do NOT upload to the Chrome Web Store (policy violation). Private installs only."));
}

// ---------- bump ----------

function bump(part = "patch") {
  if (!["patch", "minor", "major"].includes(part)) {
    console.error(c.bad(`Unknown bump "${part}". Use patch, minor or major.`));
    process.exit(1);
  }
  const manifest = readJSON("manifest.json");
  const pkg = readJSON("package.json");
  const [maj, min, pat] = manifest.version.split(".").map(Number);
  const next =
    part === "major" ? `${maj + 1}.0.0` : part === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${(pat || 0) + 1}`;
  manifest.version = pkg.version = next;
  writeJSON("manifest.json", manifest);
  writeJSON("package.json", pkg);
  console.log(c.ok("✔ version") + ` ${c.bold(next)}`);
}

// ---------- cli ----------

const [cmd = "build", ...rest] = process.argv.slice(2);
switch (cmd) {
  case "check":
    check();
    break;
  case "build":
    await build({ dev: rest.includes("--dev"), protect: rest.includes("--protected") });
    break;
  case "clean":
    rmSync(DIST, { recursive: true, force: true });
    console.log(c.ok("✔ removed dist/"));
    break;
  case "bump":
    bump(rest.find((a) => !a.startsWith("-")) || process.env.npm_config_bump);
    break;
  default:
    console.error(`Unknown command "${cmd}". Use check, build, clean or bump.`);
    process.exit(1);
}
