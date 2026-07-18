/**
 * background.js — CrediBytes
 * Manifest V3 service worker.
 *
 * Handles ALL network requests to the FastAPI backend.
 * Content scripts cannot fetch external origins due to Facebook's
 * strict Content Security Policy — service workers are exempt.
 *
 * Also owns chrome.storage writes for scan history to prevent
 * race conditions with content.js.
 */

const BACKEND_URL = 'http://127.0.0.1:8000'

chrome.runtime.onInstalled.addListener(() => {
  console.log("CrediBytes installed.");
  chrome.storage.local.set({
    scans: [],
    settings: {
      scanningEnabled: true,
      displayMode: "badge",
    }
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  const data = await chrome.storage.local.get("settings");
  if (data.settings?.displayMode === "sidepanel") {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Stage 1: ML prediction via FastAPI backend ──────────────────────────
  if (message.type === "PREDICT") {
    fetchPrediction(message.payload)
      .then(prediction => sendResponse({ ok: true, prediction }))
      .catch(() => sendResponse({ ok: false, prediction: null }));
    return true; // keep message channel open for async response
  }

  // ── Save scan result to storage (single writer — no race conditions) ─────
  if (message.type === "SAVE_SCAN") {
    chrome.storage.local.get("scans", (data) => {
      const scans = data.scans || [];
      scans.unshift(message.payload);
      chrome.storage.local.set({ scans: scans.slice(0, 50) });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "CLEAR_SCANS") {
    chrome.storage.local.set({ scans: [] }, () => sendResponse({ ok: true }));
    return true;
  }
});

async function fetchPrediction({ companyName, platformName }) {
  try {
    const res = await fetch(`${BACKEND_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_name: companyName, platform_name: platformName }),
    });
    if (!res.ok) return null;
    return await res.json(); // { is_app: bool, probability: float }
  } catch {
    return null; // Backend unreachable — content.js degrades gracefully
  }
}
