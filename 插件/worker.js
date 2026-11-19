"use strict";

// Export snapshots are accessible only to trusted extension pages, never to page/content scripts.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "feishu-open" || sender.id !== chrome.runtime.id || sender.tab ||
    sender.url !== chrome.runtime.getURL("popup.html")) return;
  (async () => {
    if (!Array.isArray(message.payload?.notes) || !Array.isArray(message.payload?.authors)) throw new Error("采集数据不完整。");
    const jobs = await chrome.storage.session.get(null);
    for (const [key, item] of Object.entries(jobs)) {
      if (key.startsWith("feishu-job-") && item.createdAt < Date.now() - 24 * 60 * 60 * 1000) await chrome.storage.session.remove(key);
    }
    const id = crypto.randomUUID();
    await chrome.storage.session.set({ ["feishu-job-" + id]: { payload: message.payload, createdAt: Date.now() } });
    try { await chrome.tabs.create({ url: chrome.runtime.getURL("feishu.html") + "?job=" + id }); }
    catch (error) { await chrome.storage.session.remove("feishu-job-" + id); throw error; }
    reply({ ok: true });
  })().catch(error => reply({ error: error.message.includes("QUOTA") ? "导出缓存已满，请关闭 Chrome 后重新采集，或先导出 Excel。" : error.message }));
  return true;
});

// The tab owns the run. Each read can wake a suspended worker and targets only the requesting document.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "read-note-list" || sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 || !sender.tab?.id || !sender.documentId ||
    !/^https:\/\/(?:www\.)?xiaohongshu\.com\//i.test(sender.url || "")) return;
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
    world: "MAIN", files: ["collector.js"]
  }).then(([injection]) => {
    reply(injection?.result || { error: "页面暂时没有返回笔记，请等列表加载后再试。" });
  }).catch(() => reply({ error: "请在小红书列表页重新点开插件，已采集的笔记保存在原标签页中。" }));
  return true;
});

// Read identifiers attached to mounted carousel tiles in the requesting search document.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "read-douyin-carousel" || sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 || !sender.tab?.id || !sender.documentId ||
      !/^https:\/\/(?:www\.)?douyin\.com\/(?:(?:jingxuan|root)\/)?search\//i.test(sender.url || "")) return;
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
    world: "MAIN", files: ["douyin-carousel.js"]
  }).then(([run]) => reply(run?.result || []), () => reply([]));
  return true;
});
