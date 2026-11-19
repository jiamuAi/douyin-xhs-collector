"use strict";
const ui = Object.fromEntries(["summary", "loadError", "accountStep", "targetStep", "exportStep", "connectHelp", "authMessage", "connection", "connect", "reconnect", "disconnect", "cancelAuth", "authPanel", "authHeading", "authHint", "authLink", "authQr", "authCode", "authExpiry", "manual", "configureApp", "appId", "appSecret", "manualConnect", "name",
  "newTable", "existing", "target", "newFields", "existingFields", "nameHint", "readyHint", "status", "progress", "counts", "start", "stop", "open", "recover", "recoverUrl", "recoverButton"].map(id => [id, document.getElementById(id)]));
const jobId = new URLSearchParams(location.search).get("job");
const storageKey = "feishu-job-" + jobId;
let job, tables, running = false, stopping = false, connected = false, authorizing = false, authController, authTimer;
let authStep, authTabId, authTabRequested = false, openingAuthTab = Promise.resolve();
const setStatus = (text, error = false) => { ui.status.textContent = text; ui.status.classList.toggle("error", error); ui.readyHint.hidden = true; };
function authMessage(text, error = false) {
  ui.authMessage.textContent = text;
  ui.authMessage.hidden = !text;
  ui.authMessage.classList.toggle("error", error);
}
function controls() {
  const locked = running || !!job?.state?.appToken || !!job?.state?.creatingApp;
  const complete = !!job?.state?.complete;
  const existing = ui.existing.checked;
  const targetReady = !!(existing ? ui.target.value.trim() : ui.name.value.trim());
  ui.newFields.hidden = existing;
  ui.existingFields.hidden = !existing;
  ui.newTable.disabled = locked;
  ui.name.disabled = locked || existing;
  ui.nameHint.hidden = locked;
  ui.existing.disabled = locked;
  ui.target.disabled = locked || !ui.existing.checked;
  ui.reconnect.disabled = ui.connect.disabled = ui.disconnect.disabled = ui.configureApp.disabled = ui.manualConnect.disabled = ui.appId.disabled = ui.appSecret.disabled = running || authorizing;
  ui.cancelAuth.hidden = !authorizing;
  ui.connect.hidden = connected || authorizing;
  ui.reconnect.hidden = !connected;
  ui.connectHelp.hidden = connected || authorizing;
  ui.start.hidden = complete || running;
  ui.start.disabled = running || authorizing || !connected || !tables || complete || !targetReady;
  ui.accountStep.classList.toggle("done", connected && !authorizing);
  ui.accountStep.classList.toggle("current", !!tables && (!connected || authorizing) && !complete);
  ui.targetStep.classList.toggle("current", connected && !authorizing && !targetReady && !complete);
  ui.exportStep.classList.toggle("current", connected && !authorizing && targetReady && !complete);
  ui.exportStep.classList.toggle("done", complete);
  ui.open.classList.toggle("primary", complete);
  ui.progress.hidden = !running && !job?.state;
  ui.readyHint.hidden = !!ui.loadError.textContent || complete || !!ui.status.textContent;
  ui.readyHint.textContent = running ? "正在导出，请保留此页面。" : !connected || authorizing ? "请先完成第 1 步。" :
    !targetReady ? (existing ? "请在第 2 步粘贴表格链接。" : "请在第 2 步填写表格名称。") : "";
  if (!ui.readyHint.textContent) ui.readyHint.hidden = true;
  ui.stop.hidden = !running; ui.stop.disabled = stopping;
  ui.recoverButton.disabled = running;
  ui.start.textContent = job?.state ? "继续导出" : ui.existing.checked ? "导出到已有表格" : "新建表格并导出";
}
function showProgress(message, state) {
  setStatus(message);
  const all = tables?.reduce((sum,t) => sum + t.records.length, 0) || 1;
  const entries = Object.entries(state.tables || {});
  const count = entries.reduce((sum,[,t]) => sum + (t.added || 0) + (t.skipped || 0), 0);
  ui.progress.max = all; ui.progress.value = Math.min(count, all);
  ui.counts.textContent = entries.map(([key,t]) => (tables.find(table => table.key === key)?.name || key) + "：新增 " + (t.added || 0) + "，跳过已有 " + (t.skipped || 0)).join(" · ");
  if (state.url) {
    try { const target = FeishuExport.targetUrl(state.url); ui.open.href = target.url + (state.tables?.notes?.id ? "?table=" + state.tables.notes.id : ""); ui.open.hidden = false; }
    catch { ui.open.hidden = true; }
  }
  ui.recover.hidden = !state.creatingApp || !!state.appToken;
}
async function authStatus() {
  const info = await FeishuAuth.info(); connected = info.connected;
  ui.connection.textContent = connected ? "已连接" + (info.userName ? " · " + info.userName : "") : "未连接";
  ui.connection.hidden = !connected;
  ui.disconnect.hidden = ui.configureApp.hidden = !info.configured;
  controls();
}
function openAuthPage() {
  // Only reuse a tab created by this page. Never navigate the user's other tabs.
  openingAuthTab = openingAuthTab.catch(() => {}).then(async () => {
    if (!authorizing || authController.signal.aborted || !authStep) return;
    const url = authStep.url;
    if (authTabId != null) {
      try { await chrome.tabs.update(authTabId, { url, active: true }); return; }
      catch { authTabId = undefined; }
    }
    const tab = await chrome.tabs.create({ url, active: true }); authTabId = tab.id;
  });
  return openingAuthTab;
}
ui.authLink.addEventListener("click", event => {
  event.preventDefault();
  authTabRequested = true;
  openAuthPage().catch(() => authMessage("未能打开飞书页面，请扫描二维码继续。", true));
});
async function connect(manualApp, configureApp = false) {
  if (authorizing || running) return;
  authorizing = true; authController = new AbortController(); controls();
  try {
    authMessage("正在连接飞书…");
    await FeishuAuth.connect({ signal: authController.signal, manualApp, configureApp, onStep: async step => {
      authStep = step;
      ui.authPanel.hidden = false;
      authMessage("");
      ui.authHeading.textContent = step.phase === "registration" ? "选择已有应用，或新建应用" : "在飞书中确认多维表格授权";
      ui.authHint.textContent = step.phase === "registration" ? "用飞书扫码，或在电脑打开链接。应用名称和多维表格权限已预填，确认后自动进入下一步。" : "应用已就绪。请确认以你的账号读写多维表格；完成后回到这里即可导出。";
      ui.authLink.href = step.url;
      const qr = qrcode(0, "M"); qr.addData(step.url); qr.make(); ui.authQr.src = qr.createDataURL(5, 12);
      ui.authCode.textContent = step.userCode ? "确认码：" + step.userCode : "";
      clearInterval(authTimer);
      const remaining = () => { ui.authExpiry.textContent = "请在 " + Math.max(0, Math.ceil((step.expiresAt - Date.now()) / 1000)) + " 秒内完成确认。"; };
      remaining(); authTimer = setInterval(remaining, 1000);
      if (authTabRequested) await openAuthPage().catch(() => { authTabId = undefined; });
    } });
    await authStatus(); ui.manual.open = false; authMessage("");
    if (authTabId != null) {
      const currentTab = await chrome.tabs.getCurrent();
      if (currentTab?.id != null) await chrome.tabs.update(currentTab.id, { active: true }).catch(() => {});
    }
  } catch (error) { authMessage(error.message, !(error instanceof FeishuAuth.Cancelled)); }
  finally { authorizing = false; authStep = undefined; clearInterval(authTimer); ui.authPanel.hidden = true; ui.authQr.removeAttribute("src"); ui.authLink.removeAttribute("href"); ui.appSecret.value = ""; await openingAuthTab.catch(() => {}); authTabId = undefined; authTabRequested = false; await authStatus(); controls(); }
}
ui.connect.addEventListener("click", () => connect());
ui.reconnect.addEventListener("click", () => connect());
ui.configureApp.addEventListener("click", () => connect(undefined, true));
ui.manualConnect.addEventListener("click", () => connect({ clientId: ui.appId.value, clientSecret: ui.appSecret.value }));
ui.cancelAuth.addEventListener("click", () => authController?.abort());
ui.disconnect.addEventListener("click", async () => {
  try { await FeishuAuth.disconnect(); await authStatus(); ui.manual.open = false; authMessage("本机连接已清除。"); }
  catch (error) { authMessage(error.message, true); }
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes["feishu-direct-user"] || changes["feishu-direct-app"])) authStatus(); });
for (const mode of [ui.newTable, ui.existing]) mode.addEventListener("change", controls);
for (const field of [ui.name, ui.target]) field.addEventListener("input", controls);
ui.stop.addEventListener("click", () => { stopping = true; controls(); setStatus("正在停止，等待当前批次返回结果…"); });
ui.start.addEventListener("click", async () => {
  if (running || !job || !connected) return;
  running = true; stopping = false; setStatus("正在准备导出，请保留此页面。"); controls();
  try {
    await navigator.locks.request("feishu-export", { ifAvailable: true }, async lock => {
      if (!lock) throw new Error("另一个飞书导出任务正在运行，请等它完成或停止后再试。");
      const current = (await chrome.storage.session.get(storageKey))[storageKey];
      if (!current) throw new Error("本次导出缓存已清除，请重新从采集弹窗打开飞书导出。");
      job = current;
      if (job.state?.complete) { showProgress("本次导出已经完成。", job.state); return; }
      const info = await FeishuAuth.info();
      if (job.state?.accountId && info.accountId !== job.state.accountId) throw new Error("继续导出需要连接创建本次任务的飞书账号。");
      await FeishuAuth.token();
      if (!job.state?.appToken && !job.state?.creatingApp) {
        if (ui.existing.checked) FeishuExport.targetUrl(ui.target.value);
        const name = ui.name.value.trim() || (ui.existing.checked ? NoteExport.filename(job.payload, "").replace(/\.$/, "") : "");
        if (!name) throw new Error("请填写新表格名称。");
        job.state = { mode: ui.existing.checked ? "existing" : "new", targetUrl: ui.target.value.trim(), name, accountId: info.accountId };
      }
      await chrome.storage.session.set({ [storageKey]: job });
      controls();
      await FeishuExport.run(new FeishuExport.Client(() => FeishuAuth.token(job.state.accountId)), tables, job.state, {
        save: async state => { job.state = state; await chrome.storage.session.set({ [storageKey]: job }); },
        progress: showProgress, stopped: () => stopping
      });
      if (job.state.complete && !stopping && !ui.open.hidden) {
        try {
          await chrome.tabs.create({ url: ui.open.href, active: true });
        } catch {
          setStatus("导出完成。请点击“打开飞书表格”查看结果。");
        }
      }
    });
  } catch (error) {
    if (job.state) showProgress(error.message, job.state);
    setStatus(error.message, !(error instanceof FeishuExport.Stopped));
  } finally { running = false; controls(); }
});
ui.recoverButton.addEventListener("click", async () => {
  try {
    const resolved = FeishuExport.targetUrl(ui.recoverUrl.value);
    Object.assign(job.state, resolved, { creatingApp: false });
    await chrome.storage.session.set({ [storageKey]: job });
    showProgress("已指定目标表格，点击“继续导出”。", job.state); controls();
  } catch (error) { setStatus(error.message, true); }
});
window.addEventListener("beforeunload", event => { if (running || authorizing) { event.preventDefault(); event.returnValue = ""; } });
(async () => {
  try {
    if (!/^[a-f0-9-]{36}$/.test(jobId || "")) throw new Error("请从插件的“导出到飞书多维表格”按钮打开本页面。");
    job = (await chrome.storage.session.get(storageKey))[storageKey];
    if (!job?.payload) throw new Error("本次导出缓存已清除，请重新从采集弹窗打开飞书导出。");
    tables = NoteExport.tables(job.payload);
    const payload = job.payload;
    const { item, platform } = NoteExport.labels(payload.page);
    document.getElementById("tableHint").textContent = "将写入" + tables.map(t => "「" + t.name + "」").join("和") + "。全部写完后，会自动打开飞书表格。";
    ui.summary.textContent = [platform, payload.page.name, payload.profile?.name || payload.page.keyword || payload.page.section,
      payload.count + " 条" + item, payload.authors.length + " 位博主"].filter(Boolean).join(" · ");
    ui.name.value = job.state?.name || NoteExport.filename(payload, "").replace(/\.$/, "");
    ui.existing.checked = job.state?.mode === "existing";
    ui.target.value = job.state?.targetUrl || "";
    ui.newTable.checked = !ui.existing.checked;
    await chrome.storage.local.remove("feishuAuthServer");
    await chrome.storage.session.remove("feishu-connection");
    if (job.state) showProgress(job.state.complete ? "导出完成" : "已恢复进度，可以继续导出。", job.state);
    await authStatus();
  } catch (error) { ui.loadError.textContent = error.message; ui.loadError.hidden = false; ui.readyHint.hidden = true; }
})();
