// Runs once in the clicked tab. The return value contains only public listing fields.
(() => {
  "use strict";

  const origin = location.origin;
  const path = location.pathname.replace(/\/$/, "");
  const idPattern = /^[\da-f]{24}$/i;
  const ownerMatch = path.match(/^\/user\/profile\/([\da-f]{24})$/i);
  const aiSearch = path === "/search_result_ai";
  const kind = ownerMatch ? "profile" : (path === "/search_result" || aiSearch) ? "search" :
    path === "" || path === "/explore" ? "feed" : null;
  if (!kind || !["www.xiaohongshu.com", "xiaohongshu.com"].includes(location.hostname)) {
    return { error: "请在小红书发现页、博主主页或笔记搜索结果页打开插件。若正在看单篇笔记，请先返回列表。" };
  }

  const text = (value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const content = (root, selector) => text(root?.querySelector(selector)?.textContent);
  const unique = (items) => [...new Set(items.filter(Boolean))];
  const idOf = (v) => idPattern.test(text(v)) ? text(v).toLowerCase() : "";
  const number = (v) => {
    if (typeof v !== "number" && (typeof v !== "string" || !/^\d[\d,，]*$/.test(v.trim()))) return null;
    const n = Number(String(v).replace(/[,，]/g, ""));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const measurement = (v) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
  const asList = (v) => Array.isArray(v) ? v : [];
  const url = (v) => {
    if ((!v && v !== 0) || typeof v !== "string" || !v.trim()) return "";
    try {
      const u = new URL(v, location.href);
      return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : "";
    } catch { return ""; }
  };
  const imgUrl = (el) => {
    if (!el) return "";
    for (const candidate of [el.currentSrc, el.getAttribute("data-src"), el.getAttribute("data-original"),
      el.getAttribute("src"), el.getAttribute("data-lazy-src")]) {
      const resolved = url(candidate);
      if (resolved) return resolved;
    }
    const bg = el.style?.backgroundImage?.match(/^url\(["']?(.*?)["']?\)$/);
    return url(bg?.[1]);
  };
  const linkParts = (value) => {
    const resolved = url(value);
    if (!resolved) return {};
    const u = new URL(resolved);
    if (!["www.xiaohongshu.com", "xiaohongshu.com"].includes(u.hostname)) return {};
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "user" && parts[1] === "profile") {
      return { author: idOf(parts[2]), note: idOf(parts[3]), url: resolved };
    }
    return { note: ["explore", "search_result"].includes(parts[0]) ? idOf(parts[1]) :
      parts[0] === "discovery" && parts[1] === "item" ? idOf(parts[2]) : "", url: resolved };
  };
  const hasToken = (link) => !!(link && new URL(link).searchParams.get("xsec_token"));
  const bestLink = (...values) => {
    const links = unique(values.filter(Boolean));
    return links.find(hasToken) || links[0] || "";
  };
  const signed = (base, token) => {
    if (!base || !text(token)) return base;
    const u = new URL(base);
    u.searchParams.set("xsec_token", token);
    u.searchParams.set("xsec_source", { feed: "pc_feed", profile: "pc_user", search: "pc_search" }[kind]);
    return u.href;
  };
  const visibleTree = (el) => {
    if (!el || el.closest('[hidden], [aria-hidden="true"]')) return false;
    // Offscreen rows belong to the list. Inactive profile panes can also be mounted at zero height.
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (node.matches(".tab-content-item") && node.getBoundingClientRect().height === 0
        && /hidden|clip/.test(style.overflowY)) return false;
    }
    return true;
  };
  const heading = kind === "profile" ? "博主主页" : kind === "search" ? "搜索结果" : "发现页";
  const section = kind === "profile" ? content(document, "#userPageContainer .reds-tab-item.active, .feeds-tab-container .reds-tab-item.active, .reds-tab-item.active") :
    kind === "feed" ? content(document, ".channel-content.active") : "";
  const cleanPage = new URL(location.href);
  cleanPage.username = "";
  cleanPage.password = "";
  let keyword = kind === "search" ? cleanPage.searchParams.get("keyword") || "" : "";
  if (aiSearch) {
    // This route can encode the keyword twice. Match the visible title to preserve literal percent text.
    const titleKeyword = document.title.match(/^(.*?)\s+-\s+小红书搜索$/)?.[1];
    if (titleKeyword && encodeURIComponent(titleKeyword) === keyword) keyword = titleKeyword;
  }
  cleanPage.hash = "";
  // Returning to a page should re-use card history within this document, independent of tracking parameters.
  const scopeKey = [kind, path, section, keyword, cleanPage.searchParams.get("type") || "",
    cleanPage.searchParams.get("sort") || "", cleanPage.searchParams.get("channel_id") || ""].join("|");

  function readProfile() {
    if (!ownerMatch) return null;
    const root = document.querySelector("#userPageContainer .user-info, .user-page .user-info, .user-info");
    const interactions = {};
    root?.querySelectorAll(".user-interactions .shows, .data-info .shows").forEach((label) => {
      const name = text(label.textContent);
      const raw = content(label.parentElement, ".count");
      if (name && raw) interactions[name] = { display: raw, exact: number(raw) };
    });
    return {
      id: ownerMatch[1], name: content(root, ".user-name, .user-nickname"), url: cleanPage.href,
      canonicalUrl: origin + path, avatar: imgUrl(root?.querySelector(".user-image, .avatar img")),
      redId: content(root, ".user-redId, .user-red-id").replace(/^小红书号\s*[：:]\s*/, ""),
      bio: content(root, ".user-desc, .description"),
      region: content(root, ".user-IP, .user-ip").replace(/^IP\s*属地\s*[：:]\s*/i, ""),
      tags: unique(Array.from(root?.querySelectorAll(".user-tags .tag-item") || [], t => text(t.textContent))),
      interactions, postedCount: null, receivedLikes: null, receivedSaves: null
    };
  }
  const profile = readProfile();
  const normalizeSection = (v) => text(v).replace(/\s+/g, "");
  const postedPane = !section || /^(笔记|作品|发布|笔记·作品)$/.test(normalizeSection(section));
  const roots = Array.from(document.querySelectorAll(".note-item, section[data-note-id], article[data-note-id]"));
  if (!roots.length) {
    // Fallback for layouts which expose links and omit the usual card class.
    for (const a of document.querySelectorAll('a.cover[href], a.title[href], a[href*="/explore/"], a[href*="/search_result/"]')) {
      if (!linkParts(a.getAttribute("href")).note) continue;
      const candidate = a.closest("article, section, [data-note-id], [data-index]");
      if (!candidate || roots.includes(candidate)) continue;
      const childIds = unique(Array.from(candidate.querySelectorAll("a[href]"), el => linkParts(el.href).note));
      if (childIds.length === 1) roots.push(candidate);
    }
  }

  function readCard(el) {
    const anchors = Array.from(el.querySelectorAll("a[href]"));
    const preferred = [el.querySelector("a.cover[href]"), el.querySelector("a.title[href]"), ...anchors].filter(Boolean);
    const parts = preferred.map(a => linkParts(a.getAttribute("href")));
    const id = idOf(el.dataset.noteId) || parts.find(p => p.note)?.note;
    if (!id) return null;
    const author = anchors.find(a => {
      const p = linkParts(a.href);
      return p.author && !p.note;
    });
    const profileLink = linkParts(author?.getAttribute("href"));
    const cover = el.querySelector(".cover img, img[data-preload-cover], img[elementtiming='card-exposed'], img.cover") ||
      Array.from(el.querySelectorAll("img")).find(i => !i.closest(".author,.avatar,.avatar-container") && !i.className.includes("avatar"));
    const avatar = author?.querySelector("img") || el.querySelector(".author-avatar, .avatar img");
    const coverLink = imgUrl(cover) || imgUrl(el.querySelector(".cover"));
    const domLikes = content(el, ".like-wrapper .count, .like-count, [data-liked-count]") ||
      text(el.querySelector("[data-liked-count]")?.getAttribute("data-liked-count"));
    const video = el.querySelector('video, .play-icon, .video-icon, use[href*="#play"], use[*|href*="#play"]');
    const badges = unique(Array.from(el.querySelectorAll(".badge,.tag,.note-tag,.top-tag,.sticky-tag,.pinned-tag,.note-top,.top-wrapper"), v => text(v.textContent)));
    const pinned = !!el.querySelector(".top-tag, .sticky-tag, .pinned-tag, .note-top") || badges.includes("置顶");
    return {
      id, noteUrl: bestLink(...parts.filter(p => p.note === id).map(p => p.url)),
      title: content(el, ".footer .title, .title, [data-note-title]") || text(cover?.alt),
      authorId: profileLink.author || "", authorName: content(author, ".name, .nickname") || text(author?.textContent),
      authorUrl: profileLink.url || "", avatarUrl: imgUrl(avatar), coverUrl: coverLink,
      likeDisplay: domLikes, likeCount: number(domLikes), type: video ? "视频" : "", pinned: pinned ? true : null,
      coverWidth: measurement(el.dataset.width), coverHeight: measurement(el.dataset.height),
      listIndex: number(el.dataset.index), badges
    };
  }
  const dom = new Map();
  for (const el of roots.filter(visibleTree)) {
    const card = readCard(el);
    if (card && !dom.has(card.id)) dom.set(card.id, card);
  }

  // Only specific listing stores are read. Never walk the full app state (it also contains account data).
  const unref = (v) => v && typeof v === "object" && v.__v_isRef === true ? v.value : v;
  const fromList = (v) => asList(unref(v));
  const metadata = new Map();
  const mediaUrls = (o) => unique([
    o?.urlDefault, o?.urlPre, o?.url, o?.url_default, o?.url_pre,
    ...asList(o?.infoList || o?.info_list).map(i => i?.url)
  ].map(url));
  const readDate = (v) => {
    if (!v) return "";
    const numeric = typeof v === "number" || /^\d{10,13}$/.test(v);
    if (!numeric && (typeof v !== "string" || !/^\d{4}-\d\d-\d\d/.test(v))) return "";
    const time = numeric ? Number(v) * (Number(v) < 1e11 ? 1000 : 1) : Date.parse(v);
    return Number.isFinite(time) && time > 0 && time < 9e15 ? new Date(time).toISOString() : "";
  };
  function noteData(item, note, id) {
    const user = note.user || note.author || {};
    const ii = note.interactInfo || note.interact_info || {};
    const cover = note.cover || {};
    const video = note.video || {};
    const vid = video.media || {};
    const streams = Object.values(vid.stream || {}).flatMap(asList);
    const imgs = asList(note.imageList || note.image_list);
    const likes = ii.likedCount ?? ii.liked_count ?? note.likedCount;
    const type = text(note.type || note.noteType);
    const userId = idOf(user.userId || user.user_id || user.id);
    const base = origin + "/explore/" + id;
    const userBase = userId ? origin + "/user/profile/" + userId : "";
    const sticky = ii.sticky ?? note.isTop ?? note.is_top;
    const urls = mediaUrls(cover);
    return {
      noteUrl: signed(base, item.xsecToken || item.xsec_token || note.xsecToken || note.xsec_token),
      title: text(note.displayTitle || note.display_title || note.title),
      description: text(note.desc || note.description),
      authorId: userId, authorName: text(user.nickName || user.nickname || user.nick_name),
      authorUrl: signed(userBase, user.xsecToken || user.xsec_token),
      avatarUrl: url(user.avatar || user.imageb || user.image),
      type: ({ normal: "图文", image: "图文", video: "视频" })[type] || type,
      likeCount: number(likes), likeDisplay: text(likes),
      saveCount: text(ii.collectedCount ?? ii.collected_count),
      commentCount: text(ii.commentCount ?? ii.comment_count),
      shareCount: text(ii.shareCount ?? ii.share_count),
      publishedAt: readDate(note.time || note.publishTime || note.publish_time),
      updatedAt: readDate(note.lastUpdateTime || note.last_update_time),
      tags: unique(asList(note.tagList || note.tag_list).map(t => text(t?.name ?? t))),
      coverUrl: urls[0] || "", coverUrls: urls, coverWidth: measurement(cover.width), coverHeight: measurement(cover.height),
      imageUrls: unique(imgs.flatMap(mediaUrls)), imageCount: imgs.length || number(note.imageCount ?? note.image_count),
      durationSeconds: number(video.capa?.duration ?? video.duration ?? vid.video?.duration),
      videoUrls: unique([video.url, ...streams.flatMap(s => [s.masterUrl, s.master_url, ...asList(s.backupUrls || s.backup_urls)])].map(url)),
      pinned: typeof sticky === "boolean" ? sticky : null, listIndex: number(item.index),
      noteRegion: text(note.ipLocation || note.ip_location)
    };
  }
  const present = (v) => v != null && v !== "" && (!Array.isArray(v) || v.length > 0);
  const filled = (o) => Object.fromEntries(Object.entries(o).filter(([,v]) => present(v)));
  function addItems(items, stateOnlyAllowed) {
    for (const item of items) {
      if (!item || typeof item !== "object" || item.modelType && item.modelType !== "note") continue;
      const card = item.noteCard || item.note_card || item.note || item;
      const id = idOf(card.noteId || card.note_id || item.noteId || item.id || card.id);
      if (!id || !dom.has(id) && !stateOnlyAllowed || !card.cover && !card.interactInfo && !card.interact_info && !card.displayTitle && !card.title) continue;
      const record = filled(noteData(item, card, id));
      const before = metadata.get(id) || {};
      metadata.set(id, { ...before, ...record, noteUrl: bestLink(record.noteUrl, before.noteUrl),
        authorUrl: bestLink(record.authorUrl, before.authorUrl) });
    }
  }

  const warnings = new Set();
  function enrichProfile(data, trusted) {
    const basic = data?.basicInfo || data?.basic_info;
    if (!profile || !basic) return;
    const matches = !!(profile.redId && text(basic.redId || basic.red_id) === profile.redId) ||
      !!(idOf(basic.userId || basic.user_id || data.userId) === profile.id);
    if (!matches && !trusted) return;
    profile.name ||= text(basic.nickname);
    profile.avatar ||= url(basic.imageb || basic.images);
    profile.bio ||= text(basic.desc);
    profile.redId ||= text(basic.redId || basic.red_id);
    profile.region ||= text(basic.ipLocation || basic.ip_location);
    profile.tags = unique([...profile.tags, ...asList(data.tags).map(t => text(t?.name))]);
    for (const metric of asList(data.interactions)) {
      const name = text(metric?.name);
      if (!name || metric.show === false || !["关注", "粉丝", "获赞与收藏"].includes(name)) continue;
      const previous = profile.interactions[name] || {};
      profile.interactions[name] = { display: previous.display || text(metric.count),
        exact: number(metric.count) ?? previous.exact ?? null };
    }
    profile.postedCount = number(data.posted) ?? profile.postedCount;
    profile.receivedLikes = number(data.liked) ?? profile.receivedLikes;
    profile.receivedSaves = number(data.collected) ?? profile.receivedSaves;
  }
  function readStore(state) {
    if (!state) return;
    const store = unref(state[kind === "profile" ? "user" : kind === "search" ? "search" : "feed"]);
    if (!store) return;
    // Tie cached notes to this list instead of importing an unrelated tab, search or feed channel.
    const shared = (items) => items.some(x => dom.has(idOf(x?.id || x?.noteId || x?.noteCard?.noteId || x?.note_card?.note_id)));
    if (kind === "profile") {
      const lists = fromList(store.notes);
      const active = unref(store.activeTab);
      const tabIndex = postedPane ? 0 : number(active?.index);
      const groups = lists.some(Array.isArray) ? lists : [lists];
      const current = (tabIndex != null && groups[tabIndex]) || [];
      const ownerIds = unique(current.map(x => idOf((x?.noteCard || x?.note_card || x)?.user?.userId ||
        (x?.noteCard || x?.note_card || x)?.user?.user_id)));
      const ownerVerified = postedPane && ownerIds.length === 1 && ownerIds[0] === profile.id;
      enrichProfile(unref(store.userPageData), ownerVerified);
      for (const group of groups) if (Array.isArray(group)) addItems(group,
        group === current && (postedPane ? ownerVerified || shared(group) : shared(group)));
    } else {
      const items = fromList(store.feeds);
      addItems(items, shared(items));
    }
  }
  try { readStore(window.__INITIAL_STATE__); } catch { warnings.add("部分页面内嵌字段暂时无法读取"); }
  try {
    const app = document.querySelector("#app")?.__vue_app__;
    const liveState = app?.config?.globalProperties?.$pinia?.state?.value;
    if (liveState && liveState !== window.__INITIAL_STATE__) readStore(liveState);
  } catch { warnings.add("动态笔记仅使用已取得的页面字段"); }
  // Vue's current card props also cover freshly scrolled rows not in the server-rendered first batch.
  for (const el of roots) {
    const id = idOf(el.dataset.noteId);
    if (!dom.has(id)) continue;
    try {
      let component = el.__vueParentComponent;
      for (let depth = 0; component && depth < 4; depth++, component = component.parent) {
        const props = component.props;
        if (!props) continue;
        for (const item of [props.item, props.note, props.noteData, props.data, props.noteCard]) {
          if (!item || typeof item !== "object") continue;
          const itemId = idOf(item.noteId || item.id || item.noteCard?.noteId);
          if (id === itemId) addItems([item], false);
        }
      }
    } catch { /* The DOM card remains available if this site's component shape changes. */ }
  }

  function finish(id) {
    const card = dom.get(id) || {};
    const embedded = metadata.get(id) || {};
    const data = { ...embedded, ...filled(card) };
    const canonicalUrl = origin + "/explore/" + id;
    const isOwner = profile && (data.authorId === profile.id || (!data.authorId && postedPane));
    const authorId = data.authorId || (isOwner ? profile.id : "");
    const authorCanonical = authorId ? origin + "/user/profile/" + authorId : "";
    const authorLink = bestLink(card.authorUrl, embedded.authorUrl, isOwner ? profile.url : "", authorCanonical);
    const likeDisplay = card.likeDisplay || embedded.likeDisplay || "";
    const likeCount = embedded.likeCount ?? card.likeCount ?? null;
    const amount = likeDisplay.replace(/[,，\s]/g, "").match(/^(\d+(?:\.\d+)?)(万|亿|[kKmMwW])?(\+)?$/);
    const multiplier = { "万": 1e4, "亿": 1e8, k: 1e3, m: 1e6, w: 1e4 };
    const referenceCount = likeCount ?? (amount ? Math.round(Number(amount[1]) * (multiplier[(amount[2] || "").toLowerCase()] || 1)) : null);
    const precision = likeCount !== null ? "精确" : amount?.[3] ? "下限" : amount?.[2] ? "约数" : "";
    return {
      ...data, id, canonicalUrl, noteUrl: card.noteUrl || bestLink(embedded.noteUrl, canonicalUrl),
      _noteUrlFromCard: !!card.noteUrl,
      authorId, authorCanonical, authorName: data.authorName || (isOwner ? profile.name : ""),
      authorUrl: authorLink, authorCardUrl: card.authorUrl && card.authorUrl !== authorLink ? card.authorUrl : "",
      avatarUrl: data.avatarUrl || (isOwner ? profile.avatar : ""),
      avatarUrls: unique([card.avatarUrl, embedded.avatarUrl, isOwner ? profile.avatar : ""]),
      coverUrls: unique([card.coverUrl, ...asList(embedded.coverUrls)]),
      type: embedded.type || card.type || "", pinned: embedded.pinned ?? card.pinned ?? null,
      likeDisplay, likeCount, referenceCount, precision, rendered: dom.has(id),
      source: dom.has(id) ? metadata.has(id) ? "卡片＋页面数据" : "卡片" : "仅页面数据"
    };
  }
  const notes = unique([...dom.keys(), ...metadata.keys()]).map(finish);
  return {
    page: { kind, name: heading, section, keyword, url: cleanPage.href, title: document.title, scopeKey },
    capturedAt: new Date().toISOString(), profile, notes, warnings: [...warnings]
  };
})();
