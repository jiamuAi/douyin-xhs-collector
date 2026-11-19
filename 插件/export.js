"use strict";

const NoteExport = (() => {
  const noteColumns = [
    ["title", "笔记标题", 48], ["authorName", "博主昵称", 20], ["type", "笔记类型", 12],
    ["likeDisplay", "点赞显示", 13], ["likeCount", "精确点赞数", 14], ["referenceCount", "点赞排序值", 14],
    ["precision", "数值口径", 12], ["noteUrl", "笔记链接", 43, "link"], ["authorUrl", "博主主页链接", 40, "link"],
    ["coverUrl", "卡片封面链接", 41, "link"], ["avatarUrl", "卡片头像链接", 37, "link"],
    ["id", "笔记 ID", 30], ["authorId", "博主 ID", 30], ["coverWidth", "封面宽（像素）", 16],
    ["coverHeight", "封面高（像素）", 16], ["durationSeconds", "视频时长（秒）", 16],
    ["pinned", "是否置顶", 11], ["publishedAt", "发布时间（北京时间）", 25, "date"],
    ["updatedAt", "更新时间（北京时间）", 25, "date"], ["saveCount", "收藏数", 13],
    ["commentCount", "评论数", 13], ["shareCount", "分享数", 13], ["description", "笔记正文或摘要", 53],
    ["tags", "话题", 28], ["badges", "卡片标签", 22], ["noteRegion", "笔记公开属地", 16],
    ["imageCount", "图片数", 11], ["coverUrls", "封面各规格链接", 46],
    ["imageUrls", "笔记图片链接", 46], ["videoUrls", "视频链接", 46],
    ["canonicalUrl", "笔记基础链接", 38, "link"], ["authorCanonical", "博主基础链接", 38, "link"],
    ["listIndex", "页面索引（从 0 起）", 22], ["source", "数据来源", 20],
    ["avatarUrls", "头像各规格链接", 40], ["authorCardUrl", "卡片原始主页链接（有差异时）", 39, "link"]
  ];
  const authorColumns = [
    ["name", "博主昵称", 24], ["id", "博主 ID", 30], ["url", "博主主页链接", 46, "link"],
    ["avatar", "头像链接", 44, "link"], ["notesInExport", "本次笔记数", 15],
    ["redId", "小红书号", 20], ["bio", "简介", 56], ["region", "IP 属地", 14], ["tags", "公开标签", 24],
    ["followingDisplay", "关注显示", 13], ["followingExact", "精确关注数", 14],
    ["fansDisplay", "粉丝显示", 13], ["fansExact", "精确粉丝数", 15],
    ["engagementDisplay", "获赞与收藏显示", 18], ["engagementExact", "精确获赞与收藏", 18],
    ["receivedLikes", "获赞数", 14], ["receivedSaves", "获收藏数", 14],
    ["postedCount", "主页发布数", 15], ["canonicalUrl", "博主基础链接", 40, "link"]
  ];
  function labels(page) {
    return page?.platform === "douyin" ? { platform: "抖音", item: "作品" } : { platform: "小红书", item: "笔记" };
  }
  function sheets(payload) {
    const { item, platform } = labels(payload.page);
    const works = noteColumns.map(([key, name, ...rest]) => [key, name.replace("笔记", item), ...rest]);
    let people = authorColumns;
    if (platform === "抖音") {
      works.splice(works.findIndex(([key]) => key === "precision") + 1, 0, ["publishedDisplay", "发布时间（页面显示）", 22]);
      if (payload.notes.some(n => n.linkSource === "按卡片作品 ID 生成")) works.push(["linkSource", "作品链接来源", 20]);
      works.push(["saveDisplay", "收藏显示", 14],
        ["commentDisplay", "评论显示", 14], ["shareDisplay", "分享显示", 14]);
      people = authorColumns.map(([key, name, ...rest]) => [key, name.replace("笔记", item), ...rest])
        .concat([["douyinId", "抖音号", 24], ["receivedLikesDisplay", "获赞显示", 16]]);
    }
    return [["notes", item, item + " ID", works, payload.notes],
      ["authors", "博主", "博主 ID", people, payload.authors]];
  }
  function authors(notes, profile) {
    const map = new Map();
    if (profile) {
      const a = { ...profile, notesInExport: 0 };
      for (const [key, name] of [["following", "关注"], ["fans", "粉丝"], ["engagement", "获赞与收藏"]]) {
        const metric = profile.interactions?.[name];
        a[key + "Display"] = metric?.display ?? "";
        a[key + "Exact"] = metric?.exact ?? null;
      }
      map.set(profile.id, a);
    }
    for (const n of notes) {
      const key = n.authorId || n.authorUrl || n.authorCanonical;
      if (!key) continue;
      const a = map.get(key) || { notesInExport: 0 };
      a.id ||= n.authorId;
      a.name ||= n.authorName;
      a.url ||= n.authorUrl;
      a.canonicalUrl ||= n.authorCanonical;
      a.avatar ||= n.avatarUrl;
      a.notesInExport++;
      map.set(key, a);
    }
    return [...map.values()];
  }
  function prepare(snapshot) {
    const notes = snapshot.notes.filter(n => n.rendered).map(n => {
      const { _noteUrlFromCard, ...record } = n;
      if (snapshot.page.platform === "douyin") record.linkSource = _noteUrlFromCard ? "卡片原始链接" : "按卡片作品 ID 生成";
      return { ...record, likeCount: n.likeCount ?? null, referenceCount: n.referenceCount ?? null, pinned: n.pinned ?? null };
    });
    const { scopeKey, ...page } = snapshot.page;
    return {
      schemaVersion: 1, capturedAt: snapshot.capturedAt, page,
      scope: "已展示的卡片",
      count: notes.length, renderedCount: notes.filter(n => n.rendered).length,
      preloadedCount: notes.filter(n => !n.rendered).length,
      profile: snapshot.profile, authors: authors(notes, snapshot.profile), notes,
      warnings: snapshot.warnings || []
    };
  }
  function localTime(iso) {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).format(new Date(iso));
  }
  function filename(payload, suffix) {
    const name = (payload.profile?.name || payload.page.keyword || payload.page.section || labels(payload.page).item)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").slice(0, 32);
    const time = localTime(payload.capturedAt).replaceAll("-", "").replaceAll(":", "").replace(" ", "-");
    return [labels(payload.page).platform, payload.page.name, name, time, payload.count + "条"].filter(Boolean).join("-") + "." + suffix;
  }
  function cellValue(value, format) {
    if (Array.isArray(value)) value = value.join("\n").slice(0, 32767);
    if (value == null || typeof value === "string" && !value.trim()) return null;
    if (format === "date") return localTime(value);
    if (format === "link" && typeof value === "string" && /^https?:\/\//.test(value)) {
      return { text: value, hyperlink: value };
    }
    if (typeof value === "boolean") return value ? "是" : "否";
    // Workbook strings are literal cells, including names/titles beginning with "=".
    return typeof value === "string" ? value.slice(0, 32767) : value;
  }
  function setSheet(sheet, columns, records) {
    const populatedColumns = columns.filter(([key,,,format]) =>
      records.some(record => cellValue(record[key], format) !== null));
    if (!populatedColumns.length) return;
    sheet.columns = populatedColumns.map(([,header,width]) => ({ header, width }));
    sheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];
    for (const [i, record] of records.entries()) {
      const row = sheet.addRow(populatedColumns.map(([key,,,format]) => cellValue(record[key], format)));
      row.height = 25;
      row.eachCell(cell => {
        cell.alignment = { vertical: "middle" };
        if (i % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F5F2" } };
        if (cell.hyperlink) cell.font = { name: "Arial", size: 10, color: { argb: "FF256473" }, underline: true };
      });
    }
    const header = sheet.getRow(1);
    header.height = 28;
    header.eachCell(cell => {
      cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF85353C" } };
      cell.alignment = { vertical: "middle" };
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: records.length + 1, column: populatedColumns.length } };
  }
  // Shared populated-column schema; Feishu applies its own select/reserved columns.
  function tables(payload) {
    return sheets(payload).map(([key, name, idField, columns, records]) => ({
      key, name, idField, records, platform: labels(payload.page).platform,
      columns: columns.filter(([key,,,format]) => records.some(row => cellValue(row[key], format) !== null))
        .map(([key, name,,format]) => ({ key, name, format,
          type: format === "date" ? 5 : format === "link" ? 15 :
            records.some(row => typeof row[key] === "boolean") ? 7 :
            records.some(row => typeof row[key] === "number") &&
              records.every(row => row[key] == null || row[key] === "" || typeof row[key] === "number") ? 2 : 1
        }))
    })).filter(table => table.records.length);
  }
  async function workbook(payload) {
    const book = new ExcelJS.Workbook();
    book.creator = "内容采集夹";
    for (const [, name,, columns, records] of sheets(payload)) setSheet(book.addWorksheet(name), columns, records);
    const rows = [
      ["来源页面", payload.page.title], ["页面地址", payload.page.url], ["页面类型", payload.page.name],
      ["栏目或关键词", payload.page.keyword || payload.page.section], ["采集时间（北京时间）", localTime(payload.capturedAt)],
      ["导出范围", payload.scope], [labels(payload.page).item + "数", payload.count], ["已展示的卡片", payload.renderedCount], ["仅页面预载", payload.preloadedCount],
      ["点赞排序值", "精确值优先。页面仅给出 1.1万 时记为约 11000，10万+ 记为下限 100000。"],
      ["空白字段", "采集时页面没有提供可确认的值。"],
      ["列的保留规则", "本次导出中至少有一条有效数据的列才会出现。数字 0 和“否”均属于有效数据。"],
      ["媒体链接", "保留采集当时页面给出的地址，部分封面或视频地址可能过期。"]
    ];
    for (const message of payload.warnings) rows.push(["采集提示", message]);
    const info = book.addWorksheet("采集说明");
    setSheet(info, [["item", "项目", 27], ["value", "内容", 96]], rows.map(([item, value]) => ({ item, value })));
    info.getCell("B3").value = cellValue(payload.page.url, "link");
    return book.xlsx.writeBuffer();
  }
  return { prepare, filename, workbook, tables, labels };
})();
