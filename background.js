/**
 * background.js — Service Worker
 * Handles: side panel activation, Gemini API calls, cross-tab storage events.
 */

// ─────────────────────────────────────────────────────────────
// CONFIGURATION — Replace with your Gemini API key.
// ─────────────────────────────────────────────────────────────
// const CONFIG = {
//   GEMINI_API_KEY: "AIzaSyAYfMYL1-1y2BzYN-lwAF9_o4Y7B773NsI",   // ← paste your key here
//   GEMINI_MODEL:   "gemini-1.5-flash",
//   GEMINI_ENDPOINT: "https://generativelanguage.googleapis.com/v1beta/models/"
// };

// ─────────────────────────────────────────────────────────────
// Side Panel — open on action-button click
// ─────────────────────────────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});

// ─────────────────────────────────────────────────────────────
// Message Router
// ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "GENERATE_FLASHCARD":
      generateFlashcard(message.text)
        .then((card) => sendResponse({ success: true, card }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // keep channel open for async response

    case "GET_ALL_DATA":
      getAllData().then(sendResponse);
      return true;

    case "SAVE_FLASHCARD":
      saveFlashcard(message.flashcard).then(() => sendResponse({ success: true }));
      return true;

    case "DELETE_HIGHLIGHT":
      deleteHighlight(message.id).then(() => sendResponse({ success: true }));
      return true;

    case "DELETE_FLASHCARD":
      deleteFlashcard(message.id).then(() => sendResponse({ success: true }));
      return true;

    case "EXPORT_DATA":
      exportData(message.format).then(sendResponse);
      return true;

    default:
      break;
  }
});

// // ─────────────────────────────────────────────────────────────
// // Gemini API
// // ─────────────────────────────────────────────────────────────
// // async function generateFlashcard(text) {
// //   const url = `${CONFIG.GEMINI_ENDPOINT}${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

// //   const prompt = `Convert the following text into a clear flashcard.
// // Create one focused question and one concise, accurate answer.
// // Return ONLY valid JSON with keys "question" and "answer" — no markdown, no extra text.

// // Text: "${text}"`;

//   const body = {
//     contents: [{ parts: [{ text: prompt }] }],
//     generationConfig: {
//       temperature: 0.4,
//       maxOutputTokens: 512,
//       responseMimeType: "application/json"
//     }
//   };

//   const res = await fetch(url, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify(body)
//   });

//   if (!res.ok) {
//     const errBody = await res.text();
//     throw new Error(`Gemini API error ${res.status}: ${errBody}`);
//   }

//   const data = await res.json();
//   const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
//   if (!raw) throw new Error("Empty response from Gemini.");

//   // Strip accidental markdown fences
//   const clean = raw.replace(/```json|```/gi, "").trim();
//   const parsed = JSON.parse(clean);

//   if (!parsed.question || !parsed.answer) {
//     throw new Error("Gemini returned unexpected JSON shape.");
//   }

//   return {
//     id:          `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
//     question:    parsed.question,
//     answer:      parsed.answer,
//     timestamp:   Date.now()
//   };
// }

// ─────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────
function getAllData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["highlights"], (result) => {
      resolve({
        highlights: result.highlights || [],

      });
    });
  });
}

// function saveFlashcard(flashcard) {
//   return new Promise((resolve) => {
//     chrome.storage.local.get(["flashcards"], (result) => {
//       const list = result.flashcards || [];
//       list.unshift(flashcard);                       // newest first
//       chrome.storage.local.set({ flashcards: list }, resolve);
//     });
//   });
// }

function deleteHighlight(id) {
  return new Promise((resolve) => {
    chrome.storage.local.get(["highlights"], (result) => {
      const list = (result.highlights || []).filter((h) => h.id !== id);
      chrome.storage.local.set({ highlights: list }, resolve);
    });
  });
}

// function deleteFlashcard(id) {
//   return new Promise((resolve) => {
//     chrome.storage.local.get(["flashcards"], (result) => {
//       const list = (result.flashcards || []).filter((f) => f.id !== id);
//       chrome.storage.local.set({ flashcards: list }, resolve);
//     });
//   });
// }

// ─────────────────────────────────────────────────────────────
// Export helper
// ─────────────────────────────────────────────────────────────
async function exportData(format = "json") {
  const { highlights } = await getAllData();

  if (format === "markdown") {
    let md = "# AI Chat Highlights & Flashcards\n\n";
    md += "## 📌 Highlights\n\n";
    highlights.forEach((h) => {
      const date = new Date(h.timestamp).toLocaleString();
      md += `### [${h.type.toUpperCase()}] — ${date}\n> ${h.text}\n_Source: ${h.url}_\n\n`;
    });
    // md += "---\n\n## 🃏 Flashcards\n\n";
    // flashcards.forEach((f, i) => {
    //   md += `**Q${i + 1}: ${f.question}**\nA: ${f.answer}\n\n`;
    // });
    return { content: md, format: "markdown" };
  }

  // Default: JSON
  return {
    content: JSON.stringify({ highlights }, null, 2),
    format: "json"
  };
}
