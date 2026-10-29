console.log("=== TOOLKIT WORKER LOADED ===");
spindle.log.info("Toolkit worker started!");

let cachedUserId = null;
let cachedChatId = null;
let cachedConnectionId = null;

// In-memory caches so toggles and folders never fail if Spindle storage blinks
const chatVaultModes = new Map();
let lastKnownVaultMode = "strict";
const memoryFoldersCache = new Map();

function resolveUserId(arg) {
 if (typeof arg === "string" && arg.trim()) return arg.trim();
 if (arg && typeof arg === "object") {
  const candidate = arg.userId || arg.user_id || arg.uid || arg.id;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
 }
 return cachedUserId;
}

function resolveChatId(arg) {
 if (typeof arg === "string" && arg.trim()) return arg.trim();
 if (arg && typeof arg === "object") {
  const candidate = arg.chatId || arg.chat_id || arg.id;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
 }
 return cachedChatId;
}

for (const evt of ["MESSAGE_SENT", "CHAT_SWITCHED", "CHAT_CHANGED", "GENERATION_STARTED"]) {
 spindle.on(evt, (payload, uid) => {
  const resolvedUid = resolveUserId(uid) || resolveUserId(payload);
  if (resolvedUid) cachedUserId = resolvedUid;

  const resolvedCid = resolveChatId(payload);
  if (resolvedCid) cachedChatId = resolvedCid;

  const connId = payload?.connectionId || payload?.connection_id;
  if (connId) cachedConnectionId = connId;
 });
}

async function getActiveChatId(chatId, userId) {
 const direct = resolveChatId(chatId);
 if (direct) return direct;
 if (spindle.chats?.getActive) {
  try {
   const active = await spindle.chats.getActive(userId);
   if (active?.id) {
    cachedChatId = active.id;
    return active.id;
   }
  } catch (e) {}
 }
 return cachedChatId;
}

async function getVaultMode(chatId, userId) {
 const cId = await getActiveChatId(chatId, userId);
 if (cId && chatVaultModes.has(cId)) {
  return chatVaultModes.get(cId);
 }
 if (cId && spindle.variables?.chat?.get) {
  try {
   const raw = await spindle.variables.chat.get(cId, "vault_mode", userId);
   const val = (raw && typeof raw === "object") ? (raw.value ?? raw.data) : raw;
   if (val === "all" || val === "strict") {
    chatVaultModes.set(cId, val);
    lastKnownVaultMode = val;
    return val;
   }
  } catch (e) {}
 }
 return cId ? (chatVaultModes.get(cId) || lastKnownVaultMode) : lastKnownVaultMode;
}

async function setVaultMode(chatId, userId, targetMode) {
 const uId = resolveUserId(userId);
 const cId = await getActiveChatId(chatId, uId);
 const current = await getVaultMode(cId, uId);

 const nextMode = (targetMode === "all" || targetMode === "strict")
  ? targetMode
  : (current === "all" ? "strict" : "all");

 lastKnownVaultMode = nextMode;
 if (cId) {
  chatVaultModes.set(cId, nextMode);
  if (spindle.variables?.chat?.set) {
   try {
    await spindle.variables.chat.set(cId, "vault_mode", nextMode, uId);
   } catch (e) {
    console.warn("variables.chat.set warning:", e.message);
   }
  }
 }

 const label = nextMode === "all"
  ? "All Vaults Mode (Searching ALL Vaults in this chat)"
  : "Strict Mode (Searching ONLY attached Vaults in this chat)";

 if (spindle.toast?.info) {
  try { spindle.toast.info(`Toolkit: ${label}`); } catch (e) {}
 } else if (typeof spindle.toast === "function") {
  try { spindle.toast(`Toolkit: ${label}`); } catch (e) {}
 }

 console.log(`=== VAULT MODE CHANGED (Chat: ${cId || "active"}) -> ${nextMode} ===`);
 return { mode: nextMode, label };
}

// === MEMORY FOLDERS SYSTEM (Global Storage + Native Databank Sync) ===
async function getGlobalFolders(userId) {
 const uId = resolveUserId(userId);
 if (spindle.variables?.global?.get) {
  try {
   const raw = await spindle.variables.global.get("toolkit_folders", uId);
   const unwrapped = (raw && typeof raw === "object" && ("value" in raw || "data" in raw))
    ? (raw.value ?? raw.data)
    : raw;
   const parsed = typeof unwrapped === "string" ? JSON.parse(unwrapped) : unwrapped;
   if (parsed && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed)) {
     memoryFoldersCache.set(k, v);
    }
   }
  } catch (e) {}
 }
 return Object.fromEntries(memoryFoldersCache.entries());
}

function buildFolderMarkdown(folder) {
 const lines = [
  `# ${folder.name}`,
  `**Category:** ${folder.type || "topic"}`,
  `**Description:** ${folder.description || `Memory Folder for ${folder.name}`}`,
  `**Last Updated:** ${formatTime(folder.updatedAt)}`,
  "",
  "## Compiled Facts"
 ];
 (folder.facts || []).forEach((f, idx) => {
  lines.push(`${idx + 1}. ${f}`);
 });
 return lines.join("\n");
}

async function syncFolderToDatabank(folder, userId) {
 if (!spindle.databanks) return null;
 try {
  const rawBanks = await spindle.databanks.list(userId);
  const banks = Array.isArray(rawBanks) ? rawBanks : (rawBanks?.databanks || rawBanks?.data || []);
  let targetBank = banks.find(b => String(b.name || "").toLowerCase() === "memory folders" || String(b.name || "").toLowerCase() === "toolkit folders");

  if (!targetBank && spindle.databanks.create) {
   targetBank = await spindle.databanks.create({
    name: "Memory Folders",
    description: "Compiled topic dossiers managed by Assistant's Toolkit.",
    scope: "global",
    userId
   }, userId);
  }

  const bankId = targetBank?.id || targetBank?.databankId;
  if (!bankId) return null;

  const markdown = buildFolderMarkdown(folder);
  const docApi = spindle.databanks.documents || spindle.databanks.files || spindle.databanks.entries;

  if (docApi) {
   let existingDoc = null;
   if (docApi.list) {
    const rawDocs = await docApi.list(bankId, userId);
    const docs = Array.isArray(rawDocs) ? rawDocs : (rawDocs?.documents || rawDocs?.files || rawDocs?.data || []);
    existingDoc = docs.find(d => {
     const dName = String(d.title || d.name || d.filename || "").toLowerCase().replace(/\.md$/, "");
     return dName === folder.name.toLowerCase();
    });
   }

   if (existingDoc?.id && docApi.update) {
    await docApi.update(bankId, existingDoc.id, {
     title: folder.name,
     name: `${folder.name}.md`,
     filename: `${folder.name}.md`,
     content: markdown,
     userId
    }, userId);
   } else if (docApi.create) {
    await docApi.create(bankId, {
     title: folder.name,
     name: `${folder.name}.md`,
     filename: `${folder.name}.md`,
     content: markdown,
     userId
    }, userId);
   }
   console.log(`=== DATABANK SYNCED: ${folder.name} in Memory Folders ===`);
   return bankId;
  }
 } catch (err) {
  console.warn("Databank sync notice:", err.message);
 }
 return null;
}

async function saveMemoryFolder({ chatId, userId, folderName, folderType, description, facts }) {
 const uId = resolveUserId(userId);
 const cleanName = String(folderName || "").trim();
 if (!cleanName) return null;

 const key = cleanName.toLowerCase();
 const allFolders = await getGlobalFolders(uId);
 const existing = allFolders[key] || {
  name: cleanName,
  type: folderType || "topic",
  description: "",
  facts: [],
  createdAt: Date.now(),
  updatedAt: Date.now()
 };

 if (folderType) existing.type = folderType;
 if (description) existing.description = description;

 const incomingFacts = Array.isArray(facts)
  ? facts
  : String(facts || "").split(/\n|\|/).map(s => s.trim()).filter(Boolean);

 const seen = new Set((existing.facts || []).map(f => String(f).toLowerCase().trim()));
 for (const f of incomingFacts) {
  const trimmed = String(f).trim();
  if (trimmed && !seen.has(trimmed.toLowerCase())) {
   existing.facts.push(trimmed);
   seen.add(trimmed.toLowerCase());
  }
 }
 existing.updatedAt = Date.now();

 memoryFoldersCache.set(key, existing);
 allFolders[key] = existing;

 // 1. Save to Global Variables (persists across ALL chats automatically)
 if (spindle.variables?.global?.set) {
  try {
   await spindle.variables.global.set("toolkit_folders", JSON.stringify(allFolders), uId);
  } catch (e) {
   console.warn("Global folder save warning:", e.message);
  }
 }

 // 2. Sync to Lumiverse Native Databanks for UI viewing/management
 await syncFolderToDatabank(existing, uId);

 console.log(`=== MEMORY FOLDER SAVED: ${cleanName} (${existing.facts.length} total facts) ===`);
 return existing;
}

// 1. Register Command Palette Toggle
if (spindle.commands?.register) {
 try {
  spindle.commands.register([
   {
    id: "toggle-vault-mode",
    label: "Toolkit: Toggle Vault Recall Mode (Strict / All Vaults)",
    description: "Switch the current chat between searching only attached Vaults or all Vaults.",
    keywords: ["vault", "memory", "toggle", "strict", "all"],
    scope: "chat"
   }
  ]);

  spindle.commands.onInvoked(async (commandId, context) => {
   if (commandId === "toggle-vault-mode") {
    await setVaultMode(resolveChatId(context), resolveUserId(context), "toggle");
   }
  });
 } catch (err) {
  console.warn("Command registration failed:", err.message);
 }
}

// 2. Listen for Extras Popover button clicks from frontend.js
if (spindle.onFrontendMessage) {
 spindle.onFrontendMessage(async (msg, contextOrUid) => {
  if (msg?.type === "TOGGLE_VAULT_MODE") {
   const uId = resolveUserId(contextOrUid) || resolveUserId(msg);
   const cId = resolveChatId(msg) || resolveChatId(contextOrUid);
   await setVaultMode(cId, uId, "toggle");
  }
 });
}

function extractKeywords(query) {
 return String(query || "")
  .toLowerCase()
  .replace(/__(toggle|all|strict)_vaults__|__list_folders__/g, " ")
  .replace(/[,?!;."']/g, " ")
  .split(/\s+/)
  .filter(Boolean);
}

function matchesKeywords(text, keywords) {
 const lower = String(text || "").toLowerCase();
 return keywords.some(k => lower.includes(k));
}

function countKeywordMatches(text, keywords) {
 const lower = String(text || "").toLowerCase();
 let count = 0;
 for (const k of keywords) {
  if (lower.includes(k)) count++;
 }
 return count;
}

function formatTime(val) {
 if (!val) return null;
 const raw = Array.isArray(val) ? val[0] : val;
 if (!raw) return null;
 const num = Number(raw);
 const normalized = (!isNaN(num) && num > 0 && num < 1e11) ? num * 1000 : raw;
 const d = new Date(normalized);
 if (isNaN(d.getTime())) return String(raw);
 return d.toLocaleString("en-US", {
  timeZone: "Asia/Jakarta",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true
 });
}

function getMsgTimestamp(m) {
 if (!m) return null;
 return m.created_at ?? m.timestamp ?? m.createdAt ?? m.send_date ?? m.sentAt ?? m.timeRange?.[0] ?? m.updated_at ?? m.updatedAt ?? null;
}

function getChunkStartIdx(c) {
 if (!c) return undefined;
 if (Array.isArray(c.messageRange) && c.messageRange.length > 0) return c.messageRange[0];
 if (Array.isArray(c.message_range) && c.message_range.length > 0) return c.message_range[0];
 return c.startMessageIndex ?? c.messageStart ?? c.startIndex ?? c.metadata?.startIndex ?? c.messageIndex;
}

function getChunkEndIdx(c) {
 if (!c) return undefined;
 if (Array.isArray(c.messageRange) && c.messageRange.length > 1) return c.messageRange[1];
 if (Array.isArray(c.message_range) && c.message_range.length > 1) return c.message_range[1];
 return c.endMessageIndex ?? c.messageEnd ?? c.endIndex ?? c.metadata?.endIndex;
}

function inspectSpindle() {
 const describeObj = (obj) => {
  if (!obj) return null;
  const info = {};
  for (const key of Object.keys(obj)) {
   const val = obj[key];
   if (val && typeof val === "object") {
    info[key] = Object.keys(val);
   } else {
    info[key] = typeof val;
   }
  }
  return info;
 };

 return JSON.stringify({
  spindleRoot: Object.keys(spindle),
  databanks: describeObj(spindle.databanks),
  memories: describeObj(spindle.memories),
  chats: describeObj(spindle.chats),
  chat: describeObj(spindle.chat),
  connections: describeObj(spindle.connections),
  generate: describeObj(spindle.generate),
  images: describeObj(spindle.images),
  variables: describeObj(spindle.variables),
  ui: describeObj(spindle.ui)
 }, null, 2);
}

function isUsefulEntity(e) {
 if (!e) return false;
 if (Array.isArray(e.facts) && e.facts.length > 0) return true;
 return false;
}

function cleanEntity(e) {
 const item = {
  name: e.name,
  type: e.entityType || e.type
 };
 if (e.aliases?.length) item.aliases = e.aliases;
 if (e.description) item.description = e.description;
 if (e.facts?.length) item.facts = e.facts;

 const msgs = e.messageIndices || e.messages || [];
 if (Array.isArray(msgs) && msgs.length > 0) {
  const nums = msgs.map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (nums.length > 0) {
   item.messageRange = `#${nums[0]} to #${nums[nums.length - 1]} (${nums.length} mentions, latest: #${nums[nums.length - 1]})`;
  }
 } else if (e.mentionCount) {
  item.mentions = e.mentionCount;
 }

 const firstTime = formatTime(e.created_at || e.createdAt || e.firstSeenAt);
 const lastTime = formatTime(e.updated_at || e.updatedAt || e.lastSeenAt || e.lastMentionedAt);
 if (firstTime) item.firstRecorded = firstTime;
 if (lastTime && lastTime !== firstTime) item.lastUpdated = lastTime;

 return item;
}

function formatAndSortChunks(chunks) {
 const sorted = [...chunks].sort((a, b) => {
  const idxA = getChunkStartIdx(a) ?? a.chunkIndex ?? a.index ?? 0;
  const idxB = getChunkStartIdx(b) ?? b.chunkIndex ?? b.index ?? 0;
  if (idxA !== idxB) return idxA - idxB;
  const tA = Number(Array.isArray(a.timeRange) ? a.timeRange[0] : (a.timestamp || a.created_at || a.createdAt || 0));
  const tB = Number(Array.isArray(b.timeRange) ? b.timeRange[0] : (b.timestamp || b.created_at || b.createdAt || 0));
  return tA - tB;
 });

 return sorted.map((c, i) => {
  const parts = [];
  const cIdx = c.chunkIndex ?? c.index;
  if (cIdx !== undefined) parts.push(`Chunk #${cIdx}`);

  const startMsg = getChunkStartIdx(c);
  const endMsg = getChunkEndIdx(c);
  if (startMsg !== undefined && endMsg !== undefined) {
   parts.push(startMsg === endMsg ? `Message #${startMsg}` : `Messages #${startMsg}-#${endMsg}`);
  } else if (startMsg !== undefined) {
   parts.push(`Message #${startMsg}`);
  }

  const timeStr = formatTime(c.timestamp || c.timeRange || c.created_at || c.createdAt || c.updatedAt);
  if (timeStr) parts.push(`Time: ${timeStr}`);

  const header = parts.length > 0 ? `[${parts.join(" | ")}]\n` : `[Excerpt #${i + 1}]\n`;
  return header + (c.content || c.text || "");
 });
}

spindle.registerTool({
 name: "recall_memory",
 display_name: "Inline Memory Recall & Folders",
 description: "Search persistent long-term memory, Memory Folders, Databanks, linked Vaults, and past chat records (including searching messages by date/time). Can also create or update a Memory Folder using the optional folder_* parameters, or switch Vault Recall Mode using vault_mode.",
 parameters: {
  type: "object",
  properties: {
   query: {
    type: "string",
    description: "Keywords, folder names, dates/timestamps, or topics to search (or '__list_folders__' to view all Memory Folders, '__inspect__' to inspect APIs)."
   },
   vault_mode: {
    type: "string",
    description: "Optional: set to 'strict', 'all', or 'toggle' to change the chat's Vault Recall Mode."
   },
   folder_name: {
    type: "string",
    description: "Optional: name of a Memory Folder to create or update with new facts (e.g., 'Toolkit', 'Armored Core 1')."
   },
   folder_type: {
    type: "string",
    description: "Optional: category for the folder (e.g., 'project', 'topic', 'character', 'game')."
   },
   folder_description: {
    type: "string",
    description: "Optional: short summary description of what this Memory Folder is about."
   },
   folder_facts: {
    type: "array",
    items: { type: "string" },
    description: "Optional: array of detailed, clear bullet-point facts to append into the specified Memory Folder."
   }
  },
  required: ["query"]
 },
 council_eligible: true,
 inline_available: true
});

spindle.registerTool({
 name: "web_search",
 display_name: "Inline Web Search",
 description: "Search the live web for up-to-date information, news, documentation, or factual verification.",
 parameters: {
  type: "object",
  properties: {
   query: {
    type: "string",
    description: "The search query to look up on the web."
   }
  },
  required: ["query"]
 },
 council_eligible: true,
 inline_available: true
});

spindle.on("TOOL_INVOCATION", async (payload, eventUserId) => {
 const userId = resolveUserId(eventUserId) || resolveUserId(payload);

 if (payload.toolName === "web_search") {
  const query = String(payload.args?.query || "").trim();
  console.log("=== WEB SEARCH TRIGGERED ===", query, "userId:", userId);

  // 2-second buffer BEFORE Request #2 so Request #1 fully closes on the proxy
  await new Promise(r => setTimeout(r, 2000));

  if (spindle.generate?.quiet) {
   let nativeResult = null;
   try {
    let connId = cachedConnectionId;
    if (!connId && spindle.connections?.list) {
     const conns = await spindle.connections.list(userId);
     const list = Array.isArray(conns) ? conns : (conns?.data || []);
     const chosen = list.find(c => c.is_default || c.isDefault) || list.find(c => c.has_api_key) || list[0];
     if (chosen?.id) connId = chosen.id;
    }

    const quietReq = {
     userId,
     messages: [
      {
       role: "system",
       content: "Search the web and provide a detailed, factual summary with source names and URLs if available."
      },
      {
       role: "user",
       content: query
      }
     ]
    };
    if (connId) quietReq.connection_id = connId;

    const res = await spindle.generate.quiet(quietReq, userId);
    if (res?.content) {
     nativeResult = `=== WEB SEARCH RESULTS (Native) ===\n${res.content}`;
    }
   } catch (err) {
    console.warn("Quiet native search failed, falling back to SearXNG:", err.message);
   } finally {
    // 2-second buffer AFTER Request #2 so the proxy unlocks before Lumiverse fires Request #3
    await new Promise(r => setTimeout(r, 2000));
   }

   if (nativeResult) return nativeResult;
  }

  if (spindle.webSearch?.query) {
   try {
    const search = await spindle.webSearch.query({ query, count: 5, userId }, userId);
    return `=== WEB SEARCH RESULTS (SearXNG) ===\n${search.context || JSON.stringify(search, null, 2)}`;
   } catch (err) {
    return `Web search error: ${err.message}`;
   }
  }

  return "Web search unavailable: ensure 'generation' or 'web_search' permission is granted to the extension.";
 }

 if (payload.toolName !== "recall_memory") return;

 const query = String(payload.args?.query || "").trim();
 const requestedMode = String(payload.args?.vault_mode || "").trim().toLowerCase();
 const folderName = String(payload.args?.folder_name || "").trim();

 if (query === "__inspect__") {
  return "=== SPINDLE API INSPECTION ===\n" + inspectSpindle();
 }

 const chatId = await getActiveChatId(payload.chatId || payload.chat_id, userId);
 const results = [];

 // Handle Memory Folder creation / updating in the exact same tool call
 if (folderName) {
  const savedFolder = await saveMemoryFolder({
   chatId,
   userId,
   folderName,
   folderType: payload.args?.folder_type,
   description: payload.args?.folder_description,
   facts: payload.args?.folder_facts
  });
  if (savedFolder) {
   results.push(`=== FOLDER UPDATED: ${savedFolder.name} ===\n` + JSON.stringify({
    name: savedFolder.name,
    type: savedFolder.type,
    description: savedFolder.description,
    totalFacts: savedFolder.facts.length,
    facts: savedFolder.facts,
    lastUpdated: formatTime(savedFolder.updatedAt)
   }, null, 2));
  }
 }

 // Handle explicit Vault mode changes
 if (requestedMode === "all" || query.includes("__all_vaults__")) {
  const res = await setVaultMode(chatId, userId, "all");
  if (query === "__all_vaults__" && !folderName) return res.label;
 } else if (requestedMode === "strict" || query.includes("__strict_vaults__")) {
  const res = await setVaultMode(chatId, userId, "strict");
  if (query === "__strict_vaults__" && !folderName) return res.label;
 } else if (requestedMode === "toggle" || query.includes("__toggle_vaults__")) {
  const res = await setVaultMode(chatId, userId, "toggle");
  if (query === "__toggle_vaults__" && !folderName) return res.label;
 }

 const allFolders = await getGlobalFolders(userId);
 const folderList = Object.values(allFolders);

 if (query === "__list_folders__") {
  if (folderList.length === 0) return "No Memory Folders have been created yet.";
  return "=== ALL MEMORY FOLDERS ===\n" + JSON.stringify(folderList.map(f => ({
   name: f.name,
   type: f.type,
   description: f.description,
   factCount: f.facts?.length || 0,
   facts: f.facts,
   lastUpdated: formatTime(f.updatedAt)
  })), null, 2);
 }

 const keywords = extractKeywords(query);
 const vaultMode = await getVaultMode(chatId, userId);
 console.log("=== MEMORY RECALL TRIGGERED ===", query, "vaultMode:", vaultMode, "userId:", userId);

 try {
  const attachedLinks = (chatId && spindle.memories?.links?.list)
   ? await spindle.memories.links.list(chatId, userId)
   : [];
  const activeLinks = (attachedLinks || []).filter(l => l.enabled !== false);

  const allVaults = spindle.memories?.vaults?.list
   ? await spindle.memories.vaults.list(userId)
   : [];
  const vaultIdMap = new Map((allVaults || []).map(v => [v.id, v]));

  const attachedVaults = [];
  const interlinkedChatIds = new Set();

  for (const link of activeLinks) {
   const vId = link.vaultId || link.targetVaultId || link.sourceVaultId || (vaultIdMap.has(link.targetId) ? link.targetId : null);
   if (vId && vaultIdMap.has(vId)) {
    attachedVaults.push(vaultIdMap.get(vId));
    continue;
   }
   const cId = link.targetChatId || link.linkedChatId || link.sourceChatId || link.targetId || (link.chatId !== chatId ? link.chatId : null);
   if (cId && cId !== chatId && !vaultIdMap.has(cId)) {
    interlinkedChatIds.add(cId);
   }
  }

  const vaultsToSearch = vaultMode === "all" ? (allVaults || []) : attachedVaults;
  const vaultNames = vaultsToSearch.map(v => v.name).join(", ") || "None";
  results.unshift(`[Vault Recall Mode: ${vaultMode.toUpperCase()} | Memory Folders: ${folderList.length} | Searching Vaults (${vaultsToSearch.length}): ${vaultNames} | Active Interlinks: ${interlinkedChatIds.size}]`);

  // 0. Search Global Memory Folders first!
  if (folderList.length > 0 && keywords.length > 0) {
   const matchedFolders = folderList.filter(f =>
    matchesKeywords(f.name, keywords) ||
    matchesKeywords(f.description, keywords) ||
    matchesKeywords(JSON.stringify(f.facts || []), keywords)
   );
   if (matchedFolders.length > 0) {
    results.push("=== MEMORY FOLDERS (Global Dossiers) ===\n" + JSON.stringify(matchedFolders.map(f => ({
     name: f.name,
     type: f.type,
     description: f.description,
     facts: f.facts,
     lastUpdated: formatTime(f.updatedAt)
    })), null, 2));
   }
  }

  // 1. Current chat entities (filtered to skip empty heuristic junk)
  if (chatId && spindle.memories?.entities?.list && keywords.length > 0) {
   const localEntities = await spindle.memories.entities.list(chatId, {
    activeOnly: false,
    userId
   });
   const matchedLocal = (localEntities || [])
    .filter(isUsefulEntity)
    .filter(e => matchesKeywords(e.name, keywords) || matchesKeywords(JSON.stringify(e.facts || []), keywords) || matchesKeywords(e.description, keywords))
    .map(cleanEntity);

   if (matchedLocal.length > 0) {
    results.push("=== CURRENT CHAT ENTITIES ===\n" + JSON.stringify(matchedLocal, null, 2));
   }
  }

  // 2. Search Vaults
  for (const v of vaultsToSearch) {
   if (keywords.length === 0) break;
   const fullVault = await spindle.memories.vaults.get(v.id, userId);
   const vaultTime = formatTime(fullVault?.created_at || fullVault?.createdAt || v.created_at || v.createdAt);
   const vaultLabel = vaultTime ? `${v.name} | Snapshot: ${vaultTime}` : v.name;

   const matchedEntities = (fullVault?.entities || [])
    .filter(isUsefulEntity)
    .filter(e => matchesKeywords(e.name, keywords) || matchesKeywords(JSON.stringify(e.facts || []), keywords) || matchesKeywords(e.description, keywords))
    .map(cleanEntity);

   if (matchedEntities.length > 0) {
    results.push(`=== VAULT ENTITIES (${vaultLabel}) ===\n` + JSON.stringify(matchedEntities, null, 2));
   }

   if (spindle.memories.vaults.getChunks) {
    const chunks = await spindle.memories.vaults.getChunks(v.id, userId);
    const matchedChunks = (chunks || [])
     .map(c => ({ c, score: countKeywordMatches(c.content || c.text, keywords) }))
     .filter(item => item.score > 0)
     .sort((a, b) => b.score - a.score)
     .slice(0, 6)
     .map(item => item.c);
    if (matchedChunks.length > 0) {
     const formattedChunks = formatAndSortChunks(matchedChunks);
     results.push(`=== VAULT CHAT CHUNKS (${vaultLabel}) ===\n` + formattedChunks.join("\n---\n"));
    }
   }
  }

  // 3. Search Interlinked Chats
  for (const linkedChatId of interlinkedChatIds) {
   if (keywords.length === 0) break;
   if (spindle.memories?.entities?.list) {
    const linkedEntities = await spindle.memories.entities.list(linkedChatId, {
     activeOnly: false,
     userId
    });
    const matchedEntities = (linkedEntities || [])
     .filter(isUsefulEntity)
     .filter(e => matchesKeywords(e.name, keywords) || matchesKeywords(JSON.stringify(e.facts || []), keywords) || matchesKeywords(e.description, keywords))
     .map(cleanEntity);

    if (matchedEntities.length > 0) {
     results.push(`=== INTERLINKED CHAT ENTITIES (Chat: ${linkedChatId}) ===\n` + JSON.stringify(matchedEntities, null, 2));
    }
   }

   let chatMessages = [];
   if (spindle.chat?.getMessages) {
    try {
     const rawMsgs = await spindle.chat.getMessages(linkedChatId, userId);
     chatMessages = Array.isArray(rawMsgs) ? rawMsgs : (rawMsgs?.messages || rawMsgs?.data || []);
    } catch (err) {
     console.warn("spindle.chat.getMessages failed:", err.message);
    }
   }

   if (chatMessages.length > 0) {
    const scoredMsgs = [];
    chatMessages.forEach((m, idx) => {
     const msgTime = formatTime(getMsgTimestamp(m)) || "";
     const msgText = typeof m.content === "string" ? m.content : (m.mes || m.text || JSON.stringify(m.content || ""));
     const combined = `${msgTime} ${msgText}`;
     const score = countKeywordMatches(combined, keywords);
     const minRequired = keywords.length <= 4 ? keywords.length : Math.max(2, keywords.length - 1);
     if (score >= minRequired) {
      const role = m.role || m.name || (m.is_user ? "User" : "Assistant");
      scoredMsgs.push({
       idx,
       score,
       formatted: `[Message #${idx} | Time: ${msgTime} | ${role}]\n${msgText}`
      });
     }
    });

    if (scoredMsgs.length > 0) {
     scoredMsgs.sort((a, b) => b.score - a.score || a.idx - b.idx);
     const topMsgs = scoredMsgs.slice(0, 6).map(item => item.formatted);
     results.push(`=== INTERLINKED MESSAGES (Chat: ${linkedChatId}) ===\n` + topMsgs.join("\n---\n"));
    }
   }

   if (spindle.memories?.chatMemory?.listChunks) {
    const rawChunks = await spindle.memories.chatMemory.listChunks(linkedChatId, userId);
    const chatChunks = Array.isArray(rawChunks) ? rawChunks : (rawChunks?.chunks || []);
    const enrichedChunks = chatChunks.map(c => {
     const startIdx = getChunkStartIdx(c);
     const realMsg = (startIdx !== undefined && chatMessages[startIdx]) ? chatMessages[startIdx] : null;
     const realTime = getMsgTimestamp(realMsg);
     return realTime ? { ...c, timestamp: realTime } : c;
    });

    const matchedChunks = enrichedChunks
     .map(c => {
      const timeStr = formatTime(c.timestamp || c.timeRange || c.created_at || c.createdAt || c.updatedAt) || "";
      const score = countKeywordMatches(`${timeStr} ${c.content || c.text || ""}`, keywords);
      return { c, score };
     })
     .filter(item => item.score > 0)
     .sort((a, b) => b.score - a.score)
     .slice(0, 6)
     .map(item => item.c);

    if (matchedChunks.length > 0) {
     const formattedChunks = formatAndSortChunks(matchedChunks);
     results.push(`=== INTERLINKED CHAT CHUNKS (Chat: ${linkedChatId}) ===\n` + formattedChunks.join("\n---\n"));
    }
   }
  }

  if (results.length <= 1) {
   return `${results[0]}\nNo matching memories found for "${query}".`;
  }
  return results.join("\n\n");
 } catch (error) {
  console.error("Memory recall error:", error);
  return "Memory search encountered an error: " + error.message;
 }
});