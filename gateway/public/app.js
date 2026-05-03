(function () {
  "use strict";

  const $ = (s, p) => (p || document).querySelector(s);
  const $$ = (s, p) => [...(p || document).querySelectorAll(s)];

  const BOT_COLORS = { michael: "#3B82F6", eliyahu: "#F59E0B", miriam: "#A855F7", tzali: "#10B981", avi: "#F43F5E" };
  const MODEL_LABELS = { opus: "Opus 4.7", sonnet: "Sonnet 4.6", haiku: "Haiku 4.5" };

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  if (window.marked) {
    marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
  }

  function renderMarkdown(text) {
    if (!window.marked || !window.DOMPurify) return escapeHtml(text).replace(/\n/g, "<br>");
    const html = marked.parse(text || "");
    return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // ── Toast ──
  const toast = $("#toast");
  let toastTimer;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2000);
  }

  // ══════════════════ AUTH ══════════════════
  const loginPage = $("#login-page");
  const dashboard = $("#dashboard");

  // Authenticated user profile — populated from /ui/session on boot.
  // Gates every agent-filtered UI element (orbs, filter pills, send
  // target) to `currentUser.agents` so each user only sees the bots
  // they aren't entitled to address.
  let currentUser = null;

  async function tryLogin(token) {
    try {
      const res = await fetch("/ui/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) return false;
      const body = await res.json().catch(() => ({}));
      if (body && body.user) currentUser = body.user;
      return true;
    } catch { return false; }
  }

  async function fetchSession() {
    try {
      const res = await fetch("/ui/session");
      if (!res.ok) return null;
      const body = await res.json();
      return body.user || null;
    } catch { return null; }
  }

  function applyUserAgentFilter() {
    // Hide any header indicator, filter pill, or settings card whose
    // bot isn't in the allowed list. If currentUser is missing, fall
    // back to showing everything (auth-locked routes will 401 anyway).
    const allowed = currentUser ? new Set(currentUser.agents) : null;
    const isAdmin = !!(currentUser && currentUser.admin);
    $$(".bot-ind").forEach((el) => {
      const botClass = [...el.classList].find((c) => c !== "bot-ind");
      if (!botClass) return;
      if (allowed && !allowed.has(botClass)) {
        el.style.display = "none";
      } else {
        el.style.display = "";
      }
    });
    $$(".filter-btn").forEach((el) => {
      const bot = el.dataset.bot;
      if (!bot || bot === "all") { el.style.display = ""; return; }
      if (allowed && !allowed.has(bot)) {
        el.style.display = "none";
        if (activeBot === bot) {
          activeBot = "all";
          $$(".filter-btn").forEach((b) => b.classList.toggle("active", b.dataset.bot === "all"));
          updateSendTarget();
        }
      } else {
        el.style.display = "";
      }
    });

    // Admin-only tabs — Costs (operating subscriptions) and Settings
    // (bot model/voice tuning) are admin-only. Non-admin users never
    // see the tab buttons, and if they're currently on such a tab when
    // their session downgrades, snap them back to Feed.
    $$(".tab-btn").forEach((btn) => {
      const tab = btn.dataset.tab;
      const adminOnly = tab === "costs" || tab === "settings";
      if (adminOnly && !isAdmin) {
        btn.style.display = "none";
        if (btn.classList.contains("active")) {
          const feedBtn = $('.tab-btn[data-tab="feed"]');
          if (feedBtn) feedBtn.click();
        }
      } else {
        btn.style.display = "";
      }
    });
  }

  $("#login-btn").addEventListener("click", async () => {
    const token = $("#token-input").value.trim();
    if (!token) return;
    if (await tryLogin(token)) {
      showDashboard();
    } else {
      const err = $("#login-error");
      err.style.display = "block";
      err.textContent = "Invalid token";
    }
  });

  $("#token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#login-btn").click();
  });

  function showDashboard() {
    loginPage.style.display = "none";
    dashboard.style.display = "flex";
    applyUserAgentFilter();
    initWebSocket();
    // Settings is admin-only — skip the fetch for non-admin to avoid 403
    // console noise. Gateway info still populates from /ui/health.
    if (currentUser && currentUser.admin) loadSettings();
    else loadGatewayInfoOnly();
    loadClips();
    loadFiles();
  }

  // Auto-login — both pages start hidden, reveal the right one after
  // we know whether the cookie resolves to a known user.
  fetchSession().then((user) => {
    if (user) {
      currentUser = user;
      showDashboard();
    } else {
      loginPage.style.display = "flex";
    }
  }).catch(() => {
    loginPage.style.display = "flex";
  });

  // ══════════════════ THEME ══════════════════
  const themeBtn = $("#theme-btn");
  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ahi-theme", theme);
    themeBtn.innerHTML = theme === "dark" ? "&#x263E;" : "&#x2600;";
    // Update PWA theme-color
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#0c0e14" : "#ffffff";
  }
  // Load saved theme
  setTheme(localStorage.getItem("ahi-theme") || "dark");
  themeBtn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    setTheme(current === "dark" ? "light" : "dark");
  });

  // ══════════════════ LOGOUT ══════════════════
  $("#logout-btn").addEventListener("click", async () => {
    await fetch("/ui/logout", { method: "POST" });
    dashboard.style.display = "none";
    loginPage.style.display = "flex";
    $("#token-input").value = "";
    if (ws) ws.close();
  });

  // ══════════════════ REFRESH ══════════════════
  const refreshBtn = $("#refresh-btn");
  function refreshAll() {
    refreshBtn.classList.add("spinning");
    setTimeout(() => refreshBtn.classList.remove("spinning"), 600);
    if (ws) { ws.close(); }
    initWebSocket();
    if (currentUser && currentUser.admin) loadSettings();
    else loadGatewayInfoOnly();
    loadClips();
    loadFiles();
    showToast("Refreshed");
  }
  refreshBtn.addEventListener("click", refreshAll);

  // ══════════════════ TABS ══════════════════
  const tabBtns = $$(".tab-btn");
  const tabPages = $$(".tab-page");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
      tabPages.forEach((p) => p.classList.toggle("active", p.id === "tab-" + tab));
      if (tab === "mc") loadMissionControl();
      if (tab === "costs") loadCosts();
    });
  });

  // ══════════════════ WEBSOCKET / FEED ══════════════════
  let ws = null;
  let reconnectTimer = null;
  let activeBot = "all"; // which bot filter is active

  // Bot filter pills — control both feed view AND send target
  const filterBtns = $$(".filter-btn");
  const sendTarget = $("#send-target");

  function getSendBot() {
    // When on "all", default to michael
    return activeBot === "all" ? "michael" : activeBot;
  }

  function updateSendTarget() {
    const bot = getSendBot();
    sendTarget.textContent = bot.charAt(0).toUpperCase() + bot.slice(1);
    sendTarget.style.color = BOT_COLORS[bot] || "var(--accent)";
  }

  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      activeBot = btn.dataset.bot;
      filterBtns.forEach((b) => b.classList.toggle("active", b === btn));
      updateSendTarget();
      loadBotMessages(activeBot);
    });
  });

  updateSendTarget();

  async function loadBotMessages(bot) {
    try {
      const url = bot === "all" ? "/ui/messages" : `/ui/messages?bot=${bot}`;
      const res = await fetch(url);
      const messages = await res.json();
      clearFeed();
      if (messages.length > 0) {
        messages.forEach((msg) => appendMessage(msg));
      } else {
        showFeedEmpty();
      }
    } catch {}
  }

  function initWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ui/ws`);

    ws.onopen = () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "session") {
          // Server-announced identity — update the filter and UI.
          if (data.user) {
            currentUser = data.user;
            applyUserAgentFilter();
          }
        } else if (data.type === "history") {
          // On connect, load via API for the active filter (not the "all" WS sends)
          loadBotMessages(activeBot);
        } else if (data.type === "message") {
          if (activeBot === "all" || data.bot === activeBot) {
            hideFeedEmpty();
            appendMessage(data);
          }
        } else if (data.type === "mc-update") {
          handleMCUpdate(data.file, data.entry);
        } else if (data.type === "stream-start")    { onStreamStart(data); }
        else if (data.type === "stream-chunk")      { onStreamChunk(data); }
        else if (data.type === "stream-tool-use")   { onStreamToolUse(data); }
        else if (data.type === "stream-end")        { onStreamEnd(data); }
        else if (data.type === "stream-error")      { onStreamError(data); }
      } catch {}
    };

    ws.onclose = () => {
      reconnectTimer = setTimeout(initWebSocket, 3000);
    };
  }

  const feedList = $("#feed-list");
  const FEED_EMPTY_HTML = `<div class="feed-empty" id="feed-empty">
    Waiting for messages...<br/>
    <span style="font-size:0.75rem; margin-top:0.5rem; display:block;">
      Send a message to any bot on Telegram and it will appear here in real-time.
    </span>
  </div>`;

  function clearFeed() {
    feedList.innerHTML = "";
  }

  function showFeedEmpty() {
    if (!$("#feed-empty")) feedList.innerHTML = FEED_EMPTY_HTML;
  }

  function hideFeedEmpty() {
    const empty = $("#feed-empty");
    if (empty) empty.remove();
  }

  function appendMessage(msg) {
    hideFeedEmpty();

    // Dedupe: if a just-finalized streaming card is waiting for this canonical out-message, reuse it
    if (msg.direction === "out") {
      const lastChild = feedList.lastElementChild;
      if (lastChild && lastChild.dataset.consumeNextOutForBot === msg.bot) {
        delete lastChild.dataset.consumeNextOutForBot;
        const textEl = lastChild.querySelector(".msg-text");
        if (textEl) textEl.innerHTML = renderMarkdown(msg.text);
        // Re-bind click with canonical text (clone strips streaming listeners)
        const fresh = lastChild.cloneNode(true);
        fresh.addEventListener("click", () => {
          navigator.clipboard.writeText(msg.text).then(() => showToast("Copied to clipboard"));
        });
        feedList.replaceChild(fresh, lastChild);
        return;
      }
    }

    const el = document.createElement("div");

    // direction "in" = user sent TO bot, "out" = bot replied TO user
    // User messages go RIGHT, bot messages go LEFT.
    // Author comes from the broadcast's `senderName` (attributed server-side
    // from users.json) — falls back to "unknown" when the sender can't be
    // resolved (legacy records or anonymous Telegram senders).
    const isUser = msg.direction === "in";
    const senderName = msg.senderName || "unknown";
    const label = isUser ? senderName : msg.bot;
    const colorClass = isUser ? (senderName.toLowerCase() === "primary" ? "primary" : "user") : msg.bot;

    el.className = `msg ${colorClass} ${isUser ? "out" : ""}`;

    const badge = msg.contentType !== "text" ? `<span class="msg-badge">${msg.contentType}</span>` : "";

    el.innerHTML = `
      <div class="msg-head">
        <span class="msg-bot">${label}</span>
        <span class="msg-time">${formatTime(msg.timestamp)}</span>
        ${badge}
      </div>
      <div class="msg-text">${renderMarkdown(msg.text)}</div>
    `;

    el.addEventListener("click", () => {
      navigator.clipboard.writeText(msg.text).then(() => showToast("Copied to clipboard"));
    });

    feedList.appendChild(el);
    feedList.scrollTop = feedList.scrollHeight;
  }

  // Quick Send — sends message to bot and triggers Claude response
  const sendBtn = $("#send-btn");
  const sendInput = $("#send-input");

  sendBtn.addEventListener("click", async () => {
    const text = sendInput.value.trim();
    if (!text) return;
    const bot = getSendBot();
    sendBtn.disabled = true;
    sendInput.value = "";
    try {
      const res = await fetch("/ui/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot, text }),
      });
      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || "Send failed");
      }
    } catch {
      showToast("Send failed");
    }
    sendBtn.disabled = false;
  });

  sendInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });

  // ══════════════════ CLIPBOARD ══════════════════
  const clipInput = $("#clip-input");
  const clipsGrid = $("#clips-grid");

  $("#clip-save-btn").addEventListener("click", async () => {
    const text = clipInput.value.trim();
    if (!text) return;
    try {
      const res = await fetch("/ui/clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        clipInput.value = "";
        showToast("Clip saved");
        loadClips();
      }
    } catch { showToast("Failed to save clip"); }
  });

  clipInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      $("#clip-save-btn").click();
    }
  });

  async function loadClips() {
    try {
      const res = await fetch("/ui/clips");
      const clips = await res.json();
      renderClips(clips);
    } catch {}
  }

  function renderClips(clips) {
    if (!clips.length) {
      clipsGrid.innerHTML = '<div class="clips-empty">No clips saved yet. Type or paste text above and hit Save.</div>';
      return;
    }
    clipsGrid.innerHTML = clips.map((c) => `
      <div class="clip-card" data-id="${c.id}">
        <div class="clip-text">${escapeHtml(c.text)}</div>
        <div class="clip-footer">
          <span class="clip-time">${formatDate(c.created)}</span>
          <button class="clip-del" data-id="${c.id}">Delete</button>
        </div>
        <div class="clip-copied">Copied!</div>
      </div>
    `).join("");

    $$(".clip-card", clipsGrid).forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("clip-del")) return;
        const clip = clips.find((c) => c.id === card.dataset.id);
        if (clip) {
          navigator.clipboard.writeText(clip.text).then(() => {
            card.classList.add("copied");
            setTimeout(() => card.classList.remove("copied"), 800);
          });
        }
      });
    });

    $$(".clip-del", clipsGrid).forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/ui/clips/${btn.dataset.id}`, { method: "DELETE" });
        loadClips();
      });
    });
  }

  // ══════════════════ FILES ══════════════════
  const dropZone = $("#drop-zone");
  const fileInput = $("#file-input");
  const filesList = $("#files-list");

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) uploadFiles(fileInput.files);
    fileInput.value = "";
  });

  async function uploadFiles(files) {
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/ui/upload", { method: "POST", body: form });
        if (res.ok) showToast(`Uploaded ${file.name}`);
        else {
          const err = await res.json();
          showToast(err.error || "Upload failed");
        }
      } catch { showToast("Upload failed"); }
    }
    loadFiles();
  }

  async function loadFiles() {
    try {
      const res = await fetch("/ui/files");
      const files = await res.json();
      renderFiles(files);
    } catch {}
  }

  function fileIcon(name) {
    const ext = name.split(".").pop().toLowerCase();
    const icons = {
      pdf: "\u{1F4C4}", doc: "\u{1F4DD}", docx: "\u{1F4DD}",
      jpg: "\u{1F5BC}", jpeg: "\u{1F5BC}", png: "\u{1F5BC}", gif: "\u{1F5BC}", webp: "\u{1F5BC}",
      mp3: "\u{1F3B5}", wav: "\u{1F3B5}", ogg: "\u{1F3B5}",
      mp4: "\u{1F3AC}", mov: "\u{1F3AC}",
      zip: "\u{1F4E6}", tar: "\u{1F4E6}", gz: "\u{1F4E6}",
    };
    return icons[ext] || "\u{1F4CE}";
  }

  function renderFiles(files) {
    if (!files.length) {
      filesList.innerHTML = '<div class="files-empty">No files uploaded yet.</div>';
      return;
    }
    filesList.innerHTML = files.map((f) => `
      <div class="file-row">
        <span class="file-icon">${fileIcon(f.name)}</span>
        <div class="file-info">
          <a href="/ui/files/${encodeURIComponent(f.name)}" download>${escapeHtml(f.name)}</a>
          <div class="file-meta">${formatSize(f.size)} &middot; ${formatDate(f.modified)}</div>
        </div>
        <button class="btn btn-danger btn-sm del-file" data-name="${escapeHtml(f.name)}">Delete</button>
      </div>
    `).join("");

    $$(".del-file", filesList).forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(`/ui/files/${encodeURIComponent(btn.dataset.name)}`, { method: "DELETE" });
        loadFiles();
        showToast("File deleted");
      });
    });
  }

  // ══════════════════ SETTINGS ══════════════════
  const settingsGrid = $("#settings-grid");
  const gatewayInfo = $("#gateway-info");

  async function loadSettings() {
    try {
      const res = await fetch("/ui/settings");
      if (res.ok) {
        const data = await res.json();
        renderSettings(data);
      }
    } catch {}
    await loadGatewayInfoOnly();
  }

  // Used by non-admin sessions: skip the 403-gated /ui/settings fetch,
  // still populate the gateway-info block (uptime, bot count) since
  // /ui/health is unauthenticated.
  async function loadGatewayInfoOnly() {
    try {
      const res = await fetch("/ui/health");
      const data = await res.json();
      renderGatewayInfo(data);
    } catch {}
  }

  function renderSettings(data) {
    settingsGrid.innerHTML = data.bots.map((bot) => `
      <div class="bot-settings-card" data-bot="${bot.name}">
        <div class="bot-settings-header">
          <div class="dot" style="background:${BOT_COLORS[bot.name] || '#666'}; color:${BOT_COLORS[bot.name] || '#666'}"></div>
          <span class="name">${bot.name}</span>
          <span class="status">Online</span>
        </div>
        <div class="setting-row">
          <span class="setting-label">Model</span>
          <div>
            <select class="model-select" data-bot="${bot.name}">
              ${data.availableModels.map((m) => `<option value="${m}" ${m === bot.model ? "selected" : ""}>${MODEL_LABELS[m] || m}</option>`).join("")}
            </select>
            <span class="setting-saved" id="saved-model-${bot.name}">Saved</span>
          </div>
        </div>
        <div class="setting-row">
          <span class="setting-label">Voice</span>
          <div>
            <select class="voice-select" data-bot="${bot.name}">
              ${(data.voiceGroups || []).map((g) => `
                <optgroup label="${g.label}">
                  ${g.voices.map((v) => `<option value="${v}" ${v === bot.voice ? "selected" : ""}>${v}</option>`).join("")}
                </optgroup>
              `).join("")}
            </select>
            <span class="setting-saved" id="saved-voice-${bot.name}">Saved</span>
          </div>
        </div>
              </div>
    `).join("");

    $$(".model-select", settingsGrid).forEach((sel) => {
      sel.addEventListener("change", async () => {
        const bot = sel.dataset.bot;
        const res = await fetch("/ui/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bot, model: sel.value }),
        });
        if (res.ok) {
          const indicator = $(`#saved-model-${bot}`);
          indicator.classList.add("show");
          setTimeout(() => indicator.classList.remove("show"), 1500);
          showToast(`${bot} model \u2192 ${sel.value}`);
        }
      });
    });

    $$(".voice-select", settingsGrid).forEach((sel) => {
      sel.addEventListener("change", async () => {
        const bot = sel.dataset.bot;
        const res = await fetch("/ui/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bot, voice: sel.value }),
        });
        if (res.ok) {
          const indicator = $(`#saved-voice-${bot}`);
          indicator.classList.add("show");
          setTimeout(() => indicator.classList.remove("show"), 1500);
          showToast(`${bot} voice \u2192 ${sel.value}`);
        }
      });
    });
  }

  function renderGatewayInfo(data) {
    const mins = Math.floor(data.uptime / 60);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);

    let uptimeStr;
    if (days > 0) uptimeStr = `${days}d ${hrs % 24}h ${mins % 60}m`;
    else if (hrs > 0) uptimeStr = `${hrs}h ${mins % 60}m`;
    else uptimeStr = `${mins}m`;

    gatewayInfo.innerHTML = `
      <div class="section-title" style="margin-bottom:0.5rem">Gateway Info</div>
      <div class="info-row">
        <span class="info-label">Uptime</span>
        <span class="info-value">${uptimeStr}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Bots</span>
        <span class="info-value">${data.bots.length} active</span>
      </div>
      <div class="info-row">
        <span class="info-label">Version</span>
        <span class="info-value">v0.3.0</span>
      </div>
    `;
  }

  setInterval(() => {
    if (dashboard.style.display === "none") return;
    if (currentUser && currentUser.admin) loadSettings();
    else loadGatewayInfoOnly();
  }, 30000);

  // ══════════════════ MISSION CONTROL ══════════════════
  const mcGrid = $("#mc-grid");
  const mcExpanded = $("#mc-expanded");
  const mcRender = $("#mc-render");
  const mcEditor = $("#mc-editor");
  const mcEditBtn = $("#mc-edit-btn");
  const mcSaveBtn = $("#mc-save-btn");
  const mcCancelBtn = $("#mc-cancel-btn");
  const mcCloseBtn = $("#mc-close");
  const mcExpandedLabel = $("#mc-expanded-label");
  const mcExpandedFile = $("#mc-expanded-file");
  const mcSavedIndicator = $("#mc-saved");

  let mcFiles = [];           // full list with content
  let mcOpenFile = null;      // currently expanded file name
  let mcEditing = false;      // edit mode flag

  function extractPreview(content) {
    if (!content) return [{ text: "(empty)", cls: "muted" }];
    const lines = content.split(/\r?\n/);
    let firstHeadingSkipped = false;
    const out = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // skip the first top-level heading (it's usually the file title)
      if (!firstHeadingSkipped && /^#\s+/.test(line)) {
        firstHeadingSkipped = true;
        continue;
      }
      if (/^#{1,6}\s+/.test(line)) {
        out.push({ text: line.replace(/^#{1,6}\s+/, ""), cls: "heading" });
      } else if (/^[-*+]\s+/.test(line)) {
        out.push({ text: line.replace(/^[-*+]\s+/, ""), cls: "bullet" });
      } else if (/^\d+\.\s+/.test(line)) {
        out.push({ text: line.replace(/^\d+\.\s+/, ""), cls: "bullet" });
      } else if (/^\|/.test(line) || /^-{3,}/.test(line)) {
        continue; // skip table separators / horizontal rules
      } else {
        out.push({ text: line, cls: "" });
      }
      if (out.length >= 3) break;
    }
    return out.length ? out : [{ text: "(empty)", cls: "muted" }];
  }

  function formatRelative(ms) {
    if (!ms) return "never";
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  }

  function renderMCGrid() {
    mcGrid.innerHTML = mcFiles.map((f) => {
      if (!f.exists) {
        return `
          <div class="mc-card missing" data-file="${escapeHtml(f.name)}">
            <div class="mc-card-head">
              <span class="mc-card-label">${escapeHtml(f.label)}</span>
              <span class="mc-card-file">${escapeHtml(f.name)}</span>
            </div>
            <div class="mc-card-blurb">${escapeHtml(f.blurb)}</div>
            <div class="mc-card-preview"><span class="mc-card-preview-line">File not found on disk.</span></div>
          </div>
        `;
      }
      const preview = extractPreview(f.content);
      const previewHtml = preview.map((p) =>
        `<span class="mc-card-preview-line ${p.cls}">${escapeHtml(p.text)}</span>`
      ).join("");
      return `
        <div class="mc-card" data-file="${escapeHtml(f.name)}">
          <div class="mc-card-head">
            <span class="mc-card-label">${escapeHtml(f.label)}</span>
            <span class="mc-card-file">${escapeHtml(f.name)}</span>
          </div>
          <div class="mc-card-blurb">${escapeHtml(f.blurb)}</div>
          <div class="mc-card-preview">${previewHtml}</div>
          <div class="mc-card-foot">
            <span>${(f.content || "").split(/\r?\n/).length} lines</span>
            <span>Updated ${formatRelative(f.mtime)}</span>
          </div>
        </div>
      `;
    }).join("");

    $$(".mc-card", mcGrid).forEach((card) => {
      if (card.classList.contains("missing")) return;
      card.addEventListener("click", () => openMCFile(card.dataset.file));
    });
  }

  async function loadMissionControl() {
    try {
      const res = await fetch("/ui/mc");
      const data = await res.json();
      mcFiles = data.files || [];
      renderMCGrid();
    } catch {}
  }

  function openMCFile(name) {
    const entry = mcFiles.find((f) => f.name === name);
    if (!entry || !entry.exists) return;
    mcOpenFile = name;
    mcEditing = false;
    mcExpandedLabel.textContent = entry.label;
    mcExpandedFile.textContent = entry.name;
    mcRender.innerHTML = renderMarkdown(entry.content);
    mcEditor.value = entry.content;
    mcRender.style.display = "";
    mcEditor.style.display = "none";
    mcEditBtn.style.display = "";
    mcSaveBtn.style.display = "none";
    mcCancelBtn.style.display = "none";
    mcExpanded.classList.add("open");
    mcExpanded.setAttribute("aria-hidden", "false");
  }

  function closeMCFile() {
    mcExpanded.classList.remove("open");
    mcExpanded.setAttribute("aria-hidden", "true");
    mcOpenFile = null;
    mcEditing = false;
  }

  function enterEditMode() {
    mcEditing = true;
    mcRender.style.display = "none";
    mcEditor.style.display = "block";
    mcEditBtn.style.display = "none";
    mcSaveBtn.style.display = "";
    mcCancelBtn.style.display = "";
    mcEditor.focus();
  }

  function exitEditMode() {
    mcEditing = false;
    const entry = mcFiles.find((f) => f.name === mcOpenFile);
    if (entry) mcEditor.value = entry.content;
    mcRender.style.display = "";
    mcEditor.style.display = "none";
    mcEditBtn.style.display = "";
    mcSaveBtn.style.display = "none";
    mcCancelBtn.style.display = "none";
  }

  async function saveMCFile() {
    if (!mcOpenFile) return;
    const content = mcEditor.value;
    try {
      const res = await fetch(`/ui/mc/${encodeURIComponent(mcOpenFile)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) { showToast("Save failed"); return; }
      const updated = await res.json();
      const idx = mcFiles.findIndex((f) => f.name === updated.name);
      if (idx >= 0) mcFiles[idx] = updated; else mcFiles.push(updated);
      mcRender.innerHTML = renderMarkdown(updated.content);
      exitEditMode();
      mcSavedIndicator.classList.add("show");
      setTimeout(() => mcSavedIndicator.classList.remove("show"), 1500);
      showToast(`${updated.label} saved`);
      renderMCGrid();
    } catch {
      showToast("Save failed");
    }
  }

  function handleMCUpdate(fileName, entry) {
    const idx = mcFiles.findIndex((f) => f.name === fileName);
    if (idx >= 0) mcFiles[idx] = entry; else mcFiles.push(entry);
    // If the updated file is currently open and NOT being edited, refresh the rendered view
    if (mcOpenFile === fileName && !mcEditing) {
      mcRender.innerHTML = renderMarkdown(entry.content);
      mcEditor.value = entry.content;
      mcSavedIndicator.classList.add("show");
      setTimeout(() => mcSavedIndicator.classList.remove("show"), 1500);
    }
    // Always keep the grid fresh (cards stay current even when file is open)
    if ($("#tab-mc").classList.contains("active")) renderMCGrid();
  }

  mcEditBtn.addEventListener("click", enterEditMode);
  mcSaveBtn.addEventListener("click", saveMCFile);
  mcCancelBtn.addEventListener("click", exitEditMode);
  mcCloseBtn.addEventListener("click", closeMCFile);

  // Esc closes the expanded view
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mcExpanded.classList.contains("open") && !mcEditing) {
      closeMCFile();
    }
  });

  // ══════════════════ COSTS ══════════════════
  const costsBody = $("#costs-body");
  const costsFooter = $("#costs-footer");
  const costAddBtn = $("#cost-add-btn");
  const costPills = $$(".cost-pill");
  const costModal = $("#cost-modal");
  const costModalTitle = $("#cost-modal-title");
  const costModalClose = $("#cost-modal-close");
  const costModalBackdrop = $("#cost-modal-backdrop");
  const costModalCancel = $("#cost-modal-cancel");
  const costModalSave = $("#cost-modal-save");
  const costModalDelete = $("#cost-modal-delete");

  const BUCKET_LABELS = {
    ai_automation: "AI Automation",
    personal: "Personal",
  };

  let costEntries = [];
  let activeBucket = "ai_automation";
  let modalMode = "add";       // "add" | "edit"
  let modalEditingId = null;

  function fmtCurrency(n) {
    if (n === null || n === undefined) return "";
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    return "$" + v.toLocaleString(undefined, { minimumFractionDigits: v % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  }

  function displayCost(entry) {
    if (entry.cost_type === "free") {
      return { text: "$0", cls: "free" };
    }
    if (entry.monthly_cost_fixed !== null && entry.monthly_cost_fixed !== undefined) {
      return { text: fmtCurrency(entry.monthly_cost_fixed), cls: "" };
    }
    if (entry.monthly_cost_estimate !== null && entry.monthly_cost_estimate !== undefined) {
      return { text: "~" + fmtCurrency(entry.monthly_cost_estimate) + "/mo est", cls: "estimate" };
    }
    return { text: "TBD", cls: "tbd" };
  }

  function computeBucketTotals(entries) {
    let fixed = 0;
    let usage = 0;
    for (const e of entries) {
      if (!e.active) continue;
      if (e.cost_type === "free") continue;
      if (e.monthly_cost_fixed !== null && e.monthly_cost_fixed !== undefined) {
        fixed += Number(e.monthly_cost_fixed) || 0;
      } else if (e.monthly_cost_estimate !== null && e.monthly_cost_estimate !== undefined) {
        usage += Number(e.monthly_cost_estimate) || 0;
      }
    }
    return { fixed, usage, total: fixed + usage };
  }

  function renderEntryRow(entry) {
    const cost = displayCost(entry);
    const hasUrl = !!entry.billing_url;
    const dupFlag = entry.duplicate_of ? `<span class="dup-flag" title="Possible overlap with another bucket — ID: ${escapeHtml(entry.duplicate_of)}">DUP?</span>` : "";
    const usedFor = entry.used_for ? `<span class="costs-row-used">${escapeHtml(entry.used_for)}</span>` : "";
    const notes = (!entry.used_for && entry.notes) ? `<span class="costs-row-used">${escapeHtml(entry.notes)}</span>` : "";
    const badge = `<span class="cost-badge ${entry.cost_type}">${entry.cost_type}</span>`;
    const manageBtn = hasUrl
      ? `<a class="cost-action" href="${escapeHtml(entry.billing_url)}" target="_blank" rel="noopener noreferrer">Manage &rarr;</a>`
      : `<span class="cost-action disabled">Manage &rarr;</span>`;
    const editBtn = `<button class="cost-action cost-edit" data-id="${escapeHtml(entry.id)}">Edit</button>`;
    return `
      <div class="costs-row ${entry.active ? "" : "inactive"} ${entry.cost_type === "free" ? "free" : ""}">
        <div class="costs-row-service">
          <span class="costs-row-name">${escapeHtml(entry.service)} ${dupFlag}</span>
          ${usedFor}${notes}
        </div>
        <span class="costs-row-cost ${cost.cls}">${cost.text}</span>
        ${badge}
        <div class="costs-row-actions">
          ${editBtn}
          ${manageBtn}
        </div>
      </div>
    `;
  }

  function renderBucketSection(bucket, entries) {
    const active = entries.filter((e) => e.active);
    const inactive = entries.filter((e) => !e.active);
    const totals = computeBucketTotals(entries);

    // Group active by category
    const byCat = {};
    for (const e of active) {
      if (!byCat[e.category]) byCat[e.category] = [];
      byCat[e.category].push(e);
    }
    // Sort categories alphabetically; within each, free last
    const categories = Object.keys(byCat).sort();
    const groupsHtml = categories.map((cat) => {
      const rows = byCat[cat].slice().sort((a, b) => {
        if (a.cost_type === "free" && b.cost_type !== "free") return 1;
        if (b.cost_type === "free" && a.cost_type !== "free") return -1;
        return a.service.localeCompare(b.service);
      });
      return `
        <div class="costs-category-header">${escapeHtml(cat)}</div>
        ${rows.map(renderEntryRow).join("")}
      `;
    }).join("");

    const inactiveBlock = inactive.length
      ? `
        <div class="costs-inactive-toggle" data-bucket="${bucket}">
          <span class="caret">&#x25B8;</span> Inactive / Paused (${inactive.length})
        </div>
        <div class="costs-inactive-rows" data-bucket="${bucket}">
          ${inactive.map(renderEntryRow).join("")}
        </div>
      `
      : "";

    const subtotalLabel = `<strong>${fmtCurrency(totals.total).replace(/\.\d+$/, "")}</strong>/mo`;

    return `
      <div class="costs-bucket-section" data-bucket="${bucket}">
        <div class="costs-bucket-header">
          <span class="costs-bucket-name">${BUCKET_LABELS[bucket] || bucket}</span>
          <span class="costs-bucket-subtotal">${active.length} active &middot; ~${subtotalLabel}</span>
        </div>
        ${groupsHtml || '<div class="costs-empty">No active services in this bucket.</div>'}
        ${inactiveBlock}
      </div>
    `;
  }

  function renderBucketFooter(bucket, entries) {
    const totals = computeBucketTotals(entries);
    return `
      <div class="costs-footer-section">
        <div class="section-label">${BUCKET_LABELS[bucket]}</div>
        <div class="costs-footer-row"><span class="label">Fixed / Subscription</span><span class="value">${fmtCurrency(totals.fixed)}/mo</span></div>
        <div class="costs-footer-row"><span class="label">Usage-Based (est)</span><span class="value">~${fmtCurrency(totals.usage)}/mo</span></div>
        <div class="costs-footer-row total"><span class="label">Total Estimated</span><span class="value">~${fmtCurrency(totals.total)}/mo</span></div>
      </div>
    `;
  }

  function renderCosts() {
    costAddBtn.style.display = "";

    let bucketsToShow;
    if (activeBucket === "all") {
      bucketsToShow = ["ai_automation", "personal"];
    } else {
      bucketsToShow = [activeBucket];
    }

    const sections = bucketsToShow.map((b) => {
      const entries = costEntries.filter((e) => e.bucket === b);
      return renderBucketSection(b, entries);
    }).join("");

    costsBody.innerHTML = sections || '<div class="costs-empty">No entries.</div>';

    // Footer: per-bucket breakdown + grand total when "all"
    if (activeBucket === "all") {
      const parts = bucketsToShow.map((b) => {
        const entries = costEntries.filter((e) => e.bucket === b);
        return renderBucketFooter(b, entries);
      }).join("");
      const grand = computeBucketTotals(costEntries);
      costsFooter.innerHTML = `
        <div class="costs-footer-title">Monthly Spend Summary</div>
        ${parts}
        <div class="costs-footer-section">
          <div class="costs-footer-row total">
            <span class="label">Combined Grand Total</span>
            <span class="value">~${fmtCurrency(grand.total)}/mo</span>
          </div>
        </div>
      `;
    } else {
      const entries = costEntries.filter((e) => e.bucket === activeBucket);
      const t = computeBucketTotals(entries);
      costsFooter.innerHTML = `
        <div class="costs-footer-title">${BUCKET_LABELS[activeBucket]} — Monthly Total</div>
        <div class="costs-footer-row"><span class="label">Fixed / Subscription</span><span class="value">${fmtCurrency(t.fixed)}/mo</span></div>
        <div class="costs-footer-row"><span class="label">Usage-Based (est)</span><span class="value">~${fmtCurrency(t.usage)}/mo</span></div>
        <div class="costs-footer-row total"><span class="label">Total Estimated</span><span class="value">~${fmtCurrency(t.total)}/mo</span></div>
      `;
    }

    // Wire inactive toggles
    $$(".costs-inactive-toggle", costsBody).forEach((t) => {
      t.addEventListener("click", () => {
        const b = t.dataset.bucket;
        const rows = costsBody.querySelector(`.costs-inactive-rows[data-bucket="${b}"]`);
        if (rows) rows.classList.toggle("open");
        const caret = t.querySelector(".caret");
        if (caret) caret.innerHTML = rows && rows.classList.contains("open") ? "&#x25BE;" : "&#x25B8;";
      });
    });

    // Wire edit buttons
    $$(".cost-edit", costsBody).forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const entry = costEntries.find((e) => e.id === id);
        if (entry) openCostModal("edit", entry);
      });
    });
  }

  async function loadCosts() {
    try {
      const res = await fetch("/ui/costs");
      const data = await res.json();
      costEntries = data.entries || [];
      renderCosts();
    } catch (err) {
      costsBody.innerHTML = '<div class="costs-empty">Failed to load costs.</div>';
    }
  }

  costPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      activeBucket = pill.dataset.bucket;
      costPills.forEach((p) => p.classList.toggle("active", p === pill));
      renderCosts();
    });
  });

  // ── Modal logic (all buckets) ──
  function defaultBucketForAdd() {
    // When the Add button is clicked, default to the currently filtered bucket;
    // for the "all" view, fall back to AI Automation.
    if (activeBucket === "all") return "ai_automation";
    return activeBucket;
  }

  function openCostModal(mode, entry) {
    modalMode = mode;
    modalEditingId = entry ? entry.id : null;
    costModalTitle.textContent = mode === "add" ? "Add Subscription" : "Edit Subscription";
    costModalDelete.style.display = mode === "edit" ? "" : "none";

    $("#cost-f-bucket").value = entry ? entry.bucket : defaultBucketForAdd();
    $("#cost-f-service").value = entry ? entry.service : "";
    $("#cost-f-category").value = entry ? entry.category : "";
    $("#cost-f-cost-type").value = entry ? entry.cost_type : "subscription";
    const costVal = entry
      ? (entry.monthly_cost_fixed ?? entry.monthly_cost_estimate ?? "")
      : "";
    $("#cost-f-cost").value = costVal === null || costVal === undefined ? "" : costVal;
    $("#cost-f-billing").value = entry && entry.billing_url ? entry.billing_url : "";
    $("#cost-f-notes").value = entry && entry.notes ? entry.notes : "";
    $("#cost-f-active").checked = entry ? !!entry.active : true;

    costModal.classList.add("open");
    costModal.setAttribute("aria-hidden", "false");
    setTimeout(() => $("#cost-f-service").focus(), 50);
  }

  function closeCostModal() {
    costModal.classList.remove("open");
    costModal.setAttribute("aria-hidden", "true");
    modalEditingId = null;
  }

  function collectModalPayload() {
    const costType = $("#cost-f-cost-type").value;
    const rawCost = $("#cost-f-cost").value.trim();
    const costNum = rawCost === "" ? null : Number(rawCost);

    // For free, always $0 and store in fixed
    let monthly_cost_fixed = null;
    let monthly_cost_estimate = null;
    if (costType === "free") {
      monthly_cost_fixed = 0;
    } else if (costType === "usage") {
      monthly_cost_estimate = costNum;
    } else {
      // fixed or subscription → put in fixed
      monthly_cost_fixed = costNum;
    }

    return {
      bucket: $("#cost-f-bucket").value,
      service: $("#cost-f-service").value.trim(),
      category: $("#cost-f-category").value.trim() || "Other",
      cost_type: costType,
      monthly_cost_fixed,
      monthly_cost_estimate,
      billing_url: $("#cost-f-billing").value.trim() || null,
      notes: $("#cost-f-notes").value.trim() || null,
      active: $("#cost-f-active").checked,
    };
  }

  costAddBtn.addEventListener("click", () => openCostModal("add", null));
  costModalClose.addEventListener("click", closeCostModal);
  costModalBackdrop.addEventListener("click", closeCostModal);
  costModalCancel.addEventListener("click", closeCostModal);

  costModalSave.addEventListener("click", async () => {
    const payload = collectModalPayload();
    if (!payload.service) {
      showToast("Service name required");
      return;
    }
    costModalSave.disabled = true;
    try {
      let res;
      if (modalMode === "add") {
        res = await fetch("/ui/costs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch(`/ui/costs/${encodeURIComponent(modalEditingId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || "Save failed");
      } else {
        showToast(modalMode === "add" ? "Added" : "Saved");
        closeCostModal();
        await loadCosts();
      }
    } catch {
      showToast("Save failed");
    } finally {
      costModalSave.disabled = false;
    }
  });

  costModalDelete.addEventListener("click", async () => {
    if (!modalEditingId) return;
    if (!confirm("Delete this entry? This cannot be undone.")) return;
    try {
      const res = await fetch(`/ui/costs/${encodeURIComponent(modalEditingId)}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || "Delete failed");
      } else {
        showToast("Deleted");
        closeCostModal();
        await loadCosts();
      }
    } catch {
      showToast("Delete failed");
    }
  });

  // Esc closes cost modal too
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && costModal.classList.contains("open")) {
      closeCostModal();
    }
  });

  // ══════════════════ INLINE STREAM ══════════════════
  // streamCards: streamId → { bot, el, textBuf, tools: Set, lastEventMs }
  const streamCards = new Map();

  function buildStreamingMsgCard(bot) {
    const el = document.createElement("div");
    el.className = `msg ${bot} streaming`;
    el.innerHTML = `
      <div class="msg-head">
        <span class="msg-bot">${escapeHtml(bot)}</span>
        <span class="msg-time">${formatTime(Date.now())}</span>
        <span class="msg-tools"></span>
      </div>
      <div class="msg-text"><span class="msg-placeholder">working...</span></div>
    `;
    return el;
  }

  function onStreamStart(ev) {
    const { streamId, botName } = ev;
    if (activeBot !== "all" && activeBot !== botName) return;
    hideFeedEmpty();
    const el = buildStreamingMsgCard(botName);
    feedList.appendChild(el);
    feedList.scrollTop = feedList.scrollHeight;
    streamCards.set(streamId, { bot: botName, el, textBuf: "", tools: new Set(), lastEventMs: Date.now() });
  }

  function onStreamChunk(ev) {
    const state = streamCards.get(ev.streamId);
    if (!state) return;
    state.lastEventMs = Date.now();
    state.textBuf += ev.chunk || "";
    const textEl = state.el.querySelector(".msg-text");
    if (textEl) {
      textEl.innerHTML = renderMarkdown(state.textBuf) + '<span class="stream-cursor"></span>';
    }
    feedList.scrollTop = feedList.scrollHeight;
  }

  function onStreamToolUse(ev) {
    const state = streamCards.get(ev.streamId);
    if (!state) return;
    state.lastEventMs = Date.now();
    const name = ev.toolName || "tool";
    if (state.tools.has(name)) return;
    state.tools.add(name);
    const toolsEl = state.el.querySelector(".msg-tools");
    if (toolsEl) {
      const badge = document.createElement("span");
      badge.className = "msg-tool-badge";
      badge.textContent = name;
      toolsEl.appendChild(badge);
    }
  }

  function finalizeStreamCard(streamId, opts) {
    const state = streamCards.get(streamId);
    if (!state) return;
    streamCards.delete(streamId);

    const { el, bot, textBuf } = state;
    el.classList.remove("streaming");

    // Strip streaming-only decorations
    const cursor = el.querySelector(".stream-cursor");
    if (cursor) cursor.remove();
    const toolsEl = el.querySelector(".msg-tools");
    if (toolsEl) toolsEl.innerHTML = "";

    if (opts && opts.error) {
      el.classList.add("errored");
      if (!textBuf) {
        const textEl = el.querySelector(".msg-text");
        if (textEl) textEl.innerHTML = `<em class="stream-error-text">${escapeHtml(opts.error)}</em>`;
      }
    }

    // Mark for dedupe: next appendMessage "out" for this bot should reuse this card
    el.dataset.consumeNextOutForBot = bot;
    setTimeout(() => { delete el.dataset.consumeNextOutForBot; }, 5000);

    el.addEventListener("click", () => {
      navigator.clipboard.writeText(textBuf).then(() => showToast("Copied to clipboard"));
    });
  }

  function onStreamEnd(ev) {
    finalizeStreamCard(ev.streamId, null);
  }

  function onStreamError(ev) {
    finalizeStreamCard(ev.streamId, { error: ev.error || "stream error" });
  }

  // Watchdog: finalize any stream silent >90s
  setInterval(() => {
    const now = Date.now();
    for (const [streamId, state] of streamCards) {
      if (now - state.lastEventMs > 90_000) {
        finalizeStreamCard(streamId, { error: "lost" });
      }
    }
  }, 5000);

})();
