#!/usr/bin/env node
// Clawd — Nano Agent hook (JSON envelope on stdin, PascalCase events)
// Registered in ~/.config/nano/config.yaml by hooks/nano-agent-install.js
//
// Post-PR-210 contract: stdin JSON envelope with hook_event_name as PascalCase.
// For PermissionRequest, prints hookSpecificOutput JSON on stdout.

const fs = require("fs");
const crypto = require("crypto");
const { postStateToRunningServer, readHostPrefix, readRuntimePort, DEFAULT_SERVER_PORT } = require("./server-config");
const { createPidResolver, getPlatformConfig } = require("./shared-process");

// Constants for tool input fingerprinting
const TOOL_MATCH_STRING_MAX = 240;
const ARRAY_MAX = 16;
const OBJECT_KEYS_MAX = 32;
const DEPTH_MAX = 6;

// PascalCase event → state mapping (13 entries; Notification has no state change)
const EVENT_TO_STATE = {
  SessionStart:       "idle",
  SessionEnd:         "idle",
  UserPromptSubmit:   "working",
  PreToolUse:         "working",
  PostToolUse:        "working",
  PostToolUseFailure: "working",
  Stop:               "idle",
  StopFailure:        "idle",
  SubagentStart:      "juggling",
  SubagentStop:       "working",
  PreCompact:         "working",
  PostCompact:        "working",
  PermissionRequest:  "needs-permission",
};

/**
 * Read hook envelope from stdin (JSON).
 * Returns parsed object or {} on any error.
 */
function readHookEnvelopeFromStdin() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Resolve event name from argv or envelope.
 * Priority: argv[2] first, then envelope.hook_event_name.
 * PascalCase only — snake_case returns null. envelope.event is never consulted.
 */
function resolveEvent(argv, envelope) {
  const candidates = [
    argv && argv[2],
    envelope && envelope.hook_event_name,
  ].filter((c) => c && typeof c === "string");

  for (const candidate of candidates) {
    if (EVENT_TO_STATE[candidate] !== undefined) return candidate;
    // Special case: Notification is a valid event but not in EVENT_TO_STATE
    if (candidate === "Notification") return candidate;
  }
  return null;
}

/**
 * Create a stable fingerprint for tool_input to track identical calls.
 * Truncates strings, limits array/object depth to avoid bloat.
 */
function createToolInputFingerprint(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return undefined;

  function truncate(value, depth = 0) {
    if (depth > DEPTH_MAX) return "[depth]";
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "string") {
      return value.length > TOOL_MATCH_STRING_MAX
        ? value.slice(0, TOOL_MATCH_STRING_MAX) + "..."
        : value;
    }
    if (t === "number" || t === "boolean") return value;
    if (Array.isArray(value)) {
      const truncated = value.slice(0, ARRAY_MAX).map((item) => truncate(item, depth + 1));
      return truncated.length < value.length ? [...truncated, "[...]"] : truncated;
    }
    if (t === "object") {
      const keys = Object.keys(value).sort().slice(0, OBJECT_KEYS_MAX);
      const out = {};
      for (const k of keys) out[k] = truncate(value[k], depth + 1);
      if (keys.length < Object.keys(value).length) out["[...]"] = true;
      return out;
    }
    return String(value);
  }

  const normalized = truncate(toolInput);
  return crypto.createHash("sha1").update(JSON.stringify(normalized), "utf8").digest("hex");
}

/**
 * Build state body for POST /state.
 * Special handling: PreToolUse + tool_name ∈ {Task, main_agent, spawn_agent} → SubagentStart.
 * Returns null for unknown events (including BinaryStop) and Notification.
 */
function buildStateBody(event, envelope, resolve) {
  if (!event || EVENT_TO_STATE[event] === undefined) return null;

  let finalEvent = event;
  let finalState = EVENT_TO_STATE[event];

  const toolName = envelope && envelope.tool_name;

  // Task delegation synthesis: PreToolUse + tool_name in delegation set → SubagentStart
  if (event === "PreToolUse" && toolName) {
    const delegationTools = new Set(["Task", "main_agent", "spawn_agent"]);
    if (delegationTools.has(toolName)) {
      finalEvent = "SubagentStart";
      finalState = "juggling";
    }
  }

  const sessionId = (envelope && envelope.session_id) || "default";
  const cwd = envelope && envelope.cwd;

  const body = {
    state: finalState,
    session_id: sessionId,
    event: finalEvent,
    agent_id: "nano-agent",
  };

  if (cwd) body.cwd = cwd;
  if (toolName) body.tool_name = toolName;
  if (envelope && envelope.tool_use_id) body.tool_use_id = envelope.tool_use_id;

  const fingerprint = createToolInputFingerprint(envelope && envelope.tool_input);
  if (fingerprint) body.tool_input_fingerprint = fingerprint;

  // Remote mode vs local mode
  if (process.env.CLAWD_REMOTE === "1") {
    body.host = readHostPrefix();
  } else {
    const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
    body.source_pid = stablePid;
    if (agentPid) {
      body.agent_pid = agentPid;
      body.nano_pid = agentPid;
    }
    if (detectedEditor) body.editor = detectedEditor;
    if (pidChain && pidChain.length) body.pid_chain = pidChain;
  }

  return body;
}

/**
 * Build hookSpecificOutput JSON for PermissionRequest decision.
 */
function buildHookSpecificOutput(decision) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  });
}

function main() {
  const envelope = readHookEnvelopeFromStdin();
  const event = resolveEvent(process.argv, envelope);

  // Unknown event → silent exit
  if (!event) {
    process.exit(0);
    return;
  }

  const config = getPlatformConfig({
    extraTerminals: { win: ["nano.exe"], mac: ["nano"], linux: ["nano"] },
    extraEditors: {
      win: { "nano.exe": "nano" },
      mac: { "nano": "nano" },
      linux: { "nano": "nano" },
    },
  });

  const resolve = createPidResolver({
    agentNames: {
      win: new Set(["nano.exe"]),
      mac: new Set(["nano"]),
      linux: new Set(["nano"]),
    },
    agentCmdlineCheck: (cmdline) => /\bnano(-agent)?\b/.test(cmdline),
    platformConfig: config,
  });

  // Notification → POST to /notification and exit
  if (event === "Notification") {
    const body = {
      agent_id: "nano-agent",
      session_id: (envelope && envelope.session_id) || "default",
      event: "Notification",
      tool_name: envelope && envelope.tool_name,
      message: envelope && envelope.message,
    };
    postStateToRunningServer(body, { timeoutMs: 100, path: "/notification" }, () => {
      process.exit(0);
    });
    return;
  }

  // PermissionRequest → POST to /permission-request, await decision, print hookSpecificOutput
  if (event === "PermissionRequest") {
    const body = buildStateBody(event, envelope, resolve);
    if (!body) { process.exit(0); return; }

    // POST state first
    postStateToRunningServer(body, { timeoutMs: 100 }, () => {});

    // POST permission request and await decision
    const permBody = {
      agent_id: "nano-agent",
      session_id: (envelope && envelope.session_id) || "default",
      tool_name: envelope && envelope.tool_name,
      tool_use_id: envelope && envelope.tool_use_id,
      tool_input: envelope && envelope.tool_input,
      cwd: envelope && envelope.cwd,
    };
    const http = require("http");
    const port = readRuntimePort() || DEFAULT_SERVER_PORT;
    const reqData = JSON.stringify(permBody);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/permission",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(reqData) },
      timeout: 600000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const decision = JSON.parse(data);
          const output = buildHookSpecificOutput(decision);
          process.stdout.write(output + "\n");
        } catch {
          // Default to allow on parse failure
          process.stdout.write(buildHookSpecificOutput({ behavior: "allow" }) + "\n");
        }
        process.exit(0);
      });
    });
    req.on("error", () => {
      // Server unreachable — allow by default
      process.stdout.write(buildHookSpecificOutput({ behavior: "allow" }) + "\n");
      process.exit(0);
    });
    req.on("timeout", () => {
      req.destroy();
      process.stdout.write(buildHookSpecificOutput({ behavior: "allow" }) + "\n");
      process.exit(0);
    });
    req.write(reqData);
    req.end();
    return;
  }

  // Regular state events
  if (event === "SessionStart" && !process.env.CLAWD_REMOTE) {
    resolve();
  }

  const body = buildStateBody(event, envelope, resolve);
  if (!body) {
    process.exit(0);
    return;
  }

  postStateToRunningServer(body, { timeoutMs: 100 }, () => {
    process.exit(0);
  });
}

// Export for testing
module.exports = {
  EVENT_TO_STATE,
  readHookEnvelopeFromStdin,
  resolveEvent,
  buildStateBody,
  buildHookSpecificOutput,
};

if (require.main === module) {
  main();
}
