"use strict";
(() => {
  const host = "ai.jiamu.dy_xhs_collector";
  const version = chrome.runtime.getManifest().version;
  const report = state => chrome.storage.session.set({ collectorUpdate: state });
  let running;

  function nativeSession() {
    const port = chrome.runtime.connectNative(host);
    let receive, fail, closed;
    port.onMessage.addListener(message => receive?.(message));
    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message || "";
      closed = Object.assign(new Error(/not found|forbidden|access.*denied|failed to start/i.test(detail)
        ? "请先运行安装包中的「安装采集器」，启用本机更新助手。"
        : "更新助手已断开，请再试一次。"), { setup: /not found|forbidden|access.*denied|failed to start/i.test(detail) });
      fail?.(closed);
    });
    return {
      async send(message) {
        if (closed) throw closed;
        let timer;
        try {
          const result = await new Promise((resolve, reject) => {
            receive = resolve; fail = reject;
            timer = setTimeout(() => reject(new Error("更新请求超时，请检查网络后重试。")), 180000);
            port.postMessage(message);
          });
          if (result?.state === "error") throw new Error(result.message || "更新失败，请重试。");
          if (!result || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(result.version)) throw new Error("更新助手返回的版本信息无效。");
          return result;
        } finally { clearTimeout(timer); receive = fail = undefined; }
      },
      close() { port.disconnect(); }
    };
  }
  async function assertIdle() {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const ids = windows.map(client => new URL(client.url))
      .filter(url => url.origin === self.location.origin && url.pathname === "/feishu.html")
      .map(url => url.searchParams.get("job")).filter(Boolean);
    if (ids.length) {
      const jobs = await chrome.storage.session.get(ids.map(id => "feishu-job-" + id));
      if (ids.some(id => jobs["feishu-job-" + id] && !jobs["feishu-job-" + id].state?.complete))
        throw new Error("有待完成的飞书导出。请先完成导出，或关闭不用的导出页，再点更新。");
    }
    const tabs = await chrome.tabs.query({});
    const replies = await Promise.all(tabs.filter(tab => tab.id != null && !tab.discarded)
      .map(tab => chrome.tabs.sendMessage(tab.id, { type: "collector-update-scroll" }, { frameId: 0 }).catch(() => null)));
    if (replies.some(reply => reply?.active)) throw new Error("有页面正在自动采集。请先停止采集并导出要保留的结果，再点更新。");
  }
  async function whileIdle(action) {
    return navigator.locks.request("collector-install", { ifAvailable: true }, async installLock => {
      if (!installLock) throw new Error("采集器还有操作正在进行，请稍后再点更新。");
      return navigator.locks.request("feishu-export", { ifAvailable: true }, async exportLock => {
        if (!exportLock) throw new Error("飞书正在授权或导出，完成后请再点更新。");
        await assertIdle();
        return action();
      });
    });
  }
  async function reload(target) {
    // A user may have copied a managed folder, including its marker, to another location.
    const manifest = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    if (!manifest.ok || (await manifest.json()).version !== target) {
      throw Object.assign(new Error("新版已写入专用目录。请在 Chrome 加载安装工具显示的「插件」文件夹。"), { setup: true });
    }
    // If Chrome closes the popup during reload, the new version can still display the result.
    try { await chrome.storage.local.set({ collectorUpdatedVersion: target }); } finally { chrome.runtime.reload(); }
  }
  async function update() {
    await report({ busy: true, text: "正在检查 GitHub 版本…" });
    let native;
    try {
      const response = await fetch(chrome.runtime.getURL("update-install.json"), { cache: "no-store" });
      const marker = response.ok ? await response.json() : {};
      native = nativeSession();
      const remote = await native.send({ action: "check", version, installation: marker.installation || "" });
      const label = "v" + remote.version;
      const setup = !marker.installation || !remote.integrated;
      const sourceHint = !marker.installation ? " 当前加载的是源码或解压目录。"
        : remote.integrated ? "" : " 运行一次新版安装包，可将旧更新助手迁入插件。";
      switch (remote.state) {
        case "current": return await report({ setup, text: "已是最新版本 " + label + "。" + sourceHint });
        case "ahead": return await report({ setup, text: "当前试用版 v" + version + "，高于 GitHub 公开版 " + label + "。" + sourceHint });
        case "setup": return await report({ setup: true, text: "发现新版 " + label + "。请先加载安装工具显示的插件目录。" });
        case "reload": return await whileIdle(() => reload(remote.version));
        case "available": break;
        default: throw new Error("更新助手返回了未知状态。");
      }
      await whileIdle(async () => {});
      await report({ busy: true, text: "发现 " + label + "，正在下载并校验…" });
      const ready = await native.send({ action: "prepare" });
      if (ready.state !== "ready" || ready.version !== remote.version) throw new Error("下载版本不一致，请重试。");
      await whileIdle(async () => {
        await report({ busy: true, text: "正在安装 " + label + "，插件即将重新加载…" });
        const done = await native.send({ action: "install" });
        if (done.state !== "installed" || done.version !== remote.version) throw new Error("安装结果未确认，请再点检查。");
        await reload(done.version);
      });
    } catch (error) {
      await report({ error: true, setup: !!error.setup, text: error.message || "检查失败，请再试一次。" });
    } finally { native?.close(); }
  }
  async function status() {
    const { collectorUpdate } = await chrome.storage.session.get("collectorUpdate");
    if (collectorUpdate && (!collectorUpdate.busy || running)) return collectorUpdate;
    const { collectorUpdatedVersion } = await chrome.storage.local.get("collectorUpdatedVersion");
    if (collectorUpdatedVersion === version) return { text: "已更新至 v" + version + "。" };
    return collectorUpdate?.busy ? { text: "上次检查已结束，可以重新检查。" } : {};
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("popup.html")) return;
    if (message?.type === "collector-update-status") { status().then(reply, () => reply({})); return true; }
    if (message?.type !== "collector-update-start") return;
    if (!running) running = update().finally(() => { running = undefined; });
    running.then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  });
})();
