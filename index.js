console.log("=== TOOLKIT WORKER LOADED ===");
spindle.log.info("Toolkit worker started!");

let cachedUserId = null;
let cachedChatId = null;
let cachedConnectionId = null;

for (const evt of ["MESSAGE_SENT", "CHAT_SWITCHED", "CHAT_CHANGED", "GENERATION_STARTED"]) {
 spindle.on(evt, (payload, uid) => {
  if (uid) cachedUserId = uid;
  else if (payload?.userId) cachedUserId = payload.userId;
  if (payload?.chatId) cachedChatId = payload.chatId;
  if (payload?.connectionId) cachedConnectionId = payload.connectionId;
 });
}

function extractKeywords(query) {
 return String(query || "")
  .toLowerCase()
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
 const num = Number(val);
 // Fix 1970 bug: convert Unix seconds to milliseconds if under 100 billion
 const normalized = (!isNaN(num) && num > 0 && num < 1e11) ? num * 1000 : val;
 const d = new Date(normalized);
 if (isNaN(d.getTime())) return String(val);
 return d.toLocaleString("en-US", {
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
 return m.created_at ?? m.timestamp ?? m.createdAt ?? m.send_date ?? m.sentAt ?? m.updated_at ?? m.updatedAt ?? null;
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
  const idxA = a.chunkIndex ?? a.startMessageIndex ?? a.startIndex ?? a.metadata?.startIndex ?? a.index ?? 0;
  const idxB = b.chunkIndex ?? b.startMessageIndex ?? b.startIndex ?? b.metadata?.startIndex ?? b.index ?? 0;
  if (idxA !== idxB) return idxA - idxB;
  const tA = new Date(a.timestamp || a.created_at || a.createdAt || 0).getTime() || 0;
  const tB = new Date(b.timestamp || b.created_at || b.createdAt || 0).getTime() || 0;
  return tA - tB;
 });

 return sorted.map((c, i) => {
  const parts = [];
  const cIdx = c.chunkIndex ?? c.index;
  if (cIdx !== undefined) parts.push(`Chunk #${cIdx}`);

  const startMsg = c.startMessageIndex ?? c.messageStart ?? c.startIndex ?? c.metadata?.startIndex;
  const endMsg = c.endMessageIndex ?? c.messageEnd ?? c.endIndex ?? c.metadata?.endIndex;
  if (startMsg !== undefined && endMsg !== undefined) {
   parts.push(`Messages #${startMsg}-#${endMsg}`);
  } else if (c.messageIndex !== undefined) {
   parts.push(`Message #${c.messageIndex}`);
  }

  const timeStr = formatTime(c.timestamp || c.created_at || c.createdAt || c.updatedAt);
  if (timeStr) parts.push(`Time: ${timeStr}`);

  const header = parts.length > 0 ? `[${parts.join(" | ")}]\n` : `[Excerpt #${i + 1}]\n`;
  return header + (c.content || c.text || "");
 });
}

spindle.registerTool({
 name: "recall_memory",
 display_name: "Inline Memory Recall",
 description: "Search persistent long-term memory, current chat entities, linked Vaults, and past chat records (including searching messages by date/time). Call this tool whenever the user asks what you remember about past events, previous chats, specific timestamps, projects, people, or entity facts.",
 parameters: {
  type: "object",
  properties: {
   query: {
    type: "string",
    description: "Specific keywords, entity names, dates/timestamps, or topics to search for in memory (or '__inspect__' to inspect Spindle APIs)."
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
 const userId = eventUserId || payload?.userId || cachedUserId;

 if (payload.toolName === "web_search") {
  const query = String(payload.args?.query || "").trim();
  console.log("=== WEB SEARCH TRIGGERED ===", query, "userId:", userId);

  // 1. Resolve active/default connection profile for spindle.generate.quiet
  if (spindle.generate?.quiet) {
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
     return `=== WEB SEARCH RESULTS (Native) ===\n${res.content}`;
    }
   } catch (err) {
    console.warn("Quiet native search failed, falling back to SearXNG:", err.message);
   }
  }

  // 2. Fallback to Lumiverse's built-in SearXNG integration
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
 if (query === "__inspect__") {
  return "=== SPINDLE API INSPECTION ===\n" + inspectSpindle();
 }

 const keywords = extractKeywords(query);
 console.log("=== MEMORY RECALL TRIGGERED ===", query, "keywords:", keywords, "userId:", userId);

 try {
  const activeChat = await spindle.chats.getActive(userId);
  const chatId = payload.chatId || activeChat?.id || cachedChatId;
  const results = [];

  if (chatId && spindle.memories?.entities?.list) {
   const localEntities = await spindle.memories.entities.list(chatId, {
    activeOnly: false,
    userId
   });
   const matchedLocal = (localEntities || [])
    .filter(e => matchesKeywords(e.name, keywords) || matchesKeywords(JSON.stringify(e.facts || []), keywords) || matchesKeywords(e.description, keywords))
    .map(cleanEntity);

   if (matchedLocal.length > 0) {
    results.push("=== CURRENT CHAT ENTITIES ===\n" + JSON.stringify(matchedLocal, null, 2));
   }
  }

  if (chatId && spindle.memories?.cortex?.queryLinked) {
   const linked = await spindle.memories.cortex.queryLinked(chatId, {
    queryText: query,
    userId
   });
   const hasLinkedData = (linked?.vaults?.length > 0) || (linked?.interlinks?.length > 0);
   if (hasLinkedData) {
    results.push("=== LINKED Cortex MEMORIES ===\n" + JSON.stringify(linked, null, 2));
   }
  }

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

  for (const v of attachedVaults) {
   const fullVault = await spindle.memories.vaults.get(v.id, userId);
   const vaultTime = formatTime(fullVault?.created_at || fullVault?.createdAt || v.created_at || v.createdAt);
   const vaultLabel = vaultTime ? `${v.name} | Snapshot: ${vaultTime}` : v.name;

   const matchedEntities = (fullVault?.entities || [])
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
   if (spindle.memories?.entities?.list) {
    const linkedEntities = await spindle.memories.entities.list(linkedChatId, {
     activeOnly: false,
     userId
    });
    const matchedEntities = (linkedEntities || [])
     .filter(e => matchesKeywords(e.name, keywords) || matchesKeywords(JSON.stringify(e.facts || []), keywords) || matchesKeywords(e.description, keywords))
     .map(cleanEntity);

    if (matchedEntities.length > 0) {
     results.push(`=== INTERLINKED CHAT ENTITIES (Chat: ${linkedChatId}) ===\n` + JSON.stringify(matchedEntities, null, 2));
    }
   }

   // Fetch raw messages via chat_mutation permission for true per-message timestamps
   let chatMessages = [];
   if (spindle.chat?.getMessages) {
    try {
     const rawMsgs = await spindle.chat.getMessages(linkedChatId, userId);
     chatMessages = Array.isArray(rawMsgs) ? rawMsgs : (rawMsgs?.messages || rawMsgs?.data || []);
    } catch (err) {
     console.warn("spindle.chat.getMessages failed:", err.message);
    }
   }

   // 1. Direct message & timestamp search (ranked by how many query keywords match)
   if (chatMessages.length > 0) {
    const scoredMsgs = [];
    chatMessages.forEach((m, idx) => {
     const msgTime = formatTime(getMsgTimestamp(m)) || "";
     const msgText = typeof m.content === "string" ? m.content : (m.mes || m.text || JSON.stringify(m.content || ""));
     const combined = `${msgTime} ${msgText}`;
     const score = countKeywordMatches(combined, keywords);
     // Require matching all keywords if <= 4 keywords, or at least 2 keywords otherwise
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

   // 2. Vector chunk search (enriched with real timestamps from chatMessages)
   if (spindle.memories?.chatMemory?.listChunks) {
    const rawChunks = await spindle.memories.chatMemory.listChunks(linkedChatId, userId);
    const chatChunks = Array.isArray(rawChunks) ? rawChunks : (rawChunks?.chunks || []);
    const enrichedChunks = chatChunks.map(c => {
     const startIdx = c.startMessageIndex ?? c.messageStart ?? c.startIndex ?? c.metadata?.startIndex ?? c.messageIndex;
     const realMsg = (startIdx !== undefined && chatMessages[startIdx]) ? chatMessages[startIdx] : null;
     const realTime = getMsgTimestamp(realMsg);
     return realTime ? { ...c, timestamp: realTime } : c;
    });

    const matchedChunks = enrichedChunks
     .map(c => {
      const timeStr = formatTime(c.timestamp || c.created_at || c.createdAt || c.updatedAt) || "";
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

  if (results.length === 0) {
   return `No matching memories found for "${query}" in current chat or active links.`;
  }
  return results.join("\n\n");
 } catch (error) {
  console.error("Memory recall error:", error);
  return "Memory search encountered an error: " + error.message;
 }
});