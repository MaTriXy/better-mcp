import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPreview,
  effectiveOffloadConfig,
  inferArrayInterface,
  makeOffloader,
  resolveOffloadConfig,
  slugifyHeading,
  splitMarkdownChapters,
  tryUnwrapTextContent,
} from "../offload.middleware.js";

// ============================================================================
// buildPreview — tabular / sample preview line for offloaded arrays
// ============================================================================

test("buildPreview: empty array returns null", () => {
  assert.equal(buildPreview([], 3), null);
});

test("buildPreview: maxRows=0 disables preview", () => {
  assert.equal(buildPreview([{ a: 1 }], 0), null);
  assert.equal(buildPreview([1, 2, 3], 0), null);
});

test("buildPreview: homogeneous object array renders as {cols,rows}", () => {
  const out = buildPreview(
    [
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
      { id: 3, name: "carol" },
    ],
    3,
  )!;
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.cols, ["id", "name"]);
  assert.deepEqual(parsed.rows, [
    [1, "alice"],
    [2, "bob"],
    [3, "carol"],
  ]);
});

test("buildPreview: respects maxRows by slicing", () => {
  const out = buildPreview([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], 2)!;
  const parsed = JSON.parse(out);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows, [[1], [2]]);
});

test("buildPreview: union of keys; missing fields rendered as null", () => {
  const out = buildPreview(
    [
      { id: 1, name: "a" },
      { id: 2, email: "b@x" },
    ],
    3,
  )!;
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.cols, ["id", "name", "email"]);
  assert.deepEqual(parsed.rows, [
    [1, "a", null],
    [2, null, "b@x"],
  ]);
});

test("buildPreview: primitive array renders as JSON sample", () => {
  assert.equal(buildPreview([1, 2, 3, 4, 5], 3), JSON.stringify([1, 2, 3]));
  assert.equal(buildPreview(["a", "b", "c"], 3), JSON.stringify(["a", "b", "c"]));
});

test("buildPreview: mixed-shape array renders as JSON sample (not tabular)", () => {
  const out = buildPreview([{ id: 1 }, "raw"], 3);
  assert.equal(out, JSON.stringify([{ id: 1 }, "raw"]));
});

test("buildPreview: array with null elements does not crash and renders as sample", () => {
  assert.equal(buildPreview([null, null], 3), JSON.stringify([null, null]));
});

test("buildPreview: array of arrays renders as JSON sample (arrays are not plain objects)", () => {
  const out = buildPreview([[1, 2], [3, 4]], 3);
  assert.equal(out, JSON.stringify([[1, 2], [3, 4]]));
});

test("buildPreview: oversize string cells are truncated with ellipsis", () => {
  const huge = "x".repeat(200);
  const out = buildPreview([{ blob: huge }], 1)!;
  const parsed = JSON.parse(out);
  assert.equal(parsed.rows[0][0].length, 80);
  assert.ok(parsed.rows[0][0].endsWith("…"));
});

test("buildPreview: nested object cells are stringified and capped", () => {
  const out = buildPreview([{ meta: { a: 1, b: 2 } }], 1)!;
  const parsed = JSON.parse(out);
  assert.equal(parsed.rows[0][0], '{"a":1,"b":2}');
});

test("buildPreview: nested object cells longer than cap get truncated", () => {
  const big: Record<string, number> = {};
  for (let i = 0; i < 30; i++) big[`field_${i}`] = i;
  const out = buildPreview([{ meta: big }], 1)!;
  const parsed = JSON.parse(out);
  assert.equal(parsed.rows[0][0].length, 80);
  assert.ok(parsed.rows[0][0].endsWith("…"));
});

test("buildPreview: rows with > 12 cols fall back to no preview (null)", () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < 13; i++) wide[`c${i}`] = i;
  assert.equal(buildPreview([wide], 1), null);
});

test("buildPreview: rows with exactly 12 cols still render", () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < 12; i++) wide[`c${i}`] = i;
  const out = buildPreview([wide], 1)!;
  const parsed = JSON.parse(out);
  assert.equal(parsed.cols.length, 12);
});

test("buildPreview: object with only inherited keys (none own) returns null", () => {
  assert.equal(buildPreview([{}], 1), null);
});

test("buildPreview: booleans, numbers, null pass through untouched", () => {
  const out = buildPreview([{ ok: true, n: 1.5, miss: null }], 1)!;
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.rows[0], [true, 1.5, null]);
});

test("buildPreview: tabular form is meaningfully smaller than raw JSON on wide tables", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i,
    title: `Title ${i}`,
    state: i % 2 ? "open" : "closed",
    assignee: `user_${i}`,
  }));
  const raw = JSON.stringify(rows);
  const preview = buildPreview(rows, 10)!;
  assert.ok(preview.length < raw.length, `tabular ${preview.length} should be < raw ${raw.length}`);
});

// ============================================================================
// inferArrayInterface — TypeScript-shape signature for offloaded arrays
// ============================================================================

test("inferArrayInterface: object array with mixed keys -> optional fields", () => {
  assert.equal(
    inferArrayInterface([{ id: 1, name: "x" }, { id: 2, name: "y", email: "a@b" }]),
    "Array<{ id: number; name: string; email?: string }>",
  );
});

test("inferArrayInterface: primitive union", () => {
  assert.equal(inferArrayInterface([1, "two", 3, null]), "Array<string | number | null>");
});

test("inferArrayInterface: empty array", () => {
  assert.equal(inferArrayInterface([]), "Array<unknown>");
});

test("inferArrayInterface: nested arrays + objects", () => {
  assert.equal(
    inferArrayInterface([{ tags: ["a", "b"], meta: { v: 1 } }]),
    "Array<{ tags: Array<string>; meta: { v: number } }>",
  );
});

// ============================================================================
// splitMarkdownChapters — H2-split with code-block awareness
// ============================================================================

test("splitMarkdownChapters: splits a doc on H2 headings", () => {
  const md = ["intro text", "more intro", "", "## First", "first body", "", "## Second", "body"].join("\n");
  const ch = splitMarkdownChapters(md);
  assert.equal(ch.length, 3);
  assert.equal(ch[0].heading, null);
  assert.equal(ch[1].heading, "First");
  assert.equal(ch[2].heading, "Second");
  assert.equal(ch[1].lines[0], "## First");
  assert.equal(ch[2].lines[0], "## Second");
});

test("splitMarkdownChapters: returns single chapter when there are no H2 headings", () => {
  const md = "just some text\nwith no headings\n";
  const ch = splitMarkdownChapters(md);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].heading, null);
});

test("splitMarkdownChapters: empty input yields zero chapters", () => {
  assert.equal(splitMarkdownChapters("").length, 0);
  assert.equal(splitMarkdownChapters("   \n\n  ").length, 0);
});

test("splitMarkdownChapters: intro chapter is dropped when text starts with `## ` immediately", () => {
  const md = "## First\nbody\n";
  const ch = splitMarkdownChapters(md);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].heading, "First");
});

test("splitMarkdownChapters: `## ` inside a fenced code block does NOT split", () => {
  const md = [
    "intro",
    "",
    "```",
    "## not a heading",
    "echo hello",
    "```",
    "",
    "## Real Heading",
    "real body",
  ].join("\n");
  const ch = splitMarkdownChapters(md);
  assert.equal(ch.length, 2);
  assert.equal(ch[0].heading, null);
  assert.equal(ch[1].heading, "Real Heading");
  assert.ok(ch[0].lines.includes("## not a heading"));
});

test("splitMarkdownChapters: `## ` inside a ~~~ fenced block also does NOT split", () => {
  const md = ["intro", "~~~", "## inside", "~~~", "## Real"].join("\n");
  const ch = splitMarkdownChapters(md);
  assert.equal(ch.length, 2);
  assert.equal(ch[1].heading, "Real");
});

test("splitMarkdownChapters: H3+ stays within parent chapter", () => {
  const md = ["## Parent", "### Sub", "body", "#### Sub-sub", "more"].join("\n");
  const ch = splitMarkdownChapters(md);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].lines.length, 5);
});

test("splitMarkdownChapters: CRLF line endings are normalized", () => {
  const md = "intro\r\n\r\n## First\r\nbody\r\n";
  const ch = splitMarkdownChapters(md);
  assert.equal(ch.length, 2);
  assert.equal(ch[1].heading, "First");
  for (const c of ch) for (const l of c.lines) assert.ok(!l.includes("\r"));
});

test("splitMarkdownChapters: heading text is trimmed", () => {
  const md = "##    Spaced Heading   \nbody";
  const ch = splitMarkdownChapters(md);
  assert.equal(ch[0].heading, "Spaced Heading");
});

// ============================================================================
// slugifyHeading
// ============================================================================

test("slugifyHeading: basic alphanumeric phrase", () => {
  assert.equal(slugifyHeading("First Chapter"), "first_chapter");
});

test("slugifyHeading: strips punctuation but keeps separation", () => {
  assert.equal(slugifyHeading("API: Reference & Notes!"), "api_reference_notes");
});

test("slugifyHeading: drops apostrophes without inserting underscores", () => {
  assert.equal(slugifyHeading("What's New?"), "whats_new");
  assert.equal(slugifyHeading("It’s Working"), "its_working");
});

test("slugifyHeading: strips combining diacritics via NFKD", () => {
  assert.equal(slugifyHeading("Café Owners"), "cafe_owners");
  assert.equal(slugifyHeading("Naïve Approach"), "naive_approach");
});

test("slugifyHeading: caps at 40 chars", () => {
  const s = slugifyHeading("a".repeat(100));
  assert.equal(s.length, 40);
});

test("slugifyHeading: falls back to 'chapter' when nothing usable remains", () => {
  assert.equal(slugifyHeading("???"), "chapter");
  assert.equal(slugifyHeading("你好"), "chapter");
  assert.equal(slugifyHeading(""), "chapter");
});

test("slugifyHeading: trims leading/trailing underscores", () => {
  assert.equal(slugifyHeading("!! Important !!"), "important");
});

// ============================================================================
// tryUnwrapTextContent
// ============================================================================

test("tryUnwrapTextContent: unwraps a single text-block wrapper", () => {
  const result = { content: [{ type: "text", text: "hello world" }] };
  assert.equal(tryUnwrapTextContent(result), "hello world");
});

test("tryUnwrapTextContent: returns null when content has multiple blocks", () => {
  const result = {
    content: [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
  };
  assert.equal(tryUnwrapTextContent(result), null);
});

test("tryUnwrapTextContent: returns null when content is not an array", () => {
  assert.equal(tryUnwrapTextContent({ content: "raw" }), null);
});

test("tryUnwrapTextContent: returns null when block type isn't text", () => {
  assert.equal(tryUnwrapTextContent({ content: [{ type: "image", data: "..." }] }), null);
});

test("tryUnwrapTextContent: returns null for non-object input", () => {
  assert.equal(tryUnwrapTextContent(null), null);
  assert.equal(tryUnwrapTextContent("hi"), null);
  assert.equal(tryUnwrapTextContent(42), null);
});

// ============================================================================
// effectiveOffloadConfig — per-tool / per-server overrides
// ============================================================================

const baseConfig = (perTool: Record<string, unknown> = {}) =>
  resolveOffloadConfig(
    { thresholdBytes: 16384, perTool: perTool as never, chapterMarkdown: true, previewRows: 3 },
    "/tmp",
  )!;

type Req = { server: string; kind: "tool" | "resource" | "prompt"; name: string; params: unknown };
const req = (server: string, name: string, kind: "tool" | "resource" | "prompt" = "tool"): Req => ({
  server,
  kind,
  name,
  params: {},
});

test("effectiveOffloadConfig: no perTool entries -> pass through unchanged", () => {
  const base = baseConfig();
  assert.equal(effectiveOffloadConfig(base, req("gh", "list")), base);
});

test("effectiveOffloadConfig: unmatched tool -> pass through unchanged", () => {
  const base = baseConfig({ "other-server__t": { thresholdBytes: 0 } });
  assert.equal(effectiveOffloadConfig(base, req("gh", "list")), base);
});

test("effectiveOffloadConfig: server__tool match merges overrides over base", () => {
  const base = baseConfig({ "gh__list": { thresholdBytes: 0 } });
  const out = effectiveOffloadConfig(base, req("gh", "list"))!;
  assert.notEqual(out, base);
  assert.equal(out.thresholdBytes, 0);
  assert.equal(out.chapterMarkdown, true);
  assert.equal(out.previewRows, 3);
});

test("effectiveOffloadConfig: whole-server match applies to every tool on that server", () => {
  const base = baseConfig({ "noisy": { thresholdBytes: 0 } });
  assert.equal(effectiveOffloadConfig(base, req("noisy", "tool_a"))!.thresholdBytes, 0);
  assert.equal(effectiveOffloadConfig(base, req("noisy", "tool_b"))!.thresholdBytes, 0);
  assert.equal(effectiveOffloadConfig(base, req("other", "tool_a")), base);
});

test("effectiveOffloadConfig: server__tool wins over whole-server when both match", () => {
  const base = baseConfig({
    "gh": { thresholdBytes: 1000 },
    "gh__list": { thresholdBytes: 5000 },
  });
  assert.equal(effectiveOffloadConfig(base, req("gh", "list"))!.thresholdBytes, 5000);
  assert.equal(effectiveOffloadConfig(base, req("gh", "other"))!.thresholdBytes, 1000);
});

test("effectiveOffloadConfig: `false` sentinel returns null (skip offload entirely)", () => {
  const base = baseConfig({ "gh__never": false });
  assert.equal(effectiveOffloadConfig(base, req("gh", "never")), null);
});

test("effectiveOffloadConfig: `false` at the whole-server level disables for every tool there", () => {
  const base = baseConfig({ "skip-me": false });
  assert.equal(effectiveOffloadConfig(base, req("skip-me", "a")), null);
  assert.equal(effectiveOffloadConfig(base, req("skip-me", "b")), null);
});

test("effectiveOffloadConfig: server__tool override can re-enable a server-disabled match", () => {
  const base = baseConfig({
    "skip-me": false,
    "skip-me__keep": { thresholdBytes: 0 },
  });
  assert.equal(effectiveOffloadConfig(base, req("skip-me", "other")), null);
  const on = effectiveOffloadConfig(base, req("skip-me", "keep"))!;
  assert.notEqual(on, null);
  assert.equal(on.thresholdBytes, 0);
});

test("effectiveOffloadConfig: object override can change chapterMarkdown / previewRows independently", () => {
  const base = baseConfig({ "gh__raw": { chapterMarkdown: false, previewRows: 0 } });
  const out = effectiveOffloadConfig(base, req("gh", "raw"))!;
  assert.equal(out.chapterMarkdown, false);
  assert.equal(out.previewRows, 0);
  assert.equal(out.thresholdBytes, 16384);
});

test("effectiveOffloadConfig: override doesn't mutate the base config object", () => {
  const base = baseConfig({ "gh__list": { thresholdBytes: 0 } });
  const snap = JSON.stringify({
    thresholdBytes: base.thresholdBytes,
    chapterMarkdown: base.chapterMarkdown,
    previewRows: base.previewRows,
  });
  effectiveOffloadConfig(base, req("gh", "list"));
  assert.equal(
    JSON.stringify({
      thresholdBytes: base.thresholdBytes,
      chapterMarkdown: base.chapterMarkdown,
      previewRows: base.previewRows,
    }),
    snap,
  );
});

// ============================================================================
// makeOffloader — end-to-end behaviors with a real temp dir
// ============================================================================

const smokeReq: Req = { server: "github", kind: "tool", name: "list_issues", params: {} };

test("makeOffloader: oversize JSON array offloads + emits length/interface/preview pointer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-mcp-test-"));
  const opts = resolveOffloadConfig({ thresholdBytes: 1024, dir }, dir)!;
  const offloader = makeOffloader(opts);

  const issues = Array.from({ length: 50 }, (_, i) => ({
    id: i,
    number: i + 1,
    title: `Issue ${i}`,
    state: i % 2 ? "open" : "closed",
    labels: i % 3 ? [{ name: "bug", color: "red" }] : [],
    assignee: i % 5 ? { login: `user${i}` } : null,
  }));
  const arrayResp = {
    result: { content: [{ type: "text", text: JSON.stringify(issues) }], isError: false },
    durationMs: 12,
  };
  const out = await offloader.after!(smokeReq, arrayResp);
  assert.ok(out, "expected offloader to replace oversize response");
  const text = (out.result as { content: { text: string }[] }).content[0].text;
  assert.match(text, /^response exported to: /m);
  assert.match(text, /^length: 50$/m);
  assert.match(text, /^interface: Array<\{/m);
  assert.match(text, /^preview: \{/m);

  // Confirm the persisted file is the PARSED array (not the wrapper).
  const m = /response exported to: (.*\.json)/.exec(text)!;
  const persisted = JSON.parse(await readFile(m[1], "utf8"));
  assert.ok(Array.isArray(persisted));
  assert.equal(persisted.length, 50);
  assert.equal(persisted[0].title, "Issue 0");
});

test("makeOffloader: oversize non-JSON text -> JSON wrapper saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-mcp-test-"));
  const opts = resolveOffloadConfig({ thresholdBytes: 1024, dir }, dir)!;
  const offloader = makeOffloader(opts);

  const blob = "x".repeat(3000); // no `## ` headings -> not chaptered
  const resp = {
    result: { content: [{ type: "text", text: blob }], isError: false },
    durationMs: 5,
  };
  const out = await offloader.after!(smokeReq, resp);
  assert.ok(out);
  const text = (out.result as { content: { text: string }[] }).content[0].text;
  assert.match(text, /^response exported to: .*\.json$/m);
});

test("makeOffloader: small responses pass through unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-mcp-test-"));
  const opts = resolveOffloadConfig({ thresholdBytes: 1024, dir }, dir)!;
  const offloader = makeOffloader(opts);

  const small = {
    result: { content: [{ type: "text", text: "tiny ok" }], isError: false },
    durationMs: 1,
  };
  const out = await offloader.after!(smokeReq, small);
  assert.equal(out, undefined);
});

test("makeOffloader: oversize markdown with H2 chapters -> chaptered .md + TOC pointer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-mcp-test-"));
  const opts = resolveOffloadConfig({ thresholdBytes: 1024, dir }, dir)!;
  const offloader = makeOffloader(opts);

  const intro = "# Page Title\n\nThis is the intro paragraph.\n\n";
  const ch1 = "## Overview\n\n" + "x".repeat(500) + "\n\n";
  const ch2 = "## API Reference\n\n" + "y".repeat(500) + "\n\n";
  const ch3 = "## Examples\n\n" + "z".repeat(500) + "\n";
  const markdown = intro + ch1 + ch2 + ch3;
  const mdResp = {
    result: { content: [{ type: "text", text: markdown }], isError: false },
    durationMs: 8,
  };
  const out = await offloader.after!(smokeReq, mdResp);
  assert.ok(out);
  const text = (out.result as { content: { text: string }[] }).content[0].text;

  assert.match(text, /^markdown exported to: .*\.md$/m, "expected markdown exported header");
  assert.match(text, /^chapters:$/m, "expected `chapters:` line");

  const tocEntries = text.split("\n").filter((l) => /^ - \d{2,} - /.test(l));
  assert.equal(tocEntries.length, 4, "expected 4 chapter entries (H1 intro + 3 H2s)");
  assert.match(tocEntries[0], /00 - page_title:/, "expected intro slug from H1 title");

  // Every chapter file should be readable and non-empty.
  for (const line of tocEntries) {
    const m = / - \d+ - [^:]+: (.+)$/.exec(line);
    assert.ok(m, `malformed TOC entry: ${line}`);
    const content = await readFile(m[1], "utf8");
    assert.ok(content.length > 0, `chapter file empty: ${m[1]}`);
  }
});

test("makeOffloader: oversize text WITHOUT H2 -> JSON-wrapper fallback (not chaptered)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-mcp-test-"));
  const opts = resolveOffloadConfig({ thresholdBytes: 1024, dir }, dir)!;
  const offloader = makeOffloader(opts);

  const noHeadings = "just a long bit of text\n".repeat(200);
  const resp = {
    result: { content: [{ type: "text", text: noHeadings }], isError: false },
    durationMs: 4,
  };
  const out = await offloader.after!(smokeReq, resp);
  assert.ok(out);
  const text = (out.result as { content: { text: string }[] }).content[0].text;
  assert.match(text, /^response exported to: .*\.json$/m, "expected fallback to `.json` wrapper");
});

test("makeOffloader: perTool thresholdBytes:0 makes a normally-tiny response offload anyway", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-mcp-pertool-"));
  const opts = resolveOffloadConfig(
    { thresholdBytes: 1_000_000, dir, perTool: { "fs__list": { thresholdBytes: 0 } } },
    dir,
  )!;
  const mw = makeOffloader(opts);
  const tinyRes = {
    result: { content: [{ type: "text", text: "tiny" }], isError: false },
    durationMs: 1,
  };

  const skipped = await mw.after!({ server: "fs", kind: "tool", name: "other", params: {} }, tinyRes);
  assert.equal(skipped, undefined);

  const offloaded = await mw.after!({ server: "fs", kind: "tool", name: "list", params: {} }, tinyRes);
  assert.ok(offloaded);
  const text = (offloaded.result as { content: { text: string }[] }).content[0].text;
  assert.match(text, /^response exported to: /);
  const files = await readdir(dir);
  assert.ok(files.length >= 1, "expected at least one offload file on disk");
});

test("makeOffloader: perTool `false` sentinel skips offload even when response exceeds threshold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-mcp-pertool-"));
  const opts = resolveOffloadConfig(
    { thresholdBytes: 100, dir, perTool: { "fs__never_offload": false } },
    dir,
  )!;
  const mw = makeOffloader(opts);
  const bigRes = {
    result: { content: [{ type: "text", text: "x".repeat(5000) }], isError: false },
    durationMs: 1,
  };

  const skipped = await mw.after!(
    { server: "fs", kind: "tool", name: "never_offload", params: {} },
    bigRes,
  );
  assert.equal(skipped, undefined);
  const files = await readdir(dir);
  assert.equal(files.length, 0, "expected no file on disk for `false` override");

  const offloaded = await mw.after!(
    { server: "fs", kind: "tool", name: "other", params: {} },
    bigRes,
  );
  assert.ok(offloaded);
});
