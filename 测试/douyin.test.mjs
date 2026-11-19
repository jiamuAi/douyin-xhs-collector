import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

const read = file => fs.readFileSync(new URL("../插件/" + file, import.meta.url), "utf8");
const id = "9000000000000000101";
const raw = "https://www.douyin.com/video/" + id + "?from=example";
function element(attrs = {}, words = "") {
  return { id: attrs.id || "", textContent: words, children: [],
    getAttribute: key => attrs[key] ?? null,
    getClientRects: () => attrs.hidden ? [] : [{}], closest: () => null,
    querySelector: () => null, querySelectorAll: () => [] };
}
// Model a rendered search card with either an anchor, a clickable video cover, or a search suggestion.
function card({ href, label, hidden = false, value = id }) {
  const root = element({ hidden });
  root.parentElement = element({ id: "waterfall_item_" + value });
  const cover = element();
  const badge = element({}, label || "");
  cover.querySelectorAll = () => [badge];
  const anchor = element({ href });
  const picture = element({ src: "https://images.example.test/cover.jpg" });
  const single = selector => {
    if (selector === ".videoImage" && label) return cover;
    if (selector === "img") return picture;
    if (selector.includes("video-desc")) return element({}, "一条作品 #摄影");
    if (selector.includes("like-count")) return element({}, "1.2万");
    return null;
  };
  const multi = selector => {
    if (selector === "span,div,time") return [badge];
    const paths = [...selector.matchAll(/a\[href\*="([^"]+)"\]/g)];
    return href && paths.some(([, path]) => href.includes(path)) ? [anchor] : [];
  };
  root.querySelector = anchor.querySelector = single;
  root.querySelectorAll = anchor.querySelectorAll = multi;
  return root;
}
function load(cards, url = "https://www.douyin.com/search/摄影?type=general") {
  const document = { title: "摄影 - 抖音", querySelector: () => null, querySelectorAll: () => cards };
  const context = vm.createContext({ document, location: new URL(url), URL });
  vm.runInContext(read("douyin.js"), context);
  vm.runInContext(read("session.js"), context);
  return { scan: rows => context.douyinCollector.capture(rows), document, store: context.xhsPageNotes };
}
test("clickable work cards retain their decimal-string IDs and distinguish video from photo and suggestions", () => {
  const { scan } = load([card({ label: "图文" }), card({ label: "00:12", value: "9000000000000000102" }),
    card({ label: "相关搜索", value: "9000000000000000103" }), card({ href: raw, hidden: true })]);
  const { notes } = scan();
  assert.equal(notes.length, 2);
  assert.equal(notes[0].noteUrl, "https://www.douyin.com/note/" + id);
  assert.equal(notes[0]._noteUrlFromCard, false);
  assert.equal(notes[0].type, "图文");
  assert.equal(notes[1].id, "9000000000000000102");
  assert.equal(notes[1].durationSeconds, 12);
  assert.equal(notes[1].referenceCount, 12000);
  assert.equal(notes[1].likeCount, null);
  assert.equal(notes[1].precision, "约数");
});
test("export excludes URL userinfo and preserves ordinary work link parameters", () => {
  const url = new URL(raw);
  url.username = "sample";
  url.password = "fixture";
  const source = "https://sample:fixture@www.douyin.com/search/demo?type=general";
  const { notes, page } = load([card({ href: url.href }), card({ href: raw })], source).scan();
  assert.equal(page.url, "https://www.douyin.com/search/demo?type=general");
  assert.deepEqual(Array.from(notes, note => note.noteUrl), [raw]);
  assert.equal(load([card({ href: url.href })], source).scan().notes.length, 0);
});

test("original link wins in either DOM order and survives a later fallback-only scan", async () => {
  const fallback = card({ label: "00:12" });
  const original = card({ href: raw });
  for (const pair of [[fallback, original], [original, fallback]]) {
    const { scan, document, store } = load(pair);
    store.accept(await store.capture());
    document.querySelectorAll = () => [fallback];
    store.accept(scan());
    const { notes } = store.result();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, id);
    assert.equal(notes[0].noteUrl, raw);
    assert.equal(notes[0]._noteUrlFromCard, true);
  }
});
for (const prefix of ["/jingxuan", "/root"]) {
  test(prefix + " search collects both result tabs and preserves original card links", () => {
    const base = "https://www.douyin.com" + prefix;
    for (const [type, section] of [["general", "综合"], ["video", "视频"]]) {
      const { page, notes } = load([card({ href: raw })], base + "/search/GPT%206.2?type=" + type).scan();
      assert.equal(page.kind, "search");
      assert.equal(page.keyword, "GPT 6.2");
      assert.equal(page.section, section);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].noteUrl, raw);
    }
    for (const suffix of ["", "/search/关键词?type=user", "/search/关键词?modal_id=" + id]) {
      assert.throws(load([], base + suffix).scan, /请/);
    }
  });
}
test("unsupported Douyin pages and verification screens provide an actionable message", () => {
  for (const path of ["/user/self", "/video/" + id, "/search/摄影?type=user", "/search/摄影?modal_id=" + id]) {
    assert.throws(load([], "https://www.douyin.com" + path).scan, /请/);
  }
  const { document, scan } = load([]);
  document.title = "验证码中间页";
  assert.throws(scan, /完成页面验证/);
});


test("a profile counts video, photo and article cards, preserving the original article URL", () => {
  const articleId = "9000000000000000104";
  const articleUrl = "https://www.douyin.com/article/" + articleId + "?from=profile";
  const { notes } = load([card({ href: raw }), card({ href: "/note/9000000000000000105" }),
    card({ href: articleUrl }), card({ href: articleUrl }), card({ href: "https://other.example/article/123" })],
    "https://www.douyin.com/user/example").scan();
  assert.equal(notes.length, 3);
  assert.deepEqual(Array.from(notes, n => n.type), ["视频", "图文", "文章"]);
  assert.equal(notes[2].id, articleId);
  assert.equal(notes[2].noteUrl, articleUrl);
  assert.equal(notes[2]._noteUrlFromCard, true);
});


test("author strip reads each mounted work, deduplicates ordinary hits and never exports the group ID", () => {
  const group = "waterfall_item_900000000000001";
  const wrap = card({ label: "02:12", value: group.slice(15) });
  const owner = element({ href: "/user/owner" }, "公开作者");
  const tiles = ["第一条", "第二条", "没有作品标识"].map(title => {
    const tile = card({ label: "02:12" });
    tile.querySelector(".videoImage").parentElement = { nextElementSibling: element({}, title) };
    return tile;
  });
  const strip = { contains: () => false, querySelectorAll: () => tiles };
  const select = wrap.querySelector, selectAll = wrap.querySelectorAll;
  wrap.querySelector = s => s === ".cs-scroller-content" ? strip : select(s);
  wrap.querySelectorAll = s => s === 'a[href*="/user/"]' ? [owner] : selectAll(s);
  wrap.parentElement.id = group;
  const ordinary = card({ href: raw });
  const second = "9000000000000000106";
  const rows = [id, second].map((work, i) => ({ group, title: ["第一条", "第二条"][i], cover: "", id: work, route: "video" }));
  for (const cards of [[ordinary, wrap], [wrap, ordinary]]) {
    const { scan } = load(cards);
    const result = scan(rows);
    assert.equal(result.notes.length, 2);
    assert.equal(result.notes.find(n => n.id === id).noteUrl, raw);
    const tile = result.notes.find(n => n.id === second);
    assert.equal(tile.title, "第二条");
    assert.equal(tile.authorName, "公开作者");
    assert.equal(tile.noteUrl, "https://www.douyin.com/video/" + second);
    assert.ok(result.warnings.some(msg => msg.includes("横排中有 1 项")));
  }
});

test("carousel identity is a decimal string from the mounted tile and excludes conflicting or parent IDs", () => {
  const group = "waterfall_item_900000000000001";
  const label = element({}, "00:20");
  function tileFor(props, key = null) {
    const media = element();
    const tile = element();
    const outer = { nodeType: 1 };
    media.nodeType = tile.nodeType = 1;
    media.__reactFiber$test = { stateNode: media, memoizedProps: props,
      return: { stateNode: tile, key, return: { stateNode: outer, key: "9000000000000000107" } } };
    media.parentElement = { nextElementSibling: element({}, "显示标题") };
    media.querySelectorAll = () => [label];
    tile.querySelector = () => media;
    tile.contains = el => el === media || el === tile;
    tile.closest = s => s === ".search-result-card" ? { parentElement: { id: group } } : null;
    return tile;
  }
  const tiles = [tileFor({ awemeInfo: { awemeId: id } }), tileFor({ awemeId: Number(id) }),
    tileFor({ awemeId: id }, "9000000000000000106")];
  const result = vm.runInNewContext(read("douyin-carousel.js"), { document: { querySelectorAll: () => tiles } });
  assert.deepEqual(Array.from(result, r => [r.id, r.route, r.title]), [[id, "video", "显示标题"]]);
});
