/**
 * content.js — Content Script
 * Runs on AI-chat pages. Manages text selection, tooltip, DOM highlighting,
 * and re-hydrates saved highlights after page reload.
 */

(function () {
  "use strict";

  // ─── Guard against double-injection ────────────────────────
  if (window.__hlInjected) return;
  window.__hlInjected = true;

  // ─── Constants ─────────────────────────────────────────────
  const TOOLTIP_ID = "hl-float-tooltip";
  const STORAGE_KEY = "highlights";
  const PULSE_CLASS = "hl-pulse";
  const DEFAULT_MIN_SELECTION = 3;
  const CODE_MIN_SELECTION = 1;

  function isContextInvalidatedError(err) {
    return String(err?.message || err || "").toLowerCase().includes("context invalidated");
  }

  function safeSendMessage(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch (err) {
      if (!isContextInvalidatedError(err)) {
        console.debug("PromptPulse: sendMessage failed", err);
      }
    }
  }

  function safeStorageGet(keys, callback) {
    try {
      chrome.storage.local.get(keys, (res) => {
        if (chrome.runtime.lastError) return;
        callback(res || {});
      });
    } catch (err) {
      if (!isContextInvalidatedError(err)) {
        console.debug("PromptPulse: storage.get failed", err);
      }
    }
  }

  function safeStorageSet(value, callback) {
    try {
      chrome.storage.local.set(value, () => {
        void chrome.runtime.lastError;
        if (callback) callback();
      });
    } catch (err) {
      if (!isContextInvalidatedError(err)) {
        console.debug("PromptPulse: storage.set failed", err);
      }
    }
  }

  function safeStorageRemove(keys) {
    try {
      chrome.storage.local.remove(keys, () => {
        void chrome.runtime.lastError;
      });
    } catch (err) {
      if (!isContextInvalidatedError(err)) {
        console.debug("PromptPulse: storage.remove failed", err);
      }
    }
  }

  // ─── State ─────────────────────────────────────────────────
  let activeTooltip = null;
  let savedRange = null;
  let savedFieldSelection = null;
  let lastRangeSnapshot = null;

  // ─── Init ──────────────────────────────────────────────────
  function init() {
    document.addEventListener("mouseup", onMouseUp, { passive: true });
    document.addEventListener("mousedown", onMouseDown, { passive: true });
    document.addEventListener("keyup", onKeyUp, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange, { passive: true });
    chrome.runtime.onMessage.addListener(onMessage);

    const performRehydrate = () => {
      rehydrateAll();
      setTimeout(checkPendingScroll, 500);
    };

    // Rehydrate after DOM is settled (with retries for heavy SPAs)
    [500, 1500, 3200, 5200].forEach((delay) => setTimeout(performRehydrate, delay));

    // Watch for SPA navigations
    observeNavigation();
  }

  function checkPendingScroll() {
    safeStorageGet(["pendingScroll"], (res) => {
      if (res.pendingScroll) {
        const id = res.pendingScroll;
        const el = document.querySelector(`[data-hl-id="${id}"], [data-hl-field-id="${id}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add(PULSE_CLASS);
          setTimeout(() => el.classList.remove(PULSE_CLASS), 2200);
          safeStorageRemove(["pendingScroll"]);
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Selection & Tooltip
  // ─────────────────────────────────────────────────────────────
  function onMouseUp(e) {
    if (e.target.closest(`#${TOOLTIP_ID}`)) return;

    // Small delay so the selection is fully committed
    setTimeout(() => {
      tryCaptureAndShowSelection(e.clientX, e.clientY);
    }, 30);
  }

  function onKeyUp() {
    // Support keyboard-driven selection (Shift+Arrow, Ctrl+A, etc.).
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const pt = getSelectionAnchorPoint(sel);
      tryCaptureAndShowSelection(pt.x, pt.y);
    }, 20);
  }

  function tryCaptureAndShowSelection(clientX, clientY) {
    savedFieldSelection = getActiveFieldSelection();
    if (savedFieldSelection && savedFieldSelection.text.length >= 1) {
      savedRange = null;
      const rect = getFieldSelectionRect(savedFieldSelection.element);
      showTooltip(rect.x, rect.y);
      return;
    }

    const sel = window.getSelection();
    const text = sel?.toString().trim() || "";
    const minSelection = getMinSelectionLength(sel);

    if (sel && !sel.isCollapsed && text.length >= minSelection) {
      try {
        savedRange = sel.getRangeAt(0).cloneRange();
        savedFieldSelection = null;
        showTooltip(clientX, clientY);
        return;
      } catch {
        return;
      }
    }

    // Some search-result pages collapse selection immediately on mouseup.
    if (lastRangeSnapshot && (Date.now() - lastRangeSnapshot.ts) < 900 && lastRangeSnapshot.text.length >= minSelection) {
      savedRange = lastRangeSnapshot.range.cloneRange();
      savedFieldSelection = null;
      showTooltip(clientX, clientY);
    }
  }

  function getSelectionAnchorPoint(sel) {
    try {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const x = rect.left + Math.max(8, rect.width / 2);
      const y = Math.max(8, rect.top + 8);
      return { x, y };
    } catch {
      return {
        x: Math.round(window.innerWidth / 2),
        y: 60
      };
    }
  }

  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const text = sel.toString().trim();
    const minSelection = getMinSelectionLength(sel);
    if (text.length < minSelection) return;

    try {
      lastRangeSnapshot = {
        range: sel.getRangeAt(0).cloneRange(),
        text,
        ts: Date.now()
      };
    } catch {
      // Ignore transient selection errors.
    }
  }

  function onMouseDown(e) {
    if (!e.target.closest(`#${TOOLTIP_ID}`)) destroyTooltip();
  }

  function showTooltip(cx, cy) {
    destroyTooltip();

    const tip = document.createElement("div");
    tip.id = TOOLTIP_ID;
    tip.innerHTML = `
      <div class="hl-tip-arrow"></div>
      <div class="hl-tip-label">Highlight as</div>
      <div class="hl-tip-btns">
        <button class="hl-tip-btn hl-tip-important" data-type="important">
          <span class="hl-tip-dot"></span>Important
        </button>
        <button class="hl-tip-btn hl-tip-concept" data-type="concept">
          <span class="hl-tip-dot"></span>Concept
        </button>
        <button class="hl-tip-btn hl-tip-doubt" data-type="doubt">
          <span class="hl-tip-dot"></span>Doubt
        </button>
      </div>
    `;

    document.body.appendChild(tip);
    activeTooltip = tip;

    // Position
    const tipW = 220;
    const tipH = 80;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const vw = window.innerWidth;

    let left = cx + sx - tipW / 2;
    let top = cy + sy - tipH - 14;

    if (left < sx + 8) left = sx + 8;
    if (left + tipW > vw + sx - 8) left = vw + sx - tipW - 8;
    if (top < sy + 8) top = cy + sy + 18;   // flip below

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;

    // Button handlers
    tip.querySelectorAll(".hl-tip-btn").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyHighlight(btn.dataset.type);
        destroyTooltip();
      });
    });
  }

  function destroyTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Highlight Creation
  // ─────────────────────────────────────────────────────────────
  function applyHighlight(type) {
    if (savedFieldSelection) {
      applyFieldHighlight(type);
      return;
    }

    if (!savedRange) return;

    const text = savedRange.toString().trim();
    if (!text) return;

    const id = generateId();
    const anchors = buildRangeAnchors(savedRange);

    const textNodes = getTextNodesInRange(savedRange);
    let appliedCount = 0;

    if (textNodes.length === 0) {
      if (!applyRangeFallback(savedRange, id, type)) return;
      appliedCount = 1;
    }

    textNodes.forEach(({ node, startOffset, endOffset }) => {
      const textContent = node.nodeValue;
      const before = textContent.slice(0, startOffset);
      const inside = textContent.slice(startOffset, endOffset);
      const after = textContent.slice(endOffset);

      if (!inside.trim()) return;

      const parent = node.parentNode;
      if (!parent) return;
      if (parent?.classList?.contains("hl-mark")) return;

      const span = buildSpan(id, type);
      span.textContent = inside;

      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(span, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);

      parent.removeChild(node);
      appliedCount++;
    });

    if (appliedCount === 0 && !applyRangeFallback(savedRange, id, type)) return;

    window.getSelection()?.removeAllRanges();
    savedRange = null;
    savedFieldSelection = null;

    const highlight = {
      id,
      text,
      type,
      timestamp: Date.now(),
      url: location.href,
      urlKey: getPageKey(),
      chatId: parseChatId(),
      ...anchors
    };

    persistHighlight(highlight);

    safeSendMessage({ type: "HIGHLIGHT_CREATED", highlight });
  }

  function applyFieldHighlight(type) {
    const fieldSel = savedFieldSelection;
    if (!fieldSel || !fieldSel.element?.isConnected) return;

    const id = generateId();
    fieldSel.element.classList.remove("hl-field-important", "hl-field-concept", "hl-field-doubt");
    fieldSel.element.classList.add("hl-field", `hl-field-${type}`);
    fieldSel.element.dataset.hlFieldId = id;

    const highlight = {
      id,
      text: fieldSel.text,
      type,
      timestamp: Date.now(),
      url: location.href,
      urlKey: getPageKey(),
      mode: "field",
      fieldSelector: fieldSel.selector,
      selectionStart: fieldSel.start,
      selectionEnd: fieldSel.end
    };

    persistHighlight(highlight);
    savedFieldSelection = null;
    savedRange = null;

    safeSendMessage({ type: "HIGHLIGHT_CREATED", highlight });
  }

  function getTextNodesInRange(range) {
    const textNodes = [];
    let root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) {
      root = root.parentNode || document.body;
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      let startOffset = 0;
      let endOffset = node.nodeValue.length;

      if (node === range.startContainer) {
        startOffset = range.startOffset;
      }
      if (node === range.endContainer) {
        endOffset = range.endOffset;
      }

      textNodes.push({ node, startOffset, endOffset });
    }

    return textNodes;
  }

  function applyRangeFallback(range, id, type) {
    try {
      const r = range.cloneRange();
      const selectedText = r.toString().trim();
      if (!selectedText) return false;

      const span = buildSpan(id, type);
      const frag = r.extractContents();
      span.appendChild(frag);
      r.insertNode(span);
      return true;
    } catch {
      return false;
    }
  }

  function buildSpan(id, type) {
    const span = document.createElement("span");
    span.className = `hl-mark hl-${type}`;
    span.dataset.hlId = id;
    return span;
  }

  // ─────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────
  function persistHighlight(highlight) {
    safeStorageGet([STORAGE_KEY], (res) => {
      const list = res[STORAGE_KEY] || [];
      const isDup = list.some((h) => {
        const hKey = h.urlKey || normalizeUrl(h.url || "");
        if (h.text !== highlight.text || h.type !== highlight.type || hKey !== highlight.urlKey) return false;

        if (Math.abs((h.charOffset || 0) - (highlight.charOffset || 0)) < 20) return true;

        return false;
      });
      if (isDup) return;
      list.unshift(highlight);
      safeStorageSet({ [STORAGE_KEY]: list });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Rehydration — restore highlights from storage after page load
  // ─────────────────────────────────────────────────────────────
  function rehydrateAll() {
    const pageKey = getPageKey();
    const chatId = parseChatId();

    safeStorageGet([STORAGE_KEY], (res) => {
      const all = res[STORAGE_KEY] || [];
      const forPage = all.filter((h) => {
        const hKey = h.urlKey || normalizeUrl(h.url || "");
        if (hKey && hKey === pageKey) return true;
        if (chatId && h.chatId && h.chatId === chatId) return true;
        return false;
      });

      forPage.forEach((h) => {
        if (h.mode === "field") {
          restoreFieldHighlight(h);
          return;
        }
        if (!document.querySelector(`[data-hl-id="${h.id}"]`)) {
          restoreHighlight(h);
        }
      });
    });
  }

  function restoreFieldHighlight(h) {
    const el = h.fieldSelector ? document.querySelector(h.fieldSelector) : null;
    if (!el) return;
    el.classList.remove("hl-field-important", "hl-field-concept", "hl-field-doubt");
    el.classList.add("hl-field", `hl-field-${h.type}`);
    el.dataset.hlFieldId = h.id;
  }

  function restoreHighlight(h) {
    const target = h.text.trim();
    if (!target) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        if (p.closest(`#${TOOLTIP_ID}`)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const charMap = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue;
      for (let i = 0; i < text.length; i++) {
        charMap.push({ node, offset: i, char: text[i] });
      }
    }

    if (charMap.length === 0) return;

    const matches = findAllMatches(charMap, target, h);
    if (matches.length) {
      for (const m of matches) {
        if (applyMatchFromCharMap(charMap, m.start, m.end, h.id, h.type)) {
          return;
        }
      }
    }
  }

  function applyMatchFromCharMap(charMap, matchStart, matchEnd, id, type) {
    const highlightNodes = [];
    let currentNode = null;
    let startOffset = 0;
    let endOffset = 0;

    for (let i = matchStart; i <= matchEnd; i++) {
      const m = charMap[i];
      if (m.node !== currentNode) {
        if (currentNode) {
          highlightNodes.push({ node: currentNode, startOffset, endOffset });
        }
        currentNode = m.node;
        startOffset = m.offset;
      }
      endOffset = m.offset + 1;
    }
    if (currentNode) {
      highlightNodes.push({ node: currentNode, startOffset, endOffset });
    }

    let applied = 0;

    highlightNodes.forEach(({ node, startOffset, endOffset }) => {
      const textContent = node.nodeValue;
      const before = textContent.slice(0, startOffset);
      const inside = textContent.slice(startOffset, endOffset);
      const after = textContent.slice(endOffset);

      if (!inside.trim()) return;

      const parent = node.parentNode;
      if (!parent) return;
      if (parent?.classList?.contains("hl-mark")) return;

      const span = buildSpan(id, type);
      span.textContent = inside;

      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(span, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);

      parent.removeChild(node);
      applied++;
    });

    return applied > 0;
  }

  // ─────────────────────────────────────────────────────────────
  // SPA Navigation Observer
  // ─────────────────────────────────────────────────────────────
  function observeNavigation() {
    let lastUrl = location.href;

    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(rehydrateAll, 600);
        setTimeout(rehydrateAll, 2000);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────────────────────
  // Message Handler (from sidebar / background)
  // ─────────────────────────────────────────────────────────────
  function onMessage(msg, _sender, sendResponse) {
    switch (msg.type) {
      case "SCROLL_TO_HIGHLIGHT": {
        const el = document.querySelector(`[data-hl-id="${msg.id}"], [data-hl-field-id="${msg.id}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add(PULSE_CLASS);
          setTimeout(() => el.classList.remove(PULSE_CLASS), 2200);
          sendResponse({ found: true });
        } else {
          sendResponse({ found: false });
        }
        break;
      }

      case "REMOVE_HIGHLIGHT_DOM": {
        const nodes = document.querySelectorAll(`[data-hl-id="${msg.id}"]`);
        nodes.forEach((el) => {
          const parent = el.parentNode;
          if (!parent) return;
          while (el.firstChild) parent.insertBefore(el.firstChild, el);
          el.remove();
        });

        const fieldEl = document.querySelector(`[data-hl-field-id="${msg.id}"]`);
        if (fieldEl) {
          fieldEl.classList.remove("hl-field", "hl-field-important", "hl-field-concept", "hl-field-doubt", PULSE_CLASS);
          delete fieldEl.dataset.hlFieldId;
        }

        sendResponse({ done: true });
        break;
      }

      case "REHYDRATE":
        rehydrateAll();
        sendResponse({ done: true });
        break;
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────
  function generateId() {
    return `hl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function parseChatId() {
    const url = location.href;
    return (
      url.match(/\/c\/([a-f0-9-]{8,})/)?.[1] ||   // ChatGPT
      url.match(/\/chat\/([a-z0-9]+)/)?.[1] ||   // Gemini
      url.match(/\/chat\/([a-zA-Z0-9_-]+)/)?.[1] ||   // Claude
      null
    );
  }

  function normalizeUrl(rawUrl) {
    try {
      const u = new URL(rawUrl, location.origin);
      const path = u.pathname.replace(/\/+$/, "") || "/";
      return `${u.origin}${path}`;
    } catch {
      return rawUrl.split(/[?#]/)[0].replace(/\/+$/, "");
    }
  }

  function getPageKey() {
    return normalizeUrl(location.href);
  }

  function buildRangeAnchors(range) {
    try {
      if (!range) return {};

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
          if (p.closest(`#${TOOLTIP_ID}`)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      let charOffset = 0;
      let startCharOffset = -1;
      let fullText = "";

      while (walker.nextNode()) {
        const node = walker.currentNode;
        const textStr = node.nodeValue;

        if (startCharOffset === -1) {
          if (node === range.startContainer) {
            startCharOffset = charOffset + range.startOffset;
          } else if (range.intersectsNode(node)) {
            startCharOffset = charOffset;
          }
        }

        charOffset += textStr.length;
        fullText += textStr;
      }

      if (startCharOffset === -1) return {};

      const selectedText = range.toString().trim();
      const preContext = fullText.slice(Math.max(0, startCharOffset - 48), startCharOffset);
      const postContext = fullText.slice(startCharOffset + selectedText.length, startCharOffset + selectedText.length + 48);

      let occurrenceIndex = 0;
      if (selectedText) {
        const target = selectedText.toLowerCase();
        const fullLower = fullText.toLowerCase();
        let idx = 0;

        while (idx <= startCharOffset) {
          const found = fullLower.indexOf(target, idx);
          if (found === -1 || found > startCharOffset) break;
          if (found === startCharOffset) break;
          occurrenceIndex++;
          idx = found + Math.max(1, target.length);
        }
      }

      return {
        preContext: normalizeAnchor(preContext),
        postContext: normalizeAnchor(postContext),
        charOffset: startCharOffset,
        occurrenceIndex
      };
    } catch {
      return {};
    }
  }

  function findAllMatches(charMap, target, h) {
    if (!Array.isArray(charMap) || charMap.length === 0) return [];

    const full = charMap.map((c) => c.char).join("");
    const targetLower = target.toLowerCase();
    const fullLower = full.toLowerCase();
    let matches = [];

    let startAt = 0;
    while (startAt < fullLower.length) {
      const idx = fullLower.indexOf(targetLower, startAt);
      if (idx === -1) break;
      matches.push({ start: idx, end: idx + target.length - 1 });
      startAt = idx + Math.max(1, target.length);
    }

    if (matches.length === 0) {
      let startI = 0;
      while (startI < charMap.length) {
        let targetIdx = 0;
        let matchStart = -1;
        let matchEnd = -1;

        for (let i = startI; i < charMap.length; i++) {
          let tChar = target[targetIdx];
          let cChar = charMap[i].char;

          const isTSpace = /\s/.test(tChar);
          const isCSpace = /\s/.test(cChar);

          if (isTSpace && isCSpace) {
            while (targetIdx < target.length && /\s/.test(target[targetIdx])) targetIdx++;
            while (i + 1 < charMap.length && /\s/.test(charMap[i + 1].char)) i++;
            continue;
          }

          if (isTSpace) {
            while (targetIdx < target.length && /\s/.test(target[targetIdx])) targetIdx++;
            i--;
            continue;
          }

          if (isCSpace) {
            continue;
          }

          if (tChar.toLowerCase() === cChar.toLowerCase()) {
            if (matchStart === -1) matchStart = i;
            targetIdx++;
            if (targetIdx === target.length) {
              matchEnd = i;
              break;
            }
          } else {
            if (matchStart !== -1) {
              i = matchStart;
              matchStart = -1;
              targetIdx = 0;
            }
          }
        }

        if (matchStart !== -1 && matchEnd !== -1) {
          matches.push({ start: matchStart, end: matchEnd });
          startI = matchStart + 1;
        } else {
          break;
        }
      }
    }

    if (matches.length === 0) return [];
    if (matches.length === 1) return matches;

    const preAnchor = normalizeAnchor(h?.preContext || "");
    const postAnchor = normalizeAnchor(h?.postContext || "");
    const desiredOccurrence = Number.isInteger(h?.occurrenceIndex) ? h.occurrenceIndex : null;
    const desiredOffset = Number.isInteger(h?.charOffset) ? h.charOffset : null;

    const ranked = matches.map((m, idx) => {
      let score = 0;

      if (desiredOccurrence !== null) {
        if (idx === desiredOccurrence) score += 20;
        else score += Math.max(0, 10 - Math.abs(idx - desiredOccurrence));
      }

      if (desiredOffset !== null) {
        const distance = Math.abs(m.start - desiredOffset);
        if (distance < 50) score += 50;
        else score += Math.max(0, 10 - Math.floor(distance / 200));
      }

      if (preAnchor) {
        const preSlice = normalizeAnchor(full.slice(Math.max(0, m.start - 96), m.start));
        if (preSlice.endsWith(preAnchor)) score += 10;
        else if (preSlice.includes(preAnchor.slice(-Math.min(16, preAnchor.length)))) score += 3;
      }

      if (postAnchor) {
        const postSlice = normalizeAnchor(full.slice(m.end + 1, Math.min(full.length, m.end + 97)));
        if (postSlice.startsWith(postAnchor)) score += 10;
        else if (postSlice.includes(postAnchor.slice(0, Math.min(16, postAnchor.length)))) score += 3;
      }

      return { ...m, score };
    });

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (desiredOffset !== null) {
        return Math.abs(a.start - desiredOffset) - Math.abs(b.start - desiredOffset);
      }
      return a.start - b.start;
    });

    return ranked.map(({ start, end }) => ({ start, end }));
  }

  function normalizeAnchor(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function getMinSelectionLength(sel) {
    try {
      if (!sel || sel.rangeCount === 0) return DEFAULT_MIN_SELECTION;
      const range = sel.getRangeAt(0);
      let root = range.commonAncestorContainer;
      if (root.nodeType === Node.TEXT_NODE) root = root.parentElement;
      if (root?.closest?.("pre, code")) return CODE_MIN_SELECTION;
      return DEFAULT_MIN_SELECTION;
    } catch {
      return DEFAULT_MIN_SELECTION;
    }
  }

  function getActiveFieldSelection() {
    const el = document.activeElement;
    if (!el) return null;

    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      return null;
    }

    if (el instanceof HTMLInputElement) {
      const allowed = ["text", "search", "url", "email", "tel", "password", "number"];
      if (!allowed.includes((el.type || "text").toLowerCase())) return null;
    }

    const start = Number.isInteger(el.selectionStart) ? el.selectionStart : null;
    const end = Number.isInteger(el.selectionEnd) ? el.selectionEnd : null;
    if (start === null || end === null || end <= start) return null;

    const value = el.value || "";
    const text = value.slice(start, end).trim();
    if (!text) return null;

    return {
      element: el,
      selector: buildElementSelector(el),
      start,
      end,
      text
    };
  }

  function getFieldSelectionRect(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + Math.min(rect.width * 0.5, 260),
      y: rect.top + 6
    };
  }

  function buildElementSelector(el) {
    if (el.id) return `#${cssEscape(el.id)}`;

    if (el.name) {
      const byName = document.querySelectorAll(`[name="${cssEscape(el.name)}"]`);
      if (byName.length === 1) return `${el.tagName.toLowerCase()}[name="${cssEscape(el.name)}"]`;
    }

    const segments = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
      const tag = node.tagName.toLowerCase();
      let index = 1;
      let prev = node.previousElementSibling;
      while (prev) {
        if (prev.tagName === node.tagName) index++;
        prev = prev.previousElementSibling;
      }
      segments.unshift(`${tag}:nth-of-type(${index})`);
      node = node.parentElement;
    }
    return `body > ${segments.join(" > ")}`;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // ─── Kick off ───────────────────────────────────────────────
  init();
})();
