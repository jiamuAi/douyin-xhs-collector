"use strict";

const field = id => document.getElementById(id);
const elements = Object.fromEntries(["context", "rescan", "status", "results", "total", "authors",
  "rows", "excel", "json", "feishu", "reset", "automation", "direction", "toggleScroll", "runStatus"].map(id => [id, field(id)]));
let tabId, documentId, snapshot;
let excelLibrary;
let busy = false;
let pollEpoch = 0;
let pollTimer;

function status(message = "", error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}
function toggleBusy(value) {
  busy = value;
  const available = !!snapshot && (snapshot.notes.some(n => n.rendered) || !!snapshot.profile);
  const running = !!snapshot?.scroll.active;
  elements.rescan.disabled = value || !tabId || running;
  elements.reset.disabled = elements.direction.disabled = value || running;
  elements.toggleScroll.disabled = value || !snapshot;
  elements.excel.disabled = elements.json.disabled = elements.feishu.disabled = value || !available;
}
function renderRun() {
  const { active, direction, message } = snapshot.scroll;
  elements.automation.hidden = false;
  if (active) elements.direction.value = direction;
  elements.toggleScroll.textContent = active ? "停止采集" : "开始自动采集";
  elements.toggleScroll.classList.toggle("running", active);
  elements.runStatus.textContent = message || "";
  toggleBusy(busy);
}
function render() {
  const selected = NoteExport.prepare(snapshot);
  const { item, platform } = NoteExport.labels(snapshot.page);
  field("itemCountLabel").textContent = "条已选" + item;
  field("previewHeading").textContent = item + "预览";
  elements.results.hidden = !snapshot.notes.length && !snapshot.profile;
  elements.total.textContent = selected.count;
  elements.authors.textContent = selected.authors.length;
  elements.context.textContent = [platform, snapshot.page.name, snapshot.profile?.name || snapshot.page.keyword || snapshot.page.section].filter(Boolean).join(" · ");
  elements.rows.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const n of selected.notes.slice(0, 30)) {
    const item = document.createElement("li");
    const note = document.createElement("div");
    note.className = "note";
    const title = document.createElement("strong");
    title.textContent = n.title || "（页面没有标题）";
    title.title = title.textContent;
    const subtitle = document.createElement("small");
    subtitle.textContent = [n.authorName, n.type].filter(Boolean).join(" · ");
    const counter = document.createElement("span");
    counter.className = "likes";
    counter.textContent = n.likeDisplay || "—";
    note.append(title, subtitle);
    item.append(note, counter);
    fragment.append(item);
  }
  elements.rows.append(fragment);
  if (!snapshot.notes.length) status("当前列表还没有可采集的" + item + "。页面加载完成后可以重新扫描。");
  else if (snapshot.warnings?.length) status(snapshot.warnings.join("。"));
  else status();
  renderRun();
}
async function pageCall(func, args = []) {
  const [reply] = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, func, args });
  if (!reply?.result) throw new Error("标签页已切换或刷新，请重新打开插件。");
  if (reply.result.error) throw new Error(reply.result.error);
  return reply.result;
}
function cancelPoll() {
  pollEpoch++;
  clearTimeout(pollTimer);
}
function poll() {
  cancelPoll();
  if (!snapshot?.scroll.active) return;
  const epoch = pollEpoch;
  pollTimer = setTimeout(async () => {
    try {
      const data = await pageCall(revision => globalThis.xhsPageNotes.result(revision), [snapshot.revision]);
      if (epoch !== pollEpoch) return;
      if (data.notes) { snapshot = data; render(); }
      else { snapshot.scroll = data.scroll; renderRun(); }
      poll();
    } catch (error) {
      if (epoch !== pollEpoch) return;
      snapshot.scroll = { ...snapshot.scroll, active: false, message: "" };
      renderRun();
      status(error.message, true);
    }
  }, 650);
}
async function scan(reset = false) {
  if (busy) return;
  cancelPoll();
  toggleBusy(true);
  status("正在读取当前页面的卡片…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = tab?.url?.match(/^https:\/\/(?:www\.)?(douyin|xiaohongshu)\.com(?:\/|$)/i)?.[1];
    if (!tab?.id || !host) {
      tabId = null;
      throw new Error("请先打开小红书发现页、博主主页或搜索页，或抖音博主作品、搜索结果页。");
    }
    tabId = tab.id;
    const files = host === "douyin" ? ["douyin.js", "session.js", "scroll.js"] : ["session.js", "scroll.js"];
    const [installed] = await chrome.scripting.executeScript({ target: { tabId }, files });
    documentId = installed.documentId;
    snapshot = await pageCall(async clear => {
      try { return await globalThis.xhsPageScroll.scan(clear); }
      catch (error) { return { error: error.message }; }
    }, [reset]);
    elements.direction.value = snapshot.scroll.direction;
    render();
    poll();
  } catch (err) {
    snapshot = null;
    elements.automation.hidden = true;
    elements.results.hidden = true;
    elements.context.textContent = "当前页面";
    status(err.message, true);
  } finally { toggleBusy(false); }
}
async function toggleScroll() {
  if (busy || !snapshot) return;
  cancelPoll();
  toggleBusy(true);
  try {
    snapshot = await pageCall(async (mode, scope) => {
      try {
        const scroll = globalThis.xhsPageScroll;
        if (mode === "stop") await scroll.stop();
        else scroll.start(mode, scope);
        return globalThis.xhsPageNotes.result();
      } catch (error) { return { error: error.message }; }
    }, [snapshot.scroll.active ? "stop" : elements.direction.value, snapshot.page.scopeKey]);
    render();
  } catch (error) { status(error.message, true); }
  finally { toggleBusy(false); poll(); }
}
function loadExcel() {
  if (globalThis.ExcelJS) return Promise.resolve();
  if (!excelLibrary) excelLibrary = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/exceljs.min.js";
    script.onload = resolve;
    script.onerror = () => { excelLibrary = null; reject(new Error("Excel 导出组件加载失败，请重新打开插件。")); };
    document.head.append(script);
  });
  return excelLibrary;
}
async function download(format) {
  if (busy || !snapshot) return;
  cancelPoll();
  toggleBusy(true);
  status("正在生成文件…");
  try {
    if (snapshot.scroll.active) snapshot = await pageCall(() => globalThis.xhsPageNotes.result());
    const payload = NoteExport.prepare(snapshot);
    let blob;
    if (format === "xlsx") {
      await loadExcel();
      blob = new Blob([await NoteExport.workbook(payload)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    } else blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = NoteExport.filename(payload, format);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    status("已提交下载，共 " + payload.count + " 条" + NoteExport.labels(payload.page).item + "。");
  } catch (err) { status("导出失败。" + err.message, true); }
  finally { toggleBusy(false); poll(); }
}
elements.rescan.addEventListener("click", () => scan());
elements.toggleScroll.addEventListener("click", toggleScroll);
elements.reset.addEventListener("click", () => scan(true));
elements.excel.addEventListener("click", () => download("xlsx"));
elements.json.addEventListener("click", () => download("json"));
elements.feishu.addEventListener("click", async () => {
  if (busy || !snapshot) return;
  cancelPoll(); toggleBusy(true);
  try {
    if (snapshot.scroll.active) snapshot = await pageCall(() => globalThis.xhsPageNotes.result());
    const payload = NoteExport.prepare(snapshot);
    const reply = await chrome.runtime.sendMessage({ type: "feishu-open", payload });
    if (reply?.error) throw new Error(reply.error);
    if (!reply?.ok) throw new Error("飞书导出页面未能打开，请重试。");
    status("已打开飞书导出页面。");
  } catch (error) { status(error.message, true); }
  finally { toggleBusy(false); poll(); }
});
scan();
