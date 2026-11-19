import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const read = file => fs.readFileSync(new URL("../插件/" + file, import.meta.url), "utf8");
const owner = "0000000000000000000000a1";
const ids = ["000000000000000000000001", "000000000000000000000002", "000000000000000000000003"];
const rawLink = id => `https://www.xiaohongshu.com/user/profile/${owner}/${id}?xsec_token=card%2Btoken%3D&xsec_source=pc_user&from=original`;
const pageUrl = `https://www.xiaohongshu.com/user/profile/${owner}?xsec_token=profile-token&xsec_source=pc_search`;
const metadata = id => ({ id, displayTitle: "页面数据中的标题", type: "video", time: 1794625200000,
  user: { userId: owner, nickname: "同一博主", xsecToken: "unused-author-token" },
  cover: { urlDefault: "https://images.example.test/cover.jpg", width: 1080, height: 1440 },
  interactInfo: { likedCount: "12" }, xsecToken: "must-not-become-a-link" });

// These DOM-shaped fixtures exercise the real collector and page-state enrichment.
// They model mounted cards, an inactive pane, and notes with data but no card.
function collect({ cards = [], stateIds = ids, kind = "profile", searchUrl = "https://www.xiaohongshu.com/search_result?keyword=test", title = "采集页面" } = {}) {
  const location = new URL(kind === "profile" ? pageUrl : kind === "search"
    ? searchUrl : "https://www.xiaohongshu.com/explore");
  const documentElement = {};
  const makeAnchor = href => ({ href: new URL(href, location.href).href, style: {}, querySelector: () => null,
    getAttribute: name => name === "href" ? href : null });
  const roots = cards.map(({ id, href = rawLink(id), hidden = false, alternateHref }) => {
    const cover = href ? makeAnchor(href) : null;
    const alternate = alternateHref ? makeAnchor(alternateHref) : null;
    const author = makeAnchor(`/user/profile/${owner}?xsec_source=pc_note&from=author-card`);
    const anchors = [cover, alternate, author].filter(Boolean);
    return {
      dataset: { noteId: id, index: String(ids.indexOf(id)) }, parentElement: documentElement,
      closest: selector => hidden && selector.includes("[hidden]") ? {} : null,
      matches: () => false,
      querySelectorAll: selector => selector === "a[href]" ? anchors : [],
      querySelector: selector => {
        if (selector === "a.cover[href]" || selector === ".cover") return cover;
        if (selector === "a.title[href]") return alternate;
        if (selector === ".footer .title, .title, [data-note-title]") return { textContent: "卡片原始标题" };
        if (selector === ".like-wrapper .count, .like-count, [data-liked-count]") return { textContent: "12" };
        return null;
      }
    };
  });
  const items = stateIds.map(metadata);
  const state = kind === "profile" ? { user: { notes: [items] } } : { [kind]: { feeds: items } };
  const document = {
    documentElement, title,
    querySelectorAll: selector => selector === ".note-item, section[data-note-id], article[data-note-id]" ? roots : [],
    querySelector: selector => selector.includes(".reds-tab-item.active") ? { textContent: "笔记" } : null
  };
  return vm.runInNewContext(read("collector.js"), { URL, location, document, window: { __INITIAL_STATE__: state },
    getComputedStyle: () => ({ display: "block", visibility: "visible", overflowY: "visible" }) });
}

function session() {
  const context = vm.createContext({ URL });
  vm.runInContext(read("session.js"), context);
  return context.xhsPageNotes;
}

for (const kind of ["profile", "feed", "search"]) {
  test(`${kind}: only mounted active cards enter the session; page-data enrichment and basic links remain`, () => {
    const cache = session();
    cache.accept(collect({ kind, cards: [{ id: ids[0] }, { id: ids[1], hidden: true }] }));
    const snapshot = cache.result();
    assert.equal(snapshot.notes.length, 1);
    const note = snapshot.notes[0];
    assert.equal(note.id, ids[0]); assert.equal(note.rendered, true);
    assert.equal(note.noteUrl, rawLink(ids[0]), "keep the original path, query order and escaping");
    assert.equal(note.authorUrl, `https://www.xiaohongshu.com/user/profile/${owner}?xsec_token=unused-author-token&xsec_source=${{ profile: "pc_user", feed: "pc_feed", search: "pc_search" }[kind]}`);
    assert.equal(note.title, "卡片原始标题"); assert.equal(note.type, "视频");
    assert.equal(note.publishedAt, new Date(metadata(ids[0]).time).toISOString());
    assert.equal(note.coverWidth, 1080); assert.equal(note.source, "卡片＋页面数据");
    assert.equal(note.canonicalUrl, `https://www.xiaohongshu.com/explore/${ids[0]}`);
    assert.equal(note.authorCanonical, `https://www.xiaohongshu.com/user/profile/${owner}`);
    assert.equal(note._noteUrlFromCard, true);
  });
}

test("source page omits URL userinfo while keeping the original note link", () => {
  const searchUrl = "https://sample:fixture@www.xiaohongshu.com/search_result?keyword=demo";
  const data = collect({ kind: "search", searchUrl, cards: [{ id: ids[0] }] });
  assert.equal(data.page.url, "https://www.xiaohongshu.com/search_result?keyword=demo");
  assert.equal(data.notes.find(note => note.id === ids[0]).noteUrl, rawLink(ids[0]));
});

test("AI search accepts the listing, keeps the card URL, and displays the actual search term", () => {
  const base = "https://www.xiaohongshu.com/search_result_ai";
  const href = `https://www.xiaohongshu.com/search_result/${ids[0]}?xsec_token=sample&xsec_source=pc_search`;
  for (const [word, encoded] of [
    ["小红书ai文案", encodeURIComponent(encodeURIComponent("小红书ai文案"))],
    ["100%有效", encodeURIComponent("100%有效")],
    ["%20", encodeURIComponent("%20")]
  ]) {
    const cache = session();
    cache.accept(collect({ kind: "search", searchUrl: base + "/?keyword=" + encoded,
      title: word + " - 小红书搜索", cards: [{ id: ids[0], href }] }));
    const { page, notes } = cache.result();
    assert.equal(page.kind, "search"); assert.equal(page.keyword, word);
    assert.equal(notes.length, 1); assert.equal(notes[0].noteUrl, href);
  }
  assert(collect({ kind: "search", searchUrl: base + "/" + ids[0] }).error);
});

test("preloaded page-state notes cannot be collected before any cards appear", () => {
  const cache = session();
  cache.accept(collect());
  assert.equal(cache.result().notes.length, 0);
  assert.equal(cache.progress().total, 0);
});

test("a missing or mismatched card link still uses the existing signed fallback", () => {
  for (const href of ["", rawLink(ids[1])]) {
    const snapshot = collect({ cards: [{ id: ids[0], href }] });
    const note = snapshot.notes.find(note => note.id === ids[0]);
    assert.equal(note.noteUrl, `https://www.xiaohongshu.com/explore/${ids[0]}?xsec_token=must-not-become-a-link&xsec_source=pc_user`);
    assert.equal(note._noteUrlFromCard, false);
    assert.equal(note.canonicalUrl, `https://www.xiaohongshu.com/explore/${ids[0]}`);
  }
});

test("when several links exist on one card, the signed original is kept without using page-state tokens", () => {
  const original = rawLink(ids[0]);
  const snapshot = collect({ cards: [{ id: ids[0], href: `/explore/${ids[0]}`, alternateHref: original }] });
  assert.equal(snapshot.notes[0].noteUrl, original);
});

test("scroll history retains original links after old cards unmount and ignores metadata-only overwrites", () => {
  const cache = session();
  cache.accept(collect({ cards: [{ id: ids[0] }] }));
  cache.accept(collect({ cards: [{ id: ids[1] }] }));
  const later = collect();
  // Reproduce the former failure, including its signed replacement and unseen extra note.
  later.notes = [ids[0], ids[2]].map(id => ({ id, noteUrl: `https://www.xiaohongshu.com/explore/${id}?xsec_token=metadata`,
    rendered: false, source: "仅页面数据", _noteUrlFromCard: false, description: "后续补充的正文" }));
  cache.accept(later);
  const notes = cache.result().notes;
  assert.equal(notes.length, 2); assert.equal(cache.progress().renderedCount, 2);
  assert.equal(notes[0].noteUrl, rawLink(ids[0])); assert.equal(notes[1].noteUrl, rawLink(ids[1]));
  assert.equal(notes[0].source, "卡片＋页面数据");
  assert.equal(notes[0].description, "后续补充的正文", "other page-data enrichment is preserved");
  assert.equal(notes[0]._noteUrlFromCard, true);
  assert.equal(cache.select, undefined);
  cache.accept(collect({ cards: [{ id: ids[2] }] }));
  assert.equal(cache.result().notes.length, 3, "a previously preloaded note is added once its card appears");
  cache.accept(collect({ cards: [{ id: ids[2] }] }));
  assert.equal(cache.result().notes.length, 3, "repeated scans stay deduplicated");
});

test("a subsequent card scan can refresh its original link, but a scan with no readable link cannot erase it", () => {
  const cache = session();
  cache.accept(collect({ cards: [{ id: ids[0] }] }));
  const newer = rawLink(ids[0]).replace("card%2Btoken%3D", "new%2Bcard%3D");
  cache.accept(collect({ cards: [{ id: ids[0], href: newer }] }));
  cache.accept(collect({ cards: [{ id: ids[0], href: "" }] }));
  assert.equal(cache.result().notes[0].noteUrl, newer);
  cache.accept(collect({ cards: [{ id: ids[1] }] }), true);
  assert.equal(cache.result().notes.length, 1); assert.equal(cache.result().notes[0].id, ids[1]);
});

test("an original card link replaces a prior fallback, even if only the fallback has a token", () => {
  const cache = session();
  cache.accept(collect({ cards: [{ id: ids[0], href: "" }] }));
  assert.equal(cache.result().notes[0]._noteUrlFromCard, false);
  const original = `https://www.xiaohongshu.com/user/profile/${owner}/${ids[0]}`;
  cache.accept(collect({ cards: [{ id: ids[0], href: original }] }));
  assert.equal(cache.result().notes[0].noteUrl, original);
  assert.equal(cache.result().notes[0]._noteUrlFromCard, true);
  cache.accept(collect());
  assert.equal(cache.result().notes[0].noteUrl, original);
});

test("JSON, Excel and Feishu input exclude unseen notes and retain the existing basic-link columns and schema", async () => {
  const require = createRequire(import.meta.url);
  const ExcelJS = require("../插件/vendor/exceljs.min.js");
  const exporter = new Function("ExcelJS", read("export.js") + "\nreturn NoteExport;")(ExcelJS);
  const snapshot = collect({ cards: [{ id: ids[0] }, { id: ids[1], href: "" }] });
  snapshot.notes.push({ id: ids[2], rendered: false, noteUrl: rawLink(ids[2]) });
  // Supplying the old second argument must not restore the removed preload option.
  const payload = exporter.prepare(snapshot, true);
  assert.equal(payload.count, 2); assert.equal(payload.renderedCount, 2);
  assert.equal(payload.schemaVersion, 1); assert.equal(payload.scope, "已展示的卡片");
  assert.equal(payload.preloadedCount, 0);
  const json = JSON.parse(JSON.stringify(payload));
  assert.equal(json.notes[0].noteUrl, rawLink(ids[0]));
  assert.equal(json.notes[1].noteUrl, `https://www.xiaohongshu.com/explore/${ids[1]}?xsec_token=must-not-become-a-link&xsec_source=pc_user`);
  assert(json.notes.every(note => !("_noteUrlFromCard" in note)), "the internal link marker does not change exported JSON fields");
  const notesTable = exporter.tables(payload).find(table => table.key === "notes");
  assert.equal(notesTable.records.length, 2); assert.equal(notesTable.records[0].noteUrl, rawLink(ids[0]));
  for (const name of ["笔记基础链接", "博主基础链接"]) assert(notesTable.columns.some(column => column.name === name));
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await exporter.workbook(payload));
  const sheet = book.getWorksheet("笔记");
  const headers = sheet.getRow(1).values;
  const linkColumn = headers.indexOf("笔记链接");
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getRow(2).getCell(linkColumn).value.hyperlink, rawLink(ids[0]));
  assert.equal(sheet.getRow(3).getCell(linkColumn).value.hyperlink, json.notes[1].noteUrl);
  for (const name of ["笔记基础链接", "博主基础链接"]) assert(headers.includes(name));
  assert.equal(sheet.getRow(2).getCell(headers.indexOf("笔记基础链接")).value.hyperlink,
    `https://www.xiaohongshu.com/explore/${ids[0]}`);
  assert.equal(sheet.getRow(2).getCell(headers.indexOf("博主基础链接")).value.hyperlink,
    `https://www.xiaohongshu.com/user/profile/${owner}`);
});
