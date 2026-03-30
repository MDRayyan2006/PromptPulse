<<<<<<< HEAD
/**
 * background.js — Service Worker
 * Handles side panel behavior and highlight storage/export actions.
 */

// Open side panel when extension action is clicked.
=======


// ─────────────────────────────────────────────────────────────
// Side Panel — open on action-button click
// ─────────────────────────────────────────────────────────────
>>>>>>> 0cf3bf52cfc108b043bc97fd20b2efbef7a75898
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "GET_ALL_DATA":
      getAllData().then(sendResponse);
      return true;

    case "DELETE_HIGHLIGHT":
      deleteHighlight(message.id).then(() => sendResponse({ success: true }));
      return true;

    case "CLEAR_ALL_HIGHLIGHTS":
      clearAllHighlights().then(() => sendResponse({ success: true }));
      return true;

    case "EXPORT_DATA":
      exportData(message.format).then(sendResponse);
      return true;

    default:
      break;
  }
});

function getAllData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["highlights", "highlightCategories"], (result) => {
      resolve({
        highlights: result.highlights || [],
        highlightCategories: result.highlightCategories || []
      });
    });
  });
}

function deleteHighlight(id) {
  return new Promise((resolve) => {
    chrome.storage.local.get(["highlights"], (result) => {
      const list = (result.highlights || []).filter((h) => h.id !== id);
      chrome.storage.local.set({ highlights: list }, resolve);
    });
  });
}

function clearAllHighlights() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ highlights: [] }, resolve);
  });
}

async function exportData(format = "json") {
  const { highlights } = await getAllData();

  if (format === "markdown") {
    let md = "# AI Chat Highlights\n\n";
    md += "## Highlights\n\n";

    highlights.forEach((h) => {
      const date = new Date(h.timestamp).toLocaleString();
      md += `### [${h.type.toUpperCase()}] - ${date}\n> ${h.text}\n_Source: ${h.url}_\n\n`;
    });

    return { content: md, format: "markdown" };
  }

  return {
    content: JSON.stringify({ highlights }, null, 2),
    format: "json"
  };
}
