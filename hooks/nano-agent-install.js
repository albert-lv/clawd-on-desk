#!/usr/bin/env node
// Merge Clawd Nano Agent hooks into ~/.config/nano/config.yaml (append-only, idempotent)
// Nano Agent uses Go hookservice with YAML config format and SSRF protection.

const fs = require("fs");
const path = require("path");
const os = require("os");
const yaml = require("js-yaml");
const { resolveNodeBin, buildPermissionUrl, DEFAULT_SERVER_PORT, readRuntimePort } = require("./server-config");
const { asarUnpackedPath, extractExistingNodeBin } = require("./json-utils");

const HOOK_NAME_PREFIX = "clawd-on-desk:";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "nano", "config.yaml");

// Command hooks (fire-and-forget state reporting)
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

// HTTP hooks (blocking permission approval)
const NANO_HTTP_HOOK_EVENTS = ["permission_request"];

/**
 * Quote a string for POSIX shell (hookservice uses `sh -c`).
 * Single-quote escaping: ' → '\''
 */
function quoteForShell(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Build hook command string for nano-agent.
 * Remote mode prepends CLAWD_REMOTE=1 (must be in env_whitelist).
 */
function buildHookCommand(node, script, event, options = {}) {
  const quotedNode = quoteForShell(node);
  const quotedScript = quoteForShell(script);
  const quotedEvent = quoteForShell(event);
  const base = `${quotedNode} ${quotedScript} ${quotedEvent}`;
  return options.remote ? `CLAWD_REMOTE=1 ${base}` : base;
}

/**
 * Build a command hook entry for YAML config.
 */
function buildCommandHookEntry(node, script, event, options = {}) {
  const command = buildHookCommand(node, script, event, options);
  return {
    name: `${HOOK_NAME_PREFIX}${event}`,
    event,
    pattern: "*",
    type: "command",
    command,
    enabled: true,
    failure_policy: "allow",  // Don't block user if Clawd is down
    async: true,
    env_whitelist: ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "CLAWD_REMOTE"],
    status_message: `Clawd: ${event}`,
  };
}

/**
 * Build an HTTP hook entry for permission approval.
 */
function buildHttpHookEntry(event, url) {
  return {
    name: `${HOOK_NAME_PREFIX}${event}`,
    event,
    pattern: "*",
    type: "http",
    http: {
      url,
      method: "POST",
      timeout_seconds: 600,
      // CRITICAL: url_allowlist is required by nano-agent's SSRF protection
      url_allowlist: ["127.0.0.1", "localhost"],
    },
    enabled: true,
    failure_policy: "allow",
    status_message: `Clawd: ${event}`,
  };
}

/**
 * Ensure config.security.hooks is a usable array.
 * Returns null if config shape is incompatible (security is scalar/array).
 */
function ensureSecurityHooksArray(config) {
  if (!config.security) config.security = {};
  if (typeof config.security !== "object" || Array.isArray(config.security)) {
    return null; // Incompatible shape
  }
  if (!config.security.hooks) config.security.hooks = [];
  if (!Array.isArray(config.security.hooks)) {
    return null; // Incompatible shape
  }
  return config.security.hooks;
}

/**
 * Atomic YAML write: write to tmp file, then rename.
 */
function writeYamlAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const content = yaml.dump(data, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Check if an entry belongs to Clawd (by name prefix).
 */
function isOurEntry(entry) {
  return entry && entry.name && entry.name.startsWith(HOOK_NAME_PREFIX);
}

/**
 * Register Nano Agent hooks into ~/.config/nano/config.yaml.
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {boolean} [options.remote]
 * @param {string} [options.configPath]
 * @param {string} [options.scriptPath]
 * @param {string} [options.nodeBin]
 * @param {number} [options.port]
 * @returns {{ status: string, added?: number, updated?: number, skipped?: number, reason?: string }}
 */
function registerNanoAgentHooks(options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;

  // Skip if config doesn't exist (nano-agent not installed)
  if (!fs.existsSync(configPath)) {
    if (!options.silent) console.log("Clawd: ~/.config/nano/config.yaml not found — skipping");
    return { status: "skipped", reason: "config-missing" };
  }

  let config = {};
  try {
    config = yaml.load(fs.readFileSync(configPath, "utf-8")) || {};
  } catch (err) {
    if (!options.silent) console.error(`Clawd: failed to parse ${configPath}:`, err.message);
    return { status: "error", reason: "config-parse-failed", message: err.message };
  }

  const hooks = ensureSecurityHooksArray(config);
  if (!hooks) {
    if (!options.silent) console.error("Clawd: config.security.hooks is not usable (incompatible shape)");
    return { status: "error", reason: "config-shape-incompatible" };
  }

  const scriptPath = options.scriptPath ||
    asarUnpackedPath(path.resolve(__dirname, "nano-agent-hook.js").replace(/\\/g, "/"));
  const nodeBin = options.nodeBin !== undefined ? options.nodeBin : (resolveNodeBin() || "node");
  const port = options.port || readRuntimePort() || DEFAULT_SERVER_PORT;
  const permissionUrl = buildPermissionUrl(port);

  // Build desired hook set
  const desired = [];
  for (const event of NANO_COMMAND_HOOK_EVENTS) {
    desired.push(buildCommandHookEntry(nodeBin, scriptPath, event, options));
  }
  for (const event of NANO_HTTP_HOOK_EVENTS) {
    desired.push(buildHttpHookEntry(event, permissionUrl));
  }

  const desiredByName = new Map(desired.map((e) => [e.name, e]));
  let added = 0;
  let updated = 0;
  let skipped = 0;

  // In-place replacement: update existing entries, mark others for addition
  const newHooks = [];
  for (const entry of hooks) {
    if (!isOurEntry(entry)) {
      newHooks.push(entry);
      continue;
    }
    const desiredEntry = desiredByName.get(entry.name);
    if (!desiredEntry) {
      // Stale entry (not in desired set) — skip for uninstall to clean
      continue;
    }
    // Check if update needed (deep structural equality)
    if (JSON.stringify(entry) === JSON.stringify(desiredEntry)) {
      newHooks.push(entry);
      desiredByName.delete(entry.name);
      skipped++;
    } else {
      newHooks.push(desiredEntry);
      desiredByName.delete(entry.name);
      updated++;
    }
  }

  // Add remaining desired entries
  for (const entry of desiredByName.values()) {
    newHooks.push(entry);
    added++;
  }

  config.security.hooks = newHooks;
  writeYamlAtomic(configPath, config);

  if (!options.silent) {
    console.log(`Clawd Nano Agent hooks → ${configPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { status: "ok", added, updated, skipped };
}

/**
 * Unregister Clawd Nano Agent hooks from ~/.config/nano/config.yaml.
 */
function unregisterNanoAgentHooks(options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(configPath)) {
    if (!options.silent) console.log("Clawd: config not found — nothing to uninstall");
    return { status: "skipped", reason: "config-missing" };
  }

  let config = {};
  try {
    config = yaml.load(fs.readFileSync(configPath, "utf-8")) || {};
  } catch (err) {
    if (!options.silent) console.error(`Clawd: failed to parse ${configPath}:`, err.message);
    return { status: "error", reason: "config-parse-failed", message: err.message };
  }

  if (!config.security || !Array.isArray(config.security.hooks)) {
    if (!options.silent) console.log("Clawd: no hooks array found — nothing to uninstall");
    return { status: "skipped", reason: "no-hooks" };
  }

  const before = config.security.hooks.length;
  config.security.hooks = config.security.hooks.filter((entry) => !isOurEntry(entry));
  const removed = before - config.security.hooks.length;

  if (removed > 0) {
    writeYamlAtomic(configPath, config);
    if (!options.silent) {
      console.log(`Clawd: unregistered ${removed} Nano Agent hooks from ${configPath}`);
    }
  } else if (!options.silent) {
    console.log("Clawd: no Nano Agent hooks found — nothing to uninstall");
  }

  return { status: "ok", removed };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  HOOK_NAME_PREFIX,
  NANO_COMMAND_HOOK_EVENTS,
  NANO_HTTP_HOOK_EVENTS,
  registerNanoAgentHooks,
  unregisterNanoAgentHooks,
  quoteForShell,
  buildHookCommand,
  buildCommandHookEntry,
  buildHttpHookEntry,
  ensureSecurityHooksArray,
  isOurEntry,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const isUninstall = args.includes("--uninstall");
  const isRemote = args.includes("--remote");

  try {
    if (isUninstall) {
      unregisterNanoAgentHooks({});
    } else {
      registerNanoAgentHooks({ remote: isRemote });
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
