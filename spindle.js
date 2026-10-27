// index.js
console.log("=== INLINE MEMORY & SEARCH WORKER LOADED ===");
spindle.log.info("Inline Memory & Search worker started!");
var cachedUserId = null;
var cachedChatId = null;
for (const evt of ["MESSAGE_SENT", "CHAT_SWITCHED", "CHAT_CHANGED"]) {
  spindle.on(evt, (payload, uid) => {
    if (uid) cachedUserId = uid;
    else if (payload?.userId) cachedUserId = payload.userId;
    if (payload?.chatId) cachedChatId = payload.chatId;
  });
}
function matchesKeywords(text, keywords) {
  const lower = String(text || "").toLowerCase();
  return keywords.some((k) => lower.includes(k));
}
function formatTime(val) {
  if (!val) return null;
  const num = Number(val);
  const normalized = !isNaN(num) && num > 0 && num < 1e11 ? num * 1e3 : val;
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
    const nums = msgs.map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    if (nums.length > 0) {
      item.messageRange = `#${nums[0]} to #${nums[nums.length - 1]} (${nums.length} mentions, latest: #${nums[nums.length - 1]})`;
    }
  } else if (e.mentionCount) {
    item.mentions = e.mentionCount;
  }
  const firstTime = formatTime(e.createdAt || e.firstSeenAt);
  const lastTime = formatTime(e.updatedAt || e.lastSeenAt || e.lastMentionedAt);
  if (firstTime) item.firstRecorded = firstTime;
  if (lastTime && lastTime !== firstTime) item.lastUpdated = lastTime;
  return item;
}
function formatAndSortChunks(chunks) {
  const sorted = [...chunks].sort((a, b) => {
    const idxA = a.chunkIndex ?? a.startMessageIndex ?? a.startIndex ?? a.index ?? 0;
    const idxB = b.chunkIndex ?? b.startMessageIndex ?? b.startIndex ?? b.index ?? 0;
    if (idxA !== idxB) return idxA - idxB;
    const tA = new Date(a.timestamp || a.createdAt || 0).getTime() || 0;
    const tB = new Date(b.timestamp || b.createdAt || 0).getTime() || 0;
    return tA - tB;
  });
  return sorted.map((c, i) => {
    const parts = [];
    const cIdx = c.chunkIndex ?? c.index;
    if (cIdx !== void 0) parts.push(`Chunk #${cIdx}`);
    const startMsg = c.startMessageIndex ?? c.messageStart ?? c.startIndex;
    const endMsg = c.endMessageIndex ?? c.messageEnd ?? c.endIndex;
    if (startMsg !== void 0 && endMsg !== void 0) {
      parts.push(`Messages #${startMsg}-#${endMsg}`);
    } else if (c.messageIndex !== void 0) {
      parts.push(`Message #${c.messageIndex}`);
    }
    const timeStr = formatTime(c.timestamp || c.createdAt || c.updatedAt);
    if (timeStr) parts.push(`Time: ${timeStr}`);
    const header = parts.length > 0 ? `[${parts.join(" | ")}]
` : `[Excerpt #${i + 1}]
`;
    return header + (c.content || c.text || "");
  });
}
spindle.registerTool({
  name: "recall_memory",
  display_name: "Inline Memory Recall",
  description: "Search persistent long-term memory, current chat entities, linked Vaults, and past chat records. Call this tool whenever the user asks what you remember about past events, previous chats, specific projects, people, or entity facts.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Specific keywords, entity names, or topics to search for in memory (or '__inspect__' to inspect Spindle APIs)."
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
    const query2 = String(payload.args?.query || "").trim();
    console.log("=== WEB SEARCH TRIGGERED ===", query2, "userId:", userId);
    if (spindle.generate?.quiet) {
      try {
        const res = await spindle.generate.quiet({
          userId,
          messages: [
            {
              role: "system",
              content: "Search the web and provide a detailed, factual summary with source names and URLs if available."
            },
            {
              role: "user",
              content: query2
            }
          ]
        }, userId);
        if (res?.content) {
          return `=== WEB SEARCH RESULTS (Native) ===
${res.content}`;
        }
      } catch (err) {
        console.warn("Quiet native search failed, falling back to SearXNG:", err.message);
      }
    }
    if (spindle.webSearch?.query) {
      try {
        const search = await spindle.webSearch.query({ query: query2, count: 5, userId }, userId);
        return `=== WEB SEARCH RESULTS (SearXNG) ===
${search.context || JSON.stringify(search, null, 2)}`;
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
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  console.log("=== MEMORY RECALL TRIGGERED ===", query, "userId:", userId);
  try {
    const activeChat = await spindle.chats.getActive(userId);
    const chatId = payload.chatId || activeChat?.id || cachedChatId;
    const results = [];
    if (chatId && spindle.memories?.entities?.list) {
      const localEntities = await spindle.memories.entities.list(chatId, {
        activeOnly: false,
        userId
      });
      const matchedLocal = (localEntities || []).filter((e) => matchesKeywords(e.name, keywords) || matchesKeywords(JSON.stringify(e.facts || []), keywords) || matchesKeywords(e.description, keywords)).map(cleanEntity);
      if (matchedLocal.length > 0) {
        results.push("=== CURRENT CHAT ENTITIES ===\n" + JSON.stringify(matchedLocal, null, 2));
      }
    }
    if (chatId && spindle.memories?.cortex?.queryLinked) {
      const linked = await spindle.memories.cortex.queryLinked(chatId, {
        queryText: query,
        userId
      });
      const hasLinkedData = linked?.vaults?.length > 0 || linked?.interlinks?.length > 0;
      if (hasLinkedData) {
        results.push("=== LINKED Cortex MEMORIES ===\n" + JSON.stringify(linked, null, 2));
      }
    }
    const attachedLinks = chatId && spindle.memories?.links?.list ? await spindle.memories.links.list(chatId, userId) : [];
    const activeLinks = (attachedLinks || []).filter((l) => l.enabled !== false);
    const allVaults = spindle.memories?.vaults?.list ? await spindle.memories.vaults.list(userId) : [];
    const vaultIdMap = new Map((allVaults || []).map((v) => [v.id, v]));
    const attachedVaults = [];
    const interlinkedChatIds = /* @__PURE__ */ new Set();
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
      const vaultTime = formatTime(fullVault?.createdAt || v.createdAt);
      const vaultLabel = vaultTime ? `${v.name} | Snapshot: ${vaultTime}` : v.name;
      const matchedEntities = (fullVault?.entities || []).filter((e) => matchesKeywords(e.name, keywords) || matchesKeywords(JSON.stringify(e.facts || []), keywords) || matchesKeywords(e.description, keywords)).map(cleanEntity);
      if (matchedEntities.length > 0) {
        results.push(`=== VAULT ENTITIES (${vaultLabel}) ===
` + JSON.stringify(matchedEntities, null, 2));
      }
      if (spindle.memories.vaults.getChunks) {
        const chunks = await spindle.memories.vaults.getChunks(v.id, userId);
        const matchedChunks = (chunks || []).filter((c) => matchesKeywords(c.content, keywords)).slice(0, 6);
        if (matchedChunks.length > 0) {
          const formattedChunks = formatAndSortChunks(matchedChunks);
          results.push(`=== VAULT CHAT CHUNKS (${vaultLabel}) ===
` + formattedChunks.join("\n---\n"));
        }
      }
    }
    for (const linkedChatId of interlinkedChatIds) {
      if (spindle.memories?.entities?.list) {
        const linkedEntities = await spindle.memories.entities.list(linkedChatId, {
          activeOnly: false,
          userId
        });
        const matchedEntities = (linkedEntities || []).filter((e) => matchesKeywords(e.name, keywords) || matchesKeywords(JSON.stringify(e.facts || []), keywords) || matchesKeywords(e.description, keywords)).map(cleanEntity);
        if (matchedEntities.length > 0) {
          results.push(`=== INTERLINKED CHAT ENTITIES (Chat: ${linkedChatId}) ===
` + JSON.stringify(matchedEntities, null, 2));
        }
      }
      if (spindle.memories?.chatMemory?.listChunks) {
        const rawChunks = await spindle.memories.chatMemory.listChunks(linkedChatId, userId);
        const chatChunks = Array.isArray(rawChunks) ? rawChunks : rawChunks?.chunks || [];
        const matchedChunks = chatChunks.filter((c) => {
          const timeStr = formatTime(c.timestamp || c.createdAt || c.updatedAt) || "";
          return matchesKeywords(c.content || c.text, keywords) || matchesKeywords(timeStr, keywords);
        }).slice(0, 6);
        if (matchedChunks.length > 0) {
          const formattedChunks = formatAndSortChunks(matchedChunks);
          results.push(`=== INTERLINKED CHAT CHUNKS (Chat: ${linkedChatId}) ===
` + formattedChunks.join("\n---\n"));
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
