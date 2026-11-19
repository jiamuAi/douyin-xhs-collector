import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
const load = (file, name) => new Function("crypto", fs.readFileSync(new URL("../插件/" + file, import.meta.url), "utf8") + "\nreturn " + name)(webcrypto);
const exporter = load("export.js", "NoteExport");
const api = load("feishu.js", "FeishuExport");
const payload = (count = 3) => ({ notes: Array.from({ length: count }, (_,i) => ({ id: "note" + i, title: "笔记 " + i,
  likeCount: i, pinned: false, publishedAt: "2026-11-14T03:00:00Z", saveCount: "", description: null,
  noteUrl: "https://www.xiaohongshu.com/explore/note" + i, tags: ["中文", "测试"] })),
  authors: [{ id: "author1", name: "作者", notesInExport: count, fansExact: 0 }] });

class Remote {
  constructor() { this.tables = new Map(); this.batches = new Map(); this.calls = []; this.apps = 0; this.committedFailure = false; }
  async list(path, query = {}) {
    const out = [];
    let page = "";
    do {
      const data = await this.request("GET", path, undefined, { ...query, page_token: page });
      out.push(...data.items); page = data.has_more ? data.page_token : "";
    } while (page);
    return out;
  }
  async request(method, path, body, query = {}) {
    this.calls.push({ method, path, body, query });
    if (method === "POST" && path === "/bitable/v1/apps") {
      this.apps++;
      this.tables.set("tblDefault", { name: "数据表", fields: [], rows: this.defaultRows || [] });
      if (this.failCreate) throw new Error("network lost");
      return { app: { app_token: "base123", url: "https://example.feishu.cn/base/base123", default_table_id: "tblDefault" } };
    }
    const id = path.match(/\/tables\/([^/]+)/)?.[1];
    const table = this.tables.get(id);
    if (path.endsWith("/tables") && method === "GET") return { items: [...this.tables].map(([table_id,t]) => ({ table_id, name: t.name })) };
    if (path.endsWith("/tables") && method === "POST") {
      const id = "tbl" + (this.tables.size + 1);
      this.tables.set(id, { name: body.table.name, fields: body.table.fields, rows: [] }); return { table_id: id };
    }
    assert(table, "unknown table " + id);
    if (method === "DELETE") { this.tables.delete(id); return {}; }
    if (path.endsWith("/fields") && method === "GET") return { items: table.fields };
    if (path.endsWith("/fields") && method === "POST") { table.fields.push(body); return {}; }
    if (path.endsWith("/records") && method === "GET") {
      const offset = Number(query.page_token || 0), size = Number(query.page_size || 100);
      const items = table.rows.slice(offset, offset + size);
      return { items, has_more: offset + size < table.rows.length, page_token: String(offset + size) };
    }
    if (path.endsWith("/records/batch_create") && method === "POST") {
      assert(query.client_token, "writes must be idempotent");
      if (this.batches.has(query.client_token)) {
        const prev = this.batches.get(query.client_token); assert.deepEqual(body, prev.body); return prev.result;
      }
      const rows = body.records.map((r,i) => ({ ...r, record_id: "rec" + (table.rows.length + i) }));
      table.rows.push(...rows);
      const result = { records: rows };
      this.batches.set(query.client_token, { body: structuredClone(body), result });
      if (this.committedFailure) { this.committedFailure = false; throw new Error("response lost after commit"); }
      return result;
    }
    throw new Error("unexpected " + method + " " + path);
  }
}
const options = () => ({ save: async () => {} });

test("Feishu creates a two-option note type and an empty transcript column immediately after the note URL", async () => {
  const data = payload(3); data.notes[0].type = "视频"; data.notes[1].type = "图文";
  data.notes[2].type = "unknown"; data.notes[0].reservedVideoTranscript = "must not be uploaded";
  const source = exporter.tables(data), original = structuredClone(source), remote = new Remote(), state = { mode: "new", name: "主页测试" };
  await api.run(remote, source, state, options());
  assert.deepEqual(source, original, "Excel/shared schema stays unchanged");
  const notes = remote.tables.get(state.tables.notes.id), fields = notes.fields;
  const type = fields.find(field => field.field_name === "笔记类型");
  assert.equal(type.type, 3); assert.deepEqual(type.property.options, [{ name: "视频" }, { name: "图文" }]);
  const linkIndex = fields.findIndex(field => field.field_name === "笔记链接");
  assert.deepEqual(fields[linkIndex + 1], { field_name: "视频文案提取", type: 1 });
  assert.equal(notes.rows[0].fields["笔记类型"], "视频"); assert.equal(notes.rows[1].fields["笔记类型"], "图文");
  assert(!("笔记类型" in notes.rows[2].fields), "unknown types must not become a third option");
  assert(notes.rows.every(row => !("视频文案提取" in row.fields)));
  assert(!remote.tables.get(state.tables.authors.id).fields.some(field => field.field_name === "视频文案提取"));
});

test("a video-only profile still gets both options; continuing an existing table preserves manually filled transcripts", async () => {
  const data = payload(1); data.notes[0].type = "视频";
  const tables = api.tablesForExport(exporter.tables(data));
  assert.deepEqual(api.tablesForExport(tables), tables, "schema preparation is idempotent");
  assert.deepEqual(api.fieldSpec(tables[0].columns.find(c => c.key === "type")).property.options.map(o => o.name), ["视频", "图文"]);
  const remote = new Remote();
  remote.tables.set("tblExisting", { name: "笔记", fields: tables[0].columns.map(api.fieldSpec), rows: [
    { record_id: "recOld", fields: { "笔记 ID": "note0", "笔记类型": "视频", "视频文案提取": "用户填写的文案" } }
  ] });
  await api.run(remote, exporter.tables(data), { mode: "existing", targetUrl: "https://example.feishu.cn/base/base123?table=tblExisting" }, options());
  assert.equal(remote.tables.get("tblExisting").rows[0].fields["视频文案提取"], "用户填写的文案");
  assert.equal(remote.tables.get("tblExisting").rows.length, 1);
});

test("profile export keeps only sortable likes, turns pin evidence into one choice, and moves the date after precision", async () => {
  const data = payload(5);
  const evidence = [
    { pinned: true, badges: [], referenceCount: 0, precision: "精确值" },
    { pinned: null, badges: ["置顶", "其他标签"], referenceCount: 11000, precision: "近似值" },
    { pinned: false, badges: ["其他标签"], referenceCount: 100000, precision: "下限值" },
    { pinned: null, badges: [], referenceCount: null, precision: "" },
    { pinned: null, badges: "置顶\n其他标签", referenceCount: 7, precision: "精确值" }
  ];
  data.notes.forEach((note, index) => Object.assign(note, evidence[index], { likeDisplay: String(index), type: "视频" }));
  const source = exporter.tables(data), original = structuredClone(source), remote = new Remote(), state = { mode: "new", name: "主页精简" };
  await api.run(remote, source, state, options());
  assert.deepEqual(source, original, "raw source and Excel schema must not change");
  const notes = remote.tables.get(state.tables.notes.id), names = notes.fields.map(field => field.field_name);
  for (const removed of ["点赞显示", "精确点赞数", "是否置顶"]) {
    assert(!names.includes(removed)); assert(notes.rows.every(row => !(removed in row.fields)));
  }
  assert.equal(names[names.indexOf("数值口径") + 1], "发布时间（北京时间）");
  assert.equal(names[names.indexOf("笔记链接") + 1], "视频文案提取");
  assert.deepEqual(notes.fields.find(field => field.field_name === "卡片标签"),
    { field_name: "卡片标签", type: 3, property: { options: [{ name: "置顶" }] } });
  assert.deepEqual(notes.rows.map(row => row.fields["卡片标签"]), ["置顶", "置顶", undefined, undefined, "置顶"]);
  assert.deepEqual(notes.rows.map(row => row.fields["点赞排序值"]), [0, 11000, 100000, undefined, 7]);
  const prepared = api.tablesForExport(source);
  assert.deepEqual(api.tablesForExport(prepared), prepared);
});

test("discovery export omits unavailable date and pin columns while always reserving transcript space", async () => {
  const data = payload(2);
  for (const note of data.notes) {
    delete note.publishedAt; delete note.pinned;
    note.badges = ["其他标签"]; note.referenceCount = 0; note.precision = "精确值";
  }
  const remote = new Remote(), state = { mode: "new", name: "发现页精简" };
  await api.run(remote, exporter.tables(data), state, options());
  const notes = remote.tables.get(state.tables.notes.id), names = notes.fields.map(field => field.field_name);
  for (const absent of ["点赞显示", "精确点赞数", "是否置顶", "发布时间（北京时间）", "卡片标签"]) assert(!names.includes(absent));
  assert.equal(names[names.indexOf("笔记链接") + 1], "视频文案提取");
  assert(notes.rows.every(row => row.fields["点赞排序值"] === 0 && !("视频文案提取" in row.fields)));
});

test("shared schema preserves zero/false, empty columns are omitted, typed values and links remain exact", () => {
  const [notes, authors] = exporter.tables(payload());
  assert(!notes.columns.some(c => ["收藏数", "笔记正文或摘要", "分享数"].includes(c.name)));
  const row = api.rowsFor(notes)[0].fields;
  assert.equal(row["精确点赞数"], 0); assert.equal(row["是否置顶"], false);
  assert.equal(row["发布时间（北京时间）"], Date.parse("2026-11-14T03:00:00Z"));
  assert.equal(row["笔记链接"].link, payload().notes[0].noteUrl);
  assert.equal(row["话题"], "中文\n测试"); assert.equal(api.rowsFor(authors)[0].fields["精确粉丝数"], 0);
  assert.throws(() => api.rowsFor({ ...notes, records: [{ title: "missing id" }] }), /ID/);
});

test("new Base, two populated tables, 100-row batches; stop and resume do not duplicate committed rows", async () => {
  const remote = new Remote(), tables = exporter.tables(payload(205));
  let state = { mode: "new", name: "测试" }, stop = false, saved;
  const opts = { save: async s => { saved = structuredClone(s); if (s.tables.notes?.added === 100) stop = true; }, stopped: () => stop };
  await assert.rejects(api.run(remote, tables, state, opts), api.Stopped);
  assert.equal(state.tables.notes.added, 100); assert.equal(state.complete, undefined);
  state = saved;
  await api.run(remote, tables, state, options());
  assert.equal(remote.apps, 1); assert.equal(state.tables.notes.added, 205); assert(state.complete);
  assert.deepEqual([...remote.tables.values()].map(t => t.name), ["笔记", "博主"]);
  assert.equal(remote.tables.get(state.tables.notes.id).rows.length, 205);
});

test("lost batch response is replayed with same body and token, even across page reload", async () => {
  const remote = new Remote(); remote.committedFailure = true;
  const tables = exporter.tables(payload(102)); let state = { mode: "new", name: "测试" }, saved;
  await assert.rejects(api.run(remote, tables, state, { save: async s => { saved = structuredClone(s); } }), /response lost/);
  assert(saved.tables.notes.pending); state = saved;
  await api.run(remote, tables, state, options());
  assert.equal(remote.tables.get(state.tables.notes.id).rows.length, 102);
  assert.equal(state.tables.notes.added, 102); assert.equal(remote.apps, 1);
});

test("only the new Base default table is cleaned up; blank placeholders may be removed but zero, false and later-page values remain", async () => {
  for (const preserved of [undefined, 0, false, "用户内容"]) {
    const remote = new Remote();
    remote.defaultRows = Array.from({ length: 101 }, (_,i) => ({ record_id: "blank" + i, fields: {} }));
    if (preserved !== undefined) remote.defaultRows[100].fields = { "用户字段": preserved };
    await api.run(remote, exporter.tables(payload(1)), { mode: "new", name: "测试" }, options());
    assert.equal(remote.tables.has("tblDefault"), preserved !== undefined);
  }
});

test("existing target skips IDs, adds only needed fields, preserves unrelated content, rejects incompatible fields", async () => {
  const remote = new Remote(), tables = exporter.tables(payload(3));
  remote.tables.set("tblExisting", { name: "我的资料", fields: tables[0].columns.map(api.fieldSpec),
    rows: [{ record_id: "recOld", fields: { "笔记 ID": "note0", "笔记标题": "用户手动编辑" } }] });
  const state = { mode: "existing", targetUrl: "https://example.feishu.cn/base/base123?table=tblExisting", name: "unused" };
  await api.run(remote, tables, state, options());
  assert.equal(remote.apps, 0); assert.equal(state.tables.notes.added, 2); assert.equal(state.tables.notes.skipped, 1);
  assert.equal(remote.tables.get("tblExisting").rows[0].fields["笔记标题"], "用户手动编辑");
  remote.tables.get("tblExisting").fields.find(f => f.field_name === "笔记 ID").type = 2;
  await assert.rejects(api.run(remote, tables, { mode: "existing", targetUrl: state.targetUrl }, options()), /类型不匹配/);
});

test("unacknowledged Base creation is not blindly repeated", async () => {
  const remote = new Remote(); remote.failCreate = true;
  const state = { mode: "new", name: "测试" };
  await assert.rejects(api.run(remote, exporter.tables(payload()), state, options()), /network lost/);
  await assert.rejects(api.run(remote, exporter.tables(payload()), state, options()), /查找该表格/);
  assert.equal(remote.apps, 1);
});

test("a definitive permission rejection allows a fresh attempt after reconnecting", async () => {
  const state = { mode: "new", name: "测试" };
  const client = new api.Client(async () => "test", async () => Response.json({ code: 99991672 }, { status: 403 }));
  await assert.rejects(api.run(client, exporter.tables(payload()), state, options()), /权限不足/);
  assert.equal(state.creatingApp, false);
  const remote = new Remote();
  await api.run(remote, exporter.tables(payload()), state, options());
  assert.equal(remote.apps, 1); assert(state.complete);
});

test("stopping an existing-table ID scan stops before fetching the next page", async () => {
  let stop = false, count = 0;
  const client = new api.Client(async () => "test", async () => {
    count++; stop = true; return Response.json({ code: 0, data: { items: [], has_more: true, page_token: "next" } });
  });
  await assert.rejects(client.list("/bitable/v1/apps/app/tables/tbl/records", {}, () => stop), api.Stopped);
  assert.equal(count, 1);
});

test("target URL parser rejects foreign hosts, credentials, wiki and malformed table IDs", () => {
  for (const url of ["http://x.feishu.cn/base/abc", "https://feishu.cn.evil.test/base/abc", "https://u:p@x.feishu.cn/base/abc",
    "https://x.feishu.cn/wiki/abc", "https://x.feishu.cn/base/abc?table=../../foo"]) assert.throws(() => api.targetUrl(url));
  assert.equal(api.targetUrl("https://x.feishu.cn/base/abc?table=tbl123&view=vew123").noteTable, "tbl123");
});

test("HTTP client authenticates only to Feishu, paginates, and does not auto-repeat an ambiguous write", async () => {
  let calls = 0;
  const client = new api.Client(async () => "test-user-token", async (url, init) => {
    calls++; assert.equal(new URL(url).origin, "https://open.feishu.cn"); assert.equal(init.headers.Authorization, "Bearer test-user-token");
    return new Response(JSON.stringify({ code: 0, data: { items: [{ id: calls }], has_more: calls < 2, page_token: "next" } }));
  });
  assert.equal((await client.list("/bitable/v1/apps/app/tables")).length, 2);
  let attempts = 0;
  const failure = new api.Client(async () => "t", async () => { attempts++; throw new Error("network"); });
  await assert.rejects(failure.request("POST", "/bitable/v1/apps", { name: "x" }), /未收到结果/);
  assert.equal(attempts, 1); await assert.rejects(client.request("GET", "https://evil.test"), /不支持/);
});

test("real Feishu empty record response omits items; ambiguous or inconsistent pages are still rejected", async () => {
  const path = "/bitable/v1/apps/app/tables/tbl/records";
  for (const data of [{ has_more: false, total: 0 }, { items: null, has_more: false, total: 0 }]) {
    const client = new api.Client(async () => "test", async () => Response.json({ code: 0, data }));
    assert.equal((await client.list(path)).length, 0);
  }
  for (const data of [{}, { total: 0 }, { has_more: false, total: 1 }, { has_more: true, total: 0 }, { items: {}, has_more: false, total: 0 }]) {
    const client = new api.Client(async () => "test", async () => Response.json({ code: 0, data }));
    await assert.rejects(client.list(path), /缺少数据/);
  }
  let page = 0;
  const client = new api.Client(async () => "test", async () => Response.json({ code: 0, data: page++ === 0
    ? { items: [{ record_id: "one" }], has_more: true, page_token: "next" } : { has_more: false, total: 0 } }));
  await assert.rejects(client.list(path), /缺少数据/);
});

test("Douyin export preserves long IDs, original URLs, type and transcript order; existing Base uses separate tables", async () => {
  const data = { ...payload(2), page: { platform: "douyin", name: "搜索页", keyword: "摄影" },
    capturedAt: "2026-11-18T08:00:00Z" };
  const first = "7700000000000000001", second = "7700000000000000002";
  Object.assign(data.notes[0], { id: first, type: "图文", noteUrl: "https://www.douyin.com/note/" + first + "?from=search" });
  Object.assign(data.notes[1], { id: second, type: "视频", noteUrl: "https://www.douyin.com/video/" + second,
    linkSource: "按卡片作品 ID 生成", publishedDisplay: "2月前" });
  const remote = new Remote();
  remote.tables.set("tblOld", { name: "小红书博主", fields: [], rows: [] });
  const target = { mode: "existing", targetUrl: "https://example.feishu.cn/base/base123" };
  await api.run(remote, exporter.tables(data), target, options());
  await api.run(remote, exporter.tables(data), { ...target, tables: {} }, options());
  const works = [...remote.tables.values()].find(t => t.name === "抖音作品");
  assert(works);
  assert.equal(works.rows.length, 2);
  assert.deepEqual(works.rows.map(r => r.fields["作品 ID"]), [first, second]);
  assert.deepEqual(works.rows.map(r => r.fields["作品类型"]), ["图文", "视频"]);
  assert.equal(works.rows[0].fields["作品链接"].link, data.notes[0].noteUrl);
  assert.equal(works.rows[1].fields["作品链接来源"], "按卡片作品 ID 生成");
  assert.equal(works.fields[works.fields.findIndex(f => f.field_name === "作品链接") + 1].field_name, "视频文案提取");
  assert.deepEqual([...remote.tables.values()].map(t => t.name), ["小红书博主", "抖音作品", "抖音博主"]);
  assert.match(exporter.filename(data, "xlsx"), /^抖音-搜索页-摄影-/);
});

test("Douyin article records retain their article type and original URL in the Feishu work table", () => {
  const data = { ...payload(1), page: { platform: "douyin" } };
  const noteUrl = "https://www.douyin.com/article/9000000000000000104?from=profile";
  Object.assign(data.notes[0], { id: "9000000000000000104", type: "文章", noteUrl });
  const [table] = api.tablesForExport(exporter.tables(data));
  assert.deepEqual(table.columns.find(c => c.key === "type").options, ["视频", "图文", "文章"]);
  const [{ fields }] = api.rowsFor(table);
  assert.equal(fields["作品类型"], "文章");
  assert.equal(fields["作品链接"].link, noteUrl);
});
