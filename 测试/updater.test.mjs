import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../插件/update-worker.js", import.meta.url), "utf8");
const id = "npnmgnkhnkjhgbccjajcfbbhppkjgpke";
const origin = "chrome-extension://" + id;
const popup = { id, url: origin + "/popup.html" };

function harness({ active = [], installedVersion = "1.6.1", loadedFiles = "1.6.1", closeAt, holdExport = false, checkState = "available", integrated } = {}) {
  const session = {}, local = {}, actions = [];
  const area = data => ({ set: async values => Object.assign(data, values), get: async () => data });
  let listener, replyToPort, disconnected, reloaded = 0, opened = 0;
  const runtime = {
    id, getManifest: () => ({ version: "1.6.0" }), getURL: s => origin + "/" + s,
    onMessage: { addListener(fn) { listener = fn; } }, reload() { reloaded++; },
    connectNative(name) {
      assert.equal(name, "ai.jiamu.dy_xhs_collector"); opened++;
      return {
        onMessage: { addListener(fn) { replyToPort = fn; } },
        onDisconnect: { addListener(fn) { disconnected = fn; } }, disconnect() {},
        postMessage(m) {
          actions.push(m.action);
          queueMicrotask(() => {
            if (m.action === closeAt) { disconnected(); return; }
            const state = { check: checkState, prepare: "ready", install: "installed" }[m.action];
            const version = state === "current" ? "1.6.0" : m.action === "install" ? installedVersion : "1.6.1";
            replyToPort({ state, version, integrated });
          });
        }
      };
    }
  };
  vm.runInNewContext(source, {
    URL, setTimeout, clearTimeout,
    self: { location: { origin }, clients: { matchAll: async () => [] } },
    fetch: async url => ({ ok: true, json: async () => url.endsWith("/manifest.json")
      ? { version: loadedFiles } : { installation: "test-installation" } }),
    chrome: { runtime, storage: { session: area(session), local: area(local) },
      tabs: { query: async () => [{ id: 7 }], sendMessage: async () => ({ active: !!active.shift() }) } },
    navigator: { locks: { request: async (name, _, fn) => fn(name === "feishu-export" && holdExport ? null : {}) } }
  });
  return {
    actions, session, local, get reloaded() { return reloaded; }, get opened() { return opened; },
    request(sender = popup) { return new Promise(resolve => {
      if (!listener({ type: "collector-update-start" }, sender, resolve)) resolve(undefined);
    }); }
  };
}

test("a second click shares the native session and a verified install reloads once", async () => {
  const t = harness(); await Promise.all([t.request(), t.request()]);
  assert.equal(t.opened, 1); assert.deepEqual(t.actions, ["check", "prepare", "install"]);
  assert.equal(t.reloaded, 1); assert.equal(t.local.collectorUpdatedVersion, "1.6.1");
});
test("a collection starting during download prevents activation", async () => {
  const t = harness({ active: [false, true] }); await t.request();
  assert.deepEqual(t.actions, ["check", "prepare"]); assert.equal(t.reloaded, 0);
  assert.match(t.session.collectorUpdate.text, /正在自动采集/);
});
test("an active Feishu operation defers the update before downloading", async () => {
  const t = harness({ holdExport: true }); await t.request();
  assert.deepEqual(t.actions, ["check"]); assert.match(t.session.collectorUpdate.text, /飞书正在授权或导出/);
});
test("an interrupted download or unexpected installed version never triggers reload", async () => {
  for (const settings of [{ closeAt: "prepare" }, { installedVersion: "1.6.2" }]) {
    const t = harness(settings); await t.request();
    assert.equal(t.reloaded, 0); assert.equal(t.session.collectorUpdate.error, true);
  }
});
test("a copied install directory points to the managed folder without reloading the old copy", async () => {
  const t = harness({ loadedFiles: "1.6.0" }); await t.request();
  assert.equal(t.reloaded, 0); assert.equal(t.session.collectorUpdate.setup, true);
});

test("a managed install offers migration only while it still uses the v1.6.0 helper", async () => {
  for (const integrated of [undefined, true]) {
    const t = harness({ checkState: "current", integrated });
    await t.request();
    assert.deepEqual(t.actions, ["check"]);
    assert.equal(t.session.collectorUpdate.setup, !integrated);
    assert.equal(t.session.collectorUpdate.text.includes("迁入插件"), !integrated);
  }
});

test("web content, other extensions and ordinary tabs cannot start a native update", async () => {
  const t = harness();
  for (const sender of [{ id, tab: { id: 2 }, url: "https://www.douyin.com/" }, { ...popup, tab: { id: 3 } }, { ...popup, id: "other" }]) {
    assert.equal(await t.request(sender), undefined);
  }
  assert.equal(t.opened, 0);
});
