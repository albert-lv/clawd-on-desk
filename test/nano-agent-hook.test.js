const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  EVENT_TO_STATE,
  snakeToPascal,
  readNanoHookEnvelope,
  resolveEvent,
  buildStateBody,
} = require("../hooks/nano-agent-hook");

const fakeResolve = () => ({
  stablePid: 4242,
  agentPid: 9999,
  agentCommandLine: "nano /path/to/cwd",
  detectedEditor: null,
  pidChain: [4242, 9999],
});

describe("Nano Agent hook", () => {
  describe("snakeToPascal", () => {
    it("converts snake_case to PascalCase", () => {
      assert.strictEqual(snakeToPascal("pre_tool_use"), "PreToolUse");
      assert.strictEqual(snakeToPascal("session_start"), "SessionStart");
      assert.strictEqual(snakeToPascal("subagent_stop"), "SubagentStop");
    });

    it("returns null for empty or non-string input", () => {
      assert.strictEqual(snakeToPascal(""), null);
      assert.strictEqual(snakeToPascal(null), null);
      assert.strictEqual(snakeToPascal(undefined), null);
      assert.strictEqual(snakeToPascal(123), null);
    });

    it("handles already PascalCase input (no underscores)", () => {
      assert.strictEqual(snakeToPascal("SessionStart"), "Sessionstart");
      assert.strictEqual(snakeToPascal("PreToolUse"), "Pretooluse");
    });
  });

  describe("readNanoHookEnvelope", () => {
    it("parses NANO_HOOK_INPUT JSON", () => {
      const env = {
        NANO_HOOK_INPUT: JSON.stringify({
          hook_event_name: "pre_tool_use",
          session_id: "abc123",
          tool_name: "Task",
          params: { tool_input: { prompt: "test" } },
        }),
      };
      const envelope = readNanoHookEnvelope(env);
      assert.strictEqual(envelope.hook_event_name, "pre_tool_use");
      assert.strictEqual(envelope.session_id, "abc123");
      assert.strictEqual(envelope.tool_name, "Task");
      assert.deepStrictEqual(envelope.params, { tool_input: { prompt: "test" } });
    });

    it("falls back to legacy NANO_TOOL_INPUT / NANO_TOOL_NAME", () => {
      const env = {
        NANO_HOOK_INPUT: JSON.stringify({}),
        NANO_TOOL_INPUT: JSON.stringify({ prompt: "legacy" }),
        NANO_TOOL_NAME: "LegacyTool",
      };
      const envelope = readNanoHookEnvelope(env);
      assert.deepStrictEqual(envelope.params, { prompt: "legacy" });
      assert.strictEqual(envelope.tool_name, "LegacyTool");
    });

    it("returns empty object on malformed JSON", () => {
      const env = { NANO_HOOK_INPUT: "not json" };
      const envelope = readNanoHookEnvelope(env);
      assert.deepStrictEqual(envelope, {});
    });

    it("returns empty object when NANO_HOOK_INPUT is missing", () => {
      const env = {};
      const envelope = readNanoHookEnvelope(env);
      assert.deepStrictEqual(envelope, {});
    });
  });

  describe("resolveEvent", () => {
    it("resolves event from argv[2]", () => {
      const argv = ["node", "script.js", "SessionStart"];
      const env = {};
      const envelope = {};
      assert.strictEqual(resolveEvent(argv, env, envelope), "SessionStart");
    });

    it("resolves event from NANO_HOOK_EVENT env", () => {
      const argv = ["node", "script.js"];
      const env = { NANO_HOOK_EVENT: "PreToolUse" };
      const envelope = {};
      assert.strictEqual(resolveEvent(argv, env, envelope), "PreToolUse");
    });

    it("resolves event from envelope.hook_event_name", () => {
      const argv = ["node", "script.js"];
      const env = {};
      const envelope = { hook_event_name: "post_tool_use" };
      assert.strictEqual(resolveEvent(argv, env, envelope), "PostToolUse");
    });

    it("resolves event from envelope.event", () => {
      const argv = ["node", "script.js"];
      const env = {};
      const envelope = { event: "session_end" };
      assert.strictEqual(resolveEvent(argv, env, envelope), "SessionEnd");
    });

    it("normalizes snake_case to PascalCase", () => {
      const argv = ["node", "script.js", "pre_compact"];
      const env = {};
      const envelope = {};
      assert.strictEqual(resolveEvent(argv, env, envelope), "PreCompact");
    });

    it("returns null for unknown event", () => {
      const argv = ["node", "script.js", "UnknownEvent"];
      const env = {};
      const envelope = {};
      assert.strictEqual(resolveEvent(argv, env, envelope), null);
    });
  });

  describe("buildStateBody", () => {
    it("builds complete state body for PreToolUse", () => {
      const event = "PreToolUse";
      const envelope = {
        session_id: "test-session",
        cwd: "/home/user/project",
        tool_name: "write",
        tool_use_id: "tool-123",
        params: { tool_input: { path: "test.txt", content: "hello" } },
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

    it("synthesizes SubagentStart for Task delegation", () => {
      const event = "PreToolUse";
      const envelope = {
        session_id: "test-session",
        tool_name: "Task",
      };
      const body = buildStateBody(event, envelope, fakeResolve);

      assert.strictEqual(body.state, "juggling");
      assert.strictEqual(body.event, "SubagentStart");
      assert.strictEqual(body.tool_name, "Task");
    });

    it("synthesizes SubagentStart for main_agent delegation", () => {
      const event = "PreToolUse";
      const envelope = { tool_name: "main_agent" };
      const body = buildStateBody(event, envelope, fakeResolve);

      assert.strictEqual(body.state, "juggling");
      assert.strictEqual(body.event, "SubagentStart");
    });

    it("synthesizes SubagentStart for spawn_agent delegation", () => {
      const event = "PreToolUse";
      const envelope = { tool_name: "spawn_agent" };
      const body = buildStateBody(event, envelope, fakeResolve);

      assert.strictEqual(body.state, "juggling");
      assert.strictEqual(body.event, "SubagentStart");
    });

    it("does NOT synthesize SubagentStart for other tools", () => {
      const event = "PreToolUse";
      const envelope = { tool_name: "write" };
      const body = buildStateBody(event, envelope, fakeResolve);

      assert.strictEqual(body.state, "working");
      assert.strictEqual(body.event, "PreToolUse");
    });

    it("defaults to session_id='default' when missing", () => {
      const event = "SessionStart";
      const envelope = {};
      const body = buildStateBody(event, envelope, fakeResolve);

      assert.strictEqual(body.session_id, "default");
    });

    it("returns null for unknown event", () => {
      const event = "UnknownEvent";
      const envelope = {};
      const body = buildStateBody(event, envelope, fakeResolve);

      assert.strictEqual(body, null);
    });

    it("uses host field in remote mode (no PID fields)", () => {
      const originalEnv = process.env.CLAWD_REMOTE;
      process.env.CLAWD_REMOTE = "1";

      const event = "SessionStart";
      const envelope = { session_id: "remote-session" };
      const body = buildStateBody(event, envelope, fakeResolve);

      assert.strictEqual(body.state, "idle");
      assert.strictEqual(body.event, "SessionStart");
      assert.ok(body.host);
      assert.strictEqual(body.source_pid, undefined);
      assert.strictEqual(body.agent_pid, undefined);
      assert.strictEqual(body.nano_pid, undefined);

      if (originalEnv !== undefined) process.env.CLAWD_REMOTE = originalEnv;
      else delete process.env.CLAWD_REMOTE;
    });
  });

  describe("EVENT_TO_STATE coverage", () => {
    it("maps all NANO_COMMAND_HOOK_EVENTS to EVENT_TO_STATE", () => {
      const NANO_COMMAND_HOOK_EVENTS = [
        "session_start",
        "session_end",
        "user_prompt_submit",
        "pre_tool_use",
        "post_tool_use",
        "post_tool_use_failure",
        "stop",
        "stop_failure",
        "subagent_start",
        "subagent_stop",
        "pre_compact",
        "post_compact",
        "notification",
      ];

      for (const snakeEvent of NANO_COMMAND_HOOK_EVENTS) {
        const pascalEvent = snakeToPascal(snakeEvent);
        assert.ok(
          EVENT_TO_STATE[pascalEvent],
          `Missing EVENT_TO_STATE entry for ${snakeEvent} (${pascalEvent})`
        );
      }
    });

    it("maps PermissionRequest HTTP hook event", () => {
      assert.ok(EVENT_TO_STATE.PermissionRequest, "Missing EVENT_TO_STATE.PermissionRequest");
    });
  });
});
