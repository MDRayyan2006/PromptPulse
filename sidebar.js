/**
 * sidebar.js — Sidebar panel controller
 * Manages: highlights list, flashcard generation/display, quiz mode, export.
 */

"use strict";

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let allHighlights = [];
let allFlashcards = [];
let activeFilter = "all";
let selectedHlId = null;   // for flashcard generation
let quizCards = [];
let quizIndex = 0;
let quizScore = 0;
let hasShownLoadFailureNote = false;

// ─────────────────────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupFilters();
  setupSearch();
  setupExport();
  setupQuiz();
  loadData();
  setupStorageSync();

  // Listen for new highlights from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "HIGHLIGHT_CREATED") {
      allHighlights.unshift(msg.highlight);
      renderHighlights();
      renderPickerList();
      updateBadges();
    }
  });
});

function setupStorageSync() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes.highlights) {
      allHighlights = (changes.highlights.newValue || []).sort((a, b) => b.timestamp - a.timestamp);

      if (selectedHlId && !allHighlights.some((h) => h.id === selectedHlId)) {
        selectedHlId = null;
        const btn = $("btnGenerate");
        if (btn) btn.disabled = true;
      }

      renderHighlights();
      renderPickerList();
      updateBadges();
    }

    if (changes.flashcards) {
      allFlashcards = (changes.flashcards.newValue || []).sort((a, b) => b.timestamp - a.timestamp);
      renderFlashcards();
      updateBadges();
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────────────────────
function loadData() {
  chrome.runtime.sendMessage({ type: "GET_ALL_DATA" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      showPanelLoadFailureNote();
      return;
    }
    allHighlights = (res.highlights || []).sort((a, b) => b.timestamp - a.timestamp);
    allFlashcards = (res.flashcards || []).sort((a, b) => b.timestamp - a.timestamp);
    renderHighlights();
    renderFlashcards();
    renderPickerList();
    updateBadges();
  });
}

function showPanelLoadFailureNote() {
  if (hasShownLoadFailureNote) return;
  hasShownLoadFailureNote = true;
  showToast("If panel fails to load, refresh and highlight again.");
}

// ─────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────
function setupTabs() {
  $$(".sb-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".sb-tab").forEach((t) => t.classList.remove("active"));
      $$(".sb-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`panel-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────
function setupFilters() {
  $$(".sb-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".sb-filter").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      renderHighlights();
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────
function setupSearch() {
  const search = $("hlSearch");
  if (search) search.addEventListener("input", () => renderHighlights());
}

// ─────────────────────────────────────────────────────────────
// Render Highlights
// ─────────────────────────────────────────────────────────────
function renderHighlights() {
  const list = $("hlList");
  const emptyEl = $("hlEmpty");
  const search = $("hlSearch");
  const query = (search?.value || "").toLowerCase().trim();

  if (!list || !emptyEl) return;

  let items = allHighlights;
  if (activeFilter !== "all") items = items.filter((h) => h.type === activeFilter);
  if (query) items = items.filter((h) => h.text.toLowerCase().includes(query));

  // Clear (keep empty placeholder)
  list.querySelectorAll(".sb-hl-item").forEach((el) => el.remove());

  if (items.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  items.forEach((h, i) => {
    const li = buildHighlightItem(h, i);
    list.appendChild(li);
  });
}

function buildHighlightItem(h, delay = 0) {
  const li = document.createElement("li");
  li.className = "sb-hl-item";
  li.style.animationDelay = `${delay * 30}ms`;
  li.dataset.id = h.id;

  const date = formatDate(h.timestamp);

  li.innerHTML = `
    <div class="sb-hl-item-top">
      <span class="sb-hl-type-badge ${h.type}">${capitalize(h.type)}</span>
      <span class="sb-hl-date">${date}</span>
    </div>
    <p class="sb-hl-text">${escapeHtml(h.text)}</p>
    <div class="sb-hl-actions">
      <button class="sb-hl-action-btn" data-action="scroll">↗ Scroll to</button>
      <button class="sb-hl-action-btn danger" data-action="delete">✕ Delete</button>
    </div>
  `;

  // Scroll to
  li.querySelector('[data-action="scroll"]').addEventListener("click", (e) => {
    e.stopPropagation();
    scrollToHighlight(h.id, h.url);
  });

  // Delete
  li.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
    e.stopPropagation();
    deleteHighlight(h.id);
  });

  return li;
}

// ─────────────────────────────────────────────────────────────
// Render Flashcards
// ─────────────────────────────────────────────────────────────
function renderFlashcards() {
  const list = $("fcList");
  const emptyEl = $("fcEmpty");

  if (!list || !emptyEl) return;

  list.querySelectorAll(".sb-fc-item").forEach((el) => el.remove());

  if (allFlashcards.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  allFlashcards.forEach((f, i) => {
    const li = buildFlashcardItem(f, i);
    list.appendChild(li);
  });
}

function buildFlashcardItem(f, delay = 0) {
  const li = document.createElement("li");
  li.className = "sb-fc-item";
  li.style.animationDelay = `${delay * 30}ms`;

  const date = formatDate(f.timestamp);

  li.innerHTML = `
    <p class="sb-fc-item-q">${escapeHtml(f.question)}</p>
    <p class="sb-fc-item-a">${escapeHtml(f.answer)}</p>
    <div class="sb-fc-item-footer">
      <span class="sb-fc-date">${date}</span>
      <button class="sb-hl-action-btn danger" data-id="${f.id}">✕ Delete</button>
    </div>
  `;

  li.querySelector("button").addEventListener("click", () => deleteFlashcard(f.id));
  return li;
}

// ─────────────────────────────────────────────────────────────
// Picker (for flashcard generation)
// ─────────────────────────────────────────────────────────────
function renderPickerList() {
  const list = $("fcPickerList");
  const emptyEl = $("fcPickerEmpty");

  if (!list || !emptyEl) return;

  list.querySelectorAll(".sb-picker-item").forEach((el) => el.remove());

  if (allHighlights.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  allHighlights.forEach((h) => {
    const li = document.createElement("li");
    li.className = "sb-picker-item";
    li.dataset.id = h.id;
    if (h.id === selectedHlId) li.classList.add("selected");

    li.innerHTML = `
      <span class="sb-hl-type-badge ${h.type}" style="font-size:9px;padding:1px 6px;">${capitalize(h.type)}</span>
      <p class="sb-picker-text">${escapeHtml(h.text)}</p>
    `;

    li.addEventListener("click", () => {
      $$(".sb-picker-item").forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");
      selectedHlId = h.id;
      const btnGenerate = $("btnGenerate");
      if (btnGenerate) btnGenerate.disabled = false;
    });

    list.appendChild(li);
  });
}

// ─────────────────────────────────────────────────────────────
// Flashcard Generation
// ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const btnGenerate = $("btnGenerate");
  if (btnGenerate) btnGenerate.addEventListener("click", generateFlashcard);
});

async function generateFlashcard() {
  const hl = allHighlights.find((h) => h.id === selectedHlId);
  if (!hl) return;

  const btn = $("btnGenerate");
  const spinner = $("fcSpinner");
  const errEl = $("fcError");

  btn.disabled = true;
  spinner.classList.remove("hidden");
  errEl.classList.add("hidden");

  chrome.runtime.sendMessage({ type: "GENERATE_FLASHCARD", text: hl.text }, (res) => {
    spinner.classList.add("hidden");
    btn.disabled = false;

    if (!res || !res.success) {
      errEl.textContent = res?.error || "Failed to generate flashcard.";
      errEl.classList.remove("hidden");
      return;
    }

    const card = { ...res.card, highlightId: selectedHlId };

    chrome.runtime.sendMessage({ type: "SAVE_FLASHCARD", flashcard: card }, () => {
      allFlashcards.unshift(card);
      renderFlashcards();
      updateBadges();
      showToast("✓ Flashcard saved");
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────
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

    let targetUrl, activeUrl;
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
    // Remove from DOM in active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "REMOVE_HIGHLIGHT_DOM", id }).catch(() => { });
      }
    });

    allHighlights = allHighlights.filter((h) => h.id !== id);
    if (selectedHlId === id) {
      selectedHlId = null;
      const btnGenerate = $("btnGenerate");
      if (btnGenerate) btnGenerate.disabled = true;
    }
    renderHighlights();
    renderPickerList();
    updateBadges();
    showToast("Highlight deleted");
  });
}

function deleteFlashcard(id) {
  chrome.runtime.sendMessage({ type: "DELETE_FLASHCARD", id }, () => {
    allFlashcards = allFlashcards.filter((f) => f.id !== id);
    renderFlashcards();
    updateBadges();
    showToast("Flashcard deleted");
  });
}

// ─────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Quiz Mode
// ─────────────────────────────────────────────────────────────
function setupQuiz() {
  const btnQuizStart = $("btnQuizStart");
  const btnReveal = $("btnReveal");
  const btnCorrect = $("btnCorrect");
  const btnWrong = $("btnWrong");
  const btnQuizRestart = $("btnQuizRestart");

  if (btnQuizStart) btnQuizStart.addEventListener("click", startQuiz);
  if (btnReveal) btnReveal.addEventListener("click", revealAnswer);
  if (btnCorrect) btnCorrect.addEventListener("click", () => gradeCard(true));
  if (btnWrong) btnWrong.addEventListener("click", () => gradeCard(false));
  if (btnQuizRestart) btnQuizRestart.addEventListener("click", startQuiz);
}

function startQuiz() {
  quizCards = shuffle([...allFlashcards]);
  quizIndex = 0;
  quizScore = 0;

  if (quizCards.length === 0) {
    showToast("No flashcards to quiz on yet.");
    return;
  }

  $("quizStart").classList.add("hidden");
  $("quizResult").classList.add("hidden");
  $("quizCard").classList.remove("hidden");
  showQuizCard();
}

function showQuizCard() {
  if (quizIndex >= quizCards.length) {
    endQuiz();
    return;
  }

  const card = quizCards[quizIndex];
  const pct = Math.round((quizIndex / quizCards.length) * 100);

  const qProgressBar = $("qProgressBar");
  const qCounter = $("qCounter");
  const qQuestion = $("qQuestion");
  const qAnswer = $("qAnswer");
  const qGrade = $("qGrade");
  const btnReveal = $("btnReveal");

  if (qProgressBar) qProgressBar.style.width = `${pct}%`;
  if (qCounter) qCounter.textContent = `${quizIndex + 1} / ${quizCards.length}`;
  if (qQuestion) qQuestion.textContent = card.question;
  if (qAnswer) {
    qAnswer.textContent = card.answer;
    qAnswer.classList.add("hidden");
  }
  if (qGrade) qGrade.classList.add("hidden");
  if (btnReveal) btnReveal.classList.remove("hidden");
}

function revealAnswer() {
  const qAnswer = $("qAnswer");
  const qGrade = $("qGrade");
  const btnReveal = $("btnReveal");
  if (qAnswer) qAnswer.classList.remove("hidden");
  if (qGrade) qGrade.classList.remove("hidden");
  if (btnReveal) btnReveal.classList.add("hidden");
}

function gradeCard(correct) {
  if (correct) quizScore++;
  quizIndex++;
  showQuizCard();
}

function endQuiz() {
  const quizCard = $("quizCard");
  const quizResult = $("quizResult");
  if (quizCard) quizCard.classList.add("hidden");
  if (quizResult) quizResult.classList.remove("hidden");
  const pct = Math.round((quizScore / quizCards.length) * 100);
  setText("quizScore", `${quizScore}/${quizCards.length} (${pct}%)`);
  setText("quizCount", `${allFlashcards.length} flashcard${allFlashcards.length !== 1 ? "s" : ""} available`);
}

// ─────────────────────────────────────────────────────────────
// Badges & UI helpers
// ─────────────────────────────────────────────────────────────
function updateBadges() {
  const hlCountEl = $("hlCount");
  const fcCountEl = $("fcCount");
  const quizCountEl = $("quizCount");

  if (hlCountEl) hlCountEl.textContent = allHighlights.length;
  if (fcCountEl) fcCountEl.textContent = allFlashcards.length;
  if (quizCountEl) {
    quizCountEl.textContent = allFlashcards.length > 0
      ? `${allFlashcards.length} flashcard${allFlashcards.length !== 1 ? "s" : ""} available`
      : "No flashcards yet — generate some first.";
  }
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

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────
function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
