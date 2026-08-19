/**
 * Renders `docs/manuals/*.md` into standalone, shareable HTML documents in
 * `docs/manuals/html/`.
 *
 * ## Why this exists rather than a markdown dependency
 *
 * The manuals are handed to a customer's administrator when their organization
 * is onboarded — by email, on a USB stick, printed. That deliverable is a single
 * file that opens in any browser with no server, no build step and no network
 * (fonts fall back cleanly offline). Adding a markdown toolchain to the
 * workspace to produce four static files would be the larger cost of the two,
 * and this converter only has to handle the constructs these four documents
 * actually use — headings, tables, fences, lists, checklists, quotes and inline
 * marks — all of which are ours and stay that way.
 *
 * ## What it guarantees
 *
 * - Heading ids match GitHub's slugs, so the anchors written in the markdown
 *   (`#12-glossary`) resolve in the HTML too.
 * - Links between manuals become `.html` links; links out to the spec suite keep
 *   their `.md` target and gain the `../` the extra folder costs them.
 * - Every page carries its own stylesheet and script. Nothing is fetched except
 *   the two Google Fonts, which degrade to the declared fallbacks.
 *
 * Run: `npm run manuals:html`
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'docs', 'manuals');
const OUT = join(SRC, 'html');

/**
 * The document set. `code` is the controlled-document number that appears in
 * each header — these manuals are issued to customers, and an issued document
 * that cannot be cited by number is one nobody can ask a question about.
 */
const DOCS = [
  {
    file: 'founder-guide.md',
    code: 'PO-IAM-00',
    title: "Founder's Guide",
    audience: 'For the product owner',
    blurb:
      'What PlantOps IAM is, in plain English: the one idea it is built on, how a customer is onboarded, what exists today and what does not.',
  },
  {
    file: 'platform-admin-manual.md',
    code: 'PO-IAM-01',
    title: 'Platform Administrator Manual',
    audience: 'For the PlantOps operations team',
    blurb:
      'Registering applications, onboarding an organization, enabling modules, creating their first administrator, and reading the global audit trail.',
  },
  {
    file: 'client-admin-manual.md',
    code: 'PO-IAM-02',
    title: 'Client Administrator Manual',
    audience: "For the customer's administrator",
    blurb:
      'The manual to hand over at onboarding: build your org structure, create roles, add people, and grant access at exactly the right places.',
  },
  {
    file: 'developer-manual.md',
    code: 'PO-IAM-03',
    title: 'Developer Manual',
    audience: 'For engineers',
    blurb:
      'Architecture, the request pipeline, the invariants that must not break, and how to build an application on top without writing authorization code.',
  },
];

// ── markdown → html ──────────────────────────────────────────────────────────

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

/** Manual-to-manual links become `.html`; everything else climbs out of `html/`. */
function rewriteLink(href) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path, hash = ''] = href.split('#');
  const anchor = hash ? `#${hash}` : '';
  if (path.startsWith('../')) return `../${path}${anchor}`;
  if (path === 'README.md') return `index.html${anchor}`;
  if (path.endsWith('.md')) return `${path.replace(/\.md$/, '.html')}${anchor}`;
  return `${path}${anchor}`;
}

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, href) => `<a href="${escapeHtml(rewriteLink(href))}">${label}</a>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(—])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

const LIST_START = /^\s{0,3}([-*]|\d+\.)\s+/;
const isBlockStart = (l) =>
  !l.trim() ||
  l.startsWith('```') ||
  /^#{1,4}\s/.test(l) ||
  /^-{3,}\s*$/.test(l) ||
  l.startsWith('|') ||
  /^>\s?/.test(l) ||
  LIST_START.test(l);

/**
 * @param {string[]} lines
 * @param {{headings: {level: number, text: string, id: string}[]}} ctx
 */
function renderBlocks(lines, ctx) {
  const out = [];
  let i = 0;

  const nextNonBlank = (from) => {
    let j = from;
    while (j < lines.length && !lines[j].trim()) j++;
    return j;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // fenced code
    if (line.startsWith('```')) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(`<div class="scroll-x"><pre><code>${escapeHtml(body.join('\n'))}</code></pre></div>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const raw = h[2].trim();
      const id = slug(raw);
      if (level === 2 || level === 3) ctx.headings.push({ level, text: raw.replace(/`/g, ''), id });
      out.push(`<h${level} id="${id}">${inline(raw)}</h${level}>`);
      i++;
      continue;
    }

    // rule
    if (/^-{3,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // table
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (row) =>
        row
          .replace(/^\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      const th = head.map((c) => `<th scope="col">${inline(c)}</th>`).join('');
      const tb = body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(
        `<div class="scroll-x"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`,
      );
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<aside class="note">${renderBlocks(body, ctx)}</aside>`);
      continue;
    }

    // list
    if (LIST_START.test(line)) {
      const buf = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          const j = nextNonBlank(i);
          if (j < lines.length && (LIST_START.test(lines[j]) || /^\s{2,}\S/.test(lines[j]))) {
            buf.push('');
            i++;
            continue;
          }
          break;
        }
        if (LIST_START.test(l) || /^\s{2,}\S/.test(l)) {
          buf.push(l);
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(buf, ctx));
      continue;
    }

    // paragraph
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

function renderList(buf, ctx) {
  const ordered = /^\s{0,3}\d+\./.test(buf[0]);
  const items = [];
  let current = null;

  // A continuation line is dedented by the item's own content offset — marker
  // indent plus marker plus its space — so a nested bullet's wrapped lines stay
  // inside the nested list instead of escaping into a paragraph of their own.
  let pad = 2;
  for (const l of buf) {
    const m = l.match(/^(\s{0,1})([-*]|\d+\.)\s+(.*)$/);
    if (m) {
      if (current) items.push(current);
      pad = m[1].length + m[2].length + 1;
      current = [m[3]];
    } else if (current) {
      current.push(l.startsWith(' '.repeat(pad)) ? l.slice(pad) : l.trimStart());
    }
  }
  if (current) items.push(current);

  let checklist = false;
  const rendered = items.map((itemLines) => {
    let lines = itemLines.slice();
    let boxed = '';
    const box = lines[0].match(/^\[( |x|X)\]\s+(.*)$/);
    if (box) {
      checklist = true;
      boxed = box[1].trim() ? 'done' : 'todo';
      lines[0] = box[2];
    }
    let html = renderBlocks(lines, ctx);
    // a single-paragraph item reads better unwrapped
    const single = html.match(/^<p>([\s\S]*)<\/p>$/);
    if (single && !single[1].includes('<p>')) html = single[1];
    return boxed
      ? `<li class="check"><span class="box ${boxed}" aria-hidden="true"></span><span>${html}</span></li>`
      : `<li>${html}</li>`;
  });

  const tag = ordered ? 'ol' : 'ul';
  const cls = checklist ? ' class="checklist"' : '';
  return `<${tag}${cls}>${rendered.join('')}</${tag}>`;
}

// ── page template ────────────────────────────────────────────────────────────

const STYLE = `
:root {
  color-scheme: light;
  --paper: #f3f5f7;
  --surface: #ffffff;
  --ink: #0f1720;
  --ink-2: #39434f;
  --muted: #6a7481;
  --rule: #dbe1e7;
  --rule-strong: #c2cad3;
  --accent: #17557f;
  --accent-ink: #0f3d5d;
  --accent-soft: #e6eff5;
  --signal: #8f5b06;
  --signal-soft: #f8f0df;
  --shadow: 0 1px 2px rgba(15, 23, 32, .05), 0 12px 32px -20px rgba(15, 23, 32, .35);

  --font-display: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --font-body: "Source Serif 4", Georgia, "Times New Roman", serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;

  --measure: 68ch;
  --rail: 18rem;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #0c1116;
    --surface: #131a21;
    --ink: #e3e9ef;
    --ink-2: #b6c1cc;
    --muted: #87939f;
    --rule: #232e37;
    --rule-strong: #33414d;
    --accent: #78badd;
    --accent-ink: #a8d5ef;
    --accent-soft: #122a38;
    --signal: #dfa847;
    --signal-soft: #241d0f;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 16px 40px -24px rgba(0, 0, 0, .8);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #0c1116;
  --surface: #131a21;
  --ink: #e3e9ef;
  --ink-2: #b6c1cc;
  --muted: #87939f;
  --rule: #232e37;
  --rule-strong: #33414d;
  --accent: #78badd;
  --accent-ink: #a8d5ef;
  --accent-soft: #122a38;
  --signal: #dfa847;
  --signal-soft: #241d0f;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 16px 40px -24px rgba(0, 0, 0, .8);
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; scroll-padding-top: 5rem; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 1.0625rem;
  line-height: 1.68;
  font-synthesis-weight: none;
}

/* ── chrome ─────────────────────────────────────────────── */
.topbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: 1rem;
  padding: .7rem clamp(1rem, 4vw, 2.5rem);
  background: color-mix(in srgb, var(--paper) 86%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--rule);
  font-family: var(--font-display);
}
.mark {
  display: flex; align-items: baseline; gap: .55rem;
  font-weight: 600; letter-spacing: -.01em; color: var(--ink); text-decoration: none;
}
.mark .dot {
  width: .5rem; height: .5rem; border-radius: 1px; background: var(--accent);
  transform: translateY(-.1rem);
}
.mark .sub { font-family: var(--font-mono); font-size: .72rem; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.topbar .spacer { flex: 1; }
.btn {
  font-family: var(--font-mono); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase;
  color: var(--ink-2); background: transparent;
  border: 1px solid var(--rule-strong); border-radius: 2px;
  padding: .38rem .6rem; cursor: pointer;
}
.btn:hover { border-color: var(--accent); color: var(--accent-ink); }
.btn:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.layout {
  display: grid;
  grid-template-columns: var(--rail) minmax(0, 1fr);
  gap: clamp(1.5rem, 4vw, 3.5rem);
  max-width: 78rem;
  margin: 0 auto;
  padding: 2.5rem clamp(1rem, 4vw, 2.5rem) 6rem;
}
@media (max-width: 60rem) { .layout { grid-template-columns: minmax(0, 1fr); } }

/* ── rail ───────────────────────────────────────────────── */
.rail { position: sticky; top: 4.5rem; align-self: start; max-height: calc(100vh - 6rem); overflow-y: auto; font-family: var(--font-display); }
@media (max-width: 60rem) { .rail { position: static; max-height: none; border-bottom: 1px solid var(--rule); padding-bottom: 1.5rem; } }
.rail h2 {
  font-family: var(--font-mono); font-size: .7rem; letter-spacing: .14em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 .7rem; border: 0; padding: 0;
}
.rail nav { display: flex; flex-direction: column; gap: .1rem; margin-bottom: 2rem; }
.rail nav a {
  display: flex; gap: .55rem; align-items: baseline;
  padding: .3rem .5rem .3rem .55rem;
  color: var(--ink-2); text-decoration: none; font-size: .875rem; line-height: 1.4;
  border-left: 2px solid transparent;
}
.rail nav a .code { flex: none; white-space: nowrap; font-family: var(--font-mono); font-size: .68rem; color: var(--muted); letter-spacing: .04em; }
.rail nav a:hover { color: var(--accent-ink); background: var(--accent-soft); }
.rail nav a[aria-current="page"] { color: var(--ink); font-weight: 600; border-left-color: var(--accent); background: var(--accent-soft); }
.toc a { display: block; padding: .22rem 0 .22rem .8rem; border-left: 1px solid var(--rule); color: var(--muted); text-decoration: none; font-size: .82rem; line-height: 1.45; }
.toc a.l3 { padding-left: 1.6rem; font-size: .78rem; }
.toc a:hover { color: var(--accent-ink); border-left-color: var(--rule-strong); }
.toc a.active { color: var(--ink); border-left-color: var(--accent); }

/* ── document ───────────────────────────────────────────── */
.doc { max-width: var(--measure); }
.doc-head { border-bottom: 2px solid var(--ink); padding-bottom: 1.4rem; margin-bottom: 2.5rem; }
.doc-meta {
  display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; align-items: baseline;
  font-family: var(--font-mono); font-size: .72rem; letter-spacing: .12em; text-transform: uppercase; color: var(--muted);
  margin-bottom: 1rem;
}
.doc-meta .code { color: var(--accent-ink); }
.doc h1 {
  font-family: var(--font-display); font-weight: 600; letter-spacing: -.022em;
  font-size: clamp(2rem, 5vw, 2.7rem); line-height: 1.1; margin: 0; text-wrap: balance;
}
.doc-head p { margin: .9rem 0 0; color: var(--ink-2); font-size: 1.1rem; }

.doc h2 {
  font-family: var(--font-display); font-weight: 600; letter-spacing: -.015em;
  font-size: 1.55rem; line-height: 1.22; margin: 3.2rem 0 1rem;
  padding-top: 1.4rem; border-top: 1px solid var(--rule); text-wrap: balance;
}
.doc h3 {
  font-family: var(--font-display); font-weight: 600; font-size: 1.1rem;
  margin: 2.2rem 0 .6rem; letter-spacing: -.005em; text-wrap: balance;
}
.doc h4 { font-family: var(--font-display); font-size: .98rem; margin: 1.6rem 0 .4rem; }
.doc p { margin: 0 0 1.1rem; }
.doc a { color: var(--accent-ink); text-decoration-thickness: 1px; text-underline-offset: 2px; }
.doc strong { font-weight: 700; color: var(--ink); }
.doc hr { border: 0; border-top: 1px solid var(--rule); margin: 2.6rem 0; }
/* the markdown rules a line before each section and h2 rules one of its own;
   one line is the intent, so the heading yields when it follows a rule */
.doc hr + h2 { border-top: 0; padding-top: 0; margin-top: 1.7rem; }
.doc ul, .doc ol { margin: 0 0 1.2rem; padding-left: 1.35rem; }
.doc li { margin: 0 0 .5rem; }
.doc li > ul, .doc li > ol { margin: .5rem 0 0; }
.doc ol { list-style: none; counter-reset: step; padding-left: 0; }
.doc ol > li { counter-increment: step; padding-left: 2.1rem; position: relative; }
.doc ol > li::before {
  content: counter(step);
  position: absolute; left: 0; top: .12rem;
  font-family: var(--font-mono); font-size: .78rem; color: var(--accent-ink);
  background: var(--accent-soft); border-radius: 2px;
  min-width: 1.45rem; height: 1.45rem; display: grid; place-items: center;
}
.doc ol ol > li::before { background: transparent; color: var(--muted); }
.checklist { list-style: none; padding-left: 0; }
.checklist li.check { display: flex; gap: .65rem; align-items: flex-start; padding-left: 0; }
.checklist .box {
  flex: none; width: .85rem; height: .85rem; margin-top: .42rem;
  border: 1px solid var(--rule-strong); border-radius: 2px; background: var(--surface);
}

.doc code {
  font-family: var(--font-mono); font-size: .855em;
  background: var(--accent-soft); color: var(--accent-ink);
  padding: .08em .32em; border-radius: 2px;
  overflow-wrap: anywhere;
}
.doc pre {
  margin: 0; padding: 1rem 1.15rem;
  background: var(--surface); border: 1px solid var(--rule); border-left: 2px solid var(--rule-strong);
  border-radius: 2px; overflow-x: auto;
}
.doc pre code { background: none; color: var(--ink-2); font-size: .82rem; line-height: 1.6; padding: 0; }
.scroll-x { overflow-x: auto; margin: 0 0 1.4rem; }
/* running text keeps its measure; a diagram or a wide table borrows the
   gutter the rail leaves empty rather than scrolling for the sake of it */
@media (min-width: 62rem) { .doc .scroll-x { width: calc(100% + 9rem); } }

.doc table {
  border-collapse: collapse; width: 100%; min-width: 34rem;
  font-family: var(--font-display); font-size: .875rem; line-height: 1.5;
  font-variant-numeric: tabular-nums;
}
.doc thead th {
  text-align: left; vertical-align: bottom;
  font-family: var(--font-mono); font-weight: 500; font-size: .68rem;
  letter-spacing: .1em; text-transform: uppercase; color: var(--muted);
  padding: 0 1rem .5rem 0; border-bottom: 1px solid var(--rule-strong);
}
.doc tbody td { padding: .7rem 1rem .7rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; color: var(--ink-2); }
.doc tbody tr:last-child td { border-bottom: 0; }
.doc tbody td:first-child { color: var(--ink); }
.doc table code { background: none; padding: 0; color: var(--accent-ink); overflow-wrap: normal; }

.note {
  margin: 0 0 1.4rem; padding: .9rem 1.15rem;
  background: var(--signal-soft); border-left: 2px solid var(--signal);
  border-radius: 0 2px 2px 0;
}
.note > *:last-child { margin-bottom: 0; }
.note p { font-size: .98rem; }

/* ── index cover ────────────────────────────────────────── */
.cover-lede { font-size: 1.2rem; color: var(--ink-2); max-width: 48ch; }
.cards { display: grid; gap: 1px; background: var(--rule); border: 1px solid var(--rule); margin: 2.5rem 0; }
.card {
  display: grid; gap: .45rem; padding: 1.4rem 1.5rem; background: var(--surface);
  text-decoration: none; color: inherit;
}
.card:hover { background: var(--accent-soft); }
.card .code { font-family: var(--font-mono); font-size: .68rem; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.card h2 { font-family: var(--font-display); font-size: 1.25rem; font-weight: 600; margin: 0; border: 0; padding: 0; letter-spacing: -.015em; }
.card .who { font-family: var(--font-display); font-size: .82rem; color: var(--accent-ink); }
.card p { margin: .2rem 0 0; font-size: .95rem; color: var(--ink-2); }
.triad {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px;
  background: var(--rule); border: 1px solid var(--rule); margin: 2rem 0 2.5rem;
}
.triad div { background: var(--surface); padding: 1.1rem 1.2rem; }
.triad dt { font-family: var(--font-mono); font-size: .7rem; letter-spacing: .14em; text-transform: uppercase; color: var(--accent-ink); margin-bottom: .35rem; }
.triad dd { margin: 0; font-size: .92rem; color: var(--ink-2); font-family: var(--font-display); }
@media (max-width: 40rem) { .triad { grid-template-columns: minmax(0, 1fr); } }

.foot {
  margin-top: 4rem; padding-top: 1.2rem; border-top: 1px solid var(--rule);
  font-family: var(--font-mono); font-size: .7rem; letter-spacing: .08em;
  text-transform: uppercase; color: var(--muted);
  display: flex; flex-wrap: wrap; gap: .5rem 1.5rem;
}

/* ── print ──────────────────────────────────────────────── */
@media print {
  /* repeated so the print palette outranks the dark-theme tokens above
     (:root:not([data-theme="light"])) — otherwise a machine in dark mode
     prints light text onto white paper */
  :root:root:root { --paper: #fff; --surface: #fff; --ink: #000; --ink-2: #1a1a1a; --muted: #555;
          --rule: #ccc; --rule-strong: #999; --accent: #000; --accent-ink: #000;
          --accent-soft: #f2f2f2; --signal: #666; --signal-soft: #f6f6f6; }
  .topbar, .rail { display: none; }
  .layout { display: block; max-width: none; padding: 0; }
  .doc { max-width: none; }
  .doc h2 { break-after: avoid; }
  .doc table, .note, pre { break-inside: avoid; }
  .doc a { color: #000; text-decoration: none; }
}
`;

const SCRIPT = `
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('plantops-manual-theme'); } catch (e) {}
  if (saved) root.setAttribute('data-theme', saved);

  var toggle = document.getElementById('theme');
  if (toggle) toggle.addEventListener('click', function () {
    var dark = root.getAttribute('data-theme') === 'dark' ||
      (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    var next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('plantops-manual-theme', next); } catch (e) {}
  });

  var print = document.getElementById('print');
  if (print) print.addEventListener('click', function () { window.print(); });

  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  var seen = [];
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var id = entry.target.id;
      var at = seen.indexOf(id);
      if (entry.isIntersecting) { if (at < 0) seen.push(id); }
      else if (at >= 0) seen.splice(at, 1);
    });
    links.forEach(function (a) { a.classList.remove('active'); });
    var current = seen[0];
    if (current && byId[current]) byId[current].classList.add('active');
  }, { rootMargin: '-72px 0px -70% 0px' });
  Object.keys(byId).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) observer.observe(el);
  });
})();
`;

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' +
  'family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&' +
  'family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap">';

function docNav(currentFile) {
  const items = [
    { file: 'README.md', code: '—', title: 'Contents' },
    ...DOCS.map((d) => ({ file: d.file, code: d.code, title: d.title })),
  ];
  return items
    .map((d) => {
      const href = d.file === 'README.md' ? 'index.html' : d.file.replace(/\.md$/, '.html');
      const current = d.file === currentFile ? ' aria-current="page"' : '';
      return `<a href="${href}"${current}><span class="code">${escapeHtml(d.code)}</span><span>${escapeHtml(d.title)}</span></a>`;
    })
    .join('');
}

function page({ file, title, code, audience, issued, body, headings, lede }) {
  const toc = headings.length
    ? `<h2>On this page</h2><nav class="toc">${headings
        .map((h) => `<a class="l${h.level}" href="#${h.id}">${escapeHtml(h.text)}</a>`)
        .join('')}</nav>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · PlantOps</title>
<meta name="description" content="${escapeHtml(lede)}">
${FONTS}
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
  <a class="mark" href="index.html"><span class="dot"></span>PlantOps <span class="sub">IAM Manuals</span></a>
  <span class="spacer"></span>
  <button class="btn" id="print" type="button">Print</button>
  <button class="btn" id="theme" type="button">Theme</button>
</header>
<div class="layout">
  <aside class="rail">
    <h2>Manuals</h2>
    <nav>${docNav(file)}</nav>
    ${toc}
  </aside>
  <main class="doc">
    <div class="doc-head">
      <div class="doc-meta"><span class="code">${escapeHtml(code)}</span><span>${escapeHtml(audience)}</span><span>Issued ${escapeHtml(issued)}</span></div>
      <h1>${escapeHtml(title)}</h1>
      <p>${inline(lede)}</p>
    </div>
${body}
    <div class="foot"><span>PlantOps IAM</span><span>${escapeHtml(code)}</span><span>Issued ${escapeHtml(issued)}</span></div>
  </main>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ── build ────────────────────────────────────────────────────────────────────

const issued = new Date().toLocaleDateString('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

mkdirSync(OUT, { recursive: true });

for (const doc of DOCS) {
  const md = readFileSync(join(SRC, doc.file), 'utf8').split(/\r?\n/);

  // The markdown opens with its own H1 and a bold who/what pair; the HTML header
  // band carries those, so they are lifted out rather than repeated.
  let start = 0;
  while (start < md.length && !/^#\s/.test(md[start])) start++;
  start++;
  const ctx = { headings: [] };
  const body = renderBlocks(md.slice(start), ctx);

  writeFileSync(
    join(OUT, doc.file.replace(/\.md$/, '.html')),
    page({
      file: doc.file,
      title: doc.title,
      code: doc.code,
      audience: doc.audience,
      issued,
      body,
      headings: ctx.headings,
      lede: doc.blurb,
    }),
    'utf8',
  );
}

// The cover is authored here rather than rendered from README.md: the repo index
// is a table for people already in the repository, and the shared pack opens
// with something a customer's administrator can read cold.
const cover = `
<div class="doc-head">
  <div class="doc-meta"><span class="code">PO-IAM</span><span>Documentation pack</span><span>Issued ${escapeHtml(issued)}</span></div>
  <h1>PlantOps IAM Manuals</h1>
  <p class="cover-lede">Four manuals covering the identity and access system behind every PlantOps application — one for each person who has to work with it.</p>
</div>
<p>PlantOps IAM is the security office for a family of plant applications: gate passes, visitors, meeting rooms, vehicles, patrols. It answers one question, for every screen and every button in every one of them.</p>
<dl class="triad">
  <div><dt>Who</dt><dd>A person who signs in, or a program that does</dd></div>
  <div><dt>What</dt><dd>One precise ability, such as approving a gate pass</dd></div>
  <div><dt>Where</dt><dd>A place in your structure: a group, plant, department or gate</dd></div>
</dl>
<p>Access is granted as all three at once — <strong>this person, this role, at this place</strong> — and a grant at a place covers everything beneath it. That is the whole system; the manuals below are the detail.</p>
<div class="cards">
${DOCS.map((d) => {
  const href = d.file.replace(/\.md$/, '.html');
  return `  <a class="card" href="${href}">
    <span class="code">${escapeHtml(d.code)}</span>
    <h2>${escapeHtml(d.title)}</h2>
    <span class="who">${escapeHtml(d.audience)}</span>
    <p>${escapeHtml(d.blurb)}</p>
  </a>`;
}).join('\n')}
</div>
<p>Each manual stands on its own — you should never have to read another to finish a task in yours. Every page prints cleanly if you would rather work from paper.</p>
<div class="foot"><span>PlantOps IAM</span><span>PO-IAM</span><span>Issued ${escapeHtml(issued)}</span></div>
`;

writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PlantOps IAM Manuals</title>
<meta name="description" content="Four manuals covering the PlantOps identity and access system — founder, platform admin, client admin and developer.">
${FONTS}
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
  <a class="mark" href="index.html"><span class="dot"></span>PlantOps <span class="sub">IAM Manuals</span></a>
  <span class="spacer"></span>
  <button class="btn" id="print" type="button">Print</button>
  <button class="btn" id="theme" type="button">Theme</button>
</header>
<div class="layout">
  <aside class="rail">
    <h2>Manuals</h2>
    <nav>${docNav('README.md')}</nav>
  </aside>
  <main class="doc">${cover}</main>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`,
  'utf8',
);

const built = readdirSync(OUT).filter((f) => f.endsWith('.html')).sort();
console.log(`docs/manuals/html — ${built.length} files\n${built.map((f) => `  ${f}`).join('\n')}`);
