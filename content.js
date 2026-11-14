// Injected into https://www.reddit.com/r/<sub>/submit by the dashboard.
// Fills title + body, sets the schedule date/time, and clicks "Schedule".
// Reddit's composer is built from web components with shadow roots, so every
// lookup goes through walk(), which descends into open shadow roots.
(() => {
  if (window.__redditScheduler) return;

  // ---------- human-like pacing (edit these) ----------
  // All ranges are [min, max] in milliseconds; a random value is picked each time.
  const HUMAN = {
    enabled: true,               // false = fill instantly like before
    keyDelay: [45, 160],         // between keystrokes
    spacePause: [30, 180],       // extra pause after a space
    punctuationPause: [120, 450],// extra pause after . , ! ? ; :
    lineBreakPause: [250, 700],  // after a new line in the body
    thinkChance: 0.02,           // chance per character of a longer "thinking" pause
    thinkPause: [500, 1500],
    typoChance: 0.04,            // chance per letter of hitting a neighbouring key
    typoRunOn: [0, 2],           // extra correct characters typed before noticing the typo
    noticePause: [200, 600],     // pause before starting to backspace
    backspaceDelay: [70, 170],   // between backspaces
    stepPause: [700, 2000],      // between steps: title → body → schedule → save → submit
    maxTypedBodyChars: 1500,     // longer bodies are pasted instead (typing would take minutes)
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([min, max]) => min + Math.random() * (max - min);
  const randInt = ([min, max]) => Math.floor(min + Math.random() * (max - min + 1));
  const humanPause = (range) => (HUMAN.enabled ? sleep(rand(range)) : Promise.resolve());

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

  // ---------- human typing ----------

  const isTextControl = (el) => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;

  // Re-focus and put the caret at the end if focus was lost mid-typing.
  function ensureFocus(el) {
    if (el.getRootNode().activeElement === el) return;
    el.focus();
    if (isTextControl(el)) {
      el.selectionStart = el.selectionEnd = el.value.length;
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  function insertChar(el, ch) {
    if (isTextControl(el)) {
      const before = el.value;
      document.execCommand("insertText", false, ch);
      if (el.value === before) {
        // execCommand can be a no-op for inputs inside shadow roots; edit directly instead.
        el.setRangeText(ch, el.selectionStart, el.selectionEnd, "end");
        el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: ch, bubbles: true, composed: true }));
      }
    } else {
      document.execCommand("insertText", false, ch);
    }
  }

  function backspace(el) {
    if (isTextControl(el)) {
      const before = el.value;
      document.execCommand("delete");
      if (el.value === before && el.selectionStart > 0) {
        el.setRangeText("", el.selectionStart - 1, el.selectionStart, "end");
        el.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true, composed: true }));
      }
    } else {
      document.execCommand("delete");
    }
  }

  // CSV line breaks map to the editor like Markdown:
  //   "\n"    → line break inside the paragraph (Shift+Enter, no gap)
  //   "\n\n"  → new paragraph (Enter, normal gap); each extra "\n" adds an empty paragraph
  const LINE_BREAK = { newline: "line" };
  const PARAGRAPH = { newline: "paragraph" };

  function tokenize(text) {
    const out = [];
    for (const part of text.replace(/\r/g, "").split(/(\n+)/)) {
      if (!part) continue;
      if (part[0] !== "\n") out.push(...part);
      else if (part.length === 1) out.push(LINE_BREAK);
      else for (let k = 1; k < part.length; k++) out.push(PARAGRAPH);
    }
    return out;
  }

  const snapshot = (el) => (isTextControl(el) ? el.value : el.innerText);

  // Waits until the editor's DOM changes (Lexical can apply edits a little later).
  async function domChanged(el, before, timeout = 300) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await sleep(25);
      if (el.innerHTML !== before) return true;
    }
    return false;
  }

  // Lexical ignores execCommand for Enter; it listens for the Enter keydown or a
  // beforeinput event. Try each in turn, waiting long enough for the previous one
  // to land so a slow update never results in two line breaks.
  async function pressEnter(el, shift) {
    const before = el.innerHTML;
    const keyOpts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, shiftKey: shift, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
    el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
    if (await domChanged(el, before)) return true;

    const inputType = shift ? "insertLineBreak" : "insertParagraph";
    el.dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true, composed: true }));
    if (await domChanged(el, before)) return true;

    document.execCommand(inputType);
    return domChanged(el, before);
  }

  // QWERTY neighbours, for realistic typos.
  const NEIGHBOURS = {
    q: "wa", w: "qes", e: "wrd", r: "etf", t: "ryg", y: "tuh", u: "yij", i: "uok", o: "ipl", p: "ol",
    a: "qsz", s: "awdz", d: "sefx", f: "drgc", g: "fthv", h: "gyjb", j: "hukn", k: "jilm", l: "kop",
    z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk",
  };
  function nearbyKey(ch) {
    const opts = NEIGHBOURS[ch.toLowerCase()] || "etaoin";
    const k = opts[Math.floor(Math.random() * opts.length)];
    return ch === ch.toUpperCase() ? k.toUpperCase() : k;
  }

  function pauseAfter(ch) {
    let ms = rand(HUMAN.keyDelay);
    if (ch === " ") ms += rand(HUMAN.spacePause);
    if (ch === "\n") ms += rand(HUMAN.lineBreakPause);
    if (/[.,!?;:]/.test(ch)) ms += rand(HUMAN.punctuationPause);
    if (Math.random() < HUMAN.thinkChance) ms += rand(HUMAN.thinkPause);
    return sleep(ms);
  }

  // Types a wrong key (plus maybe a few right ones), then backspaces until the
  // field is exactly as it was. Returns false if it can't get back to that state.
  async function makeTypo(el, tokens, i) {
    const before = snapshot(el);
    const wrong = [nearbyKey(tokens[i])];
    for (let k = 1, n = randInt(HUMAN.typoRunOn); k <= n && typeof tokens[i + k] === "string"; k++) wrong.push(tokens[i + k]);

    for (const w of wrong) {
      insertChar(el, w);
      await sleep(rand(HUMAN.keyDelay));
    }
    await sleep(rand(HUMAN.noticePause));
    for (let k = 0; k < wrong.length; k++) {
      ensureFocus(el);
      backspace(el);
      await sleep(rand(HUMAN.backspaceDelay));
    }

    // Verify the correction actually happened; delete any stragglers.
    for (let extra = 0; extra < wrong.length + 3 && snapshot(el) !== before; extra++) {
      if (snapshot(el).length <= before.length) break; // deleted too much: can't repair safely
      ensureFocus(el);
      backspace(el);
      await sleep(rand(HUMAN.backspaceDelay));
    }
    return snapshot(el) === before;
  }

  // Types text like a person. Returns false if the field got out of sync (stray
  // characters or a missing line break); the caller then falls back to a clean fill.
  async function typeHuman(el, text) {
    // A textarea takes "\n" as a normal character; only the rich editor needs Enter events.
    const tokens = isTextControl(el) ? [...text.replace(/\r/g, "")] : tokenize(text);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      ensureFocus(el);

      if (typeof t !== "string") {
        if (!(await pressEnter(el, t === LINE_BREAK))) return false;
        await sleep(rand(HUMAN.lineBreakPause));
        continue;
      }

      // No typos on the first character of a line: the editor's cursor can still be
      // settling right after Enter, which is where stray letters used to come from.
      const afterBreak = i === 0 || typeof tokens[i - 1] !== "string" || tokens[i - 1] === "\n";
      if (!afterBreak && /[a-z]/i.test(t) && Math.random() < HUMAN.typoChance) {
        if (!(await makeTypo(el, tokens, i))) return false;
      }

      insertChar(el, t);
      await pauseAfter(t);
    }
    return true;
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
      if (HUMAN.enabled) {
        document.execCommand("delete");
        await typeHuman(field, title);
      } else document.execCommand("insertText", false, title);
      return;
    }
    if (HUMAN.enabled) {
      if (field.value) setNativeValue(field, "");
      await typeHuman(field, title);
    } else {
      field.select();
      document.execCommand("insertText", false, title);
    }
    if (field.value !== title) setNativeValue(field, title);
  }

  // ---------- body ----------

  // Written in Reddit's Markdown mode, then switched back to the rich text editor,
  // which renders **bold**, *italic* and lists.
  async function fillBody(body) {
    // Keep line breaks as in the CSV; only trim leading/trailing blank lines.
    body = (body || "").replace(/\r/g, "").replace(/^\n+|\n+$/g, "");
    if (!body.trim()) return "";
    // Body editor host: shreddit-composer[name="body"] (older builds: #post-composer_bodytext).
    const bodyHost = () =>
      document.querySelector('shreddit-composer[name="body"], #post-composer_bodytext');
    const composer = () => bodyHost()?.shadowRoot;

    const toMarkdown = await waitFor(() =>
      document
        .querySelector("#post-composer-toolbar-portal rte-toolbar")
        ?.shadowRoot?.querySelector('rpl-menu-item[aria-label="Switch to Markdown"]')
    );
    if (!toMarkdown) throw new Error('"Switch to Markdown" not found');
    toMarkdown.click();

    // shreddit-composer > #shadow-root > shreddit-markdown-composer > #shadow-root > textarea.
    // Only ever look inside the body editor, never the whole page (the header search is a textarea too).
    const textarea = await waitFor(() => {
      const host = bodyHost();
      if (!host) return null;
      const el =
        composer()
          ?.querySelector("shreddit-markdown-composer")
          ?.shadowRoot?.querySelector('textarea[part="textarea-input"]') ||
        deepOne(host, "shreddit-markdown-composer textarea, textarea");
      return el && isVisible(el) ? el : null;
    });
    if (!textarea) throw new Error("Markdown text box not found");
    textarea.focus();
    if (textarea.value) setNativeValue(textarea, "");

    // Markdown joins single line breaks, so mark them as hard breaks (two trailing spaces).
    const markdown = body.replace(/([^\n])\n(?!\n)/g, "$1  \n");
    let how = "filled";
    if (HUMAN.enabled && markdown.length <= HUMAN.maxTypedBodyChars) {
      const ok = await typeHuman(textarea, markdown);
      how = ok && textarea.value === markdown ? "typed" : "typed (re-filled cleanly after a typing glitch)";
    }
    if (textarea.value !== markdown) setNativeValue(textarea, markdown);
    await sleep(300);
    await humanPause(HUMAN.stepPause);

    const toRichText = await waitFor(() => {
      const host = bodyHost();
      const el = host && deepOne(host, 'button[aria-label="Switch to Rich Text Editor"]');
      return el && isVisible(el) ? el : null;
    });
    if (!toRichText) throw new Error('"Switch to Rich Text Editor" not found');
    toRichText.click();

    const landed = await waitFor(() => {
      const el = bodyHost()?.querySelector('div[slot="rte"][contenteditable="true"]');
      return el && isVisible(el) && el.innerText.trim();
    });
    if (!landed) throw new Error("Body text did not stick in the editor");
    return `${how} via Markdown mode`;
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
    await humanPause(HUMAN.stepPause);
    const gotDate = await setPicker(date, wantDate);
    await humanPause(HUMAN.stepPause);
    const gotTime = await setPicker(time, wantTime);
    if (gotDate !== wantDate || gotTime !== wantTime) {
      throw new Error(`Schedule fields rejected the value (wanted ${wantDate} ${wantTime}, got ${gotDate} ${gotTime})`);
    }

    const root = findDialog(date) || document;
    const save = deepOne(root, 'button[data-testid="save-button"]');
    if (!save) throw new Error('Schedule modal "Save" button not found');
    if (save.disabled || save.getAttribute("aria-disabled") === "true") throw new Error("Schedule Save button is disabled — time may be invalid or in the past");
    await humanPause(HUMAN.stepPause);
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
      const t0 = Date.now();
      await humanPause(HUMAN.stepPause);
      await fillTitle(job.title);
      log.push("title filled");
      if (job.body) {
        await humanPause(HUMAN.stepPause);
        const how = await fillBody(job.body);
        if (how) log.push(`body ${how}`);
      }
      await humanPause(HUMAN.stepPause);
      const s = await setSchedule(when);
      if (HUMAN.enabled) log.push(`human pacing: ${Math.round((Date.now() - t0) / 1000)}s to fill`);
      log.push(`schedule set (date "${s.shownDate}", time "${s.shownTime}"${s.confirmed ? `, confirmed via "${s.confirmed}"` : ", no confirm button found"})`);
      if (!job.submit) return { ok: true, stage: "filled", log };
      await humanPause(HUMAN.stepPause);
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
