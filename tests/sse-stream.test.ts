// Unit tests for src/live.ts:tailTranscript + parseTranscriptLine — the
// live tool-call SSE stream backing /api/projects/:slug/stream.
//
// Acceptance criteria from docs/backlog/0002-sse-toolcall-stream.md:
//   - one `tool-call` event per `tool_use` entry: { name, input_head: 200ch }
//   - one `text` event per assistant text turn, truncated to 500 chars
//   - idle close after >5 min of no new bytes
//   - re-opens against a freshly mtime'd jsonl file (rotation detected)
//   - tests/sse-stream.test.ts — write 3 jsonl lines to a fixture, simulate
//     the parser, assert the right event sequence is emitted
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { parseTranscriptLine, tailTranscript } from "../src/live.ts";
import { transcriptDirFor } from "../src/config.ts";

/** Poll `predicate` every 20ms up to `maxMs` ms. Resolves true if it ever
 *  returns truthy, false on timeout. Lets the tests tolerate jittery CI
 *  scheduling without sleeping for the worst case every run. */
async function waitFor(predicate: () => boolean, maxMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return true;
    await wait(20);
  }
  return predicate();
}

function fixture(): { cfg: any; slug: string; transcriptDir: string; cleanup: () => void } {
  const cacheBase = mkdtempSync(join(tmpdir(), "fleet-sse-cache-"));
  const claudeProjects = mkdtempSync(join(tmpdir(), "fleet-sse-claude-"));
  const slug = "demo";
  const checkout = join(cacheBase, `${slug}-agent`, "checkout");
  const transcriptDir = join(claudeProjects, transcriptDirFor(checkout));
  mkdirSync(transcriptDir, { recursive: true });
  return {
    cfg: { cacheBase, claudeProjects },
    slug,
    transcriptDir,
    cleanup: () => {
      rmSync(cacheBase, { recursive: true, force: true });
      rmSync(claudeProjects, { recursive: true, force: true });
    },
  };
}

// --- parser ---------------------------------------------------------------

test("parseTranscriptLine: tool_use entry → tool-call with name + input_head≤200", () => {
  const longInput = "x".repeat(500);
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command: longInput } }],
    },
  });
  const evs = parseTranscriptLine(line);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "tool-call");
  assert.equal(evs[0].data.name, "Bash");
  // input_head should exist and be at most 200 chars
  assert.ok(typeof evs[0].data.input_head === "string");
  assert.ok(evs[0].data.input_head.length <= 200, `input_head must be ≤200 chars, got ${evs[0].data.input_head.length}`);
});

test("parseTranscriptLine: assistant text turn → text event truncated to 500 chars", () => {
  const longText = "y".repeat(1200);
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: longText }] },
  });
  const evs = parseTranscriptLine(line);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "text");
  assert.equal(evs[0].data.text.length, 500);
  assert.equal(evs[0].data.text, "y".repeat(500));
});

test("parseTranscriptLine: malformed line returns []", () => {
  assert.deepEqual(parseTranscriptLine("{not json"), []);
  assert.deepEqual(parseTranscriptLine(""), []);
});

test("parseTranscriptLine: a turn with both text and tool_use emits both events in order", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "I'll edit the file." },
        { type: "tool_use", name: "Edit", input: { file_path: "/tmp/foo.ts" } },
      ],
    },
  });
  const evs = parseTranscriptLine(line);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].type, "text");
  assert.equal(evs[1].type, "tool-call");
  assert.equal(evs[1].data.name, "Edit");
});

// --- tail: backfill + incremental ----------------------------------------

test("tailTranscript: 3 jsonl lines (one malformed) → correct event sequence", async () => {
  const { cfg, slug, transcriptDir, cleanup } = fixture();
  try {
    const file = join(transcriptDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "starting" }] } }),
      "{ not valid json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/a" } }] } }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    const seen: any[] = [];
    const ctrl = tailTranscript(cfg, slug, (e) => seen.push(e), { idleMs: 60_000 });
    // Wait until the parsed text+tool-call events appear (jittery CI safe).
    const ok = await waitFor(() => seen.filter((e) => e.type === "text" || e.type === "tool-call").length >= 2);
    ctrl.close();
    assert.ok(ok, `backfill never produced both events; saw: ${seen.map((e) => e.type).join(",")}`);

    const kinds = seen.map((e) => e.type);
    // an "open" event announces which file is being tailed, then the parsed events
    assert.ok(kinds.includes("open"), `expected open event, got ${kinds.join(",")}`);
    const payload = seen.filter((e) => e.type === "text" || e.type === "tool-call");
    assert.deepEqual(payload.map((e) => e.type), ["text", "tool-call"]);
    assert.equal(payload[0].data.text, "starting");
    assert.equal(payload[1].data.name, "Read");
  } finally {
    cleanup();
  }
});

test("tailTranscript: appended lines after backfill are streamed incrementally", async () => {
  const { cfg, slug, transcriptDir, cleanup } = fixture();
  try {
    const file = join(transcriptDir, "session.jsonl");
    writeFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "boot" }] } }) + "\n");

    const seen: any[] = [];
    const ctrl = tailTranscript(cfg, slug, (e) => seen.push(e), { idleMs: 60_000, pollMs: 50 });
    await waitFor(() => seen.some((e) => e.type === "text"));
    appendFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }) + "\n");
    // Wait for the incremental tool-call to be observed (fs.watch + read settle).
    const ok = await waitFor(() => seen.filter((e) => e.type === "tool-call").length >= 1);
    ctrl.close();
    assert.ok(ok, `incremental tool-call never seen; events: ${seen.map((e) => e.type).join(",")}`);

    const payload = seen.filter((e) => e.type === "text" || e.type === "tool-call");
    assert.deepEqual(payload.map((e) => e.type), ["text", "tool-call"]);
    assert.equal(payload[1].data.name, "Bash");
    assert.equal(payload[1].data.input_head, "ls");
  } finally {
    cleanup();
  }
});

test("tailTranscript: idle close after idleMs of no new bytes", async () => {
  const { cfg, slug, transcriptDir, cleanup } = fixture();
  try {
    const file = join(transcriptDir, "session.jsonl");
    writeFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }) + "\n");

    const seen: any[] = [];
    const ctrl = tailTranscript(cfg, slug, (e) => seen.push(e), { idleMs: 120, pollMs: 60 });
    const ok = await waitFor(() => seen.some((e) => e.type === "idle-close"), 4000);
    ctrl.close();
    assert.ok(ok, `expected idle-close event, got: ${seen.map((e) => e.type).join(",")}`);
  } finally {
    cleanup();
  }
});

test("tailTranscript: rotation — a newer jsonl file is picked up and re-opens the tail", async () => {
  const { cfg, slug, transcriptDir, cleanup } = fixture();
  try {
    const oldFile = join(transcriptDir, "old.jsonl");
    writeFileSync(oldFile, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "old run" }] } }) + "\n");
    // Backdate the old file so the new one is unambiguously newer
    const past = Math.floor(Date.now() / 1000) - 10;
    utimesSync(oldFile, past, past);

    const seen: any[] = [];
    const ctrl = tailTranscript(cfg, slug, (e) => seen.push(e), { idleMs: 60_000, pollMs: 50 });
    await waitFor(() => seen.some((e) => e.type === "open"));

    const newFile = join(transcriptDir, "new.jsonl");
    writeFileSync(newFile, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/x" } }] } }) + "\n");
    // Bump new.jsonl's mtime forward by a second so mtime resolution on
    // macOS (1s on some FS) reliably picks it as newer than old.jsonl.
    const future = Math.floor(Date.now() / 1000) + 5;
    utimesSync(newFile, future, future);

    await waitFor(() => seen.some((e) => e.type === "rotate") && seen.some((e) => e.type === "tool-call" && e.data?.name === "Edit"));
    ctrl.close();

    const dump = seen.map((e) => `${e.type}${e.path ? "(" + e.path.split("/").slice(-1)[0] + ")" : ""}${e.data ? "=" + JSON.stringify(e.data) : ""}`).join(" | ");
    const opens = seen.filter((e) => e.type === "open" || e.type === "rotate");
    assert.ok(opens.length >= 2, `expected at least one rotate after the initial open; events: ${dump}`);
    const lastOpenPath = opens[opens.length - 1].path;
    assert.equal(lastOpenPath, newFile);

    // The Edit tool-call from the new file must have been streamed
    const toolNames = seen.filter((e) => e.type === "tool-call").map((e) => e.data.name);
    assert.ok(toolNames.includes("Edit"), `expected Edit tool-call from rotated file; events: ${dump}`);
  } finally {
    cleanup();
  }
});

test("tailTranscript: no active transcript (empty dir) → emits no open event and closes cleanly", async () => {
  const { cfg, slug, cleanup } = fixture();
  try {
    const seen: any[] = [];
    const ctrl = tailTranscript(cfg, slug, (e) => seen.push(e), { idleMs: 120, pollMs: 60 });
    await wait(200);
    ctrl.close();
    assert.equal(seen.filter((e) => e.type === "open").length, 0);
  } finally {
    cleanup();
  }
});
