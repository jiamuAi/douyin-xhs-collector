// Installed lazily, in Chrome's isolated world. A full page reload starts a fresh session.
(() => {
  if (globalThis.xhsPageNotes) return;
  let current = null;
  let byId = new Map();
  let finishedAt = "";
  let revision = 0;
  let renderedCount = 0;
  const nonempty = (v) => v != null && v !== "" && (!Array.isArray(v) || v.length > 0);
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];

  function mergeNote(old, fresh) {
    const note = { ...old };
    for (const [key, value] of Object.entries(fresh)) {
      if (key === "_noteUrlFromCard") continue;
      if (!nonempty(value)) continue;
      if (key === "noteUrl") {
        // Page-data fallbacks may fill a missing link, but cannot replace a card's original URL.
        if (old._noteUrlFromCard && !fresh._noteUrlFromCard) continue;
        if (fresh._noteUrlFromCard && !old._noteUrlFromCard) { note[key] = value; continue; }
      }
      if (Array.isArray(value)) note[key] = union(value, old[key]);
      else if ((key === "noteUrl" || key === "authorUrl") && old[key] &&
        new URL(old[key]).searchParams.get("xsec_token") && !new URL(value).searchParams.get("xsec_token")) continue;
      else note[key] = value;
    }
    note._noteUrlFromCard = !!(old._noteUrlFromCard || fresh._noteUrlFromCard);
    // A later metadata-only observation must not demote a previously rendered card.
    note.rendered = fresh.rendered || old.rendered;
    note.source = note.rendered && (fresh.source !== "卡片" || old.source !== "卡片") ? "卡片＋页面数据" : fresh.source;
    if (fresh.likeDisplay && (fresh.rendered || !old.rendered)) {
      for (const key of ["likeDisplay", "likeCount", "referenceCount", "precision"]) note[key] = fresh[key];
      if (fresh.likeDisplay === old.likeDisplay && fresh.likeCount == null && old.likeCount != null) {
        for (const key of ["likeCount", "referenceCount", "precision"]) note[key] = old[key];
      }
    } else {
      for (const key of ["likeDisplay", "likeCount", "referenceCount", "precision"]) note[key] = old[key];
    }
    return note;
  }

  function accept(snapshot, reset = false) {
    if (snapshot.error) throw new Error(snapshot.error);
    const scopeChanged = current?.page.scopeKey !== snapshot.page.scopeKey;
    if (reset || scopeChanged) {
      byId = new Map();
      renderedCount = 0;
      if (current && scopeChanged) globalThis.xhsPageScroll?.clear();
    }
    const previous = current;
    current = { page: snapshot.page, profile: snapshot.profile, warnings: snapshot.warnings };
    if (!reset && previous?.page.scopeKey === snapshot.page.scopeKey && previous.profile && current.profile) {
      for (const key of ["postedCount", "receivedLikes", "receivedSaves"]) {
        current.profile[key] ??= previous.profile[key];
      }
    }
    for (const note of snapshot.notes) {
      const old = byId.get(note.id);
      if (!old && !note.rendered) continue;
      if (note.rendered && !old?.rendered) renderedCount++;
      byId.set(note.id, old ? mergeNote(old, note) : note);
    }
    finishedAt = snapshot.capturedAt;
    revision++;
  }
  function progress() {
    return { revision, renderedCount, total: byId.size, scopeKey: current?.page.scopeKey };
  }
  function result(since) {
    const scroll = globalThis.xhsPageScroll?.status();
    if (since === revision) return { revision, scroll };
    return { ...current, notes: [...byId.values()], capturedAt: finishedAt, revision, scroll };
  }
  globalThis.xhsPageNotes = {
    accept, progress, result,
    async capture() {
      const snapshot = globalThis.douyinCollector ? await globalThis.douyinCollector.captureList() :
        await chrome.runtime.sendMessage({ type: "read-note-list" });
      if (!snapshot || snapshot.error) throw new Error(snapshot?.error || "页面读取中断，请重新扫描。");
      if (new URL(snapshot.page.url).pathname !== location.pathname) throw new Error("页面已切换，请重新扫描。");
      return snapshot;
    }
  };
})();
