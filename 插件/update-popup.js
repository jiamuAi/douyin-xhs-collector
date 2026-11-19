"use strict";
(() => {
  const button = document.getElementById("checkUpdate");
  const status = document.getElementById("updateStatus");
  const help = document.getElementById("updateHelp");
  document.getElementById("pluginVersion").textContent = "版本 " + chrome.runtime.getManifest().version;

  function show(state) {
    button.disabled = !!state?.busy;
    status.textContent = state?.text || "";
    status.classList.toggle("error", !!state?.error);
    help.hidden = !state?.setup;
  }
  let changed = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.collectorUpdate) {
      changed = true;
      show(changes.collectorUpdate.newValue);
    }
  });
  chrome.runtime.sendMessage({ type: "collector-update-status" }).then(state => {
    if (!changed) show(state);
  }).catch(() => {});
  button.addEventListener("click", async () => {
    if (busy) { show({ text: "正在处理当前页面，请稍后再点检查。" }); return; }
    changed = true;
    show({ busy: true, text: "正在检查 GitHub 版本…" });
    try { await chrome.runtime.sendMessage({ type: "collector-update-start" }); }
    catch { show({ text: "请重新打开插件，查看当前版本。" }); }
  });
})();
