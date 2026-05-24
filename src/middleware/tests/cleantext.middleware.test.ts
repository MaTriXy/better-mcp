import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanResponse,
  cleanString,
  makeCleanText,
  resolveCleanTextConfig,
} from "../cleantext.middleware.js";

const dflt = resolveCleanTextConfig(undefined);
if (!dflt) throw new Error("expected non-null defaults");

// ---- resolveCleanTextConfig -----------------------------------------------

test("resolveCleanTextConfig(false) returns null (disabled)", () => {
  assert.equal(resolveCleanTextConfig(false), null);
});

test("resolveCleanTextConfig(undefined) enables safe defaults", () => {
  assert.equal(dflt.stripAnsi, true);
  assert.equal(dflt.trimTrailingWhitespace, true);
  assert.equal(dflt.collapseBlankLines, false);
  assert.equal(dflt.exclude.size, 0);
});

test("resolveCleanTextConfig honors per-knob overrides", () => {
  const c = resolveCleanTextConfig({ stripAnsi: false, collapseBlankLines: true, exclude: ["x"] });
  if (!c) throw new Error("expected non-null cfg");
  assert.equal(c.stripAnsi, false);
  assert.equal(c.trimTrailingWhitespace, true);
  assert.equal(c.collapseBlankLines, true);
  assert.ok(c.exclude.has("x"));
});

// ---- cleanString -----------------------------------------------------------

test("stripAnsi removes a basic colour sequence", () => {
  const ansi = "\x1b[31mred text\x1b[0m";
  assert.equal(cleanString(ansi, dflt), "red text");
});

test("stripAnsi removes nested/complex sequences", () => {
  const ansi = "\x1b[1;33;41mBOLD YELLOW ON RED\x1b[0m and then \x1b[2J\x1b[H";
  assert.equal(cleanString(ansi, dflt), "BOLD YELLOW ON RED and then");
  const ansiOnly = resolveCleanTextConfig({ trimTrailingWhitespace: false })!;
  assert.equal(cleanString(ansi, ansiOnly), "BOLD YELLOW ON RED and then ");
});

test("stripAnsi=false leaves ANSI alone", () => {
  const cfg = resolveCleanTextConfig({ stripAnsi: false })!;
  const ansi = "\x1b[31mred\x1b[0m";
  assert.equal(cleanString(ansi, cfg), ansi);
});

test("stripAnsi removes OSC sequences (terminal title etc.)", () => {
  const osc = "before\x1b]0;my title\x07after";
  assert.equal(cleanString(osc, dflt), "beforeafter");
});

test("trimTrailingWhitespace removes spaces + tabs at line ends only", () => {
  const text = "line one   \nline two\t\t\nline three";
  assert.equal(cleanString(text, dflt), "line one\nline two\nline three");
});

test("trimTrailingWhitespace does NOT collapse internal whitespace", () => {
  const text = "word    word";
  assert.equal(cleanString(text, dflt), "word    word");
});

test("trimTrailingWhitespace=false keeps it", () => {
  const cfg = resolveCleanTextConfig({ trimTrailingWhitespace: false })!;
  const text = "trailing   \n";
  assert.equal(cleanString(text, cfg), text);
});

test("collapseBlankLines off by default leaves blank lines alone", () => {
  const text = "a\n\n\n\nb";
  assert.equal(cleanString(text, dflt), text);
});

test("collapseBlankLines collapses 3+ to 2 when enabled", () => {
  const cfg = resolveCleanTextConfig({ collapseBlankLines: true })!;
  assert.equal(cleanString("a\n\n\n\nb", cfg), "a\n\nb");
  assert.equal(cleanString("a\n\nb", cfg), "a\n\nb");
  assert.equal(cleanString("a\nb", cfg), "a\nb");
});

test("cleanString returns same reference when nothing changes", () => {
  const s = "no changes here";
  assert.equal(cleanString(s, dflt), s);
});

test("cleanString combines transforms in one call", () => {
  const messy = "\x1b[32mhello\x1b[0m   \n\n\n\nworld   ";
  const cfg = resolveCleanTextConfig({ collapseBlankLines: true })!;
  assert.equal(cleanString(messy, cfg), "hello\n\nworld");
});

// ---- cleanResponse ---------------------------------------------------------

test("cleanResponse cleans text blocks in MCP content array", () => {
  const input = {
    content: [{ type: "text", text: "\x1b[31mred\x1b[0m line   " }],
    isError: false,
  };
  const out = cleanResponse(input, dflt) as typeof input;
  assert.notEqual(out, input);
  assert.equal(out.content[0].text, "red line");
  assert.equal(out.isError, false);
});

test("cleanResponse returns same ref when nothing changes", () => {
  const input = { content: [{ type: "text", text: "already clean" }] };
  assert.equal(cleanResponse(input, dflt), input);
});

test("cleanResponse leaves non-text blocks alone", () => {
  const input = {
    content: [
      { type: "image", data: "base64..." },
      { type: "text", text: "trailing   " },
    ],
  };
  const out = cleanResponse(input, dflt) as { content: { type: string; data?: string; text?: string }[] };
  assert.equal(out.content[0].type, "image");
  assert.equal(out.content[0].data, "base64...");
  assert.equal(out.content[1].text, "trailing");
});

test("cleanResponse passes through non-object / no-content results", () => {
  assert.equal(cleanResponse("raw string", dflt), "raw string");
  assert.equal(cleanResponse(null, dflt), null);
  assert.equal((cleanResponse({ foo: "bar" }, dflt) as { foo: string }).foo, "bar");
});

test("cleanResponse is idempotent on minified JSON text", () => {
  const input = { content: [{ type: "text", text: '{"a":1,"b":2}' }] };
  assert.equal(cleanResponse(input, dflt), input);
});

test("cleanResponse leaves offload pointer text alone (already clean)", () => {
  const input = {
    content: [{ type: "text", text: "response exported to: /tmp/x.json\nsize: 1 KB" }],
  };
  assert.equal(cleanResponse(input, dflt), input);
});

// ---- makeCleanText (middleware shell) -------------------------------------

const makeReq = (server: string, name: string, kind: "tool" | "resource" | "prompt" = "tool") => ({
  server,
  kind,
  name,
  params: {},
});
const makeRes = (text: string) => ({ result: { content: [{ type: "text", text }] }, durationMs: 1 });

test("middleware cleans when not excluded", async () => {
  const mw = makeCleanText(resolveCleanTextConfig(undefined)!);
  const out = await mw.after!(makeReq("gh", "list"), makeRes("\x1b[1mhi\x1b[0m   "));
  assert.ok(out);
  assert.equal((out.result as { content: { text: string }[] }).content[0].text, "hi");
});

test("middleware skips when entire server excluded", async () => {
  const mw = makeCleanText(resolveCleanTextConfig({ exclude: ["gh"] })!);
  const out = await mw.after!(makeReq("gh", "list"), makeRes("\x1b[1mhi\x1b[0m   "));
  assert.equal(out, undefined);
});

test("middleware skips when specific server__tool excluded", async () => {
  const mw = makeCleanText(resolveCleanTextConfig({ exclude: ["gh__raw_terminal"] })!);
  const skipped = await mw.after!(makeReq("gh", "raw_terminal"), makeRes("\x1b[31mansi\x1b[0m"));
  assert.equal(skipped, undefined);
  const cleaned = await mw.after!(makeReq("gh", "other"), makeRes("\x1b[31mansi\x1b[0m"));
  assert.ok(cleaned);
  assert.equal((cleaned.result as { content: { text: string }[] }).content[0].text, "ansi");
});

test("middleware ignores responses with upstream errors", async () => {
  const mw = makeCleanText(resolveCleanTextConfig(undefined)!);
  const errored = { result: undefined, durationMs: 1, error: { message: "boom" } };
  const out = await mw.after!(makeReq("gh", "x"), errored);
  assert.equal(out, undefined);
});

test("middleware is idempotent on already-clean responses", async () => {
  const mw = makeCleanText(resolveCleanTextConfig(undefined)!);
  const out = await mw.after!(makeReq("gh", "x"), makeRes("clean text"));
  assert.equal(out, undefined);
});

test("middleware works for resource and prompt kinds", async () => {
  const mw = makeCleanText(resolveCleanTextConfig(undefined)!);
  const out = await mw.after!(makeReq("fs", "file://x", "resource"), makeRes("trailing   "));
  assert.ok(out);
  assert.equal((out.result as { content: { text: string }[] }).content[0].text, "trailing");
});
