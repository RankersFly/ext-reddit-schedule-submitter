# Reddit Schedule Submitter

A Chrome extension (Manifest V3) that bulk-schedules Reddit posts from a CSV file.
It fills Reddit's own post composer and uses Reddit's built-in **Schedule Post** feature,
one row at a time. There's no API key and no third-party server: it runs in your browser
with your normal Reddit login.

Built for subreddits where scheduled posting is available. Typically that means
communities you moderate.

## Features

- Load a CSV of posts (`title`, `body`, `date`, `time`) by file picker or drag-and-drop
- Fills the title and rich-text body, opens the schedule picker, sets the date and time, and clicks **Schedule**
- Configurable delay between posts
- **Test mode** (on by default): fills one row and sets the schedule, but never submits
- Confirms each post was accepted before moving on; stops on the first failure so nothing gets posted twice
- Saves per-row status, so you can stop and resume and rows already done are skipped
- Dashboard with progress, coloured status labels, an activity log and a light/dark theme
- **Inspect** tool that dumps the submit page's structure, for fixing selectors after Reddit changes its UI

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the extension and click its icon to open the dashboard

After editing any file, click the reload icon on the extension card and refresh the dashboard tab.

## Build

You need Node.js 22 or newer. Run `npm install` once to get the dev tools (esbuild and
javascript-obfuscator).

| Command                         | What it does                                                              |
|---------------------------------|---------------------------------------------------------------------------|
| `npm run check`                 | Validates the manifest and referenced files, checks JS syntax and version sync |
| `npm run build`                 | **Production.** Minifies JS, CSS and HTML into `dist/reddit-schedule-submitter/`, smoke-tests the output, and creates `dist/reddit-schedule-submitter-v<version>.zip`. Allowed on the Chrome Web Store |
| `npm run build:protected`       | Production **plus obfuscation** of `content.js` and `background.js` (encoded strings, flattened control flow). Output gets a `-protected` suffix. **Not allowed on the Chrome Web Store**: use it for private installs only |
| `npm run build:dev`             | Readable copy in `dist/reddit-schedule-submitter-dev/`, no zip            |
| `npm run bump -- minor`         | Bumps the version (`patch` by default, or `minor` / `major`) in `manifest.json` and `package.json` |
| `npm run release -- minor`      | Bumps the version, then builds                                            |
| `npm run clean`                 | Deletes `dist/`                                                           |

The package contains only what the extension needs at runtime: `manifest.json`, the JS
and HTML files, and `icons/`. Sample CSVs, docs and build scripts are left out. You can
upload the zip to the Chrome Web Store, or unzip it and load it with **Load unpacked**.

During development you can still load the project folder itself unpacked; you don't need
to build first.

`dashboard.js` is always minified, never obfuscated. It passes functions to
`chrome.scripting.executeScript`, which turns them into text and runs them inside the
Reddit page. The obfuscator would make those functions call helpers that exist only in
the dashboard, so they would fail on Reddit.

## CSV format

| Column      | Required | Format                                       |
|-------------|----------|----------------------------------------------|
| `title`     | yes      | Up to 300 characters                         |
| `body`      | no       | Text or Markdown; blank lines make paragraphs |
| `date`      | yes      | `YYYY-MM-DD` or `MM/DD/YYYY`                 |
| `time`      | yes      | `HH:mm` (24h) or `h:mm AM/PM`                |
| `subreddit` | no       | Overrides the dashboard's subreddit per row  |

Times are interpreted in **your computer's local time zone**, which is the same zone
Reddit's schedule dialog shows.

Wrap a field in double quotes if it contains commas or line breaks. Write a literal
quote as `""`.

```csv
title,body,date,time
"Welcome to the sub!","First paragraph.

Second paragraph, with a comma.",2026-10-25,09:30
Weekly thread #1,Drop your questions below.,10/26/2026,2:00 PM
```

Sample files: `sample.csv` (2 rows), `sample-20.csv` (20 rows) and `sample-formatted.csv` (5 rows covering bold, italic and lists).

## Usage

1. Enter the subreddit (without `r/`) and load your CSV
2. Check the queue: rows with problems (bad date, past time, empty title) are marked **invalid** and skipped
3. With **Test mode** on, press **Start**. Check the Reddit window: the title, body and schedule should be filled in
4. Turn Test mode off and press **Start** to schedule everything

Keep the dashboard tab visible while it runs, because Chrome slows down timers in hidden tabs.

## Row statuses

| Status        | Meaning                                                                |
|---------------|------------------------------------------------------------------------|
| `pending`     | Not attempted yet                                                      |
| `invalid`     | Row data is bad; skipped                                               |
| `running`     | Being filled right now                                                 |
| `filled`      | Test mode: filled and scheduled in the form, not submitted             |
| `done`        | Reddit accepted the scheduled post                                     |
| `failed`      | An error at some step; the reason is shown                             |
| `unconfirmed` | Clicked Schedule, but no success signal within 40s: check Reddit       |

Statuses are stored in `chrome.storage.local`, keyed by a hash of subreddit, title, date
and time. A row counts as **done** when, after Schedule is clicked, the page leaves
`/submit` or the form is cleared, with no error shown in Reddit's error list under the
submit button. Any `failed` or `unconfirmed` row stops the run.

**Reset** clears all statuses after a confirmation. Rows that were done will be
scheduled again on the next Start, and nothing on Reddit is cancelled.

## How it works

```
dashboard.html / dashboard.js   UI, CSV parsing, queue runner, status storage
        │  opens a Reddit window, injects content.js per row
        ▼
content.js                      runs on reddit.com/r/<sub>/submit
   1. title  → post-composer-title (shadow DOM textarea)
   2. body   → shreddit-composer Lexical editor (typed in Markdown mode, then switched back)
   3. clock  → #date-picker-button > shadow > button
   4. modal  → shreddit-date-input[name=publish-at-date]   (YYYY-MM-DD)
              shreddit-time-input[name=publish-at-time]    (HH:mm)
              button[data-testid=save-button]
   5. submit → #submit-post-button, only if its label says "Schedule"
background.js                   opens the dashboard when the toolbar icon is clicked
```

Reddit's composer is built from web components, so `content.js` searches through open
shadow roots.

## Safety

- It never clicks the submit button unless it says **Schedule**, so a schedule that didn't apply can't turn into an immediate post
- It stops on the first failed or unconfirmed row
- Test mode is on by default

## Limitations

- Post flair isn't set. If the subreddit requires flair, the Schedule button stays disabled and the row fails
- Use Markdown for body formatting (`**bold**`, `*italic*`, `- ` bullets, `1. ` lists). A CSV can't store Excel or Google Sheets cell formatting
- Text posts only: no images, links or galleries
- It depends on Reddit's current page structure. If Reddit changes it, use **Inspect submit page** and update the selectors in `content.js`
- Use it in line with Reddit's rules and each subreddit's rules

## Project structure

```
manifest.json     extension manifest (MV3)
background.js     toolbar click → dashboard tab
dashboard.html    dashboard UI
dashboard.js      CSV parsing, runner, statuses
content.js        Reddit form automation
icons/            16/32/48/128 px icons
scripts/build.mjs build, check, bump, clean (no dependencies)
package.json      npm scripts and version
sample.csv        2-row example
sample-20.csv     20-row example
```
