#!/usr/bin/env node
// Merge Clawd Nano Agent hooks into ~/.config/nano/config.yaml (per-event mapping, idempotent)
// Post-PR-210 contract: top-level `hooks:` mapping keyed by PascalCase event names,
// `HookCommand.Id` as canonical ownership field, JSON envelope on stdin.

const fs = require("fs");
const path = require("path");
const os = require("os");
const yaml = require("js-yaml");
const { resolveNodeBin } = require("./server-config");
const { asarUnpackedPath } = require("./json-utils");

const OUR_ID_PREFIX = "clawd-on-desk:";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "nano", "config.yaml");
const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
const PERMISSION_HOOK_TIMEOUT_SECONDS = 600;

// 12 always-on PascalCase events
const NANO_HOOK_EVENTS_BASE = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
];

// Optional events gated on prefs
const NANO_HOOK_EVENTS_OPTIONAL = ["PermissionRequest", "Notification"];

/**
 * Quote a string for POSIX shell (hookservice uses `sh -c`).
 * Single-quote escaping: ' → '\''
 */
function quoteForShell(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Build hook command string for nano-agent.
 * Remote mode prepends CLAWD_REMOTE=1.
 */
function buildHookCommand(node, script, event, options = {}) {
  const quotedNode = quoteForShell(node);
  const quotedScript = quoteForShell(script);
  const quotedEvent = quoteForShell(event);
  const base = `${quotedNode} ${quotedScript} ${quotedEvent}`;
  return options.remote ? `CLAWD_REMOTE=1 ${base}` : base;
}

/**
 * Build a hook entry for the per-event YAML list.
 */
function buildHookEntry(node, script, event, options = {}) {
  const command = buildHookCommand(node, script, event, options);
  const timeout = event === "PermissionRequest"
    ? PERMISSION_HOOK_TIMEOUT_SECONDS
    : DEFAULT_HOOK_TIMEOUT_SECONDS;
  return {
    id: `${OUR_ID_PREFIX}${event}`,
    matcher: "*",
    command,
    timeout,
  };
}

/**
 * Ensure config.hooks is a usable mapping (object, not array/scalar).
 * Creates `config.hooks = {}` if missing.
 * Returns null if config.hooks exists but is not an object mapping.
 */
function ensureHooksMapping(config) {
  if (!config.hooks) {
    config.hooks = {};
    return config.hooks;
  }
  if (typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    return null;
  }
  return config.hooks;
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
 * Check if an entry belongs to Clawd (by id prefix).
 */
function isOurEntry(entry) {
  return !!(entry && entry.id && entry.id.startsWith(OUR_ID_PREFIX));
}

/**
 * Register Nano Agent hooks into ~/.config/nano/config.yaml.
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {boolean} [options.remote]
 * @param {string} [options.configPath]
 * @param {string} [options.scriptPath]
 * @param {string} [options.nodeBin]
 * @param {boolean} [options.permissionsEnabled]
 * @param {boolean} [options.notificationHookEnabled]
 * @returns {{ status: string, added?: number, updated?: number, skipped?: number, removed?: number, reason?: string }}
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

  const mapping = ensureHooksMapping(config);
  if (!mapping) {
    if (!options.silent) console.error("Clawd: config.hooks is not a mapping (incompatible shape)");
    return { status: "error", reason: "config-shape-incompatible" };
  }

  const scriptPath = options.scriptPath ||
    asarUnpackedPath(path.resolve(__dirname, "nano-agent-hook.js").replace(/\\/g, "/"));
  const nodeBin = options.nodeBin !== undefined ? options.nodeBin : (resolveNodeBin() || "node");

  const permissionsEnabled = options.permissionsEnabled !== false;
  const notificationHookEnabled = options.notificationHookEnabled !== false;

  // Build active event list
  const activeEvents = [
    ...NANO_HOOK_EVENTS_BASE,
    ...(permissionsEnabled ? ["PermissionRequest"] : []),
    ...(notificationHookEnabled ? ["Notification"] : []),
  ];

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let removed = 0;

  // Register active events
  for (const event of activeEvents) {
    const list = mapping[event];
    // If value exists but isn't an array → incompatible shape
    if (list !== undefined && !Array.isArray(list)) {
      if (!options.silent) console.error(`Clawd: hooks.${event} is not a list (incompatible shape)`);
      return { status: "error", reason: "config-shape-incompatible" };
    }
    if (!mapping[event]) mapping[event] = [];

    const desiredEntry = buildHookEntry(nodeBin, scriptPath, event, options);
    const existingIdx = mapping[event].findIndex((e) => isOurEntry(e));

    if (existingIdx === -1) {
      mapping[event].push(desiredEntry);
      added++;
    } else if (JSON.stringify(mapping[event][existingIdx]) === JSON.stringify(desiredEntry)) {
      skipped++;
    } else {
      mapping[event][existingIdx] = desiredEntry;
      updated++;
    }
  }

  // Sweep optional events that are now off
  for (const event of NANO_HOOK_EVENTS_OPTIONAL) {
    if (activeEvents.includes(event)) continue;
    if (!Array.isArray(mapping[event])) continue;
    const before = mapping[event].length;
    mapping[event] = mapping[event].filter((e) => !isOurEntry(e));
    removed += before - mapping[event].length;
    if (mapping[event].length === 0) delete mapping[event];
  }

  writeYamlAtomic(configPath, config);

  if (!options.silent) {
    console.log(`Clawd Nano Agent hooks → ${configPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}, removed: ${removed}`);
  }

  return { status: "ok", added, updated, skipped, removed };
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

  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    if (!options.silent) console.log("Clawd: no hooks mapping found — nothing to uninstall");
    return { status: "skipped", reason: "no-hooks" };
  }

  let removed = 0;
  const allEvents = [...NANO_HOOK_EVENTS_BASE, ...NANO_HOOK_EVENTS_OPTIONAL];
  for (const event of allEvents) {
    if (!Array.isArray(config.hooks[event])) continue;
    const before = config.hooks[event].length;
    config.hooks[event] = config.hooks[event].filter((e) => !isOurEntry(e));
    removed += before - config.hooks[event].length;
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }

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
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  PERMISSION_HOOK_TIMEOUT_SECONDS,
  OUR_ID_PREFIX,
  NANO_HOOK_EVENTS_BASE,
  NANO_HOOK_EVENTS_OPTIONAL,
  registerNanoAgentHooks,
  unregisterNanoAgentHooks,
  quoteForShell,
  buildHookCommand,
  buildHookEntry,
  ensureHooksMapping,
  isOurEntry,
  writeYamlAtomic,
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
