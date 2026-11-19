// Runs in the tab's isolated world so closing the extension popup does not interrupt a collection.
(() => {
  "use strict";
  if (globalThis.xhsPageScroll) return;
  const store = globalThis.xhsPageNotes;
  const MODES = ["down", "up", "fromTop"];
  const INTERVAL = 900;
  const BOTTOM_WAIT = 12000;
  let run = null;
  let manualRun = null;
  let timer, badge, badgeLabel, badgeCount;
  let direction = "down";
  let message = "";

  function updateBadge() {
    if (!badge) return;
    badgeLabel.textContent = message;
    badgeCount.textContent = "已采集 " + store.progress().renderedCount + (globalThis.douyinCollector ? " 条作品" : " 条笔记");
  }
  function removeBadge() {
    badge?.remove();
    badge = badgeLabel = badgeCount = null;
  }
  function mountBadge() {
    if (badge?.isConnected) return;
    badge = document.createElement("div");
    badge.setAttribute("data-xhs-scroll-control", "");
    // Keep site styles and selectors outside the controls.
    badge.style.cssText = "all:initial!important;position:fixed!important;right:18px!important;bottom:22px!important;z-index:2147483647!important;display:block!important";
    const root = badge.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = [
      ".bar{display:flex;align-items:center;gap:16px;padding:11px 12px 11px 15px;border:1px solid #ddd4ce;border-radius:12px;background:#fffaf7;color:#26211f;box-shadow:0 3px 16px #372a2826;font:13px/1.45 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}",
      "strong,small{display:block}strong{font-size:13px}small{font-size:11px;color:#6d645f;font-variant-numeric:tabular-nums}",
      "button{cursor:pointer;background:#a7353b;color:white;border:0;border-radius:7px;font:inherit;font-weight:600;line-height:1.3;padding:7px 13px}button:focus-visible{outline:2px solid #70272a;outline-offset:2px}"
    ].join("\n");
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "内容自动采集");
    const lines = document.createElement("div");
    badgeLabel = document.createElement("strong");
    badgeCount = document.createElement("small");
    lines.append(badgeLabel, badgeCount);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "停止";
    button.setAttribute("aria-label", "停止自动采集");
    button.addEventListener("click", () => { void stop(); });
    bar.append(lines, button);
    root.append(style, bar);
    document.documentElement.append(badge);
    updateBadge();
  }

  function scrollingElement() {
    // On the desktop site the scroll owner can be a div. Follow a card in the active pane to its
    // nearest scrollable ancestor. A short, still-loading list may not overflow yet.
    const lists = document.querySelectorAll(".note-item, [data-note-id], .feeds-container");
    const item = globalThis.douyinCollector?.scrollAnchor() || Array.from(lists).find(el => el.checkVisibility?.() !== false &&
      el.getClientRects().length && !el.closest('[hidden], [aria-hidden="true"], .tab-content-item.static-layout'));
    let candidate = null;
    for (let parent = item?.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent === document.documentElement || !/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY) || !parent.clientHeight) continue;
      candidate ||= parent;
      if (parent.scrollHeight > parent.clientHeight + 2) return parent;
    }
    const doc = document.scrollingElement || document.documentElement;
    return doc.scrollHeight > doc.clientHeight + 2 ? doc : candidate || doc;
  }

  function finish(reason) {
    run = null;
    clearTimeout(timer);
    message = reason;
    removeBadge();
  }
  async function stop() {
    const stopped = run;
    if (!stopped) return;
    // Invalidate the in-flight step before awaiting anything, including the last read.
    finish("已手动停止");
    manualRun = stopped;
    try {
      const last = await store.capture();
      if (manualRun === stopped && last.page.scopeKey === stopped.scopeKey) store.accept(last);
    } catch { /* All completed scans are already kept in the session. */ }
    finally { if (manualRun === stopped) manualRun = null; }
  }
  function schedule(job) {
    if (run === job) timer = setTimeout(() => { void step(job); }, INTERVAL);
  }
  async function step(job) {
    try {
      const batch = await store.capture();
      if (run !== job) return;
      if (batch.page.scopeKey !== job.scopeKey) {
        finish("列表已切换，自动采集已停止");
        return;
      }
      store.accept(batch);
      mountBadge();
      const el = scrollingElement();
      const top = Math.max(0, el.scrollTop);
      const viewport = el.clientHeight || innerHeight;
      const bottom = Math.max(0, el.scrollHeight - viewport);
      const atEnd = job.phase === "up" ? top <= 2 : top >= bottom - 2;
      const count = store.progress().renderedCount;
      if (job.phase === "up" && atEnd) {
        if (direction === "up") { finish("已到顶部"); return; }
        job.phase = "down";
      } else if (job.phase === "down" && atEnd) {
        const now = performance.now();
        if (!job.edge || job.edge.height !== bottom || job.edge.count !== count) job.edge = { height: bottom, count, since: now };
        if (now - job.edge.since >= BOTTOM_WAIT) {
          finish("底部暂未加载更多，已停止");
          return;
        }
        message = "等待页面加载更多";
        updateBadge();
        schedule(job);
        return;
      }
      job.edge = null;
      message = job.phase === "up" ? "正在向上采集" : "正在向下采集";
      updateBadge();
      const distance = Math.max(1, Math.round(viewport * 0.72));
      const next = Math.max(0, Math.min(bottom, top + (job.phase === "up" ? -distance : distance)));
      el.scrollTo({ top: next, behavior: "instant" });
      schedule(job);
    } catch (error) {
      if (run === job) finish(error.message || "页面读取中断，已停止");
    }
  }
  async function scan(reset) {
    // Opening the popup while running is a read-only attachment to that run.
    if (run) return store.result();
    manualRun = null;
    const batch = await store.capture();
    if (!run) {
      if (reset) message = "";
      store.accept(batch, reset);
    }
    return store.result();
  }
  function start(mode, expectedScope) {
    if (!MODES.includes(mode)) throw new Error("请选择滚动方向。");
    if (run) return;
    const scopeKey = store.progress().scopeKey;
    if (!scopeKey || scopeKey !== expectedScope) throw new Error("列表已切换，请重新扫描。");
    manualRun = null;
    direction = mode;
    const phase = mode === "down" ? "down" : "up";
    const job = { scopeKey, phase, edge: null };
    run = job;
    message = phase === "down" ? "正在向下采集" : "正在向上采集";
    mountBadge();
    void step(job);
  }
  function clear() {
    manualRun = null;
    finish("");
  }
  globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, reply) => {
    if (message?.type === "collector-update-scroll" && sender.id === chrome.runtime.id) reply({ active: !!run });
  });
  window.addEventListener("pagehide", clear);
  globalThis.xhsPageScroll = {
    scan, start, stop, clear,
    status: () => ({ active: !!run, direction, message })
  };
})();
