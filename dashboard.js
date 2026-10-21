// Drives a separate Reddit window: for each CSV row it opens the submit page,
// injects content.js, fills + schedules the post, then confirms it went through.
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rows = [];
let statuses = {}; // rowKey -> { status, note }
let stopRequested = false;
let redditTabId = null;

// ---------- CSV ----------

function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const out = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); out.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((f) => f.trim()));
}

// Accepts 2026-10-25 or 10/25/2026, and 14:30 or 2:30 PM. Local time.
function parseWhen(date, time) {
  date = (date || "").trim();
  time = (time || "").trim();
  let y, m, d;
  let mt = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) [, y, m, d] = mt.map(Number);
  else if ((mt = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [, m, d, y] = mt.map(Number);
  else return null;

  const tm = time.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!tm) return null;
  let h = Number(tm[1]);
  const min = Number(tm[2]);
  if (tm[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/pm/i.test(tm[3]) ? 12 : 0);
  }
  const when = new Date(y, m - 1, d, h, min);
  return isNaN(when) || when.getMonth() !== m - 1 ? null : when;
}

function rowKey(r) {
  const s = `${r.sub}|${r.title}|${r.date}|${r.time}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return "k" + (h >>> 0).toString(36);
}

function loadRows(text) {
  const table = parseCSV(text);
  if (!table.length) throw new Error("CSV is empty");
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  for (const need of ["title", "date", "time"]) {
    if (col(need) < 0) throw new Error(`CSV is missing a "${need}" column (found: ${header.join(", ")})`);
  }
  const defaultSub = cleanSub($("sub").value);
  return table.slice(1).map((cells, i) => {
    const get = (name) => (col(name) >= 0 ? cells[col(name)] ?? "" : "");
    const r = {
      n: i + 1,
      title: get("title").trim(),
      body: get("body"),
      date: get("date"),
      time: get("time"),
      sub: cleanSub(get("subreddit")) || defaultSub,
    };
    r.when = parseWhen(r.date, r.time);
    r.key = rowKey(r);
    r.problem = !r.title ? "empty title"
      : r.title.length > 300 ? "title over 300 chars"
      : !r.when ? `bad date/time "${r.date} ${r.time}"`
      : r.when < new Date() ? "time is in the past"
      : !r.sub ? "no subreddit"
      : "";
    return r;
  });
}

function cleanSub(s) {
  return (s || "").trim().replace(/^\/?r\//i, "").replace(/[^A-Za-z0-9_]/g, "");
}

// ---------- UI ----------

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  $("log").textContent += line;
  $("log").scrollTop = $("log").scrollHeight;
}

const statusOf = (r) => (r.problem ? { status: "invalid", note: r.problem } : statuses[r.key] || { status: "pending" });

// Builds an element; children may be strings or nodes.
function h(tag, cls, ...children) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...children.filter((c) => c !== null && c !== ""));
  return el;
}

function renderStats() {
  const counts = { done: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    const s = statusOf(r).status;
    if (s === "done") counts.done++;
    else if (s === "failed" || s === "invalid" || s === "unconfirmed") counts.failed++;
    else counts.pending++;
  }
  const valid = rows.filter((r) => !r.problem).length;
  const pct = valid ? Math.round((counts.done / valid) * 100) : 0;
  $("statTotal").textContent = rows.length;
  $("statDone").textContent = counts.done;
  $("statPending").textContent = counts.pending;
  $("statFailed").textContent = counts.failed;
  $("progressBar").style.width = pct + "%";
  $("progressText").textContent = `${counts.done} of ${valid} scheduled`;
  $("progressPct").textContent = pct + "%";
}

function render() {
  renderStats();
  const tbody = $("rows");
  if (!rows.length) {
    const td = h("td", "empty", "No CSV loaded yet. Pick a file on the left to see your queue.");
    td.colSpan = 4;
    tbody.replaceChildren(h("tr", "", td));
    return;
  }
  tbody.replaceChildren(
    ...rows.map((r) => {
      const st = statusOf(r);
      const body = r.body.replace(/\s+/g, " ").trim();
      const when = r.when
        ? [r.when.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
           h("small", "", `${r.when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · r/${r.sub}`)]
        : [`${r.date} ${r.time}`];
      return h("tr", st.status === "running" ? "is-running" : "",
        h("td", "num", String(r.n)),
        h("td", "post", h("b", "", r.title || "(no title)"), body ? h("small", "", body) : ""),
        h("td", "when", ...when),
        h("td", "status", h("span", `pill ${st.status}`, st.status), st.note ? h("small", "", st.note) : "")
      );
    })
  );
}

async function setStatus(r, status, note = "") {
  statuses[r.key] = { status, note };
  await chrome.storage.local.set({ statuses });
  render();
}

function setRunning(running) {
  $("start").disabled = running || !rows.length;
  $("stop").disabled = !running;
  $("csv").disabled = running;
  $("reset").disabled = running;
  $("inspect").disabled = running;
  document.body.classList.toggle("running", running);
  $("runState").textContent = running ? "Running" : "Idle";
}

// ---------- Reddit tab ----------

function waitForLoad(tabId, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error("Page load timed out")); }, timeout);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") { done(); resolve(); }
    };
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function openSubmitPage(sub) {
  const url = `https://www.reddit.com/r/${sub}/submit/?type=TEXT`;
  if (redditTabId !== null) {
    try {
      const loaded = waitForLoad(redditTabId);
      await chrome.tabs.update(redditTabId, { url, active: true });
      await loaded;
      return redditTabId;
    } catch {
      redditTabId = null;
    }
  }
  const win = await chrome.windows.create({ url, width: 1150, height: 900, focused: true });
  redditTabId = win.tabs[0].id;
  await waitForLoad(redditTabId);
  return redditTabId;
}

async function exec(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

async function injectContent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

// After clicking Schedule: success when Reddit leaves /submit or clears the form.
async function confirmSubmitted(tabId) {
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    let s;
    try {
      s = await exec(tabId, () => {
        const errors = document.querySelector("#submit-operation-errors");
        const ta = document.querySelector("post-composer-title")?.shadowRoot?.querySelector("textarea, input");
        return {
          url: location.href,
          errors: errors ? errors.innerText.replace(/\s+/g, " ").trim() : "",
          title: ta ? ta.value : null,
        };
      });
    } catch {
      continue; // page mid-navigation
    }
    if (!s) continue;
    if (s.errors) return { ok: false, note: s.errors };
    if (!s.url.includes("/submit")) return { ok: true, note: s.url };
    if (s.title === "") return { ok: true, note: "form cleared" };
  }
  return { ok: null, note: "no confirmation within 40s — check Reddit's scheduled posts" };
}

// ---------- runner ----------

async function runRow(r, testMode) {
  const tabId = await openSubmitPage(r.sub);
  await sleep(1500); // let the web components upgrade
  await injectContent(tabId);
  const job = { title: r.title, body: r.body, whenMs: r.when.getTime(), submit: !testMode };
  const res = await exec(tabId, (j) => window.__redditScheduler.run(j), [job]);
  if (!res) throw new Error("Content script returned nothing");
  res.log.forEach((l) => log(`  #${r.n}: ${l}`));
  if (!res.ok) return { status: "failed", note: res.error };
  if (testMode) return { status: "filled", note: "test mode — check the Reddit window" };
  const c = await confirmSubmitted(tabId);
  return c.ok === true ? { status: "done", note: "" }
    : c.ok === false ? { status: "failed", note: c.note }
    : { status: "unconfirmed", note: c.note };
}

async function start() {
  const testMode = $("testMode").checked;
  const delay = Math.max(5, Number($("delay").value) || 30) * 1000;
  stopRequested = false;
  setRunning(true);
  log(testMode ? "Starting in TEST MODE (nothing will be submitted)." : "Starting.");

  try {
    for (const r of rows) {
      if (stopRequested) break;
      if (r.problem || statuses[r.key]?.status === "done") continue;

      log(`#${r.n} "${r.title}" → r/${r.sub} at ${r.when.toLocaleString()}`);
      await setStatus(r, "running");
      let result;
      try {
        result = await runRow(r, testMode);
      } catch (e) {
        result = { status: "failed", note: String(e.message || e) };
      }
      await setStatus(r, result.status, result.note);
      log(`#${r.n}: ${result.status}${result.note ? " — " + result.note : ""}`);

      if (testMode) { log("Test mode stops after one row. Check the Reddit window, then untick Test mode."); break; }
      if (result.status !== "done") { log("Stopping so nothing gets double-posted. Fix the issue and press Start to resume."); break; }

      const next = rows.find((x) => !x.problem && statuses[x.key]?.status !== "done" && x !== r);
      if (!next) break;
      const until = Date.now() + delay;
      while (Date.now() < until && !stopRequested) await sleep(500);
    }
  } finally {
    setRunning(false);
    log(stopRequested ? "Stopped." : "Finished.");
  }
}

async function inspect() {
  const sub = cleanSub($("sub").value);
  if (!sub) return log("Enter a subreddit first.");
  setRunning(true);
  try {
    log(`Inspecting r/${sub} submit page…`);
    const tabId = await openSubmitPage(sub);
    await sleep(2000);
    await injectContent(tabId);
    const out = await exec(tabId, () => window.__redditScheduler.inspect());
    $("inspectCard").hidden = false;
    $("inspectOut").textContent = out || "(empty)";
    log("Inspect done — see the output below.");
  } catch (e) {
    log("Inspect failed: " + (e.message || e));
  } finally {
    setRunning(false);
  }
}

// ---------- wiring ----------

$("csv").addEventListener("change", async () => {
  const file = $("csv").files[0];
  if (!file) return;
  $("fileName").textContent = file.name;
  $("drop").classList.add("has-file");
  try {
    rows = loadRows(await file.text());
    const bad = rows.filter((r) => r.problem).length;
    log(`Loaded ${rows.length} rows from ${file.name}${bad ? ` (${bad} invalid, will be skipped)` : ""}.`);
  } catch (e) {
    rows = [];
    log("CSV error: " + e.message);
  }
  render();
  setRunning(false);
});

$("sub").addEventListener("change", () => {
  chrome.storage.local.set({ sub: cleanSub($("sub").value) });
  if ($("csv").files[0]) $("csv").dispatchEvent(new Event("change"));
});

$("start").addEventListener("click", start);
$("stop").addEventListener("click", () => { stopRequested = true; log("Stop requested — finishing the current row."); });
$("reset").addEventListener("click", () => {
  const done = Object.values(statuses).filter((s) => s.status === "done").length;
  $("resetDoneLine").hidden = done === 0;
  if (done) $("resetDoneLine").firstChild.textContent = `${done} row${done === 1 ? "" : "s"} marked `;
  $("resetDialog").returnValue = ""; // Escape keeps the previous value otherwise
  $("resetDialog").showModal();
});

$("resetDialog").addEventListener("close", async () => {
  if ($("resetDialog").returnValue !== "confirm") return;
  statuses = {};
  await chrome.storage.local.set({ statuses });
  render();
  log("Statuses reset.");
});
$("inspect").addEventListener("click", inspect);
$("clearLog").addEventListener("click", () => { $("log").textContent = ""; });

// Drag-and-drop styling; the file input itself covers the drop zone and receives the file.
for (const ev of ["dragenter", "dragover"]) $("drop").addEventListener(ev, () => $("drop").classList.add("over"));
for (const ev of ["dragleave", "drop"]) $("drop").addEventListener(ev, () => $("drop").classList.remove("over"));

chrome.storage.local.get(["statuses", "sub"]).then((s) => {
  statuses = s.statuses || {};
  $("sub").value = s.sub || "reddmentor_dev";
  render();
});
