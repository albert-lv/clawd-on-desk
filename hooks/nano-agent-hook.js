#!/usr/bin/env node
// Clawd — Nano Agent hook (payload via NANO_HOOK_INPUT env var)
// Registered in ~/.config/nano/config.yaml by hooks/nano-agent-install.js
//
// Nano Agent uses snake_case event names (pre_tool_use, session_start, etc.)
// that must be normalized to PascalCase before feeding the Clawd state machine.

const crypto = require("crypto");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, getPlatformConfig } = require("./shared-process");

// Constants for tool input fingerprinting
const TOOL_MATCH_STRING_MAX = 240;
const ARRAY_MAX = 16;
const OBJECT_KEYS_MAX = 32;
const DEPTH_MAX = 6;

// snake_case → PascalCase event map for Nano Agent
const EVENT_TO_STATE = {
  SessionStart:          { state: "idle",         event: "SessionStart" },
  SessionEnd:            { state: "sleeping",     event: "SessionEnd" },
  UserPromptSubmit:      { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:            { state: "working",      event: "PreToolUse" },
  PostToolUse:           { state: "working",      event: "PostToolUse" },
  PostToolUseFailure:    { state: "error",        event: "PostToolUseFailure" },
  Stop:                  { state: "attention",    event: "Stop" },
  StopFailure:           { state: "error",        event: "StopFailure" },
  SubagentStart:         { state: "juggling",     event: "SubagentStart" },
  SubagentStop:          { state: "working",      event: "SubagentStop" },
  PreCompact:            { state: "sweeping",     event: "PreCompact" },
  PostCompact:           { state: "attention",    event: "PostCompact" },
  Notification:          { state: "notification", event: "Notification" },
  PermissionRequest:     { state: "notification", event: "PermissionRequest" },
};

/**
 * Convert snake_case to PascalCase.
 * "pre_tool_use" → "PreToolUse"
 * Empty or non-string input returns null.
 */
function snakeToPascal(snakeStr) {
  if (!snakeStr || typeof snakeStr !== "string") return null;
  return snakeStr
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

/**
 * Read Nano Agent hook envelope from NANO_HOOK_INPUT env var.
 * Falls back to legacy NANO_TOOL_INPUT / NANO_TOOL_NAME if needed.
 * Returns empty object if parsing fails.
 */
function readNanoHookEnvelope(env) {
  const envCopy = env || process.env;
  let envelope = {};
  try {
    const raw = envCopy.NANO_HOOK_INPUT;
    if (raw) envelope = JSON.parse(raw);
  } catch {}

  // Fallback for legacy env vars
  if (!envelope.params && envCopy.NANO_TOOL_INPUT) {
    try {
      envelope.params = JSON.parse(envCopy.NANO_TOOL_INPUT);
    } catch {}
  }
  if (!envelope.tool_name && envCopy.NANO_TOOL_NAME) {
    envelope.tool_name = envCopy.NANO_TOOL_NAME;
  }

  return envelope;
}

/**
 * Resolve event name from argv, env vars, or envelope.
 * Priority: argv[2] > NANO_HOOK_EVENT > envelope.hook_event_name > envelope.event
 * Each candidate is checked as-is, then snake_case→PascalCase normalized.
 * Returns null if no match found.
 */
function resolveEvent(argv, env, envelope) {
  const candidates = [
    argv && argv[2],
    env && env.NANO_HOOK_EVENT,
    envelope && envelope.hook_event_name,
    envelope && envelope.event,
  ].filter((c) => c && typeof c === "string");

  for (const candidate of candidates) {
    if (EVENT_TO_STATE[candidate]) return candidate;
    const pascal = snakeToPascal(candidate);
    if (pascal && EVENT_TO_STATE[pascal]) return pascal;
  }
  return null;
}

/**
 * Create a stable fingerprint for tool_input to track identical calls.
 * Truncates strings, limits array/object depth to avoid bloat.
 */
function createToolInputFingerprint(toolInput) {
  if (!toolInput) return "";

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
 */
function buildStateBody(event, envelope, resolve) {
  if (!event || !EVENT_TO_STATE[event]) return null;

  const mapped = EVENT_TO_STATE[event];
  let finalEvent = mapped.event;
  let finalState = mapped.state;

  const toolName = envelope && envelope.tool_name;
  const params = envelope && envelope.params;

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
  if (params) {
    body.tool_input_fingerprint = createToolInputFingerprint(params.tool_input || params);
  }

  // Remote mode vs local mode
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
    body.source_pid = stablePid;
    if (agentPid) {
      body.agent_pid = agentPid;
      body.nano_pid = agentPid;  // pidField: "nano_pid" in agents/nano-agent.js
    }
    if (detectedEditor) body.editor = detectedEditor;
    if (pidChain && pidChain.length) body.pid_chain = pidChain;
  }

  return body;
}

function main() {
  const envelope = readNanoHookEnvelope(process.env);
  const event = resolveEvent(process.argv, process.env, envelope);

  // Unknown event → silent exit (hook failure defaults to allow)
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

  // SessionStart: preheat PID resolution
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
  snakeToPascal,
  readNanoHookEnvelope,
  resolveEvent,
  buildStateBody,
};

if (require.main === module) {
  main();
}
