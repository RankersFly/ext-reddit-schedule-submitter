// Injected into https://www.reddit.com/r/<sub>/submit by the dashboard.
// Fills title + body, sets the schedule date/time, and clicks "Schedule".
// Reddit's composer is built from web components with shadow roots, so every
// lookup goes through walk(), which descends into open shadow roots.
(() => {
  if (window.__redditScheduler) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function* walk(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === Node.ELEMENT_NODE) {
        yield node;
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }
      const kids = node.children || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  const deepAll = (root, sel) => [...walk(root)].filter((el) => el.matches(sel));
  const deepOne = (root, sel) => {
    for (const el of walk(root)) if (el.matches(sel)) return el;
    return null;
  };

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const label = (el) =>
    (el.getAttribute("aria-label") || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  // Parent across shadow boundaries.
  const parentOf = (el) => el.parentElement || el.getRootNode()?.host || null;

  async function waitFor(fn, timeout = 15000, interval = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  // ---------- title ----------

  async function fillTitle(title) {
    const host = await waitFor(() => document.querySelector("post-composer-title"));
    if (!host) throw new Error("Title field (post-composer-title) not found");
    const field = await waitFor(() => deepOne(host, 'textarea, input, [contenteditable="true"]'));
    if (!field) throw new Error("Title input inside post-composer-title not found");

    field.focus();
    if (field.isContentEditable) {
      document.execCommand("selectAll");
      document.execCommand("insertText", false, title);
      return;
    }
    field.select();
    document.execCommand("insertText", false, title);
    if (field.value !== title) setNativeValue(field, title);
  }

  // ---------- body ----------

  async function fillBody(body) {
    if (!body) return;
    const editor = await waitFor(
      () =>
        document.querySelector('shreddit-composer[name="body"] [contenteditable="true"]') ||
        deepOne(document, '[data-lexical-editor="true"][name="body"]')
    );
    if (!editor) throw new Error("Body editor not found");

    editor.focus();
    document.execCommand("selectAll");
    document.execCommand("delete");

    // Lexical turns a plain-text paste into proper paragraphs.
    const dt = new DataTransfer();
    dt.setData("text/plain", body);
    editor.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true })
    );
    await sleep(400);

    const probe = norm(body).slice(0, 40);
    if (norm(editor.innerText).includes(probe)) return;

    // Fallback: type it line by line.
    editor.focus();
    document.execCommand("selectAll");
    document.execCommand("delete");
    body.split(/\r?\n/).forEach((line, i) => {
      if (i > 0) document.execCommand("insertParagraph");
      if (line) document.execCommand("insertText", false, line);
    });
    await sleep(300);
    if (!norm(editor.innerText).includes(probe)) throw new Error("Body text did not stick in the editor");
  }

  // ---------- schedule ----------

  // The "Schedule Post" modal (rpl-modal-card) holds these two form-associated inputs.
  function findScheduleInputs() {
    const date = deepOne(document, 'shreddit-date-input[name="publish-at-date"]');
    const time = deepOne(document, 'shreddit-time-input[name="publish-at-time"]');
    return date && time ? { date, time } : null;
  }

  // Full pointer/mouse sequence at the element's centre, like a real click.
  function realClick(el) {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.focus?.();
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // Modal counts as open once its Save button is on screen.
  function openModalInputs() {
    const save = deepOne(document, 'button[data-testid="save-button"]');
    return save && isVisible(save) ? findScheduleInputs() : null;
  }

  async function openSchedulePicker() {
    if (openModalInputs()) return openModalInputs();
    // Clock button: post-form-date-picker-trigger > #shadow-root > faceplate-tracker > button
    const btn = await waitFor(() => {
      const host = document.querySelector("#date-picker-button, post-form-date-picker-trigger");
      const b = host && deepOne(host, "button");
      return b && isVisible(b) ? b : null;
    });
    if (!btn) throw new Error("Schedule (clock) button not found — is post scheduling enabled for this subreddit?");

    // The component may not have its click handler wired yet right after load, so retry.
    for (let attempt = 1; attempt <= 4; attempt++) {
      realClick(btn);
      const inputs = await waitFor(openModalInputs, 4000);
      if (inputs) return inputs;
    }
    const found = findScheduleInputs() ? "date/time inputs exist but Save button never became visible" : "no publish-at-date / publish-at-time inputs in the page";
    throw new Error(`Clicked the clock button 4× but the Schedule Post modal didn't open (${found})`);
  }

  const pad = (n) => String(n).padStart(2, "0");

  // shreddit-date-input takes value "YYYY-MM-DD", shreddit-time-input takes "HH:mm" (24h).
  async function setPicker(el, value) {
    el.value = value;
    el.setAttribute("value", value);
    // Also push it into the inner text input if the component renders one,
    // since some components re-read the visible field on change/blur.
    const input = deepOne(el.shadowRoot || el, "input");
    if (input && input.value !== value && (input.type === "date" || input.type === "time")) setNativeValue(input, value);
    for (const type of ["input", "change"]) el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    await sleep(300);
    return el.value ?? el.getAttribute("value");
  }

  function findDialog(el) {
    for (let n = el; n; n = parentOf(n)) {
      if (n.matches?.('rpl-modal-card, dialog, [role="dialog"], faceplate-modal')) return n;
    }
    return null;
  }

  async function setSchedule(when) {
    const { date, time } = await openSchedulePicker();
    const wantDate = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
    const wantTime = `${pad(when.getHours())}:${pad(when.getMinutes())}`;

    // Date first: the time input validates against its connected date input.
    const gotDate = await setPicker(date, wantDate);
    const gotTime = await setPicker(time, wantTime);
    if (gotDate !== wantDate || gotTime !== wantTime) {
      throw new Error(`Schedule fields rejected the value (wanted ${wantDate} ${wantTime}, got ${gotDate} ${gotTime})`);
    }

    const root = findDialog(date) || document;
    const save = deepOne(root, 'button[data-testid="save-button"]');
    if (!save) throw new Error('Schedule modal "Save" button not found');
    if (save.disabled || save.getAttribute("aria-disabled") === "true") throw new Error("Schedule Save button is disabled — time may be invalid or in the past");
    save.click();

    // The modal closes on success; if it stays open, Reddit rejected the time.
    const closed = await waitFor(() => !findScheduleInputs() || !isVisible(save), 5000);
    if (!closed) {
      const err = deepAll(root, '[slot="helper-text"], [role="alert"], .text-alert-negative').map(label).filter(Boolean).join(" ");
      throw new Error(`Schedule modal did not close after Save${err ? `: ${err}` : ""}`);
    }
    await sleep(500);
    return { shownDate: gotDate, shownTime: gotTime, confirmed: "Save" };
  }

  // ---------- submit ----------

  function submitButton() {
    const host = document.querySelector("#submit-post-button");
    return host ? deepOne(host, "button") : null;
  }

  async function clickSchedule() {
    const btn = await waitFor(submitButton, 5000);
    if (!btn) throw new Error("Submit button not found");
    const text = label(btn);
    // Safety: if the button doesn't say "Schedule", the schedule didn't apply and
    // clicking would post immediately.
    if (!/schedul/i.test(text)) throw new Error(`Submit button says "${text}", not "Schedule" — not clicking`);
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") throw new Error("Schedule button is disabled (missing flair or required field?)");
    btn.click();
    return text;
  }

  // ---------- entry points ----------

  async function run(job) {
    const log = [];
    try {
      const when = new Date(job.whenMs);
      await fillTitle(job.title);
      log.push("title filled");
      await fillBody(job.body);
      if (job.body) log.push("body filled");
      const s = await setSchedule(when);
      log.push(`schedule set (date "${s.shownDate}", time "${s.shownTime}"${s.confirmed ? `, confirmed via "${s.confirmed}"` : ", no confirm button found"})`);
      if (!job.submit) return { ok: true, stage: "filled", log };
      const btnText = await clickSchedule();
      log.push(`clicked "${btnText}"`);
      return { ok: true, stage: "clicked", log };
    } catch (e) {
      return { ok: false, error: String(e.message || e), log };
    }
  }

  // Dumps the composer's web components and the schedule picker so selectors can be tuned.
  async function inspect() {
    const out = [];
    const describe = (el, depth) => {
      const attrs = ["name", "id", "type", "role", "aria-label", "iso-date", "value"]
        .map((a) => (el.getAttribute(a) ? `${a}="${el.getAttribute(a).slice(0, 60)}"` : ""))
        .filter(Boolean)
        .join(" ");
      const txt = /^(BUTTON|LABEL|SPAN)$/.test(el.tagName) ? ` «${label(el).slice(0, 50)}»` : "";
      out.push(`${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>${el.shadowRoot ? " #shadow" : ""}${txt}`);
    };
    const dump = (root, depth = 0) => {
      for (const el of root.children || []) {
        const interesting = el.tagName.includes("-") || /^(INPUT|TEXTAREA|BUTTON|SELECT|DIALOG)$/.test(el.tagName) || el.getAttribute("role") === "dialog";
        if (interesting) describe(el, depth);
        if (el.shadowRoot) dump(el.shadowRoot, depth + (interesting ? 1 : 0));
        dump(el, depth + (interesting ? 1 : 0));
        if (out.length > 600) return;
      }
    };

    out.push("== title ==");
    const t = document.querySelector("post-composer-title");
    if (t) dump(t.shadowRoot || t);
    out.push("== submit button ==");
    const b = submitButton();
    out.push(b ? `button text: «${label(b)}»` : "not found");

    out.push("== schedule picker (after opening) ==");
    const trigger = document.querySelector("post-form-date-picker-trigger");
    if (!trigger) {
      out.push("post-form-date-picker-trigger not found");
    } else {
      (deepOne(trigger, "button") || trigger).click();
      await sleep(1500);
      const inputs = findScheduleInputs();
      const anchor = inputs ? findDialog(inputs.date) || parentOf(inputs.date) : null;
      if (anchor) dump(anchor.shadowRoot || anchor);
      else {
        out.push("(no date/time inputs found — dumping all visible dialogs)");
        deepAll(document, 'dialog, [role="dialog"], faceplate-modal, faceplate-dialog').filter(isVisible).forEach((d) => {
          describe(d, 0);
          dump(d.shadowRoot || d, 1);
          dump(d, 1);
        });
      }
    }
    return out.join("\n");
  }

  function status() {
    const errors = document.querySelector("#submit-operation-errors");
    return { url: location.href, errors: errors ? norm(errors.innerText) : "" };
  }

  window.__redditScheduler = { run, inspect, status };
})();
