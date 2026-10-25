(() => {
  "use strict";

  const CONVERSATIONS_KEY = "dexbot.conversations.v1";
  const SETTINGS_KEY = "dexbot.settings.v1";
  const ACTIVE_KEY = "dexbot.active.v1";
  const MAX_CONVERSATIONS = 80;
  const MODEL_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;

  const ICONS = {
    spark:
      '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.5l2.7 9.3 9.3 2.7-9.3 2.7L16 26.5l-2.7-9.3-9.3-2.7 9.3-2.7L16 2.5z"/></svg>',
    chat:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 01-8 8H5l-2 2V12a8 8 0 018-8h2a8 8 0 018 8z"/></svg>',
    trash:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M10 11v6M14 11v6"/></svg>',
    copy:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1"/></svg>',
    refresh:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/></svg>',
    download:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    alert:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 4.2L2.8 17a2 2 0 001.7 3h15a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z"/></svg>',
  };

  const $ = (selector) => document.querySelector(selector);

  const elements = {
    sidebar: $("#sidebar"),
    conversationList: $("#conversationList"),
    newChatBtn: $("#newChatBtn"),
    openSidebarBtn: $("#openSidebarBtn"),
    closeSidebarBtn: $("#closeSidebarBtn"),
    sidebarScrim: $("#sidebarScrim"),
    providerSelect: $("#providerSelect"),
    modelSelect: $("#modelSelect"),
    modelBadge: $("#modelBadge"),
    connectionStatus: $("#connectionStatus"),
    statusText: $("#statusText"),
    settingsBtn: $("#settingsBtn"),
    settingsBtnSidebar: $("#settingsBtnSidebar"),
    chatScroll: $("#chatScroll"),
    welcome: $("#welcome"),
    welcomeNote: $("#welcomeNote"),
    messages: $("#messages"),
    scrollBottomBtn: $("#scrollBottomBtn"),
    composer: $("#composer"),
    promptInput: $("#promptInput"),
    imageModeBtn: $("#imageModeBtn"),
    composerHint: $("#composerHint"),
    sendBtn: $("#sendBtn"),
    stopBtn: $("#stopBtn"),
    settingsDialog: $("#settingsDialog"),
    closeSettingsBtn: $("#closeSettingsBtn"),
    themeSelect: $("#themeSelect"),
    systemPrompt: $("#systemPrompt"),
    temperature: $("#temperature"),
    temperatureValue: $("#temperatureValue"),
    providerList: $("#providerList"),
    settingsProviderCount: $("#settingsProviderCount"),
    exportBtn: $("#exportBtn"),
    clearAllBtn: $("#clearAllBtn"),
    versionLabel: $("#versionLabel"),
    toast: $("#toast"),
  };

  function migrateLegacyStorage() {
    try {
      const legacy = [
        ["grokbot.conversations.v1", CONVERSATIONS_KEY],
        ["grokbot.settings.v1", SETTINGS_KEY],
        ["grokbot.active.v1", ACTIVE_KEY],
      ];
      for (const [oldKey, newKey] of legacy) {
        if (localStorage.getItem(newKey) === null) {
          const value = localStorage.getItem(oldKey);
          if (value !== null) localStorage.setItem(newKey, value);
        }
        localStorage.removeItem(oldKey);
      }
    } catch {
      /* storage unavailable */
    }
  }

  migrateLegacyStorage();

  const state = {
    config: null,
    configError: "",
    providers: [],
    providerMap: new Map(),
    conversations: loadConversations(),
    activeId: null,
    settings: loadSettings(),
    busy: false,
    streaming: null,
    renderTimer: null,
    toastTimer: null,
  };

  /* Storage ---------------------------------------------------------------- */

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function loadSettings() {
    const loaded = loadJSON(SETTINGS_KEY, {}) || {};
    const settings = {
      theme: ["dark", "light", "system"].includes(loaded.theme)
        ? loaded.theme
        : "dark",
      systemPrompt:
        typeof loaded.systemPrompt === "string"
          ? loaded.systemPrompt.slice(0, 20000)
          : "",
      temperature:
        typeof loaded.temperature === "number" &&
        loaded.temperature >= 0 &&
        loaded.temperature <= 2
          ? loaded.temperature
          : 0.7,
    };
    return settings;
  }

  function sanitizeMessage(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.role !== "user" && raw.role !== "assistant") return null;

    const message = {
      id:
        typeof raw.id === "string" && /^[a-zA-Z0-9]+$/.test(raw.id)
          ? raw.id
          : uid(),
      role: raw.role,
      content: typeof raw.content === "string" ? raw.content.slice(0, 200000) : "",
      ts: Number(raw.ts) || Date.now(),
      status: ["done", "error", "stopped", "loading", "streaming"].includes(
        raw.status
      )
        ? raw.status
        : "done",
    };

    if (message.status === "loading" || message.status === "streaming") {
      message.status = "stopped";
    }
    if (raw.kind === "image") {
      message.kind = "image";
      message.prompt =
        typeof raw.prompt === "string" ? raw.prompt.slice(0, 4000) : "";
      message.url =
        typeof raw.url === "string" && raw.url.startsWith("/media/")
          ? raw.url
          : "";
      message.provider =
        typeof raw.provider === "string" ? raw.provider.slice(0, 40) : "";
      message.model =
        typeof raw.model === "string" ? raw.model.slice(0, 120) : "";
      if (message.status === "done" && !message.url) return null;
    }
    if (raw.error) message.error = String(raw.error).slice(0, 1000);
    if (raw.provider && typeof raw.provider === "string") {
      message.provider = raw.provider.slice(0, 40);
    }
    if (raw.model && typeof raw.model === "string") {
      message.model = raw.model.slice(0, 120);
    }
    if (raw.usage && typeof raw.usage === "object") {
      message.usage = raw.usage;
    }
    return message;
  }

  function loadConversations() {
    const raw = loadJSON(CONVERSATIONS_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((conversation) => {
        if (!conversation || typeof conversation !== "object") return null;
        const messages = Array.isArray(conversation.messages)
          ? conversation.messages.map(sanitizeMessage).filter(Boolean)
          : [];
        if (!messages.length) return null;
        return {
          id:
            typeof conversation.id === "string" &&
            /^[a-zA-Z0-9]+$/.test(conversation.id)
              ? conversation.id
              : uid(),
          title:
            typeof conversation.title === "string"
              ? conversation.title.slice(0, 120)
              : "New chat",
          createdAt: Number(conversation.createdAt) || Date.now(),
          updatedAt: Number(conversation.updatedAt) || Date.now(),
          provider:
            typeof conversation.provider === "string"
              ? conversation.provider.slice(0, 40)
              : "",
          model:
            typeof conversation.model === "string"
              ? conversation.model.slice(0, 120)
              : "",
          messages,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS);
  }

  function persistConversations() {
    let list = state.conversations
      .filter((conversation) => conversation.messages.length)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
      .map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => ({
          ...message,
          status:
            message.status === "streaming" || message.status === "loading"
              ? "stopped"
              : message.status,
        })),
      }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(list));
        return;
      } catch {
        if (attempt === 1) break;
        const visible = list.slice(0, 20);
        if (!visible.some((conversation) => conversation.id === state.activeId)) {
          const active = list.find(
            (conversation) => conversation.id === state.activeId
          );
          if (active) visible.push(active);
        }
        const keep = new Set(visible.map((conversation) => conversation.id));
        state.conversations = state.conversations.filter((conversation) =>
          keep.has(conversation.id)
        );
        list = visible;
      }
    }
    toast("Could not save chat history — browser storage is full.");
  }

  function saveActiveConversation() {
    try {
      if (state.activeId) localStorage.setItem(ACTIVE_KEY, state.activeId);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* ignore */
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch {
      /* ignore */
    }
  }

  /* Utilities -------------------------------------------------------------- */

  function uid() {
    if (window.crypto?.randomUUID) {
      return crypto.randomUUID().replace(/-/g, "");
    }
    return `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderMarkdown(text) {
    if (window.marked && window.DOMPurify) {
      try {
        const html = marked.parse(text || "", { gfm: true, breaks: true });
        return DOMPurify.sanitize(html, {
          USE_PROFILES: { html: true },
          ADD_ATTR: ["target", "rel"],
        });
      } catch {
        /* fall through */
      }
    }
    return escapeHtml(text || "").replace(/\n/g, "<br>");
  }

  function shortModel(model) {
    if (!model) return "";
    return model.length > 42 ? `${model.slice(0, 39)}…` : model;
  }

  function providerLabel(providerId) {
    return state.providerMap.get(providerId)?.label || providerId || "AI";
  }

  function preferredModel(provider, preferImage = false) {
    if (!provider) return "";
    if (preferImage && provider.default_image_model) {
      return provider.default_image_model;
    }
    return provider.default_model || provider.default_image_model || "";
  }

  function isImageModel(provider, model) {
    return Boolean(provider?.image_models?.includes(model));
  }

  function currentConversation() {
    return (
      state.conversations.find(
        (conversation) => conversation.id === state.activeId
      ) || null
    );
  }

  function currentProvider() {
    const conversation = currentConversation();
    return conversation ? state.providerMap.get(conversation.provider) || null : null;
  }

  function currentIsImage() {
    const conversation = currentConversation();
    const provider = currentProvider();
    return Boolean(conversation && isImageModel(provider, conversation.model));
  }

  function availableProviders() {
    return state.providers.filter((provider) => provider.available);
  }

  function deriveTitle(text) {
    const cleaned = String(text)
      .replace(/[#*`>_~\[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "New chat";
    return cleaned.length > 52 ? `${cleaned.slice(0, 49)}…` : cleaned;
  }

  function timeAgo(timestamp) {
    const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  function groupLabel(timestamp) {
    const now = new Date();
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();
    if (timestamp >= start) return "Today";
    if (timestamp >= start - 86400000) return "Yesterday";
    if (timestamp >= start - 7 * 86400000) return "Previous 7 days";
    if (timestamp >= start - 30 * 86400000) return "Previous 30 days";
    return "Older";
  }

  function makeConversation(previous = null) {
    const current = previous
      ? state.providerMap.get(previous.provider)
      : currentProvider();
    const fallback =
      (state.config &&
        state.providerMap.get(state.config.default_provider)) ||
      availableProviders()[0] ||
      null;
    const provider = current?.available ? current : fallback;
    let model = preferredModel(provider);
    if (
      previous &&
      previous.provider === provider?.id &&
      previous.model &&
      provider &&
      !isImageModel(provider, previous.model)
    ) {
      model = previous.model;
    }
    return {
      id: uid(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: provider?.id || "demo",
      model,
      messages: [],
    };
  }

  function toast(message, duration = 3200) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    state.toastTimer = window.setTimeout(() => {
      elements.toast.classList.remove("show");
    }, duration);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  /* Theme ------------------------------------------------------------------ */

  function effectiveTheme() {
    if (state.settings.theme === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return state.settings.theme;
  }

  function applyTheme() {
    const theme = effectiveTheme();
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#08080b" : "#f6f6f8");
  }

  /* Provider + model selection --------------------------------------------- */

  function renderProviderOptions(selectedProvider) {
    elements.providerSelect.innerHTML = "";
    const known = new Set();
    for (const provider of state.providers) {
      known.add(provider.id);
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.available
        ? provider.label
        : `${provider.label} · ${provider.key_env ? "needs key" : "offline"}`;
      option.disabled = !provider.available;
      elements.providerSelect.append(option);
    }
    if (selectedProvider && !known.has(selectedProvider)) {
      const option = document.createElement("option");
      option.value = selectedProvider;
      option.textContent = selectedProvider;
      elements.providerSelect.append(option);
    }
    if (selectedProvider) elements.providerSelect.value = selectedProvider;
  }

  function populateModelOptions(provider, selected) {
    elements.modelSelect.innerHTML = "";
    if (!provider) return selected || "";

    const images = provider.image_models || [];
    const chat = (provider.models || []).filter(
      (model) => !images.includes(model)
    );
    const known = new Set([...chat, ...images]);

    if (chat.length) {
      const group = document.createElement("optgroup");
      group.label = "Chat";
      for (const model of chat) {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        group.append(option);
      }
      elements.modelSelect.append(group);
    }

    if (images.length) {
      const group = document.createElement("optgroup");
      group.label = "Image generation";
      for (const model of images) {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        group.append(option);
      }
      elements.modelSelect.append(group);
    }

    if (selected && !known.has(selected)) {
      const group = document.createElement("optgroup");
      group.label = "Selected";
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = selected;
      group.append(option);
      elements.modelSelect.append(group);
    }

    const custom = document.createElement("option");
    custom.value = "__custom__";
    custom.textContent = "Custom model…";
    elements.modelSelect.append(custom);

    if (selected) elements.modelSelect.value = selected;
    return selected;
  }

  function syncSelectors(conversation = currentConversation()) {
    if (!conversation || !state.config) return;

    let provider = state.providerMap.get(conversation.provider);
    if (!provider) {
      provider =
        state.providerMap.get(state.config.default_provider) ||
        availableProviders()[0] ||
        null;
      if (provider) {
        conversation.provider = provider.id;
        conversation.model = preferredModel(provider);
      }
    }
    if (!provider) return;

    if (!conversation.model) {
      conversation.model = preferredModel(provider);
    }

    renderProviderOptions(conversation.provider);
    populateModelOptions(provider, conversation.model);
    updateSelectionUI();
  }

  function updateSelectionUI() {
    const conversation = currentConversation();
    const provider = currentProvider();
    const isImage = currentIsImage();

    elements.imageModeBtn.setAttribute("aria-pressed", String(isImage));
    elements.modelBadge.classList.toggle("hidden", !isImage);
    elements.composer.classList.toggle("image-mode", isImage);
    elements.promptInput.placeholder = isImage
      ? "Describe the image you want to create…"
      : "Ask anything...";
    elements.imageModeBtn.title = isImage
      ? "Switch back to chat"
      : "Generate an image";
    elements.imageModeBtn.disabled =
      !provider || (!provider.image_models.length && !hasImageProvider());

    updateStatus();
    updateBusyUI();
  }

  function hasImageProvider() {
    return availableProviders().some(
      (provider) => provider.image_models && provider.image_models.length
    );
  }

  function updateStatus() {
    elements.connectionStatus.className = "status";
    if (state.configError) {
      elements.connectionStatus.classList.add("error");
      elements.statusText.textContent = "Offline";
      elements.connectionStatus.title = state.configError;
      return;
    }
    if (!state.config) {
      elements.statusText.textContent = "Connecting";
      return;
    }
    const provider = currentProvider();
    if (!provider) {
      elements.connectionStatus.classList.add("error");
      elements.statusText.textContent = "No provider";
      return;
    }
    if (!provider.available) {
      elements.connectionStatus.classList.add("error");
      if (provider.key_env) {
        elements.statusText.textContent = "Key missing";
        elements.connectionStatus.title = `Add ${provider.key_env} to .env`;
      } else if (provider.id === "ollama") {
        elements.statusText.textContent = "Ollama offline";
        elements.connectionStatus.title = "Start it with `ollama serve`";
      } else {
        elements.statusText.textContent = "Offline";
        elements.connectionStatus.title = "Provider is not configured";
      }
      return;
    }
    if (provider.kind === "demo") {
      elements.connectionStatus.classList.add("demo");
      elements.statusText.textContent = "Demo mode";
      elements.connectionStatus.title =
        "Add a provider key to .env for live model responses";
      return;
    }
    if (provider.id === "ollama") {
      elements.connectionStatus.classList.add("demo");
      elements.statusText.textContent = "Ollama (local)";
      elements.connectionStatus.title = "Make sure `ollama serve` is running";
      return;
    }
    elements.connectionStatus.classList.add("live");
    elements.statusText.textContent = provider.label;
    elements.connectionStatus.title = `${provider.label} · ${
      currentConversation()?.model || ""
    }`;
  }

  function updateBusyUI() {
    elements.sendBtn.classList.toggle("hidden", state.busy);
    elements.stopBtn.classList.toggle("hidden", !state.busy);
    elements.sendBtn.disabled =
      state.busy || !elements.promptInput.value.trim();
    if (state.busy) {
      elements.composerHint.textContent = "Generating…";
    } else if (currentIsImage()) {
      elements.composerHint.textContent = "Image mode";
    } else {
      elements.composerHint.textContent = "Enter to send";
    }
  }

  function updateWelcomeNote() {
    if (state.configError) {
      elements.welcomeNote.textContent =
        "Cannot reach the DexBot server. Is uvicorn running?";
      return;
    }
    if (!state.config) {
      elements.welcomeNote.textContent = "Connecting to your providers…";
      return;
    }
    const available = availableProviders();
    const demoOnly = available.every((provider) => provider.kind === "demo");
    if (demoOnly) {
      elements.welcomeNote.textContent =
        "Demo mode — add a provider key to .env and restart for live answers.";
    } else {
      elements.welcomeNote.textContent = `${available.length} provider${
        available.length === 1 ? "" : "s"
      } ready · switch models anytime from the top bar.`;
    }
  }

  /* Sidebar ---------------------------------------------------------------- */

  function renderSidebar() {
    elements.conversationList.innerHTML = "";
    const conversations = state.conversations
      .filter((conversation) => conversation.messages.length)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    if (!conversations.length) {
      const empty = document.createElement("div");
      empty.className = "empty-history";
      empty.textContent = "Your conversations will appear here.";
      elements.conversationList.append(empty);
      return;
    }

    let lastGroup = "";
    for (const conversation of conversations) {
      const group = groupLabel(conversation.updatedAt);
      if (group !== lastGroup) {
        lastGroup = group;
        const label = document.createElement("div");
        label.className = "conv-group-label";
        label.textContent = group;
        elements.conversationList.append(label);
      }

      const row = document.createElement("div");
      row.className = "conv-row";
      if (conversation.id === state.activeId) row.classList.add("active");

      const main = document.createElement("button");
      main.type = "button";
      main.className = "conv-main";
      main.title = conversation.title;

      const icon = document.createElement("span");
      icon.className = "conv-icon";
      icon.innerHTML = ICONS.chat;

      const text = document.createElement("span");
      text.className = "conv-text";
      const title = document.createElement("span");
      title.className = "conv-title";
      title.textContent = conversation.title;
      const time = document.createElement("span");
      time.className = "conv-time";
      time.textContent = timeAgo(conversation.updatedAt);
      text.append(title, time);
      main.append(icon, text);
      main.addEventListener("click", () => openConversation(conversation.id));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "conv-delete";
      remove.title = "Delete chat";
      remove.setAttribute("aria-label", "Delete chat");
      remove.innerHTML = ICONS.trash;
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteConversation(conversation.id);
      });

      row.append(main, remove);
      elements.conversationList.append(row);
    }
  }

  function openConversation(id) {
    if (id === state.activeId) {
      closeSidebar();
      return;
    }
    if (state.streaming) stopGeneration();
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) return;
    state.conversations = state.conversations.filter(
      (item) => item.messages.length || item.id === id
    );
    state.activeId = id;
    saveActiveConversation();
    persistConversations();
    renderSidebar();
    syncSelectors(conversation);
    renderMessages();
    scrollToBottom(true);
    closeSidebar();
    if (window.matchMedia("(pointer: fine)").matches) focusInput();
  }

  function deleteConversation(id) {
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) return;
    if (!window.confirm(`Delete “${conversation.title}”?`)) return;
    if (state.streaming && state.streaming.convId === id) stopGeneration();
    state.conversations = state.conversations.filter((item) => item.id !== id);
    if (state.activeId === id) {
      state.activeId = null;
      createNewChat({ focus: false });
    }
    renderSidebar();
    persistConversations();
    toast("Chat deleted.");
  }

  function createNewChat({ focus = true } = {}) {
    if (state.streaming) stopGeneration();
    const previous = currentConversation();
    state.conversations = state.conversations.filter(
      (conversation) => conversation.messages.length
    );
    const conversation = makeConversation(previous);
    state.conversations.unshift(conversation);
    state.activeId = conversation.id;
    saveActiveConversation();
    renderSidebar();
    syncSelectors(conversation);
    renderMessages();
    scrollToBottom(true);
    updateWelcomeNote();
    closeSidebar();
    if (focus && window.matchMedia("(pointer: fine)").matches) focusInput();
  }

  function closeSidebar() {
    document.body.classList.remove("sidebar-open");
  }

  /* Messages --------------------------------------------------------------- */

  function renderMessages() {
    const conversation = currentConversation();
    const hasMessages = Boolean(conversation && conversation.messages.length);
    elements.welcome.classList.toggle("hidden", hasMessages);
    elements.messages.innerHTML = "";

    if (!hasMessages) {
      updateWelcomeNote();
      updateScrollHint();
      return;
    }

    for (const message of conversation.messages) {
      elements.messages.append(createMessageNode(conversation, message));
    }

    window.requestAnimationFrame(() => {
      enhanceCodeBlocks(elements.messages);
      updateScrollHint();
    });
  }

  function createMessageNode(conversation, message) {
    if (message.role === "user") {
      const wrapper = document.createElement("div");
      wrapper.className = "message user";
      wrapper.dataset.messageId = message.id;
      const bubble = document.createElement("div");
      bubble.className = "user-bubble";
      bubble.textContent = message.content;
      wrapper.append(bubble);
      return wrapper;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "message assistant";
    wrapper.dataset.messageId = message.id;

    const avatar = document.createElement("div");
    avatar.className = "assistant-avatar";
    avatar.innerHTML = ICONS.spark;

    const body = document.createElement("div");
    body.className = "assistant-body";

    const meta = document.createElement("div");
    meta.className = "assistant-meta";
    const provider = state.providerMap.get(message.provider || conversation.provider);
    const providerName = provider?.label || providerLabel(message.provider || conversation.provider);
    const model = message.model || conversation.model;
    const providerSpan = document.createElement("span");
    providerSpan.textContent = providerName;
    const dot = document.createElement("span");
    dot.textContent = "·";
    const modelSpan = document.createElement("span");
    modelSpan.className = "meta-model";
    modelSpan.textContent = shortModel(model);
    meta.append(providerSpan, dot, modelSpan);

    const content = document.createElement("div");
    content.className = "assistant-content";

    if (message.kind === "image") {
      content.append(createImageContent(conversation, message));
    } else {
      const markdown = document.createElement("div");
      markdown.className = "md";
      if (message.content) {
        markdown.innerHTML = renderMarkdown(message.content);
      } else if (message.status === "streaming") {
        markdown.innerHTML = typingHtml();
      } else {
        markdown.textContent = "";
      }
      content.append(markdown);

      if (message.error) content.append(errorBanner(message.error));
      if (message.status === "stopped") {
        const note = document.createElement("div");
        note.className = "stopped-note";
        note.textContent = "Generation stopped.";
        content.append(note);
      }

      if (
        message.status !== "streaming" &&
        (message.content || message.status === "error" || message.status === "stopped")
      ) {
        content.append(createTextActions(conversation, message));
      }
    }

    body.append(meta, content);
    wrapper.append(avatar, body);
    return wrapper;
  }

  function typingHtml() {
    return '<div class="typing" aria-label="Generating"><span></span><span></span><span></span></div>';
  }

  function errorBanner(message) {
    const banner = document.createElement("div");
    banner.className = "error-banner";
    const icon = document.createElement("span");
    icon.innerHTML = ICONS.alert;
    const text = document.createElement("span");
    text.textContent = message;
    banner.append(icon, text);
    return banner;
  }

  function createImageContent(conversation, message) {
    const fragment = document.createDocumentFragment();

    if (message.status === "loading") {
      const card = document.createElement("div");
      card.className = "image-card";
      const frame = document.createElement("div");
      frame.className = "image-frame";
      const skeleton = document.createElement("div");
      skeleton.className = "image-skeleton";
      skeleton.textContent = `Generating with ${shortModel(message.model)}…`;
      frame.append(skeleton);
      const meta = document.createElement("div");
      meta.className = "image-meta";
      const prompt = document.createElement("div");
      prompt.className = "image-prompt";
      prompt.textContent = message.prompt;
      meta.append(prompt);
      card.append(frame, meta);
      fragment.append(card);
      return fragment;
    }

    if (message.status === "done" && message.url) {
      const card = document.createElement("div");
      card.className = "image-card";
      const frame = document.createElement("div");
      frame.className = "image-frame";
      const image = document.createElement("img");
      image.src = message.url;
      image.alt = message.prompt || "Generated image";
      image.loading = "lazy";
      frame.append(image);

      const meta = document.createElement("div");
      meta.className = "image-meta";
      const prompt = document.createElement("div");
      prompt.className = "image-prompt";
      prompt.textContent = message.prompt;
      meta.append(prompt, createImageActions(conversation, message));
      card.append(frame, meta);
      fragment.append(card);
      return fragment;
    }

    if (message.error) {
      fragment.append(errorBanner(message.error));
    } else if (message.status === "stopped") {
      const note = document.createElement("div");
      note.className = "stopped-note";
      note.textContent = "Image generation stopped.";
      fragment.append(note);
    }
    fragment.append(createImageActions(conversation, message));
    return fragment;
  }

  function createImageActions(conversation, message) {
    const actions = document.createElement("div");
    actions.className = "image-actions";

    if (message.url) {
      const download = document.createElement("a");
      download.href = message.url;
      download.download = `dexbot-${message.id}.${extensionFor(message.url)}`;
      download.innerHTML = `${ICONS.download}<span>Download</span>`;
      actions.append(download);
    }

    const isLast =
      conversation.messages[conversation.messages.length - 1]?.id === message.id;
    if (isLast && !state.busy && message.status !== "loading") {
      const regenerate = document.createElement("button");
      regenerate.type = "button";
      regenerate.innerHTML = `${ICONS.refresh}<span>Regenerate</span>`;
      regenerate.addEventListener("click", () => regenerateImage(conversation, message));
      actions.append(regenerate);
    }
    return actions;
  }

  function extensionFor(url) {
    const match = /\.([a-zA-Z0-9]{2,5})(?:\?|$)/.exec(url);
    return match ? match[1].toLowerCase() : "png";
  }

  function createTextActions(conversation, message) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";

    if (message.content) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "action-btn";
      copy.innerHTML = `${ICONS.copy}<span>Copy</span>`;
      copy.addEventListener("click", async () => {
        const copied = await copyText(message.content);
        copy.querySelector("span").textContent = copied ? "Copied" : "Failed";
        window.setTimeout(() => {
          copy.querySelector("span").textContent = "Copy";
        }, 1600);
      });
      actions.append(copy);
    }

    const isLast =
      conversation.messages[conversation.messages.length - 1]?.id === message.id;
    if (isLast && !state.busy) {
      const regenerate = document.createElement("button");
      regenerate.type = "button";
      regenerate.className = "action-btn";
      regenerate.innerHTML = `${ICONS.refresh}<span>Regenerate</span>`;
      regenerate.addEventListener("click", () =>
        regenerateText(conversation, message)
      );
      actions.append(regenerate);
    }
    return actions;
  }

  function enhanceCodeBlocks(root) {
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.dataset.enhanced) return;
      pre.dataset.enhanced = "1";

      const code = pre.querySelector("code");
      if (code && !code.dataset.highlighted && window.hljs) {
        const language = /language-([\w-]+)/.exec(code.className || "")?.[1];
        if (language) {
          try {
            hljs.highlightElement(code);
          } catch {
            /* unknown language or highlighting failure */
          }
        }
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy";
      button.textContent = "Copy";
      button.addEventListener("click", async () => {
        const copied = await copyText(code?.textContent || "");
        button.textContent = copied ? "Copied" : "Failed";
        window.setTimeout(() => {
          button.textContent = "Copy";
        }, 1400);
      });
      pre.append(button);
    });

    root.querySelectorAll(".md a").forEach((link) => {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
    root.querySelectorAll(".md img").forEach((image) => {
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
    });
  }

  function scheduleLiveRender(convId, message) {
    if (state.renderTimer) return;
    state.renderTimer = window.setTimeout(() => {
      state.renderTimer = null;
      if (state.activeId !== convId) return;
      const node = elements.messages.querySelector(
        `[data-message-id="${message.id}"]`
      );
      if (!node) {
        renderMessages();
        return;
      }
      const markdown = node.querySelector(".assistant-content .md");
      if (markdown) {
        markdown.innerHTML = message.content
          ? renderMarkdown(message.content)
          : typingHtml();
      }
      if (isNearBottom()) scrollToBottom(true);
    }, 70);
  }

  /* Scrolling -------------------------------------------------------------- */

  function isNearBottom() {
    return (
      elements.chatScroll.scrollHeight -
        elements.chatScroll.scrollTop -
        elements.chatScroll.clientHeight <
      150
    );
  }

  function scrollToBottom(force = false) {
    if (!force && !isNearBottom()) return;
    window.requestAnimationFrame(() => {
      elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
      updateScrollHint();
    });
  }

  function updateScrollHint() {
    const conversation = currentConversation();
    const hasMessages = Boolean(conversation && conversation.messages.length);
    const show = hasMessages && !isNearBottom();
    elements.scrollBottomBtn.classList.toggle("hidden", !show);
  }

  /* Chat generation -------------------------------------------------------- */

  function toApiMessages(conversation, excludeId) {
    return conversation.messages
      .filter(
        (message) =>
          message.id !== excludeId &&
          message.status !== "error" &&
          message.status !== "loading" &&
          message.status !== "streaming" &&
          message.content
      )
      .map((message) =>
        message.kind === "image"
          ? {
              role: "assistant",
              content: `[Earlier I generated an image with the prompt: ${
                message.prompt || ""
              }]`,
            }
          : { role: message.role, content: message.content }
      )
      .slice(-200);
  }

  async function submitMessage(rawText) {
    const text = String(rawText ?? elements.promptInput.value).trim();
    if (!text || state.busy) {
      if (state.busy) toast("Wait for the current response to finish.");
      return;
    }
    if (!state.config) {
      toast("Still connecting to the server…");
      return;
    }

    let conversation = currentConversation();
    if (!conversation) {
      createNewChat({ focus: false });
      conversation = currentConversation();
    }
    if (!conversation) return;

    let provider = state.providerMap.get(conversation.provider);
    if (!provider) {
      syncSelectors(conversation);
      provider = state.providerMap.get(conversation.provider);
    }
    if (!provider) {
      toast("Choose a provider first.");
      return;
    }
    if (!provider.available) {
      toast(
        provider.key_env
          ? `${provider.label} needs ${provider.key_env} in .env.`
          : `${provider.label} is not configured.`
      );
      return;
    }
    if (!conversation.model) {
      conversation.model = preferredModel(provider);
      syncSelectors(conversation);
    }

    const imageMode = isImageModel(provider, conversation.model);
    elements.promptInput.value = "";
    resizeInput();

    const userMessage = {
      id: uid(),
      role: "user",
      content: text,
      ts: Date.now(),
      status: "done",
    };
    if (!conversation.messages.length) {
      conversation.title = deriveTitle(text);
    }
    conversation.messages.push(userMessage);
    conversation.updatedAt = Date.now();
    conversation.provider = provider.id;
    persistConversations();
    renderSidebar();
    updateWelcomeNote();
    renderMessages();
    scrollToBottom(true);

    if (imageMode) {
      await runImageGeneration(conversation, text);
    } else {
      await runTextGeneration(conversation);
    }
  }

  async function runTextGeneration(conversation) {
    const provider = state.providerMap.get(conversation.provider);
    if (!provider) return;

    const assistant = {
      id: uid(),
      role: "assistant",
      content: "",
      ts: Date.now(),
      status: "streaming",
      provider: provider.id,
      model: conversation.model,
    };
    conversation.messages.push(assistant);
    conversation.updatedAt = Date.now();

    const controller = new AbortController();
    const stream = {
      controller,
      convId: conversation.id,
      messageId: assistant.id,
      kind: "text",
    };
    state.streaming = stream;
    state.busy = true;
    updateBusyUI();
    renderMessages();
    scrollToBottom(true);

    const payload = {
      provider: conversation.provider,
      model: conversation.model,
      messages: toApiMessages(conversation, assistant.id),
      system: state.settings.systemPrompt.trim() || null,
      temperature: state.settings.temperature,
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      await readEventStream(response, (event) => {
        if (event.type === "delta" && typeof event.text === "string") {
          assistant.content += event.text;
          scheduleLiveRender(conversation.id, assistant);
        } else if (event.type === "error") {
          assistant.error = String(event.message || "Provider error");
        } else if (event.type === "usage" && event.usage) {
          assistant.usage = event.usage;
        } else if (event.type === "meta") {
          if (event.provider) assistant.provider = event.provider;
          if (event.model) assistant.model = event.model;
        }
      });

      if (assistant.error) {
        assistant.status = "error";
      } else {
        assistant.status = "done";
        if (!assistant.content) {
          assistant.content = "_The model returned an empty response._";
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        assistant.status = "stopped";
      } else {
        assistant.status = "error";
        assistant.error =
          error.message || "Could not reach the server. Check your connection.";
      }
    } finally {
      if (state.renderTimer) {
        window.clearTimeout(state.renderTimer);
        state.renderTimer = null;
      }
      conversation.updatedAt = Date.now();
      if (state.streaming === stream) {
        state.streaming = null;
        state.busy = false;
        updateBusyUI();
      }
      persistConversations();
      renderSidebar();
      if (state.activeId === conversation.id) {
        renderMessages();
        scrollToBottom(true);
        updateStatus();
      }
      if (
        state.activeId === conversation.id &&
        window.matchMedia("(pointer: fine)").matches
      ) {
        focusInput();
      }
    }
  }

  async function runImageGeneration(conversation, prompt) {
    const provider = state.providerMap.get(conversation.provider);
    if (!provider) return;

    const message = {
      id: uid(),
      role: "assistant",
      kind: "image",
      content: "",
      prompt,
      ts: Date.now(),
      status: "loading",
      provider: provider.id,
      model: conversation.model,
    };
    conversation.messages.push(message);
    conversation.updatedAt = Date.now();

    const controller = new AbortController();
    const stream = {
      controller,
      convId: conversation.id,
      messageId: message.id,
      kind: "image",
    };
    state.streaming = stream;
    state.busy = true;
    updateBusyUI();
    renderMessages();
    scrollToBottom(true);

    try {
      const response = await fetch("/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: conversation.provider,
          model: conversation.model,
          prompt,
          size: "1024x1024",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      const data = await response.json();
      if (!data.url) throw new Error("The server did not return an image.");
      message.url = data.url;
      message.status = "done";
      message.elapsed_ms = data.elapsed_ms;
      if (data.revised_prompt) message.revised_prompt = data.revised_prompt;
    } catch (error) {
      if (error.name === "AbortError") {
        message.status = "stopped";
      } else {
        message.status = "error";
        message.error = error.message || "Image generation failed.";
      }
    } finally {
      conversation.updatedAt = Date.now();
      if (state.streaming === stream) {
        state.streaming = null;
        state.busy = false;
        updateBusyUI();
      }
      persistConversations();
      renderSidebar();
      if (state.activeId === conversation.id) {
        renderMessages();
        scrollToBottom(true);
        updateStatus();
      }
    }
  }

  async function regenerateText(conversation, message) {
    if (state.busy) return;
    const index = conversation.messages.findIndex((item) => item.id === message.id);
    if (index < 0) return;
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (conversation.messages[i].role === "user") {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;
    conversation.messages = conversation.messages.slice(0, userIndex + 1);
    conversation.updatedAt = Date.now();
    persistConversations();
    renderMessages();
    scrollToBottom(true);
    await runTextGeneration(conversation);
  }

  async function regenerateImage(conversation, message) {
    if (state.busy) return;
    const index = conversation.messages.findIndex((item) => item.id === message.id);
    if (index < 0) return;
    conversation.messages.splice(index, 1);
    conversation.updatedAt = Date.now();
    persistConversations();
    renderMessages();
    await runImageGeneration(conversation, message.prompt);
  }

  function readEventStream(response, onEvent) {
    return new Promise((resolve, reject) => {
      if (!response.body) {
        reject(new Error("Streaming is not supported by this browser."));
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleBlock = (block) => {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) return;
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* ignore malformed events */
        }
      };

      const pump = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
              if (buffer.trim()) handleBlock(buffer);
              resolve();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              handleBlock(buffer.slice(0, boundary));
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf("\n\n");
            }
            pump();
          })
          .catch(reject);
      };
      pump();
    });
  }

  async function responseError(response) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      /* ignore */
    }
    try {
      const data = JSON.parse(text);
      const detail = data.detail ?? data.message ?? data.error;
      if (typeof detail === "string") return detail;
      if (Array.isArray(detail)) {
        return detail.map((item) => item.msg || String(item)).join("; ");
      }
      if (detail) return JSON.stringify(detail);
    } catch {
      /* not JSON */
    }
    return text.slice(0, 500) || `Request failed (${response.status})`;
  }

  function stopGeneration() {
    if (state.streaming?.controller) {
      state.streaming.controller.abort();
    }
  }

  function focusInput() {
    window.requestAnimationFrame(() => {
      elements.promptInput.focus({ preventScroll: true });
    });
  }

  function resizeInput() {
    const input = elements.promptInput;
    input.style.height = "auto";
    const height = Math.min(input.scrollHeight, 200);
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > 200 ? "auto" : "hidden";
    updateBusyUI();
  }

  /* Image mode ------------------------------------------------------------- */

  function selectImageMode() {
    const conversation = currentConversation();
    if (!conversation) return false;
    const provider = state.providerMap.get(conversation.provider);

    if (provider?.available && provider.image_models?.length) {
      conversation.model = provider.default_image_model;
      conversation.updatedAt = Date.now();
      syncSelectors(conversation);
      if (conversation.messages.length) persistConversations();
      return true;
    }

    const target = availableProviders().find(
      (item) => item.image_models && item.image_models.length
    );
    if (!target) {
      toast("No image-capable provider is configured.");
      return false;
    }
    conversation.provider = target.id;
    conversation.model = target.default_image_model;
    conversation.updatedAt = Date.now();
    syncSelectors(conversation);
    if (conversation.messages.length) persistConversations();
    return true;
  }

  function selectChatMode() {
    const conversation = currentConversation();
    if (!conversation) return;
    const provider = state.providerMap.get(conversation.provider);
    const chatModel = provider?.models?.find(
      (model) => !provider.image_models.includes(model)
    );
    if (chatModel) {
      conversation.model = chatModel;
      conversation.updatedAt = Date.now();
      syncSelectors(conversation);
      if (conversation.messages.length) persistConversations();
      return;
    }
    const target = availableProviders().find((item) =>
      item.models?.some((model) => !item.image_models.includes(model))
    );
    if (target) {
      conversation.provider = target.id;
      conversation.model = preferredModel(target);
      conversation.updatedAt = Date.now();
      syncSelectors(conversation);
      if (conversation.messages.length) persistConversations();
    }
  }

  /* Settings --------------------------------------------------------------- */

  function renderProviderList() {
    elements.providerList.innerHTML = "";
    const available = availableProviders();
    elements.settingsProviderCount.textContent = String(available.length);

    for (const provider of state.providers) {
      const row = document.createElement("div");
      row.className = "provider-row";

      const info = document.createElement("div");
      info.className = "provider-info";
      const name = document.createElement("div");
      name.className = "provider-name";
      name.textContent = provider.label;

      const pill = document.createElement("span");
      pill.className = "provider-pill";
      if (provider.kind === "demo") {
        pill.classList.add("demo");
        pill.textContent = "demo";
        name.append(pill);
      } else if (provider.available) {
        pill.classList.add("live");
        pill.textContent = "connected";
        name.append(pill);
      }

      const tagline = document.createElement("div");
      tagline.className = "provider-tagline";
      tagline.textContent = provider.tagline || provider.kind;

      info.append(name, tagline);

      if (!provider.available && provider.key_env) {
        const pillKey = document.createElement("span");
        pillKey.className = "provider-pill";
        pillKey.textContent = provider.key_env;
        info.append(pillKey);
      } else if (!provider.available) {
        const pillKey = document.createElement("span");
        pillKey.className = "provider-pill";
        pillKey.textContent = provider.id === "ollama" ? "offline" : "not configured";
        info.append(pillKey);
      }

      row.append(info);

      if (provider.docs_url && /^https?:\/\//i.test(provider.docs_url)) {
        const link = document.createElement("a");
        link.className = "provider-docs";
        link.href = provider.docs_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = provider.available ? "Docs" : "Get key";
        row.append(link);
      }

      elements.providerList.append(row);
    }
  }

  function openSettings() {
    elements.themeSelect.value = state.settings.theme;
    elements.systemPrompt.value = state.settings.systemPrompt;
    elements.temperature.value = String(state.settings.temperature);
    elements.temperatureValue.textContent = state.settings.temperature.toFixed(1);
    renderProviderList();
    if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
  }

  function exportChats() {
    const conversations = state.conversations.filter(
      (conversation) => conversation.messages.length
    );
    const payload = {
      app: "DexBot",
      exportedAt: new Date().toISOString(),
      conversations,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `dexbot-chats-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${conversations.length} chat${conversations.length === 1 ? "" : "s"}.`);
  }

  function clearAllChats() {
    if (!window.confirm("Delete all chats from this browser? This cannot be undone.")) {
      return;
    }
    if (state.streaming) stopGeneration();
    state.conversations = [];
    state.activeId = null;
    try {
      localStorage.removeItem(CONVERSATIONS_KEY);
      localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* ignore */
    }
    createNewChat({ focus: false });
    renderSidebar();
    elements.settingsDialog.close();
    toast("All chats cleared.");
  }

  /* Events ----------------------------------------------------------------- */

  function bindEvents() {
    elements.newChatBtn.addEventListener("click", () => createNewChat());
    elements.openSidebarBtn.addEventListener("click", () =>
      document.body.classList.add("sidebar-open")
    );
    elements.closeSidebarBtn.addEventListener("click", closeSidebar);
    elements.sidebarScrim.addEventListener("click", closeSidebar);

    elements.settingsBtn.addEventListener("click", openSettings);
    elements.settingsBtnSidebar.addEventListener("click", openSettings);
    elements.closeSettingsBtn.addEventListener("click", () =>
      elements.settingsDialog.close()
    );
    elements.settingsDialog.addEventListener("click", (event) => {
      const rect = elements.settingsDialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        elements.settingsDialog.close();
      }
    });

    elements.themeSelect.addEventListener("change", () => {
      state.settings.theme = elements.themeSelect.value;
      applyTheme();
      saveSettings();
    });
    elements.systemPrompt.addEventListener("input", () => {
      state.settings.systemPrompt = elements.systemPrompt.value;
      saveSettings();
    });
    elements.temperature.addEventListener("input", () => {
      const value = Number(elements.temperature.value);
      state.settings.temperature = value;
      elements.temperatureValue.textContent = value.toFixed(1);
      saveSettings();
    });
    elements.exportBtn.addEventListener("click", exportChats);
    elements.clearAllBtn.addEventListener("click", clearAllChats);

    elements.providerSelect.addEventListener("change", () => {
      const conversation = currentConversation();
      if (!conversation) return;
      const previous = state.providerMap.get(conversation.provider);
      const wasImage = isImageModel(previous, conversation.model);
      const provider = state.providerMap.get(elements.providerSelect.value);
      if (!provider) return;
      conversation.provider = provider.id;
      conversation.model = wasImage && provider.image_models.length
        ? provider.default_image_model
        : preferredModel(provider);
      conversation.updatedAt = Date.now();
      syncSelectors(conversation);
      if (conversation.messages.length) persistConversations();
      updateWelcomeNote();
    });

    elements.modelSelect.addEventListener("change", () => {
      const conversation = currentConversation();
      if (!conversation) return;
      const provider = state.providerMap.get(conversation.provider);
      if (!provider) return;

      let value = elements.modelSelect.value;
      if (value === "__custom__") {
        const entered = window.prompt(
          "Enter the exact model ID:",
          conversation.model || ""
        );
        if (entered === null) {
          syncSelectors(conversation);
          return;
        }
        value = entered.trim();
        if (!MODEL_RE.test(value)) {
          toast("That model ID contains unsupported characters.");
          syncSelectors(conversation);
          return;
        }
      }

      conversation.model = value;
      conversation.updatedAt = Date.now();
      syncSelectors(conversation);
      if (conversation.messages.length) persistConversations();
    });

    elements.imageModeBtn.addEventListener("click", () => {
      if (currentIsImage()) selectChatMode();
      else selectImageMode();
      updateWelcomeNote();
    });

    elements.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!state.busy) submitMessage();
    });

    elements.promptInput.addEventListener("input", () => {
      resizeInput();
      elements.sendBtn.disabled =
        state.busy || !elements.promptInput.value.trim();
    });
    elements.promptInput.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        if (!state.busy) submitMessage();
      }
    });

    elements.sendBtn.addEventListener("click", (event) => {
      event.preventDefault();
      if (!state.busy) submitMessage();
    });
    elements.stopBtn.addEventListener("click", () => {
      stopGeneration();
      toast("Stopping…", 1200);
    });

    elements.scrollBottomBtn.addEventListener("click", () => scrollToBottom(true));
    elements.chatScroll.addEventListener("scroll", updateScrollHint, {
      passive: true,
    });

    elements.welcome.addEventListener("click", (event) => {
      const button = event.target.closest(".suggestion");
      if (!button) return;
      const prompt = button.dataset.prompt || "";
      const wantsImage = button.dataset.image === "true";
      if (state.busy) {
        toast("Wait for the current response to finish.");
        return;
      }
      if (wantsImage && !selectImageMode()) return;
      if (!wantsImage && currentIsImage()) selectChatMode();
      elements.promptInput.value = prompt;
      resizeInput();
      submitMessage(prompt);
    });

    document.addEventListener("keydown", (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (elements.settingsDialog.open) elements.settingsDialog.close();
        createNewChat();
        return;
      }
      if (mod && event.key === ",") {
        event.preventDefault();
        openSettings();
        return;
      }
      if (event.key === "Escape" && document.body.classList.contains("sidebar-open")) {
        closeSidebar();
      }
    });

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (state.settings.theme === "system") applyTheme();
      });
  }

  /* Boot ------------------------------------------------------------------- */

  async function loadConfig() {
    updateStatus();
    updateWelcomeNote();
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) throw new Error(`Config request failed (${response.status})`);
      const config = await response.json();
      state.config = config;
      state.providers = Array.isArray(config.providers) ? config.providers : [];
      state.providerMap = new Map(
        state.providers.map((provider) => [provider.id, provider])
      );
      state.configError = "";
      if (elements.versionLabel) elements.versionLabel.textContent = `v${config.version || "1.0"}`;
    } catch (error) {
      state.configError = error.message || "Could not load configuration";
      state.providers = [];
      state.providerMap = new Map();
    }

    if (state.conversations.length) {
      const saved = (() => {
        try {
          return localStorage.getItem(ACTIVE_KEY);
        } catch {
          return null;
        }
      })();
      state.activeId = state.conversations.some(
        (conversation) => conversation.id === saved
      )
        ? saved
        : state.conversations[0].id;
    } else {
      state.activeId = null;
      if (state.config) {
        const conversation = makeConversation();
        state.conversations.unshift(conversation);
        state.activeId = conversation.id;
      }
    }

    const conversation = currentConversation();
    if (conversation) {
      syncSelectors(conversation);
      saveActiveConversation();
    }
    renderProviderList();
    renderSidebar();
    renderMessages();
    updateWelcomeNote();
    updateStatus();
    updateBusyUI();

    if (
      conversation?.messages.length &&
      window.matchMedia("(pointer: fine)").matches
    ) {
      window.setTimeout(() => scrollToBottom(true), 40);
    }
  }

  applyTheme();
  bindEvents();
  renderSidebar();
  resizeInput();
  loadConfig();
})();
