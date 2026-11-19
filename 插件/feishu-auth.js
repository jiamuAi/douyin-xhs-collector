"use strict";

// Official device flow: larksuite/cli. App presets/addons: larksuite/node-sdk,
// scene/registration. See the corresponding licenses in vendor/.
// Each installation obtains its own app credentials. No publisher app or server is used.
function createFeishuAuth(options = {}) {
  const accounts = "https://accounts.feishu.cn", scope = "bitable:app offline_access";
  const appKey = "feishu-direct-app", userKey = "feishu-direct-user", pendingKey = "feishu-direct-pending";
  const fetcher = options.fetcher || globalThis.fetch.bind(globalThis);
  const local = options.local || chrome.storage.local, session = options.session || chrome.storage.session;
  const locks = options.locks || navigator.locks, now = options.now || Date.now;
  const sleep = options.sleep || ((ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  }));
  const ready = Promise.all([local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }), session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })]);
  class Cancelled extends Error { constructor() { super("已取消飞书连接。"); this.name = "Cancelled"; } }
  const check = signal => { if (signal?.aborted) throw new Cancelled(); };
  const read = async (store, key) => (await store.get(key))[key];
  const positive = (v, fallback) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback;
  function failure(code, status) {
    const messages = {
      access_denied: "你已取消授权，或所在组织暂不允许使用该应用。",
      expired_token: "二维码已过期，请重新点击连接飞书。",
      invalid_grant: "授权已过期或失效，请重新连接飞书。",
      invalid_client: "飞书应用信息已失效，请清除本机连接后重新连接。",
      invalid_scope: "该应用尚未开通多维表格权限。请展开“高级设置”，点击“扫码补充应用权限”后重试。",
      unauthorized_client: "当前飞书应用不支持此授权方式，请重新扫码配置应用。"
    };
    const label = status ? "HTTP " + status : /^[a-z0-9_]{1,60}$/i.test(code || "") ? code : "";
    const error = new Error(messages[code] || "飞书连接未成功" + (label ? "（" + label + "）" : "") + "，请稍后重试。");
    error.code = code; return error;
  }
  async function post(path, body, { signal, basic, json = false } = {}) {
    check(signal);
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 25000);
    try {
      const response = await fetcher(accounts + path, { method: "POST", credentials: "omit", redirect: "error",
        headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded", ...(basic ? { Authorization: "Basic " + btoa(basic) } : {}) },
        body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(), signal: controller.signal });
      const data = await response.json(); check(signal);
      if (response.status >= 500 || response.status === 429) { const e = failure("temporary", response.status); e.transient = true; throw e; }
      if (!response.ok && !data.error) throw failure("http", response.status);
      return data;
    } catch (error) {
      check(signal);
      if (error instanceof TypeError || error.name === "AbortError" || error.name === "SyntaxError") {
        const e = new Error("暂时无法连接飞书，请检查网络后重试。"); e.transient = true; throw e;
      }
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  function verificationUrl(raw) {
    let url; try { url = new URL(raw); } catch { throw new Error("飞书返回的确认链接无效。"); }
    if (url.protocol !== "https:" || !["open.feishu.cn", "accounts.feishu.cn"].includes(url.hostname) || url.username || url.password || url.port) {
      throw new Error("飞书返回了不支持的确认链接，已停止连接。");
    }
    return url.href;
  }
  async function registrationUrl(data, appId) {
    const url = new URL(verificationUrl(data.verification_uri_complete ||
      (data.user_code ? "https://open.feishu.cn/page/cli?user_code=" + encodeURIComponent(data.user_code) : data.verification_uri)));
    // These public options are documented by the official SDK. Omit createOnly
    // so the Feishu page retains its existing-app selection entry.
    url.searchParams.set("from", "sdk");
    url.searchParams.set("tp", "sdk");
    url.searchParams.set("source", "xhs-page-collector");
    url.searchParams.set("name", "{user}的内容采集夹");
    url.searchParams.set("desc", "将本机采集的小红书笔记或抖音作品，以你的账号导出到飞书多维表格。");
    const addons = { preset: false, scopes: { user: ["bitable:app"] } };
    const compressed = await new Response(new Blob([JSON.stringify(addons)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    const encoded = btoa(String.fromCharCode(...new Uint8Array(compressed))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    url.searchParams.set("addons", encoded);
    if (appId) url.searchParams.set("clientID", appId);
    return url.href;
  }
  async function pendingFrom(data, phase, appId) {
    if (data.error || data.code) throw failure(data.error || String(data.code));
    if (!data.device_code) throw new Error("飞书未返回有效授权码，请重新连接。");
    const raw = phase === "registration" ? await registrationUrl(data, appId) : data.verification_uri_complete || data.verification_uri;
    const expires = positive(data.expire_in || data.expires_in, phase === "registration" ? 600 : 240);
    const interval = Math.max(1, positive(data.interval, 5));
    return { phase, appId, deviceCode: data.device_code, userCode: data.user_code || "", url: verificationUrl(raw),
      expiresAt: now() + expires * 1000, interval, nextPollAt: now() + interval * 1000 };
  }
  async function poll(pending, app, { signal, onStep }) {
    check(signal);
    await onStep?.({ phase: pending.phase, url: pending.url, userCode: pending.userCode, expiresAt: pending.expiresAt });
    while (now() < pending.expiresAt) {
      check(signal);
      await sleep(Math.min(Math.max(0, pending.nextPollAt - now()), pending.expiresAt - now()), signal);
      if (now() >= pending.expiresAt) break;
      let data;
      try {
        data = pending.phase === "registration"
          ? await post("/oauth/v1/app/registration", { action: "poll", device_code: pending.deviceCode }, { signal })
          : await post("/oauth/v3/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: pending.deviceCode,
            client_id: app.clientId, client_secret: app.clientSecret }, { signal });
      } catch (error) {
        if (!error.transient) throw error;
        pending.interval += 5; data = { error: "authorization_pending" };
      }
      check(signal);
      if (data.user_info?.tenant_brand && data.user_info.tenant_brand !== "feishu") throw new Error("此版本支持中国版飞书账号，暂不支持 Lark 国际版。");
      if (data.error === "slow_down") pending.interval += 5;
      else if (data.error && data.error !== "authorization_pending") throw failure(data.error);
      else if (data.code && !data.error) throw failure(String(data.code));
      else if (!data.error && (pending.phase === "registration" ? data.client_id && data.client_secret : data.access_token)) return data;
      pending.nextPollAt = now() + pending.interval * 1000;
      await session.set({ [pendingKey]: pending });
    }
    throw failure("expired_token");
  }
  function tokenFields(data, previous = {}) {
    if (data.error || data.code) throw failure(data.error || String(data.code));
    if (!data.access_token) throw new Error("飞书未返回登录凭证，请重新连接。");
    if (data.token_type && data.token_type.toLowerCase() !== "bearer") throw new Error("此飞书组织要求尚未支持的凭证类型，无法完成连接。");
    if (data.scope && !data.scope.split(/\s+/).includes("bitable:app")) throw new Error("尚未授予多维表格权限，请重新连接并完成授权。");
    const refreshToken = data.refresh_token || previous.refreshToken || "";
    return { accessToken: data.access_token, expiresAt: now() + positive(data.expires_in, 7200) * 1000,
      refreshToken, refreshExpiresAt: data.refresh_token_expires_in != null
        ? now() + Math.max(0, Number(data.refresh_token_expires_in) || 0) * 1000
        : previous.refreshExpiresAt || now() + (refreshToken ? 604800000 : 0) };
  }
  async function info() {
    await ready;
    const app = await read(local, appKey), user = await read(local, userKey);
    const valid = !!app && user?.clientId === app.clientId && !!user.accountId;
    return { connected: valid && (now() < user.expiresAt || !!user.refreshToken && now() < user.refreshExpiresAt),
      configured: !!app, accountId: valid ? user.accountId : undefined, userName: valid ? user.userName : "" };
  }
  async function exclusive(fn) {
    await ready;
    return locks.request("feishu-export", { ifAvailable: true }, async exportLock => {
      if (!exportLock) throw new Error("正在导出，请先停止导出后再更改飞书连接。");
      return locks.request("feishu-auth", { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("另一个窗口正在连接飞书，请先完成或取消该窗口中的连接。");
        return fn();
      });
    });
  }
  async function connect({ signal, onStep, manualApp, configureApp = false } = {}) {
    return exclusive(async () => {
      let app = await read(local, appKey), pending = await read(session, pendingKey);
      try {
        if (manualApp) {
          const clientId = manualApp.clientId.trim(), clientSecret = manualApp.clientSecret.trim();
          if (!/^cli_[a-zA-Z0-9]+$/.test(clientId) || !/^[\x21-\x7e]{8,256}$/.test(clientSecret)) throw new Error("请填写有效的 App ID 和 App Secret。");
          app = { clientId, clientSecret }; pending = null;
          await local.set({ [appKey]: app }); await local.remove(userKey); await session.remove(pendingKey);
        }
        if (pending?.expiresAt <= now() || pending?.phase === "authorization" && pending.appId !== app?.clientId) pending = null;
        if (!app || configureApp || pending?.phase === "registration") {
          if (pending?.phase !== "registration" || pending.appId !== app?.clientId) pending = await pendingFrom(await post("/oauth/v1/app/registration", {
            action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id tenant_brand"
          }, { signal }), "registration", app?.clientId);
          check(signal);
          await session.set({ [pendingKey]: pending });
          const registration = await poll(pending, null, { signal, onStep });
          app = { clientId: registration.client_id, clientSecret: registration.client_secret };
          await local.set({ [appKey]: app }); await local.remove(userKey); await session.remove(pendingKey); pending = null;
        }
        if (pending?.phase !== "authorization") pending = await pendingFrom(await post("/oauth/v1/device_authorization", {
          client_id: app.clientId, scope
        }, { signal, basic: app.clientId + ":" + app.clientSecret }), "authorization", app.clientId);
        await session.set({ [pendingKey]: pending });
        const data = await poll(pending, app, { signal, onStep });
        await session.remove(pendingKey);
        const fields = tokenFields(data);
        check(signal);
        const controller = new AbortController(), abort = () => controller.abort();
        const timer = setTimeout(abort, 25000);
        signal?.addEventListener("abort", abort, { once: true });
        let response, result;
        try {
          response = await fetcher("https://open.feishu.cn/open-apis/authen/v1/user_info", { credentials: "omit", redirect: "error",
            headers: { Authorization: "Bearer " + fields.accessToken }, signal: controller.signal });
          result = await response.json();
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
        check(signal);
        if (!response.ok || result.code !== 0 || !result.data?.open_id) throw new Error("无法核实飞书账号，请重新连接。");
        await local.set({ [userKey]: { ...fields, clientId: app.clientId, accountId: app.clientId + ":" + result.data.open_id,
          userName: result.data.name || "飞书用户" } });
        return info();
      } catch (error) {
        await session.remove(pendingKey);
        check(signal); throw error;
      }
    });
  }
  async function token(accountId) {
    await ready;
    return locks.request("feishu-token", async () => {
      const app = await read(local, appKey), user = await read(local, userKey);
      if (!app || !user || app.clientId !== user.clientId) throw new Error("请先连接飞书账号。");
      if (accountId && user.accountId !== accountId) throw new Error("飞书账号已切换，请重新连接本次导出使用的账号后继续。");
      if (now() < user.expiresAt - 60000) return user.accessToken;
      if (!user.refreshToken || now() >= user.refreshExpiresAt) throw failure("invalid_grant");
      const data = await post("/oauth/v3/token", { grant_type: "refresh_token", client_id: app.clientId,
        client_secret: app.clientSecret, refresh_token: user.refreshToken }, { json: true });
      const fields = tokenFields(data, user);
      const current = await read(local, userKey);
      if (current?.accessToken !== user.accessToken) throw new Error("飞书连接已更改，请重新开始导出。");
      await local.set({ [userKey]: { ...user, ...fields } });
      return fields.accessToken;
    });
  }
  async function disconnect() {
    return exclusive(() => locks.request("feishu-token", async () => {
      await local.remove([appKey, userKey, "feishuAuthServer"]);
      await session.remove([pendingKey, "feishu-connection"]);
    }));
  }
  return { connect, info, token, disconnect, Cancelled };
}
const FeishuAuth = createFeishuAuth();
