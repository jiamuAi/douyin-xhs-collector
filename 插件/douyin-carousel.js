// Resolve only the work bound to each rendered carousel tile. Never enumerate the search payload.
(() => {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const workId = value => typeof value === "string" && /^\d{16,20}$/.test(value) ? value : "";
  const rows = [];
  for (const tile of document.querySelectorAll("#search-result-container .search-result-card .cs-scroller-content .cs-scroller-item")) {
    if (!tile.getClientRects().length || tile.closest('[hidden], [aria-hidden="true"]')) continue;
    const media = tile.querySelector(".videoImage");
    const caption = media?.parentElement?.nextElementSibling;
    const title = clean(caption?.innerText || caption?.textContent);
    const img = media?.querySelector("img");
    if (!media || !title) continue;
    const ids = new Set();
    // Walk only components rendering this individual tile, stopping before the parent list.
    const key = Object.keys(media).find(k => k.startsWith("__reactFiber$"));
    for (let f = media[key]; f; f = f.return) {
      if (f.stateNode?.nodeType === 1 && !tile.contains(f.stateNode)) break;
      const props = f.memoizedProps;
      for (const item of [props, props?.aweme, props?.awemeInfo, props?.data, props?.item, props?.videoInfo]) {
        const id = workId(item?.awemeId) || workId(item?.aweme_id);
        if (id) ids.add(id);
      }
      const id = workId(f.key);
      if (id) ids.add(id);
    }
    if (ids.size !== 1) continue;
    const labels = [...media.querySelectorAll("div,span")].filter(el => !el.children.length)
      .map(el => clean(el.textContent));
    const route = labels.includes("文章") ? "article" : labels.includes("图文") ||
      media.querySelector('[id^="ic_home_note_svg"]') ? "note" :
      labels.some(v => /^(?:\d{1,2}:)?\d{1,3}:[0-5]\d$/.test(v)) ? "video" : "";
    if (route) rows.push({ group: tile.closest(".search-result-card").parentElement.id,
      title, cover: img?.currentSrc || img?.src || "", id: [...ids][0], route });
  }
  return rows;
})();
