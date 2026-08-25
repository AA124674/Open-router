/*!
 * Router — a small, self-hosted chat client for OpenRouter models.
 * No build step, no server: everything runs in this one file, and every
 * chat lives in this browser's localStorage. Nothing is sent anywhere
 * except your messages, which go straight to openrouter.ai.
 */
(function () {
  "use strict";

  /* --------------------------------------------------------------- utils */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  /* --------------------------------------------------------- persistence */

  var LS_CHATS = "router.chats.v1";
  var LS_SETTINGS = "router.settings.v1";
  var LS_ACTIVE = "router.active.v1";
  var LS_MODEL_CACHE = "router.modelcache.v2"; // v2: free-only filter

  var DEFAULT_SETTINGS = {
    apiKey: "",
    model: "",
    temperature: "",
    maxTokens: "",
    systemPrompt: "",
    stream: true,
    theme: "dark"
  };

  // A small, curated fallback so the model field isn't empty before the
  // live list loads (or if it can't be reached). Free-tier IDs on
  // OpenRouter rotate often, so this is only a convenience — the live
  // fetch below is what actually keeps the picker current and free-only.
  var FALLBACK_MODELS = [
    { id: "stealth/ox-alpha", name: "Ox Alpha (free)" },
    { id: "poolside/laguna-s-2.1:free", name: "Poolside: Laguna S 2.1 (free)" },
    { id: "nvidia/nemotron-3.5-lightning:free", name: "NVIDIA: Nemotron 3.5 Lightning (free)" },
    { id: "thinkingmachines/inkling:free", name: "Thinking Machines: Inkling (free)" },
    { id: "liquid/lfm-2.5-2.6b:free", name: "LiquidAI: LFM2.5-2.6B (free)" },
    { id: "dots-studio/dots-3-note-preview:free", name: "Dots Studio: Dots3-Note Preview (free)" }
  ];

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }
  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      toast("Could not save — this browser's storage may be full.", "err");
      return false;
    }
  }

  var state = {
    chats: loadJson(LS_CHATS, []),
    settings: Object.assign({}, DEFAULT_SETTINGS, loadJson(LS_SETTINGS, {})),
    activeChat: loadJson(LS_ACTIVE, null)
  };
  if (!state.chats.some(function (c) { return c.id === state.activeChat; })) {
    state.activeChat = state.chats.length ? state.chats[0].id : null;
  }

  function saveChats() { saveJson(LS_CHATS, state.chats); }
  function saveSettings() { saveJson(LS_SETTINGS, state.settings); }
  function saveActive() { saveJson(LS_ACTIVE, state.activeChat); }

  function chatById(id) { return state.chats.filter(function (c) { return c.id === id; })[0] || null; }
  function activeChat() { return chatById(state.activeChat); }

  /* -------------------------------------------------------------- theme */

  function applyTheme() {
    var t = state.settings.theme || "system";
    var resolved = t;
    if (t === "system") {
      resolved = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches)
        ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", resolved);
  }
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () {
      if (state.settings.theme === "system") applyTheme();
    });
  }

  /* ------------------------------------------------------------- toasts */

  function toast(msg, kind) {
    var host = $("#toasts");
    if (!host) return;
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity .15s";
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 160);
    }, 2200);
  }

  /** navigator.clipboard needs a secure context; fall back to a hidden textarea. */
  function copyText(text, okMsg) {
    function ok() { toast(okMsg || "Copied.", "ok"); }
    function fail() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        ok();
      } catch (e) {
        toast("Couldn't copy — select and copy manually.", "err");
      }
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(ok, fail);
    } else {
      fail();
    }
  }

  /* --------------------------------------------------------------modals */

  function openModal(sel) {
    $("#modal-scrim").classList.add("open");
    $(sel).classList.add("open");
  }
  function closeModals() {
    $("#modal-scrim").classList.remove("open");
    $$(".modal").forEach(function (m) { m.classList.remove("open"); });
  }

  /* --------------------------------------------------------- markdown lite */
  /*
   * A small, dependency-free renderer: fenced code, inline code, bold,
   * italic, links, headings (# ## ###), lists, blockquotes and paragraphs.
   * Everything is HTML-escaped before any tag is introduced, so raw model
   * output can never inject markup.
   */
  function mdToHtml(raw) {
    if (!raw) return "";
    raw = String(raw).replace(/\r\n?/g, "\n");

    var blocks = [];
    var text = raw.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push({ lang: lang, code: code.replace(/\n$/, "") });
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });

    text = escapeHtml(text);

    function inline(s) {
      // Inline code first, so markers inside it are not read as formatting.
      s = s.replace(/`([^`\n]+)`/g, function (_, code) { return "<code>" + code + "</code>"; });
      s = s.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/__([^\n]+?)__/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
      });
      return s;
    }

    var RE_HEAD = /^\s*(#{1,3})\s+(.*)$/;
    var RE_UL = /^\s*[-*+]\s+/;
    var RE_OL = /^\s*\d+\.\s+/;
    var RE_QUOTE = /^\s*&gt;\s?/;

    // Line-by-line within each blank-line-delimited chunk, so a heading or
    // list that starts right after a lead-in line (no blank line before it
    // — the most common shape in model output) is still recognised instead
    // of falling back to one literal paragraph.
    function renderChunk(chunk) {
      var lines = chunk.split("\n");
      var out = [];
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];

        var h = line.match(RE_HEAD);
        if (h) {
          out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">");
          i++;
          continue;
        }

        if (RE_UL.test(line)) {
          var uitems = [];
          while (i < lines.length && RE_UL.test(lines[i])) {
            uitems.push("<li>" + inline(lines[i].replace(RE_UL, "")) + "</li>");
            i++;
          }
          out.push("<ul>" + uitems.join("") + "</ul>");
          continue;
        }

        if (RE_OL.test(line)) {
          var oitems = [];
          while (i < lines.length && RE_OL.test(lines[i])) {
            oitems.push("<li>" + inline(lines[i].replace(RE_OL, "")) + "</li>");
            i++;
          }
          out.push("<ol>" + oitems.join("") + "</ol>");
          continue;
        }

        if (RE_QUOTE.test(line)) {
          var qlines = [];
          while (i < lines.length && RE_QUOTE.test(lines[i])) {
            qlines.push(inline(lines[i].replace(RE_QUOTE, "")));
            i++;
          }
          out.push("<blockquote><p>" + qlines.join("<br>") + "</p></blockquote>");
          continue;
        }

        var plines = [];
        while (i < lines.length &&
               !RE_HEAD.test(lines[i]) && !RE_UL.test(lines[i]) &&
               !RE_OL.test(lines[i]) && !RE_QUOTE.test(lines[i])) {
          plines.push(lines[i]);
          i++;
        }
        out.push("<p>" + inline(plines.join("\n")).replace(/\n/g, "<br>") + "</p>");
      }
      return out.join("");
    }

    var out = text.split(/\n{2,}/).map(function (chunk) {
      var m = chunk.trim().match(/^\u0000B(\d+)\u0000$/);
      if (m) {
        var cb = blocks[+m[1]];
        var langClass = cb.lang ? ' class="lang-' + cb.lang.replace(/[^a-zA-Z0-9_-]/g, "") + '"' : "";
        return '<pre><button class="code-copy" type="button">Copy</button><code' + langClass + ">" +
          escapeHtml(cb.code) + "</code></pre>";
      }
      return renderChunk(chunk);
    }).join("");

    return out;
  }

  /* -------------------------------------------------------------- chats */

  function newChat() {
    var current = activeChat();
    // Reuse an already-empty chat instead of piling up blanks.
    if (current && current.messages.length === 0) {
      focusComposer();
      return current;
    }
    var chat = {
      id: uid(),
      title: "New chat",
      titleAuto: true,
      model: state.settings.model || "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    state.chats.unshift(chat);
    state.activeChat = chat.id;
    saveChats(); saveActive();
    renderSidebar();
    renderChat();
    focusComposer();
    return chat;
  }

  function selectChat(id) {
    if (state.activeChat === id) return;
    state.activeChat = id;
    saveActive();
    renderSidebar();
    renderChat();
    if (window.innerWidth <= 860) closeSidebarMobile();
  }

  function deleteChat(id) {
    var c = chatById(id);
    if (!c) return;
    if (!confirm('Delete "' + c.title + '"? This can\'t be undone.')) return;
    state.chats = state.chats.filter(function (x) { return x.id !== id; });
    if (state.activeChat === id) state.activeChat = state.chats.length ? state.chats[0].id : null;
    saveChats(); saveActive();
    renderSidebar();
    renderChat();
  }

  function clearAllChats() {
    if (!state.chats.length) { toast("No chats to delete."); return; }
    if (!confirm("Delete all " + state.chats.length + " chats? This can't be undone.")) return;
    state.chats = [];
    state.activeChat = null;
    saveChats(); saveActive();
    renderSidebar();
    renderChat();
    toast("All chats deleted.");
  }

  function renameChat(id, title) {
    var c = chatById(id);
    if (!c) return;
    var clean = title.trim();
    c.title = clean || "New chat";
    c.titleAuto = !clean;
    c.updatedAt = Date.now();
    saveChats();
    renderSidebar();
  }

  function autoTitle(chat, firstUserText) {
    if (!chat.titleAuto) return;
    var t = firstUserText.trim().replace(/\s+/g, " ");
    chat.title = t.length > 48 ? t.slice(0, 48).trim() + "…" : (t || "New chat");
    saveChats();
    renderSidebar();
  }

  /* ------------------------------------------------------------ sidebar */

  var ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7m2 0-.7 12.1A2 2 0 0 1 14.3 21H9.7a2 2 0 0 1-2-1.9L7 7" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_PENCIL = '<svg viewBox="0 0 24 24"><path d="M15.7 4.3a1.5 1.5 0 0 1 2.1 0l1.9 1.9a1.5 1.5 0 0 1 0 2.1L8.3 19.7l-4.3.9.9-4.3Z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_COPY_SM = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>';

  var renamingId = null; // chat currently shown as an inline-edit row, if any

  function renderSidebar() {
    var host = $("#chat-list");
    var q = ($("#chat-search").value || "").trim().toLowerCase();
    var list = state.chats.filter(function (c) { return !q || c.title.toLowerCase().indexOf(q) !== -1; });

    if (!state.chats.length) {
      host.innerHTML = '<div class="side-note">No chats yet. Start one with <strong>New chat</strong> above.</div>';
      return;
    }
    if (!list.length) {
      host.innerHTML = '<div class="side-note">No chats match “' + escapeHtml(q) + '”.</div>';
      return;
    }

    host.innerHTML = list.map(function (c) {
      if (c.id === renamingId) {
        return '<div class="chat-row active">' +
          '<input class="chat-title-edit" type="text" data-rename-input="' + c.id + '" value="' + escapeHtml(c.title) + '">' +
          "</div>";
      }
      return '<div class="chat-row' + (c.id === state.activeChat ? " active" : "") + '">' +
        '<button class="chat-row-btn" data-select="' + c.id + '"></button>' +
        '<span class="chat-row-acts">' +
        '<button class="chat-row-act" data-rename="' + c.id + '" title="Rename chat" aria-label="Rename chat">' + ICON_PENCIL + "</button>" +
        '<button class="chat-row-act" data-copy="' + c.id + '" title="Copy conversation" aria-label="Copy conversation">' + ICON_COPY_SM + "</button>" +
        '<button class="chat-row-act" data-delete="' + c.id + '" title="Delete chat" aria-label="Delete chat">' + ICON_TRASH + "</button>" +
        "</span></div>";
    }).join("");
    // Titles set as text, never interpolated into markup.
    $$("[data-select]", host).forEach(function (btn, i) { btn.textContent = list[i].title; });

    var editInput = $("[data-rename-input]", host);
    if (editInput) { editInput.focus(); editInput.select(); }
  }

  /* ------------------------------------------------------------- render */

  function renderChat() {
    var chat = activeChat();
    var badge = $("#model-badge");
    var empty = $("#empty-state");
    // A permanent sibling of #empty-state, toggled rather than rebuilt —
    // clearing #messages wholesale each render would also delete
    // #empty-state, leaving the next render with nothing to find.
    var wrap = $("#messages-inner");

    if (!chat) {
      badge.textContent = state.settings.model || "No model set";
      wrap.hidden = true;
      wrap.innerHTML = "";
      empty.hidden = false;
      $("#empty-copy").textContent = state.settings.apiKey
        ? "Pick a model in Settings and send a message to begin."
        : "Add your OpenRouter API key in Settings, then send a message.";
      return;
    }

    badge.textContent = chat.model || state.settings.model || "No model set";

    if (!chat.messages.length) {
      wrap.hidden = true;
      wrap.innerHTML = "";
      empty.hidden = false;
      $("#empty-copy").textContent = state.settings.apiKey
        ? "Send a message to begin."
        : "Add your OpenRouter API key in Settings, then send a message.";
      return;
    }

    empty.hidden = true;
    wrap.hidden = false;
    wrap.innerHTML = "";
    chat.messages.forEach(function (m) { wrap.appendChild(renderBubble(m)); });
    scrollToBottom();
  }

  function scrollToBottom() {
    var host = $("#messages");
    host.scrollTop = host.scrollHeight;
  }

  var ICON_COPY = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>';

  function renderBubble(m) {
    var el = document.createElement("div");
    el.className = "msg msg-" + (m.role === "error" ? "error" : m.role);
    el.dataset.msgId = m.id;

    var role = document.createElement("div");
    role.className = "msg-role";
    role.textContent = m.role === "user" ? "You" : m.role === "error" ? "Error" : (m.model || "Assistant");
    el.appendChild(role);

    var bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    if (m.pending && !m.content) {
      bubble.innerHTML = '<span class="msg-thinking"><span></span><span></span><span></span></span>';
    } else {
      bubble.innerHTML = mdToHtml(m.content) + (m.pending ? '<span class="msg-cursor"></span>' : "");
    }
    el.appendChild(bubble);

    if (!m.pending && m.content) {
      var acts = document.createElement("div");
      acts.className = "msg-acts";
      var copyBtn = document.createElement("button");
      copyBtn.className = "msg-act";
      copyBtn.type = "button";
      copyBtn.innerHTML = ICON_COPY + "<span>Copy</span>";
      copyBtn.addEventListener("click", function () { copyText(m.content, "Message copied."); });
      acts.appendChild(copyBtn);
      if (m.stopped) {
        var note = document.createElement("span");
        note.className = "hint";
        note.style.padding = "3px 5px";
        note.textContent = "Stopped";
        acts.appendChild(note);
      }
      el.appendChild(acts);
    }

    return el;
  }

  /** Update just one message's bubble in place, for cheap per-token repaint. */
  function updateBubble(m) {
    var host = $(".msg[data-msg-id='" + m.id + "']");
    if (!host) return;
    var fresh = renderBubble(m);
    host.replaceWith(fresh);
  }

  /* --------------------------------------------------------- composer -- */

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = clamp(ta.scrollHeight, 44, 200) + "px";
  }
  function focusComposer() {
    var ta = $("#composer-input");
    setTimeout(function () { ta.focus(); }, 30);
  }

  var inFlight = null; // { controller, chatId, msgId }

  function setSending(isSending) {
    $("#send-btn").disabled = isSending;
    $("#stop-btn").hidden = !isSending;
  }

  function handleSend(e) {
    if (e) e.preventDefault();
    var ta = $("#composer-input");
    var text = ta.value.trim();
    if (!text || inFlight) return;

    if (!state.settings.apiKey) {
      toast("Add your OpenRouter API key in Settings first.", "err");
      openSettings();
      return;
    }
    if (!state.settings.model) {
      toast("Pick a model in Settings first.", "err");
      openSettings();
      return;
    }

    var chat = activeChat() || newChat();
    var isFirst = chat.messages.length === 0;

    chat.messages.push({ id: uid(), role: "user", content: text, ts: Date.now() });
    chat.model = state.settings.model;
    chat.updatedAt = Date.now();
    saveChats();
    renderChat();
    if (isFirst) autoTitle(chat, text);

    ta.value = "";
    autoGrow(ta);

    runCompletion(chat);
  }

  function stopGenerating() {
    if (inFlight) inFlight.controller.abort();
  }

  function buildApiMessages(chat) {
    var out = [];
    if (state.settings.systemPrompt.trim()) {
      out.push({ role: "system", content: state.settings.systemPrompt.trim() });
    }
    chat.messages.forEach(function (m) {
      if (m.role === "user" || m.role === "assistant") {
        if (m.pending) return; // the in-progress placeholder itself
        out.push({ role: m.role, content: m.content });
      }
    });
    return out;
  }

  function runCompletion(chat) {
    var placeholder = { id: uid(), role: "assistant", content: "", pending: true, model: state.settings.model, ts: Date.now() };
    chat.messages.push(placeholder);
    renderChat();
    setSending(true);

    var controller = new AbortController();
    inFlight = { controller: controller, chatId: chat.id, msgId: placeholder.id };

    var payload = {
      model: state.settings.model,
      messages: buildApiMessages(chat),
      stream: !!state.settings.stream
    };
    var temp = parseFloat(state.settings.temperature);
    if (!isNaN(temp)) payload.temperature = temp;
    var maxTok = parseInt(state.settings.maxTokens, 10);
    if (maxTok > 0) payload.max_tokens = maxTok;

    function onDelta(piece) {
      placeholder.content += piece;
      updateBubble(placeholder);
      scrollToBottom();
    }

    function finish() {
      placeholder.pending = false;
      chat.updatedAt = Date.now();
      saveChats();
      updateBubble(placeholder);
      setSending(false);
      inFlight = null;
    }

    function fail(err) {
      var aborted = err && err.name === "AbortError";
      if (aborted) {
        placeholder.pending = false;
        placeholder.stopped = true;
        chat.updatedAt = Date.now();
        saveChats();
        updateBubble(placeholder);
        setSending(false);
        inFlight = null;
        return;
      }
      // Swap the placeholder for a distinct error bubble; nothing sent to
      // the API keeps this role, so it never confuses later turns.
      chat.messages = chat.messages.filter(function (m) { return m.id !== placeholder.id; });
      chat.messages.push({ id: uid(), role: "error", content: (err && err.message) || "Something went wrong.", ts: Date.now() });
      chat.updatedAt = Date.now();
      saveChats();
      renderChat();
      setSending(false);
      inFlight = null;
      toast("Request failed.", "err");
    }

    fetchChatCompletion(payload, controller.signal, onDelta).then(finish, fail);
  }

  /* --------------------------------------------------------- OpenRouter */

  var API_BASE = "https://openrouter.ai/api/v1";

  function authHeaders() {
    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + state.settings.apiKey,
      "HTTP-Referer": location.href,
      "X-Title": "Router"
    };
  }

  function apiErrorMessage(status, body) {
    try {
      var j = JSON.parse(body);
      if (j && j.error && j.error.message) return j.error.message;
    } catch (e) { /* not JSON */ }
    if (status === 401) return "Invalid or missing API key.";
    if (status === 402) return "OpenRouter reports insufficient credit for this model.";
    if (status === 429) return "Rate limited — wait a moment and try again.";
    return body ? body.slice(0, 300) : ("HTTP " + status);
  }

  function fetchChatCompletion(payload, signal, onDelta) {
    if (!payload.stream) {
      return fetch(API_BASE + "/chat/completions", {
        method: "POST", headers: authHeaders(), body: JSON.stringify(payload), signal: signal
      }).then(function (res) {
        return res.text().then(function (bodyText) {
          if (!res.ok) throw new Error(apiErrorMessage(res.status, bodyText));
          var json;
          try { json = JSON.parse(bodyText); } catch (e) { throw new Error("Unreadable response from OpenRouter."); }
          var content = json.choices && json.choices[0] && json.choices[0].message
            ? json.choices[0].message.content : "";
          onDelta(content || "");
        });
      });
    }

    return fetch(API_BASE + "/chat/completions", {
      method: "POST", headers: authHeaders(), body: JSON.stringify(payload), signal: signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (bodyText) { throw new Error(apiErrorMessage(res.status, bodyText)); });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";

      function pump() {
        return reader.read().then(function (step) {
          if (step.done) return;
          buffer += decoder.decode(step.value, { stream: true });
          var lines = buffer.split("\n");
          buffer = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.indexOf("data:") !== 0) continue;
            var data = line.slice(5).trim();
            if (data === "[DONE]") return;
            try {
              var json = JSON.parse(data);
              var delta = json.choices && json.choices[0] && json.choices[0].delta
                ? json.choices[0].delta.content : "";
              if (delta) onDelta(delta);
            } catch (e) { /* keep-alive comment or partial line; ignore */ }
          }
          return pump();
        });
      }
      return pump();
    });
  }

  function fetchModels() {
    var cache = loadJson(LS_MODEL_CACHE, null);
    var fresh = cache && (Date.now() - cache.ts) < 6 * 60 * 60 * 1000;
    if (fresh) { fillModelList(cache.list); return; }
    fillModelList(FALLBACK_MODELS);

    fetch(API_BASE + "/models").then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (json) {
      // Only free models are ever shown here. A ":free" suffix is the usual
      // naming pattern but isn't reliable on its own — some free models
      // don't use it — so this checks OpenRouter's actual reported price.
      var list = (json.data || [])
        .filter(function (m) {
          var pricing = m.pricing || {};
          return parseFloat(pricing.prompt) === 0 && parseFloat(pricing.completion) === 0;
        })
        .map(function (m) { return { id: m.id, name: m.name || m.id }; });
      if (!list.length) return;
      list.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
      saveJson(LS_MODEL_CACHE, { ts: Date.now(), list: list });
      fillModelList(list);
    }).catch(function () {
      // Offline, or the request was blocked — the fallback list already covers the field.
    });
  }

  function fillModelList(list) {
    var dl = $("#model-options");
    dl.innerHTML = list.map(function (m) {
      return '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + "</option>";
    }).join("");
  }

  /* ------------------------------------------------------------settings */

  function openSettings() {
    var s = state.settings;
    $("#api-key").value = s.apiKey;
    $("#api-key").type = "password";
    $("#api-key-toggle").textContent = "Show";
    $("#model-input").value = s.model;
    $("#temperature").value = s.temperature;
    $("#max-tokens").value = s.maxTokens;
    $("#system-prompt").value = s.systemPrompt;
    $("#stream-toggle").checked = !!s.stream;
    $("#theme-select").value = s.theme;
    openModal("#settings-modal");
    fetchModels();
  }

  function saveSettingsForm() {
    state.settings.apiKey = $("#api-key").value.trim();
    state.settings.model = $("#model-input").value.trim();
    state.settings.temperature = $("#temperature").value.trim();
    state.settings.maxTokens = $("#max-tokens").value.trim();
    state.settings.systemPrompt = $("#system-prompt").value;
    state.settings.stream = $("#stream-toggle").checked;
    state.settings.theme = $("#theme-select").value;
    saveSettings();
    applyTheme();
    renderChat();
    closeModals();
    toast("Settings saved.");
  }

  /* ---------------------------------------------------------- copy chat */

  function copyChatById(id) {
    var chat = chatById(id);
    if (!chat || !chat.messages.length) { toast("Nothing to copy yet."); return; }
    var text = chat.messages
      .filter(function (m) { return m.role !== "error"; })
      .map(function (m) { return (m.role === "user" ? "You" : "Assistant") + ":\n" + m.content; })
      .join("\n\n");
    copyText(text, "Conversation copied.");
  }

  /* ------------------------------------------------------- mobile nav -- */

  function openSidebarMobile() { $("#app").classList.add("sidebar-open"); }
  function closeSidebarMobile() { $("#app").classList.remove("sidebar-open"); }

  /* ------------------------------------------------------------- init -- */

  var skipRenameCommit = false;

  function bindEvents() {
    $("#new-chat").addEventListener("click", newChat);
    $("#chat-search").addEventListener("input", renderSidebar);

    $("#chat-list").addEventListener("click", function (e) {
      var sel = e.target.closest("[data-select]");
      if (sel) { selectChat(sel.dataset.select); return; }
      var ren = e.target.closest("[data-rename]");
      if (ren) { e.stopPropagation(); renamingId = ren.dataset.rename; renderSidebar(); return; }
      var cp = e.target.closest("[data-copy]");
      if (cp) { e.stopPropagation(); copyChatById(cp.dataset.copy); return; }
      var del = e.target.closest("[data-delete]");
      if (del) { e.stopPropagation(); deleteChat(del.dataset.delete); }
    });

    $("#chat-list").addEventListener("keydown", function (e) {
      var input = e.target.closest("[data-rename-input]");
      if (!input) return;
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") {
        e.preventDefault();
        skipRenameCommit = true;
        renamingId = null;
        renderSidebar();
      }
    });
    $("#chat-list").addEventListener("focusout", function (e) {
      var input = e.target.closest("[data-rename-input]");
      if (!input) return;
      if (skipRenameCommit) { skipRenameCommit = false; return; }
      var id = input.dataset.renameInput;
      renamingId = null;
      renameChat(id, input.value);
    });

    $("#messages").addEventListener("click", function (e) {
      var cp = e.target.closest(".code-copy");
      if (!cp) return;
      var code = cp.parentElement.querySelector("code");
      if (code) copyText(code.textContent, "Code copied.");
    });

    $("#composer").addEventListener("submit", handleSend);
    var ta = $("#composer-input");
    ta.addEventListener("input", function () { autoGrow(this); });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    $("#stop-btn").addEventListener("click", stopGenerating);

    $("#model-badge").addEventListener("click", openSettings);
    $("#open-settings").addEventListener("click", openSettings);
    $("#empty-settings-btn").addEventListener("click", openSettings);
    $("#settings-close").addEventListener("click", closeModals);
    $("#settings-cancel").addEventListener("click", closeModals);
    $("#settings-save").addEventListener("click", saveSettingsForm);
    $("#modal-scrim").addEventListener("click", closeModals);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModals(); });

    $("#api-key-toggle").addEventListener("click", function () {
      var input = $("#api-key");
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      this.textContent = show ? "Hide" : "Show";
    });
    $("#model-refresh").addEventListener("click", function () {
      saveJson(LS_MODEL_CACHE, null);
      fetchModels();
      toast("Refreshing model list…");
    });
    $("#clear-all").addEventListener("click", clearAllChats);

    $("#sidebar-open").addEventListener("click", openSidebarMobile);
    $("#sidebar-close").addEventListener("click", closeSidebarMobile);
    $("#scrim").addEventListener("click", closeSidebarMobile);
  }

  function init() {
    applyTheme();
    bindEvents();
    renderSidebar();
    renderChat();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
