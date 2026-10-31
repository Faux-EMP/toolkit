console.log("=== TOOLKIT WORKER LOADED ===");
spindle.log.info("Toolkit worker started!");

let cachedUserId = null;
let cachedChatId = null;
let cachedConnectionId = null;

const chatVaultModes = new Map();
let lastKnownVaultMode = "strict";
const memoryFoldersCache = new Map();

function resolveUserId(arg) {
  if (typeof arg === "string" && arg.trim()) return arg.trim();
  if (arg && typeof arg === "object") {
    const candidate = arg.userId || arg.user_id || arg.uid || arg.user?.id;
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

function rememberUserId(uid) {
  if (!uid || typeof uid !== "string" || !uid.trim()) return;
  cachedUserId = uid.trim();
  if (spindle.variables?.global?.set) {
    Promise.resolve(spindle.variables.global.set("toolkit_cached_uid", cachedUserId)).catch(() => { });
  }
}

async function ensureUserId(candidate) {
  const direct = resolveUserId(candidate);
  if (direct) {
    rememberUserId(direct);
    return direct;
  }
  if (cachedUserId) return cachedUserId;
  if (spindle.variables?.global?.get) {
    try {
      const raw = await spindle.variables.global.get("toolkit_cached_uid");
      const val = (raw && typeof raw === "object") ? (raw.value ?? raw.data) : raw;
      if (typeof val === "string" && val.trim()) {
        cachedUserId = val.trim();
        return cachedUserId;
      }
    } catch (e) { }
  }
  return cachedUserId;
}

ensureUserId().catch(() => { });

for (const evt of ["MESSAGE_SENT", "CHAT_SWITCHED", "CHAT_CHANGED", "GENERATION_STARTED"]) {
  spindle.on(evt, (payload, uid) => {
    const resolvedUid = resolveUserId(uid) || resolveUserId(payload);
    if (resolvedUid) rememberUserId(resolvedUid);

    const resolvedCid = resolveChatId(payload);
    if (resolvedCid) cachedChatId = resolvedCid;

    const connId = payload?.connectionId || payload?.connection_id;
    if (connId) cachedConnectionId = connId;
  });
}

async function getActiveChatId(chatId, userId) {
  const direct = resolveChatId(chatId);
  if (direct) return direct;
  const uId = await ensureUserId(userId);
  if (spindle.chats?.getActive) {
    try {
      const active = await spindle.chats.getActive(uId);
      if (active?.id) {
        cachedChatId = active.id;
        return active.id;
      }
    } catch (e) { }
  }
  return cachedChatId;
}

async function getActiveCharacterInfo(chatId, userId) {
  const uId = await ensureUserId(userId);
  const cId = await getActiveChatId(chatId, uId);
  let charName = "Assistant";
  let charId = null;

  if (spindle.chats?.getActive) {
    try {
      const active = await spindle.chats.getActive(uId);
      if (active) {
        charName = active.characterName || active.character_name || active.character?.name || charName;
        charId = active.character_id || active.characterId || active.character?.id || null;
      }
    } catch (e) { }
  }

  if (!charId && cId && spindle.chats?.get) {
    try {
      const chatObj = await spindle.chats.get(cId, uId);
      if (chatObj) {
        charName = chatObj.characterName || chatObj.character_name || chatObj.character?.name || charName;
        charId = chatObj.character_id || chatObj.characterId || chatObj.character?.id || null;
      }
    } catch (e) { }
  }

  return { name: String(charName || "Assistant").trim(), id: charId };
}

async function getVaultMode(chatId, userId) {
  const uId = await ensureUserId(userId);
  const cId = await getActiveChatId(chatId, uId);
  if (cId && chatVaultModes.has(cId)) {
    return chatVaultModes.get(cId);
  }
  if (cId && spindle.variables?.chat?.get) {
    try {
      const raw = await spindle.variables.chat.get(cId, "vault_mode", uId);
      const val = (raw && typeof raw === "object") ? (raw.value ?? raw.data) : raw;
      if (val === "all" || val === "strict") {
        chatVaultModes.set(cId, val);
        lastKnownVaultMode = val;
        return val;
      }
    } catch (e) { }
  }
  return cId ? (chatVaultModes.get(cId) || lastKnownVaultMode) : lastKnownVaultMode;
}

async function setVaultMode(chatId, userId, targetMode) {
  const uId = await ensureUserId(userId);
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
    try { spindle.toast.info(`Toolkit: ${label}`); } catch (e) { }
  } else if (typeof spindle.toast === "function") {
    try { spindle.toast(`Toolkit: ${label}`); } catch (e) { }
  }

  console.log(`=== VAULT MODE CHANGED (Chat: ${cId || "active"}) -> ${nextMode} ===`);
  return { mode: nextMode, label };
}

// === ARCHIVES SYSTEM (Shared 'Archives' + Personal 'Assistant's Archive') ===
async function getGlobalFolders(userId) {
  const uId = await ensureUserId(userId);
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
    } catch (e) { }
  }
  return Object.fromEntries(memoryFoldersCache.entries());
}

function canCharacterAccessFolder(folder, activeCharName) {
  if (!folder) return false;
  const scope = String(folder.scope || "shared").toLowerCase();
  if (scope !== "private" && scope !== "character") return true;
  const owner = String(folder.owner || "Assistant").toLowerCase().trim();
  const current = String(activeCharName || "Assistant").toLowerCase().trim();
  return owner === current;
}

function formatCategoryTag(typeStr) {
  const raw = String(typeStr || "Topic").trim();
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function buildFolderMarkdown(folder) {
  const scopeLabel = (folder.scope === "private" || folder.scope === "character")
    ? `Private (${folder.owner || "Assistant"} Only)`
    : "Shared (Global Archives)";
  const lines = [
    `# ${folder.name}`,
    `**Category:** ${folder.type || "topic"}`,
    `**Access:** ${scopeLabel}`,
    `**Description:** ${folder.description || `Archive dossier for ${folder.name}`}`,
    `**Last Updated:** ${formatTime(folder.updatedAt)}`,
    "",
    "## Compiled Facts"
  ];
  (folder.facts || []).forEach((f, idx) => {
    lines.push(`${idx + 1}. ${f}`);
  });
  return lines.join("\n");
}

async function syncFolderToDatabank(folder, chatId, userId) {
  if (!spindle.databanks) return null;
  const uId = await ensureUserId(userId);
  try {
    const charInfo = await getActiveCharacterInfo(chatId, uId);
    let rawBanks = null;
    try {
      rawBanks = await spindle.databanks.list({ userId: uId }, uId);
    } catch (e1) {
      rawBanks = await spindle.databanks.list(uId);
    }

    const banks = Array.isArray(rawBanks) ? rawBanks : (rawBanks?.databanks || rawBanks?.data || []);

    // Clean up old test databanks automatically
    const legacyNames = [
      "memory folders",
      "toolkit folders",
      "tech & projects",
      "people & characters",
      "oct 23, 2026, 11:24:43 pm's archive",
      "new databank"
    ];
    if (spindle.databanks.delete) {
      for (const b of banks) {
        const bName = String(b.name || "").toLowerCase().trim();
        if (legacyNames.includes(bName)) {
          const bId = b.id || b.databankId;
          if (bId) {
            try { await spindle.databanks.delete(bId, uId); } catch (delErr) { }
            console.log(`=== DELETED LEGACY DATABANK: ${b.name} ===`);
          }
        }
      }
    }

    const isPrivate = folder.scope === "private" || folder.scope === "character";
    const ownerName = folder.owner || charInfo.name || "Assistant";
    const targetBankName = isPrivate ? `${ownerName}'s Archive` : "Archives";
    const targetBankDesc = isPrivate
      ? `Personal, private memory archive exclusively for ${ownerName}.`
      : "Shared global knowledge archives managed by Toolkit.";

    let targetBank = banks.find(b => String(b.name || "").toLowerCase().trim() === targetBankName.toLowerCase());

    if (!targetBank && spindle.databanks.create) {
      if (isPrivate && charInfo.id) {
        targetBank = await spindle.databanks.create({
          name: targetBankName,
          description: targetBankDesc,
          scope: "character",
          scope_id: charInfo.id,
          enabled: false,
          userId: uId
        }, uId);
      } else {
        targetBank = await spindle.databanks.create({
          name: targetBankName,
          description: targetBankDesc,
          scope: "global",
          enabled: false,
          userId: uId
        }, uId);
      }
      console.log(`=== ARCHIVE CREATED: ${targetBankName} ===`);
    }

    const bankId = targetBank?.id || targetBank?.databankId || targetBank?.data?.id;
    if (!bankId) return null;

    const markdown = buildFolderMarkdown(folder);
    const bytes = new TextEncoder().encode(markdown);
    const tag = formatCategoryTag(folder.type);
    const filename = `[${tag}] ${folder.name}.md`;
    const docApi = spindle.databanks.documents;

    if (docApi) {
      let existingDoc = null;
      if (docApi.list) {
        let rawDocs = null;
        try {
          rawDocs = await docApi.list(bankId, { limit: 100, userId: uId }, uId);
        } catch (e2) {
          rawDocs = await docApi.list(bankId, uId);
        }
        const docs = Array.isArray(rawDocs) ? rawDocs : (rawDocs?.data || rawDocs?.documents || []);
        existingDoc = docs.find(d => {
          const dName = String(d.filename || d.name || d.title || "")
            .toLowerCase()
            .replace(/^\[.*?\]\s*/, "")
            .replace(/\.md$/, "");
          return dName === folder.name.toLowerCase();
        });
      }

      if (existingDoc?.id && docApi.delete) {
        try {
          await docApi.delete(existingDoc.id, uId);
        } catch (e3) {
          await docApi.delete(bankId, existingDoc.id, uId);
        }
      }

      if (docApi.create) {
        await docApi.create(bankId, {
          filename,
          mime_type: "text/markdown",
          data: bytes,
          userId: uId
        }, uId);
      }
      console.log(`=== ARCHIVE SYNCED: ${filename} in ${targetBankName} (Bank ID: ${bankId}) ===`);
      return bankId;
    }
  } catch (err) {
    console.warn("Databank sync notice:", err.message, "userId:", uId);
  }
  return null;
}

async function saveMemoryFolder({ chatId, userId, folderName, folderType, folderScope, description, facts, replaceFacts }) {
  const uId = await ensureUserId(userId);
  const cleanName = String(folderName || "").trim();
  if (!cleanName) return null;

  const charInfo = await getActiveCharacterInfo(chatId, uId);
  const key = cleanName.toLowerCase();
  const allFolders = await getGlobalFolders(uId);
  const existing = allFolders[key] || {
    name: cleanName,
    type: folderType || "topic",
    scope: "shared",
    owner: null,
    description: "",
    facts: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  if (folderType) existing.type = folderType;
  if (description) existing.description = description;
  if (folderScope) {
    const s = String(folderScope).toLowerCase().trim();
    existing.scope = (s === "private" || s === "character" || s === "personal") ? "private" : "shared";
    existing.owner = existing.scope === "private" ? charInfo.name : null;
  }

  const incomingFacts = Array.isArray(facts)
    ? facts
    : String(facts || "").split(/\n|\|/).map(s => s.trim()).filter(Boolean);

  if (replaceFacts && incomingFacts.length > 0) {
    existing.facts = [];
  }

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

  if (spindle.variables?.global?.set) {
    try {
      await spindle.variables.global.set("toolkit_folders", JSON.stringify(allFolders), uId);
    } catch (e) {
      console.warn("Global folder save warning:", e.message);
    }
  }

  for (const folderItem of Object.values(allFolders)) {
    await syncFolderToDatabank(folderItem, chatId, uId);
  }

  console.log(`=== ARCHIVE FOLDER SAVED: ${cleanName} [${existing.scope}] (${existing.facts.length} total facts) ===`);
  return existing;
}

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

function summarizeShape(val, depth = 0) {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") {
    return val.length > 120 ? `${val.slice(0, 100)}... [string length: ${val.length}]` : val;
  }
  if (typeof val !== "object") return val;
  if (depth > 5) return Array.isArray(val) ? `[Array(${val.length})]` : "[Object]";
  if (Array.isArray(val)) {
    return val.slice(0, 5).map(item => summarizeShape(item, depth + 1));
  }
  const out = {};
  for (const k of Object.keys(val)) {
    out[k] = summarizeShape(val[k], depth + 1);
  }
  return out;
}

async function inspectSpindle(chatId, userId, payload) {
  const describeObj = (obj) => {
    if (!obj) return null;
    const info = {};
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      info[key] = (val && typeof val === "object") ? Object.keys(val) : typeof val;
    }
    return info;
  };

  const allApis = {};
  for (const k of Object.keys(spindle)) {
    allApis[k] = (spindle[k] && typeof spindle[k] === "object") ? describeObj(spindle[k]) : typeof spindle[k];
  }

  let activeChat = null;
  let chatObj = null;
  let recentMsgs = null;
  try { activeChat = await spindle.chats?.getActive?.(userId); } catch (e) { activeChat = e.message; }
  try { chatObj = chatId ? await spindle.chats?.get?.(chatId, userId) : null; } catch (e) { chatObj = e.message; }
  try {
    const rawMsgs = chatId ? await spindle.chat?.getMessages?.(chatId, userId) : null;
    const arr = Array.isArray(rawMsgs) ? rawMsgs : (rawMsgs?.messages || rawMsgs?.data || []);
    recentMsgs = arr.slice(-4);
  } catch (e) { recentMsgs = e.message; }

  return JSON.stringify({
    spindleKeys: allApis,
    toolPayload: summarizeShape(payload),
    activeChat: summarizeShape(activeChat),
    chatObj: summarizeShape(chatObj),
    recentMessages: summarizeShape(recentMsgs)
  }, null, 2);
}

function formatAttachmentTags(m) {
  const atts = m?.extra?.attachments || m?.attachments || [];
  if (!Array.isArray(atts) || atts.length === 0) return "";
  return atts.map(a => {
    const imgId = a.image_id || a.imageId || a.id || "unknown";
    const dims = (a.width && a.height) ? ` (${a.width}x${a.height})` : "";
    const name = a.name ? ` "${a.name}"` : "";
    return `[Attached Image: ${imgId}${dims}${name}]`;
  }).join(" ");
}

function extractAttachmentIds(m) {
  const atts = m?.extra?.attachments || m?.attachments || [];
  if (!Array.isArray(atts)) return [];
  return atts.map(a => a?.image_id || a?.imageId || a?.id).filter(Boolean);
}

const imageVisionMemCache = new Map();

function isBlindVisionResponse(text) {
  if (!text) return true;
  return /\b(cannot see|can't see|no image|not attached|wasn't attached|didn't attach|upload or attach|provide the image|unable to view|don't see an image|no screenshot|empty response|returned thinking)\b/i.test(text);
}

let lastVisionScanAt = 0;

async function getVisionCacheMap(userId) {
  try {
    const raw = await spindle.variables.global.get("toolkit_image_cache", userId);
    if (raw) {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === "object") {
        const clean = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" && !isBlindVisionResponse(v)) {
            clean[k] = v;
            imageVisionMemCache.set(k, v);
          } else {
            imageVisionMemCache.delete(k);
          }
        }
        return clean;
      }
    }
  } catch (_) { }
  const fallback = {};
  for (const [k, v] of imageVisionMemCache.entries()) {
    if (!isBlindVisionResponse(v)) fallback[k] = v;
  }
  return fallback;
}

async function saveVisionCacheEntry(imageId, description, userId) {
  if (isBlindVisionResponse(description)) return;
  imageVisionMemCache.set(imageId, description);
  try {
    const current = await getVisionCacheMap(userId);
    current[imageId] = description;
    await spindle.variables.global.set("toolkit_image_cache", JSON.stringify(current), userId);
  } catch (_) { }
}

let cachedModelName = null;

async function analyzeImageById(imageId, userId, contextHint = "", searchQuery = "") {
  if (!imageId) return null;
  if (imageVisionMemCache.has(imageId)) {
    const cached = imageVisionMemCache.get(imageId);
    if (!isBlindVisionResponse(cached)) return cached;
    imageVisionMemCache.delete(imageId);
  }

  const persisted = await getVisionCacheMap(userId);
  if (persisted[imageId] && !isBlindVisionResponse(persisted[imageId])) {
    return persisted[imageId];
  }

  const specificUuidMatch = String(searchQuery || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (specificUuidMatch && specificUuidMatch[0].toLowerCase() !== imageId.toLowerCase()) {
    return null;
  }

  if (Date.now() - lastVisionScanAt < 45000) return null;
  lastVisionScanAt = Date.now();

  if (!spindle.images?.readBinary || !spindle.generate) return null;

  try {
    let mimeType = "image/png";
    let imgMeta = null;
    if (spindle.images.get) {
      try {
        imgMeta = await spindle.images.get(imageId, userId);
        if (imgMeta?.mime_type || imgMeta?.mimeType) mimeType = imgMeta.mime_type || imgMeta.mimeType;
      } catch (_) { }
    }

    const bin = await spindle.images.readBinary(imageId, userId);
    if (!bin) return null;
    const base64 = Buffer.from(bin).toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const promptText = "Analyze this image thoroughly. Transcribe all visible text, numbers, labels, logs, code, or UI elements accurately, and provide a clear visual description of the layout, subjects, and details shown.";

    let connId = cachedConnectionId;
    let modelName = cachedModelName;
    if ((!connId || !modelName) && spindle.connections?.list) {
      try {
        const conns = await spindle.connections.list(userId);
        const list = Array.isArray(conns) ? conns : (conns?.data || []);
        const chatConns = list.filter(c => !/embed/i.test(c?.name || "") && !/embed/i.test(c?.model || ""));
        const chosen = chatConns.find(c => c.is_default || c.isDefault) || chatConns.find(c => c.model) || list[0];
        if (chosen?.id) {
          connId = chosen.id;
          cachedConnectionId = connId;
        }
        const resolvedModel = chosen?.model || chosen?.model_id || chosen?.modelId || chosen?.default_model;
        if (resolvedModel) {
          modelName = resolvedModel;
          cachedModelName = resolvedModel;
        }
      } catch (_) { }
    }

    const attObj = {
      id: imageId,
      image_id: imageId,
      name: imgMeta?.name || "image.png",
      mime_type: mimeType,
      type: "image",
      width: imgMeta?.width,
      height: imgMeta?.height,
      data: base64
    };

    const brailleRule = "Use `\u2800` instead of ` ` for spaces in your replies.";

    const multimodalPayload = {
      userId,
      connection_id: connId,
      connectionId: connId,
      model: modelName,
      apiReasoning: false,
      reasoningEffort: "none",
      attachments: [attObj],
      messages: [
        {
          role: "system",
          content: `You are an accurate visual analysis and OCR assistant. Always fulfill the user's request completely.\n\n${brailleRule}`
        },
        {
          role: "user",
          content: [
            { type: "text", text: `${promptText}\n\n${brailleRule}` },
            { type: "image", mimeType, mime_type: mimeType, data: base64, url: dataUrl }
          ],
          attachments: [attObj]
        }
      ]
    };

    await new Promise(r => setTimeout(r, 3000));
    let visionText = "";
    const diagErrors = [];

    try {
      let res = null;
      if (typeof spindle.generate.raw === "function") {
        try {
          res = await spindle.generate.raw(multimodalPayload, userId);
        } catch (eRaw) {
          diagErrors.push(`raw: ${eRaw.message}`);
        }
      }

      visionText = typeof res === "string"
        ? res
        : (res?.content || res?.text || res?.response || res?.output || res?.result || res?.message?.content || res?.choices?.[0]?.message?.content || "");
      visionText = String(visionText || "").replace(/\u2800/g, " ").trim();
    } finally {
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!isBlindVisionResponse(visionText)) {
      await saveVisionCacheEntry(imageId, visionText, userId);
      return visionText;
    }

    return `[Vision filtered/blind: "${visionText.slice(0, 160)}" | diag: ${diagErrors.join(" | ") || "none"} | rawFn: ${String(spindle.generate?.raw || "").slice(0, 240)}]`;
  } catch (err) {
    return `[Vision error: ${err.message}]`;
  }
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
  display_name: "Inline Memory Recall & Archives",
  description: "Search persistent long-term memory, Archives (shared and personal character dossiers), linked Vaults, and past chat records (including searching messages by date/time). Can also create or update an Archive folder using the optional folder_* parameters, or switch Vault Recall Mode using vault_mode.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords, folder names, dates/timestamps, or topics to search (or '__list_folders__' to view accessible Archive folders, '__inspect__' to inspect APIs)."
      },
      vault_mode: {
        type: "string",
        description: "Optional: set to 'strict', 'all', or 'toggle' to change the chat's Vault Recall Mode."
      },
      folder_name: {
        type: "string",
        description: "Optional: name of an Archive folder to create or update (e.g., 'Toolkit', 'Armored Core 1', 'User')."
      },
      folder_type: {
        type: "string",
        description: "Optional: category tag for the file (e.g., 'Project', 'Game', 'Person', 'Lore')."
      },
      folder_scope: {
        type: "string",
        description: "Optional: 'shared' (saves to Global 'Archives' for all characters) or 'private' (saves to personal '<Character>'s Archive' and locks out other characters)."
      },
      folder_description: {
        type: "string",
        description: "Optional: short summary description of what this Archive folder is about."
      },
      folder_facts: {
        type: "array",
        items: { type: "string" },
        description: "Optional: array of detailed, clear bullet-point facts to save into the Archive folder."
      },
      folder_replace: {
        type: "boolean",
        description: "Optional: set to true to completely replace the folder's existing facts list with folder_facts."
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
  const userId = await ensureUserId(resolveUserId(eventUserId) || resolveUserId(payload));

  if (payload.toolName === "web_search") {
    const query = String(payload.args?.query || "").trim();
    console.log("=== WEB SEARCH TRIGGERED ===", query, "userId:", userId);

    await new Promise(r => setTimeout(r, 2000));

    if (spindle.generate?.quiet) {
      let nativeResult = null;
      try {
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
        if (!cachedConnectionId && spindle.connections?.list) {
          try {
            const conns = await spindle.connections.list(userId);
            const list = Array.isArray(conns) ? conns : (conns?.data || []);
            const chosen = list.find(c => c.is_default || c.isDefault) || list.find(c => c.has_api_key) || list[0];
            if (chosen?.id) cachedConnectionId = chosen.id;
          } catch (_) { }
        }
        if (cachedConnectionId) quietReq.connection_id = cachedConnectionId;

        const res = await spindle.generate.quiet(quietReq, userId);
        if (res?.content) {
          nativeResult = `=== WEB SEARCH RESULTS (Native) ===\n${res.content}`;
        }
      } catch (err) {
        console.warn("Quiet native search failed, falling back to SearXNG:", err.message);
      } finally {
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

  const chatId = await getActiveChatId(payload.chatId || payload.chat_id, userId);

  if (query === "__inspect__") {
    return "=== SPINDLE API INSPECTION ===\n" + await inspectSpindle(chatId, userId, payload);
  }

  const charInfo = await getActiveCharacterInfo(chatId, userId);
  const results = [];

  if (folderName) {
    const savedFolder = await saveMemoryFolder({
      chatId,
      userId,
      folderName,
      folderType: payload.args?.folder_type,
      folderScope: payload.args?.folder_scope,
      description: payload.args?.folder_description,
      facts: payload.args?.folder_facts,
      replaceFacts: Boolean(payload.args?.folder_replace)
    });
    if (savedFolder) {
      results.push(`=== ARCHIVE UPDATED: ${savedFolder.name} (${savedFolder.scope === "private" ? `${savedFolder.owner}'s Archive` : "Archives"}) ===\n` + JSON.stringify({
        name: savedFolder.name,
        type: savedFolder.type,
        scope: savedFolder.scope,
        owner: savedFolder.owner,
        description: savedFolder.description,
        totalFacts: savedFolder.facts.length,
        facts: savedFolder.facts,
        lastUpdated: formatTime(savedFolder.updatedAt)
      }, null, 2));
    }
  }

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
  const accessibleFolders = Object.values(allFolders).filter(f => canCharacterAccessFolder(f, charInfo.name));

  if (query === "__list_folders__") {
    if (accessibleFolders.length === 0) return "No Archive folders have been created yet.";
    return "=== ACCESSIBLE ARCHIVE FOLDERS ===\n" + JSON.stringify(accessibleFolders.map(f => ({
      name: f.name,
      type: f.type,
      archive: f.scope === "private" ? `${f.owner}'s Archive` : "Archives",
      description: f.description,
      factCount: f.facts?.length || 0,
      facts: f.facts,
      lastUpdated: formatTime(f.updatedAt)
    })), null, 2);
  }

  const keywords = extractKeywords(query);
  const vaultMode = await getVaultMode(chatId, userId);
  console.log("=== MEMORY RECALL TRIGGERED ===", query, "vaultMode:", vaultMode, "char:", charInfo.name);

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
    results.unshift(`[Vault Recall Mode: ${vaultMode.toUpperCase()} | Active Character: ${charInfo.name} | Accessible Archives: ${accessibleFolders.length} | Searching Vaults (${vaultsToSearch.length}): ${vaultNames} | Active Interlinks: ${interlinkedChatIds.size}]`);

    if (accessibleFolders.length > 0 && keywords.length > 0) {
      const matchedFolders = accessibleFolders.filter(f =>
        matchesKeywords(f.name, keywords) ||
        matchesKeywords(f.description, keywords) ||
        matchesKeywords(JSON.stringify(f.facts || []), keywords)
      );
      if (matchedFolders.length > 0) {
        results.push("=== ARCHIVES (Compiled Dossiers) ===\n" + JSON.stringify(matchedFolders.map(f => ({
          name: f.name,
          type: f.type,
          archive: f.scope === "private" ? `${f.owner}'s Archive` : "Archives",
          description: f.description,
          facts: f.facts,
          lastUpdated: formatTime(f.updatedAt)
        })), null, 2));
      }
    }

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
        const isImgQuery = /\b(screenshot|screenshots|image|images|pic|pics|picture|pictures|photo|attachment|attachments|shown|screen|hud)\b/i.test(query);

        chatMessages.forEach((m, idx) => {
          const msgTime = formatTime(getMsgTimestamp(m)) || "";
          const msgText = typeof m.content === "string" ? m.content : (m.mes || m.text || JSON.stringify(m.content || ""));
          const attTag = formatAttachmentTags(m);
          const hasAtt = Boolean(attTag);

          const followUps = [];
          if (hasAtt) {
            for (let offset = 1; offset <= 3; offset++) {
              const fMsg = chatMessages[idx + offset];
              if (!fMsg) break;
              const fRole = fMsg.role || fMsg.name || (fMsg.is_user ? "User" : "Assistant");
              const fTime = formatTime(getMsgTimestamp(fMsg)) || "";
              const fText = typeof fMsg.content === "string" ? fMsg.content : (fMsg.mes || fMsg.text || "");
              followUps.push({ msgIdx: idx + offset, role: fRole, time: fTime, text: fText });
              if (fRole.toLowerCase().includes("assistant") || fMsg.is_user === false) break;
            }
          }
          const followUpTextCombined = followUps.map(f => f.text).join(" ");

          const combined = `${msgTime} ${attTag} ${msgText} ${followUpTextCombined}`;
          let score = countKeywordMatches(combined, keywords);
          if (isImgQuery && hasAtt) score += keywords.length + 2;

          const minRequired = hasAtt ? 1 : (keywords.length <= 4 ? Math.max(1, keywords.length - 1) : Math.max(2, keywords.length - 2));

          if (score >= minRequired) {
            const role = m.role || m.name || (m.is_user ? "User" : "Assistant");
            let formatted = `[Message #${idx} | Time: ${msgTime} | ${role}]${attTag ? ` ${attTag}` : ""}\n${msgText}`;

            for (const f of followUps) {
              formatted += `\n ↳ [Paired #${f.msgIdx} | Time: ${f.time} | ${f.role}]\n${f.text}`;
            }

            scoredMsgs.push({
              idx,
              score,
              formatted,
              attIds: extractAttachmentIds(m),
              rawText: msgText
            });
          }
        });

        if (scoredMsgs.length > 0) {
          scoredMsgs.sort((a, b) => b.score - a.score || a.idx - b.idx);
          const topItems = scoredMsgs.slice(0, 6);
          const visionCache = await getVisionCacheMap(userId);
          let liveScansUsed = 0;
          const topMsgs = [];

          for (const item of topItems) {
            let block = item.formatted;
            for (const imgId of (item.attIds || [])) {
              if (visionCache[imgId]) {
                block += `\n [Cached Vision OCR (${imgId})]:\n${visionCache[imgId]}`;
              } else if (liveScansUsed < 1 && (isImgQuery || query.toLowerCase().includes(imgId.toLowerCase()))) {
                liveScansUsed++;
                const liveDesc = await analyzeImageById(imgId, userId, item.rawText, query);
                if (liveDesc) {
                  block += `\n [Live Vision OCR (${imgId})]:\n${liveDesc}`;
                }
              }
            }
            topMsgs.push(block);
          }

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