(() => {
  // index.js
  console.log("=== TOOLKIT WORKER LOADED ===");
  spindle.log.info("Toolkit worker started!");
  var cachedUserId = null;
  var cachedChatId = null;
  var cachedConnectionId = null;
  for (const evt of ["MESSAGE_SENT", "CHAT_SWITCHED", "CHAT_CHANGED", "GENERATION_STARTED"]) {
    spindle.on(evt, (payload, uid) => {
      if (uid) cachedUserId = uid;
      else if (payload?.userId) cachedUserId = payload.userId;
      if (payload?.chatId) cachedChatId = payload.chatId;
      if (payload?.connectionId) cachedConnectionId = payload.connectionId;
    });
  }
  async function getVaultMode(chatId, userId) {
    if (!chatId || !spindle.variables?.chat?.get) return "strict";
    try {
      const val = await spindle.variables.chat.get(chatId, "vault_mode", userId);
      return val === "all" ? "all" : "strict";
    } catch (e) {
      return "strict";
    }
  }
  async function toggleVaultMode(chatId, userId, forceMode) {
    if (!chatId && spindle.chats?.getActive) {
      const active = await spindle.chats.getActive(userId);
      chatId = active?.id || cachedChatId;
    }
    if (!chatId) return "No active chat found to toggle Vault mode.";
    const current = await getVaultMode(chatId, userId);
    const nextMode = forceMode ? forceMode : current === "all" ? "strict" : "all";
    if (spindle.variables?.chat?.set) {
      await spindle.variables.chat.set(chatId, "vault_mode", nextMode, userId);
    }
    const label = nextMode === "all" ? "All Vaults Mode (Searching ALL Vaults in this chat)" : "Strict Mode (Searching ONLY attached Vaults in this chat)";
    if (spindle.toast?.info) {
      spindle.toast.info(`Toolkit: ${label}`);
    } else if (spindle.toast) {
      try {
        spindle.toast(`Toolkit: ${label}`);
      } catch (e) {
      }
    }
    console.log(`=== VAULT MODE CHANGED (Chat: ${chatId}) -> ${nextMode} ===`);
    return label;
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
          const cId = context?.chatId || cachedChatId;
          await toggleVaultMode(cId, cachedUserId);
        }
      });
    } catch (err) {
      console.warn("Command registration failed:", err.message);
    }
  }
  if (spindle.onFrontendMessage) {
    spindle.onFrontendMessage(async (msg, uid) => {
      const uId = uid || cachedUserId;
      if (msg?.type === "TOGGLE_VAULT_MODE") {
        await toggleVaultMode(msg.chatId || cachedChatId, uId);
      }
    });
  }
  function extractKeywords(query) {
    return String(query || "").toLowerCase().replace(/[,?!;."']/g, " ").split(/\s+/).filter(Boolean);
  }
  function matchesKeywords(text, keywords) {
    const lower = String(text || "").toLowerCase();
    return keywords.some((k) => lower.includes(k));
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
    const normalized = !isNaN(num) && num > 0 && num < 1e11 ? num * 1e3 : raw;
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
    if (!c) return void 0;
    if (Array.isArray(c.messageRange) && c.messageRange.length > 0) return c.messageRange[0];
    if (Array.isArray(c.message_range) && c.message_range.length > 0) return c.message_range[0];
    return c.startMessageIndex ?? c.messageStart ?? c.startIndex ?? c.metadata?.startIndex ?? c.messageIndex;
  }
  function getChunkEndIdx(c) {
    if (!c) return void 0;
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
      const nums = msgs.map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
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
      const tA = Number(Array.isArray(a.timeRange) ? a.timeRange[0] : a.timestamp || a.created_at || a.createdAt || 0);
      const tB = Number(Array.isArray(b.timeRange) ? b.timeRange[0] : b.timestamp || b.created_at || b.createdAt || 0);
      return tA - tB;
    });
    return sorted.map((c, i) => {
      const parts = [];
      const cIdx = c.chunkIndex ?? c.index;
      if (cIdx !== void 0) parts.push(`Chunk #${cIdx}`);
      const startMsg = getChunkStartIdx(c);
      const endMsg = getChunkEndIdx(c);
      if (startMsg !== void 0 && endMsg !== void 0) {
        parts.push(startMsg === endMsg ? `Message #${startMsg}` : `Messages #${startMsg}-#${endMsg}`);
      } else if (startMsg !== void 0) {
        parts.push(`Message #${startMsg}`);
      }
      const timeStr = formatTime(c.timestamp || c.timeRange || c.created_at || c.createdAt || c.updatedAt);
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
    description: "Search persistent long-term memory, current chat entities, linked Vaults, and past chat records (including searching messages by date/time). Can also toggle vault mode if query is '__toggle_vaults__', '__all_vaults__', or '__strict_vaults__'.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Specific keywords, entity names, dates/timestamps, or topics to search for in memory (or '__inspect__', '__toggle_vaults__', '__all_vaults__', '__strict_vaults__')."
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
          let connId = cachedConnectionId;
          if (!connId && spindle.connections?.list) {
            const conns = await spindle.connections.list(userId);
            const list = Array.isArray(conns) ? conns : conns?.data || [];
            const chosen = list.find((c) => c.is_default || c.isDefault) || list.find((c) => c.has_api_key) || list[0];
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
                content: query2
              }
            ]
          };
          if (connId) quietReq.connection_id = connId;
          const res = await spindle.generate.quiet(quietReq, userId);
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
    const activeChat = await spindle.chats.getActive(userId);
    const chatId = payload.chatId || activeChat?.id || cachedChatId;
    if (query === "__toggle_vaults__") {
      return await toggleVaultMode(chatId, userId);
    }
    if (query === "__all_vaults__") {
      return await toggleVaultMode(chatId, userId, "all");
    }
    if (query === "__strict_vaults__") {
      return await toggleVaultMode(chatId, userId, "strict");
    }
    const keywords = extractKeywords(query);
    const vaultMode = await getVaultMode(chatId, userId);
    console.log("=== MEMORY RECALL TRIGGERED ===", query, "vaultMode:", vaultMode, "userId:", userId);
    try {
      const results = [];
      results.push(`[Vault Recall Mode: ${vaultMode.toUpperCase()}]`);
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
      const vaultsToSearch = vaultMode === "all" ? allVaults || [] : attachedVaults;
      for (const v of vaultsToSearch) {
        const fullVault = await spindle.memories.vaults.get(v.id, userId);
        const vaultTime = formatTime(fullVault?.created_at || fullVault?.createdAt || v.created_at || v.createdAt);
        const vaultLabel = vaultTime ? `${v.name} | Snapshot: ${vaultTime}` : v.name;
        const matchedEntities = (fullVault?.entities || []).filter((e) => matchesKeywords(e.name, keywords) || matchesKeywords(JSON.stringify(e.facts || []), keywords) || matchesKeywords(e.description, keywords)).map(cleanEntity);
        if (matchedEntities.length > 0) {
          results.push(`=== VAULT ENTITIES (${vaultLabel}) ===
` + JSON.stringify(matchedEntities, null, 2));
        }
        if (spindle.memories.vaults.getChunks) {
          const chunks = await spindle.memories.vaults.getChunks(v.id, userId);
          const matchedChunks = (chunks || []).map((c) => ({ c, score: countKeywordMatches(c.content || c.text, keywords) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map((item) => item.c);
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
        let chatMessages = [];
        if (spindle.chat?.getMessages) {
          try {
            const rawMsgs = await spindle.chat.getMessages(linkedChatId, userId);
            chatMessages = Array.isArray(rawMsgs) ? rawMsgs : rawMsgs?.messages || rawMsgs?.data || [];
            console.log(`Loaded ${chatMessages.length} messages from linked chat ${linkedChatId}`);
          } catch (err) {
            console.warn("spindle.chat.getMessages failed:", err.message);
          }
        }
        if (chatMessages.length > 0) {
          const scoredMsgs = [];
          chatMessages.forEach((m, idx) => {
            const msgTime = formatTime(getMsgTimestamp(m)) || "";
            const msgText = typeof m.content === "string" ? m.content : m.mes || m.text || JSON.stringify(m.content || "");
            const combined = `${msgTime} ${msgText}`;
            const score = countKeywordMatches(combined, keywords);
            const minRequired = keywords.length <= 4 ? keywords.length : Math.max(2, keywords.length - 1);
            if (score >= minRequired) {
              const role = m.role || m.name || (m.is_user ? "User" : "Assistant");
              scoredMsgs.push({
                idx,
                score,
                formatted: `[Message #${idx} | Time: ${msgTime} | ${role}]
${msgText}`
              });
            }
          });
          if (scoredMsgs.length > 0) {
            scoredMsgs.sort((a, b) => b.score - a.score || a.idx - b.idx);
            const topMsgs = scoredMsgs.slice(0, 6).map((item) => item.formatted);
            results.push(`=== INTERLINKED MESSAGES (Chat: ${linkedChatId}) ===
` + topMsgs.join("\n---\n"));
          }
        }
        if (spindle.memories?.chatMemory?.listChunks) {
          const rawChunks = await spindle.memories.chatMemory.listChunks(linkedChatId, userId);
          const chatChunks = Array.isArray(rawChunks) ? rawChunks : rawChunks?.chunks || [];
          const enrichedChunks = chatChunks.map((c) => {
            const startIdx = getChunkStartIdx(c);
            const realMsg = startIdx !== void 0 && chatMessages[startIdx] ? chatMessages[startIdx] : null;
            const realTime = getMsgTimestamp(realMsg);
            return realTime ? { ...c, timestamp: realTime } : c;
          });
          const matchedChunks = enrichedChunks.map((c) => {
            const timeStr = formatTime(c.timestamp || c.timeRange || c.created_at || c.createdAt || c.updatedAt) || "";
            const score = countKeywordMatches(`${timeStr} ${c.content || c.text || ""}`, keywords);
            return { c, score };
          }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map((item) => item.c);
          if (matchedChunks.length > 0) {
            const formattedChunks = formatAndSortChunks(matchedChunks);
            results.push(`=== INTERLINKED CHAT CHUNKS (Chat: ${linkedChatId}) ===
` + formattedChunks.join("\n---\n"));
          }
        }
      }
      if (results.length <= 1) {
        return `[Vault Recall Mode: ${vaultMode.toUpperCase()}]
No matching memories found for "${query}".`;
      }
      return results.join("\n\n");
    } catch (error) {
      console.error("Memory recall error:", error);
      return "Memory search encountered an error: " + error.message;
    }
  });
})();
