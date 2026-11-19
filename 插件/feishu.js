"use strict";

// The collector never receives Feishu credentials. Only the extension export page calls this client.
const FeishuExport = (() => {
  const apiRoot = "https://open.feishu.cn/open-apis";
  const noteTypes = ["视频", "图文"];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  class Stopped extends Error { constructor() { super("已停止，已写入的数据保留。可以继续导出。"); } }
  function targetUrl(input) {
    let url;
    try { url = new URL(input.trim()); } catch { throw new Error("请填写完整的飞书多维表格链接。"); }
    if (url.protocol !== "https:" || !/(^|\.)feishu\.cn$/.test(url.hostname) || url.username || url.password) {
      throw new Error("请使用 https:// 开头的飞书多维表格链接。");
    }
    const token = url.pathname.match(/^\/base\/([a-zA-Z0-9]+)\/?$/)?.[1];
    if (!token) throw new Error("请打开多维表格本身并复制 /base/ 链接；暂不支持知识库或分享记录链接。");
    const table = url.searchParams.get("table") || "";
    if (table && !/^tbl[a-zA-Z0-9]+$/.test(table)) throw new Error("链接中的数据表 ID 不正确。");
    return { appToken: token, noteTable: table, url: url.origin + url.pathname };
  }
  function tablesForExport(tables) {
    return tables.map(table => {
      if (table.key !== "notes") return table;
      const records = table.records.map(record => {
        const badges = Array.isArray(record.badges) ? record.badges : String(record.badges || "").split(/\r?\n/);
        return { ...record, badges: record.pinned === true || badges.some(badge => String(badge).trim() === "置顶") ? "置顶" : "" };
      });
      const hasPinned = records.some(record => record.badges === "置顶");
      const columns = table.columns.filter(column => !["likeDisplay", "likeCount", "pinned", "reservedVideoTranscript"].includes(column.key)
        && (column.key !== "badges" || hasPinned)).map(column => ({ ...column }));
      const typeIndex = columns.findIndex(column => column.key === "type");
      const typeColumn = { key: "type", name: table.name + "类型", type: 3, options: table.platform === "抖音" ? [...noteTypes, "文章"] : [...noteTypes] };
      if (typeIndex >= 0) columns[typeIndex] = typeColumn;
      else columns.splice(Math.min(2, columns.length), 0, typeColumn);
      if (hasPinned) {
        const badgeColumn = { key: "badges", name: "卡片标签", type: 3, options: ["置顶"] };
        const badgeIndex = columns.findIndex(column => column.key === "badges");
        if (badgeIndex >= 0) columns[badgeIndex] = badgeColumn;
        else columns.push(badgeColumn);
      }
      const publishedIndex = columns.findIndex(column => column.key === "publishedAt");
      if (publishedIndex >= 0 && columns.some(column => column.key === "precision")) {
        const [published] = columns.splice(publishedIndex, 1);
        columns.splice(columns.findIndex(column => column.key === "precision") + 1, 0, published);
      }
      const linkIndex = columns.findIndex(column => column.key === "noteUrl");
      columns.splice(linkIndex >= 0 ? linkIndex + 1 : columns.length, 0,
        { key: "reservedVideoTranscript", name: "视频文案提取", type: 1, reserved: true });
      return { ...table, columns, records };
    });
  }
  function fieldSpec(column) {
    const spec = { field_name: column.name, type: column.type };
    if (column.type === 3) spec.property = { options: column.options.map(name => ({ name })) };
    if (column.type === 5) spec.property = { date_formatter: "yyyy/MM/dd HH:mm", auto_fill: false };
    return spec;
  }
  function value(raw, type, column) {
    if (Array.isArray(raw)) raw = raw.join("\n");
    if (raw == null || typeof raw === "string" && !raw.trim()) return undefined;
    if (type === 3) {
      const selected = column.key === "type"
        ? ({ video: "视频", normal: "图文", image: "图文", "视频": "视频", "图文": "图文", "文章": "文章" })[String(raw).trim()]
        : String(raw).trim();
      return column.options.includes(selected) ? selected : undefined;
    }
    if (type === 5) {
      const time = new Date(raw).getTime();
      if (!Number.isFinite(time)) throw new Error("采集数据包含无效日期。");
      return time;
    }
    if (type === 7) return !!raw;
    if (type === 2) {
      if (!Number.isFinite(raw)) throw new Error("采集数据包含无效数字。");
      return raw;
    }
    if (type === 15) {
      if (!/^https?:\/\//i.test(raw)) throw new Error("采集数据包含无效链接。");
      return { text: String(raw), link: String(raw) };
    }
    return String(raw);
  }
  function rowsFor(table) {
    const seen = new Set();
    return table.records.map(record => {
      const fields = Object.fromEntries(table.columns.filter(column => !column.reserved).map(column => [column.name, value(record[column.key], column.type, column)])
        .filter(([,v]) => v !== undefined));
      const id = fields[table.idField];
      if (!id) throw new Error(table.name + "缺少用于去重的 ID，请重新采集后再导出。");
      if (seen.has(id)) return null;
      seen.add(id);
      return { fields };
    }).filter(Boolean);
  }
  function textCell(v) {
    if (Array.isArray(v)) return v.map(item => typeof item === "string" ? item : item.text || "").join("");
    return v == null ? "" : String(v);
  }
  class Client {
    constructor(getToken, fetcher = globalThis.fetch.bind(globalThis)) { this.getToken = getToken; this.fetcher = fetcher; }
    async request(method, path, body, query = {}, safeRetry = method === "GET") {
      if (!path.startsWith("/bitable/v1/")) throw new Error("不支持的飞书接口。");
      const url = new URL(apiRoot + path);
      for (const [key, v] of Object.entries(query)) if (v != null && v !== "") url.searchParams.set(key, v);
      for (let attempt = 0; ; attempt++) {
        const token = await this.getToken();
        let response;
        try {
          response = await this.fetcher(url.href, { method, credentials: "omit", redirect: "error",
            headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=utf-8" },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
        } catch { throw new Error("飞书请求未收到结果。已保留进度，请检查网络后继续；若正在新建表格，请先到飞书确认是否已创建。"); }
        let json;
        try { json = await response.json(); } catch { throw new Error("飞书返回了无法识别的响应，请稍后继续。"); }
        if ((response.status === 429 || [99991400, 1254290, 1254291].includes(Number(json.code))) && safeRetry && attempt < 3) {
          await sleep(Math.min(8000, 1000 * 2 ** attempt)); continue;
        }
        if (!response.ok || Number(json.code) !== 0) {
          const code = Number(json.code) || response.status;
          const failure = message => Object.assign(new Error(message), { definitive: response.status < 500 });
          if ([99991663, 99991668, 99991669, 99991671, 401].includes(code)) {
            throw failure("飞书授权已失效，请重新连接飞书后继续导出。");
          }
          if ([99991672, 99991679, 99991680, 99991681, 91403, 1254302, 403].includes(code)) {
            throw failure("飞书权限不足：请确认已授权多维表格权限，并且当前账号能编辑目标表格。（" + code + "）");
          }
          throw failure("飞书请求失败（" + code + "）：" + String(json.msg || "请检查表格权限和字段设置。").slice(0, 300));
        }
        return json.data || {};
      }
    }
    async list(path, query = {}, stopped = () => false) {
      const items = [], pages = new Set();
      let pageToken = "";
      do {
        if (stopped()) throw new Stopped();
        const data = await this.request("GET", path, undefined, { ...query, page_size: 100, page_token: pageToken });
        if (!Array.isArray(data.items)) {
          // Feishu omits `items` for a newly-created empty table. Accept only an
          // explicitly empty first page; incomplete/contradictory pages still fail.
          if (data.items == null && data.has_more === false && data.total === 0 && !pageToken && !items.length) return [];
          throw new Error("飞书列表响应缺少数据，已停止以免重复写入。");
        }
        items.push(...data.items);
        if (!data.has_more) break;
        if (!data.page_token || pages.has(data.page_token)) throw new Error("飞书分页异常，已停止以免遗漏数据。");
        pages.add(data.page_token); pageToken = data.page_token;
      } while (true);
      return items;
    }
  }
  async function run(client, tables, state, { save, progress = () => {}, stopped = () => false }) {
    const checkpoint = async message => { await save(state); progress(message, state); };
    const check = () => { if (stopped()) throw new Stopped(); };
    // Validate the whole snapshot before creating any remote resource.
    const prepared = tablesForExport(tables).map(table => ({ ...table, rows: rowsFor(table) }));
    if (!prepared.length) throw new Error("没有可以导出的数据。");
    state.tables ||= {};
    check();
    if (!state.appToken) {
      if (state.mode === "existing") Object.assign(state, targetUrl(state.targetUrl));
      else {
        if (state.creatingApp) throw new Error("上次新建表格未收到确定结果。请先在飞书查找该表格，再将它的链接填入“继续到已有表格”，避免重复创建。");
        state.creatingApp = true;
        await checkpoint("正在新建多维表格…");
        let data;
        try { data = await client.request("POST", "/bitable/v1/apps", { name: state.name, time_zone: "Asia/Shanghai" }); }
        catch (error) {
          if (error.definitive) { state.creatingApp = false; await checkpoint(error.message); }
          throw error;
        }
        if (!data.app?.app_token || !data.app?.url) throw new Error("飞书未返回新表格地址，请到飞书确认创建结果后填写链接继续。");
        const resolved = targetUrl(data.app.url);
        if (resolved.appToken !== data.app.app_token) throw new Error("飞书返回的表格地址不一致，请检查后继续。");
        state.appToken = data.app.app_token; state.url = resolved.url;
        state.defaultTable = data.app.default_table_id || "";
        state.creatingApp = false;
      }
      await checkpoint("已确定目标表格，正在准备字段…");
    }
    const base = "/bitable/v1/apps/" + encodeURIComponent(state.appToken);
    // Never delete or overwrite pre-existing data. Only remove the untouched default table created by this job.
    for (const table of prepared) {
      check();
      const entry = state.tables[table.key] ||= { added: 0, skipped: 0 };
      if (!entry.id) {
        if (table.key === "notes" && state.noteTable) entry.id = state.noteTable;
        else {
          const name = state.mode === "existing" ? (table.platform || "小红书") + table.name : table.name;
          const found = (await client.list(base + "/tables", {}, stopped)).filter(item => item.name === name);
          if (found.length > 1) throw new Error("目标中有多张同名的“" + name + "”表，请整理表名后再继续。");
          entry.id = found[0]?.table_id;
          if (!entry.id) {
            check();
            progress("正在建立“" + name + "”数据表…", state);
            const data = await client.request("POST", base + "/tables", { table: {
              name, default_view_name: "全部记录", fields: table.columns.map(fieldSpec)
            } });
            if (!data.table_id) throw new Error("飞书未返回数据表 ID，请继续以核对创建结果。");
            entry.id = data.table_id;
          }
        }
        await checkpoint("正在核对“" + table.name + "”字段…");
      }
      const path = base + "/tables/" + encodeURIComponent(entry.id);
      let fields = await client.list(path + "/fields", {}, stopped);
      const conflicts = table.columns.filter(col => fields.some(f => f.field_name === col.name && f.type !== col.type));
      if (conflicts.length) throw new Error("已有表格字段类型不匹配：" + conflicts.map(c => c.name).join("、") + "。请调整目标字段类型或新建表格。");
      for (const column of table.columns) {
        if (fields.some(field => field.field_name === column.name)) continue;
        check();
        await client.request("POST", path + "/fields", fieldSpec(column));
        await sleep(150);
      }
      // Recover an unacknowledged batch with the SAME body and idempotency token before querying existing IDs.
      if (entry.pending) {
        check();
        const data = await client.request("POST", path + "/records/batch_create", { records: entry.pending.rows },
          { client_token: entry.pending.token }, true);
        if (data.records?.length !== entry.pending.rows.length || data.records.some(r => !r.record_id)) {
          throw new Error("飞书返回的写入数量不完整，已保存批次，请继续核对。");
        }
        entry.added += entry.pending.rows.length;
        delete entry.pending;
        await checkpoint("已恢复“" + table.name + "”上次写入批次…");
      }
      check();
      progress("正在检查“" + table.name + "”重复记录…", state);
      const records = await client.list(path + "/records", { field_names: JSON.stringify([table.idField]) }, stopped);
      const existing = new Set(records.map(r => textCell(r.fields?.[table.idField])).filter(Boolean));
      const remaining = table.rows.filter(row => !existing.has(row.fields[table.idField]));
      entry.skipped = Math.max(0, table.rows.length - remaining.length - entry.added);
      entry.total = table.rows.length;
      for (let index = 0; index < remaining.length; index += 100) {
        check();
        const rows = remaining.slice(index, index + 100);
        entry.pending = { token: crypto.randomUUID(), rows };
        await checkpoint("正在写入“" + table.name + "”：" + (entry.total - remaining.length + index) + "/" + entry.total);
        const data = await client.request("POST", path + "/records/batch_create", { records: rows },
          { client_token: entry.pending.token }, true);
        if (data.records?.length !== rows.length || data.records.some(r => !r.record_id)) {
          throw new Error("飞书返回的写入数量不完整，已保存批次，请继续核对。");
        }
        entry.added += rows.length;
        delete entry.pending;
        await checkpoint("“" + table.name + "”已处理 " + (entry.total - remaining.length + index + rows.length) + "/" + entry.total);
        await sleep(150);
      }
    }
    // A fresh Base may include ten blank placeholder records. Read all of its
    // default table before removal; preserve any value, including 0 and false.
    if (state.defaultTable && !Object.values(state.tables).some(t => t.id === state.defaultTable)) {
      check();
      const current = await client.list(base + "/tables", {}, stopped);
      if (current.some(t => t.table_id === state.defaultTable)) {
        const rows = await client.list(base + "/tables/" + encodeURIComponent(state.defaultTable) + "/records", {}, stopped);
        const empty = rows.every(row => row.fields && Object.values(row.fields).every(value =>
          value == null || value === "" || Array.isArray(value) && value.length === 0));
        if (empty) {
          check();
          await client.request("DELETE", base + "/tables/" + encodeURIComponent(state.defaultTable));
        }
      }
      state.defaultTable = "";
    }
    state.complete = true;
    await checkpoint("导出完成");
    return state;
  }
  return { Client, run, targetUrl, fieldSpec, rowsFor, tablesForExport, Stopped };
})();
