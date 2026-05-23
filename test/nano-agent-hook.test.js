const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  EVENT_TO_STATE,
  readHookEnvelopeFromStdin,
  resolveEvent,
  buildStateBody,
  buildHookSpecificOutput,
} = require("../hooks/nano-agent-hook");

const fakeResolve = () => ({
  stablePid: 4242,
  agentPid: 9999,
  agentCommandLine: "nano /path/to/cwd",
  detectedEditor: null,
  pidChain: [4242, 9999],
});

describe("resolveEvent", () => {
  it("resolves from argv[2]", () => {
    const argv = ["node", "script.js", "SessionStart"];
    assert.strictEqual(resolveEvent(argv, {}), "SessionStart");
  });

  it("resolves from envelope.hook_event_name when argv missing", () => {
    const argv = ["node", "script.js"];
    const envelope = { hook_event_name: "PreToolUse" };
    assert.strictEqual(resolveEvent(argv, envelope), "PreToolUse");
  });

  it("argv wins over envelope.hook_event_name", () => {
    const argv = ["node", "script.js", "Stop"];
    const envelope = { hook_event_name: "PreToolUse" };
    assert.strictEqual(resolveEvent(argv, envelope), "Stop");
  });

  it("returns null for unknown event", () => {
    const argv = ["node", "script.js", "UnknownEvent"];
    assert.strictEqual(resolveEvent(argv, {}), null);
  });

  it("returns null for snake_case inputs", () => {
    assert.strictEqual(resolveEvent(["node", "s.js", "pre_tool_use"], {}), null);
    assert.strictEqual(resolveEvent(["node", "s.js", "session_start"], {}), null);
  });

  it("returns null when only envelope.event is set (never consulted)", () => {
    const argv = ["node", "script.js"];
    const envelope = { event: "SessionStart" };
    assert.strictEqual(resolveEvent(argv, envelope), null);
  });
});

describe("buildStateBody", () => {
  it("builds state body for PreToolUse with tool_input", () => {
    const event = "PreToolUse";
    const envelope = {
      session_id: "test-session",
      cwd: "/home/user/project",
      tool_name: "write",
      tool_use_id: "tool-123",
      tool_input: { path: "test.txt", content: "hello" },
    };
    const body = buildStateBody(event, envelope, fakeResolve);

    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.event, "PreToolUse");
    assert.strictEqual(body.agent_id, "nano-agent");
    assert.strictEqual(body.session_id, "test-session");
    assert.strictEqual(body.cwd, "/home/user/project");
    assert.strictEqual(body.tool_name, "write");
    assert.strictEqual(body.tool_use_id, "tool-123");
    assert.ok(body.tool_input_fingerprint);
    assert.strictEqual(body.source_pid, 4242);
    assert.strictEqual(body.agent_pid, 9999);
    assert.strictEqual(body.nano_pid, 9999);
  });

  it("synthesizes SubagentStart for Task", () => {
    const body = buildStateBody("PreToolUse", { tool_name: "Task" }, fakeResolve);
    assert.strictEqual(body.state, "juggling");
    assert.strictEqual(body.event, "SubagentStart");
  });

  it("synthesizes SubagentStart for main_agent", () => {
    const body = buildStateBody("PreToolUse", { tool_name: "main_agent" }, fakeResolve);
    assert.strictEqual(body.state, "juggling");
    assert.strictEqual(body.event, "SubagentStart");
  });

  it("synthesizes SubagentStart for spawn_agent", () => {
    const body = buildStateBody("PreToolUse", { tool_name: "spawn_agent" }, fakeResolve);
    assert.strictEqual(body.state, "juggling");
    assert.strictEqual(body.event, "SubagentStart");
  });

  it("does NOT synthesize SubagentStart for other tools", () => {
    const body = buildStateBody("PreToolUse", { tool_name: "write" }, fakeResolve);
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.event, "PreToolUse");
  });

  it("defaults session_id to 'default' when absent", () => {
    const body = buildStateBody("SessionStart", {}, fakeResolve);
    assert.strictEqual(body.session_id, "default");
  });

  it("returns null for unknown event", () => {
    assert.strictEqual(buildStateBody("UnknownEvent", {}, fakeResolve), null);
  });

  it("returns null for BinaryStop (intentionally omitted)", () => {
    assert.strictEqual(buildStateBody("BinaryStop", {}, fakeResolve), null);
  });

  it("PermissionRequest yields needs-permission state", () => {
    const body = buildStateBody("PermissionRequest", { tool_name: "bash", session_id: "s1" }, fakeResolve);
    assert.strictEqual(body.state, "needs-permission");
    assert.strictEqual(body.event, "PermissionRequest");
    assert.strictEqual(body.tool_name, "bash");
  });

  it("remote mode: host populated, PID fields undefined", () => {
    const originalEnv = process.env.CLAWD_REMOTE;
    process.env.CLAWD_REMOTE = "1";
    try {
      const body = buildStateBody("SessionStart", { session_id: "remote-session" }, fakeResolve);
      assert.strictEqual(body.state, "idle");
      assert.ok(body.host);
      assert.strictEqual(body.source_pid, undefined);
      assert.strictEqual(body.agent_pid, undefined);
      assert.strictEqual(body.nano_pid, undefined);
    } finally {
      if (originalEnv !== undefined) process.env.CLAWD_REMOTE = originalEnv;
      else delete process.env.CLAWD_REMOTE;
    }
  });

  it("omits tool_input_fingerprint when envelope.tool_input missing", () => {
    const body = buildStateBody("PreToolUse", { tool_name: "read" }, fakeResolve);
    assert.strictEqual(body.tool_input_fingerprint, undefined);
  });
});

describe("buildHookSpecificOutput", () => {
  it("allow decision yields correct JSON", () => {
    const output = buildHookSpecificOutput({ behavior: "allow" });
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "PermissionRequest");
    assert.strictEqual(parsed.hookSpecificOutput.decision.behavior, "allow");
  });

  it("deny decision round-trips message", () => {
    const output = buildHookSpecificOutput({ behavior: "deny", message: "Not allowed" });
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.hookSpecificOutput.decision.behavior, "deny");
    assert.strictEqual(parsed.hookSpecificOutput.decision.message, "Not allowed");
  });
});

describe("EVENT_TO_STATE coverage", () => {
  it("has exactly 13 keys", () => {
    const keys = Object.keys(EVENT_TO_STATE);
    assert.strictEqual(keys.length, 13);
  });

  it("BinaryStop, Notification, PermissionDenied are all undefined", () => {
    assert.strictEqual(EVENT_TO_STATE.BinaryStop, undefined);
    assert.strictEqual(EVENT_TO_STATE.Notification, undefined);
    assert.strictEqual(EVENT_TO_STATE.PermissionDenied, undefined);
  });
});
