"use strict";

const CATEGORY_KEY = "highlightCategories";

let allHighlights = [];
let categories = getDefaultCategories();
let activeFilter = "all";
let hasShownLoadFailureNote = false;
let searchDebounceTimer = null;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  setupSearch();
  setupBulkActions();
  setupCategoryActions();
  setupExport();
  loadData();
  setupStorageSync();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "HIGHLIGHT_CREATED") {
      allHighlights.unshift(msg.highlight);
      renderHighlights();
      updateBadges();
    }
  });
});

function getDefaultCategories() {
  return [
    { id: "important", name: "Important", color: "#f59e0b" },
    { id: "concept", name: "Concept", color: "#3b82f6" },
    { id: "doubt", name: "Doubt", color: "#ef4444" }
  ];
}

function normalizeHexColor(value) {
  const v = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  return null;
}

function normalizeCategoryId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function normalizeCategories(list) {
  const defaults = getDefaultCategories();
  if (!Array.isArray(list) || list.length === 0) return defaults;

  const seen = new Set();
  const normalized = [];

  list.forEach((c) => {
    const name = String(c?.name || "").trim().slice(0, 24);
    const color = normalizeHexColor(c?.color);
    const id = normalizeCategoryId(c?.id || name);
    if (!name || !color || !id || seen.has(id)) return;
    seen.add(id);
    normalized.push({ id, name, color });
  });

  defaults.forEach((d) => {
    if (!seen.has(d.id)) normalized.push(d);
  });

  return normalized;
}

function sortByNewest(items) {
  return [...(items || [])].sort((a, b) => b.timestamp - a.timestamp);
}

function getCategoryById(id) {
  return categories.find((c) => c.id === id) || getDefaultCategories().find((c) => c.id === id) || null;
}

function setupStorageSync() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes.highlights) {
      allHighlights = sortByNewest(changes.highlights.newValue || []);
      renderHighlights();
      updateBadges();
    }

    if (changes.highlightCategories) {
      categories = normalizeCategories(changes.highlightCategories.newValue);
      renderFilters();
      renderHighlights();
    }
  });
}

function loadData() {
  chrome.runtime.sendMessage({ type: "GET_ALL_DATA" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      showPanelLoadFailureNote();
      return;
    }

    allHighlights = sortByNewest(res.highlights || []);
    categories = normalizeCategories(res.highlightCategories || []);
    renderFilters();
    renderHighlights();
    updateBadges();
  });
}

function showPanelLoadFailureNote() {
  if (hasShownLoadFailureNote) return;
  hasShownLoadFailureNote = true;
  showToast("If panel fails to load, refresh and highlight again.");
}

function setupSearch() {
  const search = $("hlSearch");
  if (!search) return;

  search.addEventListener("input", () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderHighlights, 120);
  });
}

function setupBulkActions() {
  const btnClearAllHighlights = $("btnClearAllHighlights");
  if (btnClearAllHighlights) {
    btnClearAllHighlights.addEventListener("click", clearAllHighlights);
  }
}

function setupCategoryActions() {
  const btnAdd = $("btnAddCategory");
  const btnSave = $("btnSaveCategory");
  const btnCancel = $("btnCancelCategory");

  if (btnAdd) btnAdd.addEventListener("click", () => toggleAddPanel(true));
  if (btnCancel) btnCancel.addEventListener("click", () => toggleAddPanel(false));
  if (btnSave) btnSave.addEventListener("click", saveNewCategory);

  const filtersWrap = $("hlFilters");
  if (filtersWrap) {
    filtersWrap.addEventListener("click", (e) => {
      const btn = e.target.closest(".sb-filter");
      if (!btn) return;
      activeFilter = btn.dataset.filter || "all";
      renderFilters();
      renderHighlights();
    });
  }
}

function toggleAddPanel(show) {
  const panel = $("addCategoryPanel");
  if (!panel) return;

  panel.classList.toggle("hidden", !show);

  if (show) {
    const input = $("newCategoryName");
    if (input) input.focus();
  } else {
    resetCategoryForm();
  }
}

function resetCategoryForm() {
  const nameInput = $("newCategoryName");
  const colorInput = $("newCategoryColor");
  if (nameInput) nameInput.value = "";
  if (colorInput) colorInput.value = "#10b981";
}

function saveNewCategory() {
  const nameInput = $("newCategoryName");
  const colorInput = $("newCategoryColor");

  const name = String(nameInput?.value || "").trim();
  const color = normalizeHexColor(colorInput?.value);

  if (!name) {
    showToast("Enter a category name");
    return;
  }

  if (!color) {
    showToast("Choose a valid color");
    return;
  }

  let baseId = normalizeCategoryId(name);
  if (!baseId) baseId = `custom-${Date.now()}`;

  let id = baseId;
  let counter = 2;
  while (categories.some((c) => c.id === id)) {
    id = `${baseId}-${counter}`;
    counter++;
  }

  const next = [...categories, { id, name: name.slice(0, 24), color }];

  chrome.storage.local.set({ [CATEGORY_KEY]: next }, () => {
    categories = normalizeCategories(next);
    renderFilters();
    renderHighlights();
    toggleAddPanel(false);
    showToast("Category added");
  });
}

function renderFilters() {
  const wrap = $("hlFilters");
  if (!wrap) return;

  if (activeFilter !== "all" && !categories.some((c) => c.id === activeFilter)) {
    activeFilter = "all";
  }

  wrap.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.className = `sb-filter ${activeFilter === "all" ? "active" : ""}`;
  allBtn.dataset.filter = "all";
  allBtn.textContent = "All";
  wrap.appendChild(allBtn);

  categories.forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = `sb-filter ${activeFilter === cat.id ? "active" : ""}`;
    btn.dataset.filter = cat.id;

    const dot = document.createElement("span");
    dot.className = "sb-filter-dot";
    dot.style.background = cat.color;

    const label = document.createElement("span");
    label.textContent = cat.name;

    btn.appendChild(dot);
    btn.appendChild(label);
    wrap.appendChild(btn);
  });
}

function renderHighlights() {
  const list = $("hlList");
  const emptyEl = $("hlEmpty");
  const search = $("hlSearch");
  const query = (search?.value || "").toLowerCase().trim();

  if (!list || !emptyEl) return;

  let items = allHighlights;
  if (activeFilter !== "all") items = items.filter((h) => h.type === activeFilter);
  if (query) items = items.filter((h) => h.text.toLowerCase().includes(query));

  list.querySelectorAll(".sb-hl-item").forEach((el) => el.remove());

  if (items.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");

  const fragment = document.createDocumentFragment();
  items.forEach((h, i) => {
    fragment.appendChild(buildHighlightItem(h, i));
  });
  list.appendChild(fragment);
}

function buildHighlightItem(h, delay = 0) {
  const li = document.createElement("li");
  li.className = "sb-hl-item";
  li.style.animationDelay = `${delay * 30}ms`;

  const category = getCategoryById(h.type);
  const badgeLabel = h.categoryName || category?.name || capitalize(h.type || "highlight");
  const badgeColor = normalizeHexColor(h.categoryColor) || category?.color || "#f59e0b";

  li.innerHTML = `
    <div class="sb-hl-item-top">
      <span class="sb-hl-type-badge">${escapeHtml(badgeLabel)}</span>
      <span class="sb-hl-date">${formatDate(h.timestamp)}</span>
    </div>
    <p class="sb-hl-text">${escapeHtml(h.text)}</p>
    <div class="sb-hl-actions">
      <button class="sb-hl-action-btn" data-action="scroll">↗ Scroll to</button>
      <button class="sb-hl-action-btn danger" data-action="delete">✕ Delete</button>
    </div>
  `;

  const badge = li.querySelector(".sb-hl-type-badge");
  if (badge) {
    badge.style.background = hexToRgba(badgeColor, 0.16);
    badge.style.border = `1px solid ${hexToRgba(badgeColor, 0.45)}`;
    badge.style.color = badgeColor;
  }

  li.querySelector('[data-action="scroll"]').addEventListener("click", (e) => {
    e.stopPropagation();
    scrollToHighlight(h.id, h.url);
  });

  li.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
    e.stopPropagation();
    deleteHighlight(h.id);
  });

  return li;
}

function scrollToHighlight(id, url) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;

    const redirectToHighlightPage = () => {
      if (!url) {
        showToast("No saved URL for this highlight");
        return;
      }
      chrome.storage.local.set({ pendingScroll: id }, () => {
        chrome.tabs.update(tabs[0].id, { url });
      });
    };

    if (!tabs[0].url || tabs[0].url.startsWith("chrome://") || tabs[0].url.startsWith("edge://")) {
      redirectToHighlightPage();
      return;
    }

    let targetUrl;
    let activeUrl;
    try {
      targetUrl = new URL(url);
      activeUrl = new URL(tabs[0].url);
    } catch {
      showToast("Invalid highlight URL");
      return;
    }

    if (activeUrl.origin !== targetUrl.origin || activeUrl.pathname !== targetUrl.pathname) {
      redirectToHighlightPage();
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, { type: "SCROLL_TO_HIGHLIGHT", id }, (res) => {
      if (!chrome.runtime.lastError && res?.found) return;

      chrome.tabs.sendMessage(tabs[0].id, { type: "REHYDRATE" }, () => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabs[0].id, { type: "SCROLL_TO_HIGHLIGHT", id }, (res2) => {
            if (chrome.runtime.lastError || !res2?.found) {
              showToast("Could not find highlight on this page");
            }
          });
        }, 1500);
      });
    });
  });
}

function deleteHighlight(id) {
  chrome.runtime.sendMessage({ type: "DELETE_HIGHLIGHT", id }, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "REMOVE_HIGHLIGHT_DOM", id }).catch(() => {});
      }
    });

    allHighlights = allHighlights.filter((h) => h.id !== id);
    renderHighlights();
    updateBadges();
    showToast("Highlight deleted");
  });
}

function clearAllHighlights() {
  if (allHighlights.length === 0) {
    showToast("No highlights to clear");
    return;
  }

  const shouldClear = window.confirm("Clear all highlights? This action cannot be undone.");
  if (!shouldClear) return;

  chrome.runtime.sendMessage({ type: "CLEAR_ALL_HIGHLIGHTS" }, (res) => {
    if (!res?.success) {
      showToast("Failed to clear highlights");
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "REMOVE_ALL_HIGHLIGHTS_DOM" }).catch(() => {});
      }
    });

    allHighlights = [];
    renderHighlights();
    updateBadges();
    showToast("All highlights cleared");
  });
}

function setupExport() {
  const btnJson = $("btnExportJson");
  const btnMd = $("btnExportMd");
  if (btnJson) btnJson.addEventListener("click", () => triggerExport("json"));
  if (btnMd) btnMd.addEventListener("click", () => triggerExport("markdown"));
}

function triggerExport(format) {
  chrome.runtime.sendMessage({ type: "EXPORT_DATA", format }, (res) => {
    if (!res?.content) return;

    const ext = format === "markdown" ? "md" : "json";
    const mimeType = format === "markdown" ? "text/markdown" : "application/json";
    const blob = new Blob([res.content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `ai-highlights-${Date.now()}.${ext}`;
    a.click();

    URL.revokeObjectURL(url);
    showToast(`Exported as .${ext}`);
  });
}

function updateBadges() {
  const hlCountEl = $("hlCount");
  if (hlCountEl) hlCountEl.textContent = allHighlights.length;
}

function showToast(msg) {
  const existing = document.querySelector(".sb-toast");
  if (existing) existing.remove();

  const t = document.createElement("div");
  t.className = "sb-toast";
  t.textContent = msg;
  document.body.appendChild(t);

  setTimeout(() => t.remove(), 2400);
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function capitalize(s) {
  return String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
}

function hexToRgba(hex, alpha) {
  const clean = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(99, 102, 241, ${alpha})`;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}
