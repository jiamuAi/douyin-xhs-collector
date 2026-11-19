// Read rendered work cards in the active Douyin list.
(() => {
  "use strict";
  if (globalThis.douyinCollector) return;
  const workLinks = 'a[href*="/video/"], a[href*="/note/"], a[href*="/article/"]';
  const searchCards = "#search-result-container .search-result-card";
  const profileCards = '[data-e2e="user-post-list"] li';
  const clean = value => (value || "").replace(/\s+/g, " ").trim();
  const text = el => clean(el?.innerText || el?.textContent);
  const visible = el => el.getClientRects().length > 0 &&
    !el.closest('[hidden], [aria-hidden="true"], [role="dialog"]') &&
    el.checkVisibility?.({ visibilityProperty: true }) !== false;
  function http(raw) {
    if (!raw) return "";
    try {
      const url = new URL(raw, location.href);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  function siteLink(el, pattern) {
    const href = http(el?.getAttribute("href"));
    if (!href) return null;
    const url = new URL(href);
    if (!/^(www\.)?douyin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(pattern);
    return match ? { url, match } : null;
  }
  function metric(display) {
    const m = clean(display).replace(/[,，\s]/g, "").match(/^(\d+(?:\.\d+)?)(万|亿)?(\+)?$/);
    if (!m) return { display: "", exact: null, sort: null, precision: "" };
    const sort = Math.round(Number(m[1]) * ({ 万: 10000, 亿: 100000000 }[m[2]] || 1));
    return { display: clean(display), exact: m[2] || m[3] ? null : sort, sort,
      precision: m[3] ? "下限" : m[2] ? "约数" : "精确" };
  }
  function imgUrl(el) {
    return http(el?.currentSrc || el?.getAttribute("src") || el?.getAttribute("data-src"));
  }
  function profileInfo(id, url) {
    const scope = document.querySelector('#user_detail_element');
    const head = scope?.querySelector('[data-e2e="user-info"]');
    if (!head || !visible(head)) return null;
    const name = text(head.querySelector("h1"));
    if (!name) return null;
    const content = head.innerText || head.textContent;
    const interactions = {};
    for (const [key, label] of [["follow", "关注"], ["fans", "粉丝"], ["like", "获赞"]]) {
      const m = metric(text(head.querySelector('[data-e2e="user-info-' + key + '"]')).replace(label, ""));
      if (m.display) interactions[label] = { display: m.display, exact: m.exact };
    }
    const avatar = Array.from(scope.querySelectorAll("img[alt]")).find(img => img.alt === name + "头像");
    const count = text(scope.querySelector('#semiTabpost [data-e2e="user-tab-count"]'));
    return { id, name, url: url.href, canonicalUrl: url.origin + url.pathname, avatar: imgUrl(avatar),
      douyinId: content.match(/抖音号\s*[:：]\s*([\w.-]+)/)?.[1] || "",
      region: content.match(/IP属地\s*[:：]\s*([^\s]+)/)?.[1] || "",
      postedCount: metric(count).exact, interactions, receivedLikes: interactions["获赞"]?.exact ?? null,
      receivedLikesDisplay: interactions["获赞"]?.display || "" };
  }
  const clockLabel = /^(?:\d{1,2}:)?\d{1,3}:[0-5]\d$/;
  const searchDate = /^(?:刚刚|昨天|今天|前天|\d+\s*(?:秒钟?|分钟|小时|天|周|个?月|年)前|(?:\d{4}[-年/.])?\d{1,2}[-月/.]\d{1,2}日?)$/;
  function readCard(card, anchor, work, profile) {
    const shot = anchor.querySelector(".videoImage") || anchor;
    const image = shot.querySelector("img");
    const authorLink = Array.from(card.querySelectorAll('a[href*="/user/"]'))
      .map(a => ({ a, link: siteLink(a, /^\/user\/([\w-]+)\/?$/) })).find(v => v.link && v.link.match[1] !== "self");
    // The video-search layout puts title, @nickname and the displayed date together below the cover.
    const mention = Array.from(anchor.querySelectorAll("span")).find(el => !el.children.length && text(el) === "@");
    const byline = mention?.parentElement;
    const caption = byline?.parentElement?.previousElementSibling;
    const name = profile?.name || text(authorLink?.a) || text(byline).replace(/^@\s*/, "");
    const title = text(anchor.querySelector('[data-e2e="video-desc"], p, h3')) || text(caption) ||
      (name && image?.alt?.startsWith(name + "：") ? image.alt.slice(name.length + 1) : clean(image?.alt)) || clean(anchor.getAttribute("title"));
    const likeNode = anchor.querySelector('[data-e2e="like-count"], .author-card-user-video-like, .user-video-stats-ta svg + span, .videoImage svg + span');
    const like = metric(text(likeNode));
    const leaves = Array.from(anchor.querySelectorAll("span,div,time")).filter(el => !el.children.length);
    const duration = leaves.map(text).find(s => clockLabel.test(s));
    const published = text(byline?.nextElementSibling).replace(/^[·•]\s*/, "");
    const pinned = !!anchor.querySelector('.user-video-tag') && leaves.some(el => text(el) === "置顶");
    const profileUrl = authorLink?.link.url;
    return { id: work.id, title, type: work.type,
      noteUrl: work.url.href, _noteUrlFromCard: work.original, canonicalUrl: work.url.origin + work.url.pathname,
      authorName: name, authorId: profile?.id || authorLink?.link.match[1] || "",
      authorUrl: profile?.url || profileUrl?.href || "", authorCanonical: profile?.canonicalUrl || (profileUrl ? profileUrl.origin + profileUrl.pathname : ""),
      avatarUrl: profile?.avatar || imgUrl(authorLink?.a.querySelector("img")), coverUrl: imgUrl(image),
      coverWidth: image?.naturalWidth || null, coverHeight: image?.naturalHeight || null,
      likeDisplay: like.display, likeCount: like.exact, referenceCount: like.sort, precision: like.precision,
      durationSeconds: duration ? duration.split(":").reduce((sum, v) => sum * 60 + Number(v), 0) : null,
      publishedDisplay: searchDate.test(published) ? published : "",
      pinned: pinned || null, badges: pinned ? ["置顶"] : [], tags: title.match(/#[^#\s]+/gu) || [],
      source: "卡片", rendered: true };
  }
  function readPlayerCard(card, player) {
    const id = player.getAttribute("data-e2e-vid");
    if (!/^\d+$/.test(id)) return null;
    const authorLinks = Array.from(card.querySelectorAll('a[href*="/user/"]'));
    const author = authorLinks.find(el => el.querySelector("p")) || authorLinks.find(el => text(el));
    const home = siteLink(author, /^\/user\/([\w-]+)\/?$/);
    const cover = card.querySelector("div.hidden > img[alt]");
    const photo = !!player.querySelector('[id^="ic_home_note_svg"], [data-e2e="note-image"]');
    const noteUrl = location.origin + (photo ? "/note/" : "/video/") + id;
    const like = metric(text(player.querySelector('[data-e2e="video-player-digg"]')));
    const title = clean(cover?.alt);
    const published = text(author?.nextElementSibling).replace(/^[·•]\s*/, "");
    const result = { id, title, type: photo ? "图文" : "视频", noteUrl, canonicalUrl: noteUrl, _noteUrlFromCard: false,
      authorId: home?.match[1] || "", authorName: text(author), authorUrl: home?.url.href || "",
      authorCanonical: home ? home.url.origin + home.url.pathname : "",
      avatarUrl: imgUrl(card.querySelector('[data-e2e="live-avatar"] img')), coverUrl: imgUrl(cover),
      likeDisplay: like.display, likeCount: like.exact, referenceCount: like.sort, precision: like.precision,
      publishedDisplay: searchDate.test(published) ? published : "", tags: title.match(/#[^#\s]+/gu) || [],
      rendered: true, source: "卡片" };
    const duration = player.querySelector("video")?.duration;
    if (Number.isFinite(duration)) result.durationSeconds = Math.round(duration);
    for (const [key, marker] of [["comment", "feed-comment-icon"], ["save", "video-player-collect"], ["share", "video-player-share"]]) {
      const count = metric(text(player.querySelector('[data-e2e="' + marker + '"]')));
      if (count.display) result[key + "Display"] = count.display;
      if (count.exact != null) result[key + "Count"] = count.exact;
    }
    return result;
  }
  let scrollAnchor = null;
  let lastProfile = null;
  function capture(carouselIds = []) {
    scrollAnchor = null;
    const url = new URL(location.href);
    url.username = "";
    url.password = "";
    if (/验证码中间页|安全验证/.test(document.title) || document.querySelector('iframe[src*="/verifycenter/captcha/"]')) {
      throw new Error("抖音要求完成页面验证。请在网页中完成验证，再打开插件采集。");
    }
    const who = url.pathname.match(/^\/user\/([\w-]+)\/?$/);
    const search = url.pathname.match(/^\/(?:(?:jingxuan|root)\/)?search\/([^/]+)\/?$/);
    const type = url.searchParams.get("type") || "general";
    if (!/^(www\.)?douyin\.com$/i.test(url.hostname) || (!who && !search) || url.searchParams.has("modal_id"))
      throw new Error("请打开抖音博主主页的「作品」或搜索结果列表，先关闭单条作品。");
    if (who && (who[1] === "self" || document.querySelector('#semiTabpost[aria-selected="false"], #semiTabvideo[aria-selected="false"]')))
      throw new Error("请打开公开博主主页并切换到「作品」列表。");
    if (search && !["general", "video"].includes(type)) throw new Error("请切换到抖音搜索的「综合」或「视频」结果。");
    const profile = who ? (profileInfo(who[1], url) || (lastProfile?.id === who[1] ? lastProfile : null)) : null;
    lastProfile = profile;
    const byId = new Map();
    const carouselWorks = new Map();
    function add(el, record) {
      const old = byId.get(record.id);
      if (!old || (!old._noteUrlFromCard && record._noteUrlFromCard)) byId.set(record.id, record);
      else if (old === carouselWorks.get(record.id)) old.publishedDisplay ||= record.publishedDisplay;
      scrollAnchor ||= el;
    }
    let unresolved = 0;
    for (const card of document.querySelectorAll(who ? profileCards : searchCards)) {
      if (!visible(card)) continue;
      const strip = search && type === "general" && card.querySelector(".cs-scroller-content");
      const ownerLink = strip && Array.from(card.querySelectorAll('a[href*="/user/"]')).find(a =>
        !strip.contains(a) && text(a) && siteLink(a, /^\/user\/([\w-]+)\/?$/));
      if (strip && (ownerLink || card.querySelector('[data-e2e="live-avatar"]'))) {
        for (const item of strip.querySelectorAll(".cs-scroller-item")) {
          if (!visible(item)) continue;
          const cover = item.querySelector(".videoImage");
          const title = text(cover?.parentElement?.nextElementSibling);
          const original = Array.from(item.querySelectorAll(workLinks)).filter(visible)
            .map(a => siteLink(a, /^\/(video|note|article)\/(\d+)\/?$/)).find(Boolean);
          const coverUrl = imgUrl(cover?.querySelector("img"));
          const matches = carouselIds.filter(row => row.group === card.parentElement?.id &&
            row.title === title && row.cover === coverUrl);
          const bound = matches.length === 1 ? matches[0] : null;
          const id = original?.match[2] || bound?.id;
          if (!id) { if (cover && title) unresolved++; continue; }
          const route = original?.match[1] || bound.route;
          const url = original?.url || new URL("/" + route + "/" + id, location.origin);
          const work = readCard(card, item, { id, url, type: { video: "视频", note: "图文", article: "文章" }[route],
            original: !!original }, null);
          if (title) { work.title = title; work.tags = title.match(/#[^#\s]+/gu) || []; }
          work.authorName ||= text(ownerLink);
          carouselWorks.set(id, work);
          add(item, work);
        }
        continue;
      }
      let linked = false;
      for (const a of card.querySelectorAll(workLinks)) {
        const work = siteLink(a, /^\/(video|note|article)\/(\d+)\/?$/);
        if (!work || !visible(a)) continue;
        linked = true;
        let type = { video: "视频", note: "图文", article: "文章" }[work.match[1]];
        if (type === "视频" && a.querySelector('[id^="ic_home_note_svg"]')) type = "图文";
        add(a, readCard(card, a, { url: work.url, id: work.match[2], type, original: true }, profile));
      }
      // General search uses clickable divs. Related-search tiles also have numeric IDs,
      // so require the rendered media cover and a positive video/photo indicator.
      if (linked || !search || strip?.querySelector?.(".cs-scroller-item .videoImage")) continue;
      const player = card.querySelector('[data-e2e-vid][data-e2e="feed-video"], [data-e2e-vid][data-e2e="feed-active-video"]');
      if (player) {
        const work = readPlayerCard(card, player);
        if (work) add(card, work);
        continue;
      }
      const id = card.parentElement?.id.match(/^waterfall_item_(\d+)$/)?.[1];
      const cover = card.querySelector(".videoImage");
      if (!id || !cover || !visible(cover)) continue;
      const labels = Array.from(cover.querySelectorAll("div,span")).filter(el => !el.children.length).map(text);
      const photo = labels.includes("图文") || !!cover.querySelector('[id^="ic_home_note_svg"]');
      if (!photo && !labels.some(s => clockLabel.test(s))) continue;
      const url = new URL((photo ? "/note/" : "/video/") + id, location.origin);
      add(card, readCard(card, card, { url, id, type: photo ? "图文" : "视频", original: false }, null));
    }
    const notes = Array.from(byId.values());
    for (const note of notes) {
      const tile = carouselWorks.get(note.id);
      if (tile && tile !== note) {
        for (const key of ["authorName", "authorId", "authorUrl", "authorCanonical", "avatarUrl"])
          note[key] ||= tile[key];
      }
    }
    let keyword = "";
    if (search) { try { keyword = decodeURIComponent(search[1]); } catch { keyword = search[1]; } }
    const warnings = [];
    if (notes.some(n => n.authorName && !n.authorId)) warnings.push("仅有昵称的博主保留在作品行，有主页标识的博主才计入博主表");
    if (unresolved) warnings.push("横排中有 " + unresolved + " 项暂未识别到作品链接，可待页面加载后重新扫描");
    return { capturedAt: new Date().toISOString(),
      page: { platform: "douyin", kind: who ? "profile" : "search", name: who ? "博主主页" : "搜索页",
        section: who ? "作品" : type === "video" ? "视频" : "综合", keyword, title: document.title, url: url.href,
        scopeKey: ["douyin", url.pathname, who ? "post" : type].join("|") },
      profile, notes, warnings };
  }
  async function captureList() {
    const url = new URL(location.href);
    if (/^\/(?:(?:jingxuan|root)\/)?search\/[^/]+\/?$/.test(url.pathname) &&
        (url.searchParams.get("type") || "general") === "general" &&
        document.querySelector(searchCards + " .cs-scroller-item")) {
      const rows = await chrome.runtime.sendMessage({ type: "read-douyin-carousel" });
      return capture(Array.isArray(rows) ? rows : []);
    }
    return capture();
  }
  globalThis.douyinCollector = { capture, captureList, scrollAnchor: () => scrollAnchor };
})();
