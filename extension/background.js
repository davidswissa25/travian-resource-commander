// Service worker: clicking the toolbar icon opens (or focuses) the dashboard tab.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  try {
    const existing = await chrome.tabs.query({ url: url + '*' });
    if (existing && existing.length) {
      await chrome.tabs.update(existing[0].id, { active: true });
      if (existing[0].windowId != null) chrome.windows.update(existing[0].windowId, { focused: true });
      return;
    }
  } catch (e) { /* fall through to create */ }
  chrome.tabs.create({ url });
});
