// 每日买菜助手 · 云同步接口 v3
// 基础：GET ?key=xxx 读；POST ?key=xxx 写；GET ?key=xxx&setb64= / &appendb64= 管道写（v2）
// v3 新增（供定时管道用，避免 AI 解析大 JSON）：
//   GET ?digest=1&day=Y-M-D       返回该日纯文本摘要（反馈/记录/库存/菜谱/当日菜单），固定小节标题
//   GET ?archive=Y-M-D            服务器端确定性归档该日（菜单+勾选→buy-hist/eat-hist，按日期去重）
//   GET ?stage=SID&i=N&b64=片段    分段暂存长 b64（片段任意切分）
//   GET ?commitstage=SID&n=总段数&to=键1,键2   合并解码校验后写入目标键，并清理暂存
// 鉴权：x-auth 头 或 k= 参数
module.exports = async function (req, res) {
  var AUTH = "1a2nw1x";
  var base = process.env.KV_REST_API_URL;
  var token = process.env.KV_REST_API_TOKEN;
  res.setHeader("Cache-Control", "no-store");
  if (!base || !token) return res.status(200).json({ ok: false, reason: "no_kv" });
  var q = req.query || {};
  var auth = req.headers["x-auth"] || q.k;
  if (auth !== AUTH) return res.status(403).json({ ok: false, reason: "forbidden" });
  function clean(s) { return String(s || "").replace(/[^\w.:,-]/g, ""); }
  function b64d(s) {
    return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  }
  async function kvGet(key) {
    var r = await fetch(base + "/get/" + encodeURIComponent("mama:" + key), { headers: { Authorization: "Bearer " + token } });
    var d = await r.json();
    var data = null;
    if (d && d.result) { try { data = JSON.parse(d.result); } catch (e) { data = d.result; } }
    return data;
  }
  async function kvSet(key, body) {
    if (body.length > 900000) throw new Error("too_big");
    await fetch(base + "/set/" + encodeURIComponent("mama:" + key), {
      method: "POST", headers: { Authorization: "Bearer " + token }, body: body
    });
  }
  async function kvDel(key) {
    await fetch(base + "/del/" + encodeURIComponent("mama:" + key), {
      method: "POST", headers: { Authorization: "Bearer " + token }
    });
  }
  var MEALN = { brunch: "第一餐", second: "第二餐", dinner: "第三餐", both: "通用" };
  var WHON = { wife: "老婆", husb: "老公", nanny: "保姆" };
  function shortD(ds) { var p = String(ds || "").split("-"); return p.length === 3 ? p[1] + "/" + p[2] : ds; }
  function menuLines(menu, st) {
    // -> [[人+餐, "菜1、菜2"], ...] 减 deleted 加 extraEats(🍱外食)，跳过不在家的餐
    var out = [];
    if (!menu || !menu.meals) return out;
    var del = (st && st.deleted) || {};
    var extras = (st && st.extraEats) || [];
    ["brunch", "second", "dinner"].forEach(function (mk) {
      if (st && ((mk === "brunch" && st.awayBrunch) || (mk === "dinner" && st.awayDinner))) return;
      var mdef = menu.meals[mk] || {};
      ["wife", "husb", "nanny"].forEach(function (p) {
        var names = [];
        (mdef[p] || []).forEach(function (dd) { if (!del[dd.id]) names.push(dd.t); });
        extras.forEach(function (e) { if (e.meal === mk && e.who === p) names.push((e.out ? "🍱" : "") + (e.t || "外食")); });
        if (names.length) out.push([WHON[p] + " " + MEALN[mk], names.join("、")]);
      });
    });
    return out;
  }
  try {
    // ---------- digest ----------
    if (req.method === "GET" && q.digest) {
      var day = clean(q.day);
      var st = day ? await kvGet("mama-" + day) : null;
      var menu = day ? await kvGet("menu-" + day) : null;
      if (!menu) { var mt = await kvGet("menu-today"); if (mt && mt.date === day) menu = mt; }
      var inv = await kvGet("inv-data");
      var rec = await kvGet("rec-data");
      var inbox = await kvGet("rec-inbox");
      var eatHist = await kvGet("eat-hist");
      var L = [];
      L.push("DIGEST v1 day=" + (day || "?"));
      L.push("[反馈] " + ((st && st.fb) ? st.fb : "无") + ((st && st.fbImgs && st.fbImgs.length) ? "（附图" + st.fbImgs.length + "张）" : ""));
      var exE = (st && st.extraEats) || [];
      L.push("[额外吃] " + (exE.length ? exE.map(function (e) { return (e.out ? "🍱" : "") + (e.t || "外食") + "(" + (WHON[e.who] || e.who) + (e.kc ? "," + e.kc + "千卡" : "") + "," + (MEALN[e.meal] || e.meal) + ")"; }).join("; ") : "无"));
      var delNames = [];
      if (st && st.deleted && menu && menu.meals) {
        Object.keys(st.deleted).forEach(function (id) {
          if (!st.deleted[id]) return;
          ["brunch", "second", "dinner"].forEach(function (mk) {
            var mdef = menu.meals[mk] || {};
            ["wife", "husb", "nanny"].forEach(function (p) {
              (mdef[p] || []).forEach(function (dd) { if (dd.id === id) delNames.push(dd.t + "(" + WHON[p] + MEALN[mk] + ")"); });
            });
          });
          if (menu.supp) ["husb", "wife"].forEach(function (p) {
            (menu.supp[p] || []).forEach(function (dd) { if (dd.id === id) delNames.push(dd.t + "(" + WHON[p] + "补剂)"); });
          });
        });
      }
      L.push("[删菜] " + (delNames.length ? delNames.join("; ") : "无"));
      var awayTxt = ((st && st.awayBrunch) ? "第一餐 " : "") + ((st && st.awayDinner) ? "第三餐" : "");
      L.push("[不在家] " + (awayTxt || "无"));
      var buyDone = [];
      if (menu && menu.buys && st) menu.buys.forEach(function (b) { if (st[b.k]) buyDone.push(b.t); });
      ((st && st.extraBuys) || []).forEach(function (b) { if (b.c) buyDone.push(b.t + "(自加)"); });
      L.push("[勾选采买] " + (buyDone.length ? buyDone.join("; ") : "无"));
      L.push("[当日菜单] " + (menu ? ("note=" + (menu.note || "") + " | " + menuLines(menu, null).map(function (ln) { return ln[0] + ":" + ln[1]; }).join(" | ")) : "无"));
      if (inv) {
        var invParts = [];
        inv.forEach(function (grp) {
          var items = [];
          (grp.items || []).forEach(function (it) {
            var pos = (it.terms || []).some(function (t) { return String(t).charAt(0) !== "-"; });
            if (pos) items.push(it.n + (it.terms || []).join(""));
          });
          if (items.length) invParts.push(grp.g.replace(/^\S+\s/, "") + ":" + items.join(","));
        });
        L.push("[库存有货] " + invParts.join(" | "));
      } else L.push("[库存有货] 读取失败");
      if (rec && rec.list) {
        L.push("[菜谱库] " + rec.list.map(function (r) { return r.id + r.n + (r.kc || "?"); }).join(";"));
      } else L.push("[菜谱库] 读取失败");
      var recent = [];
      if (Array.isArray(eatHist)) eatHist.slice(-2).forEach(function (e) {
        recent.push(e.d + ":" + (e.lines || []).map(function (ln) { return ln[1]; }).join("、"));
      });
      L.push("[近两天吃过] " + (recent.length ? recent.join(" | ") : "无"));
      L.push("[导入箱] " + (Array.isArray(inbox) ? inbox.length : 0) + " 条");
      L.push("DIGEST END");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(L.join("\n"));
    }
    // ---------- archive ----------
    if (req.method === "GET" && q.archive) {
      var aday = clean(q.archive);
      var amenu = await kvGet("menu-" + aday);
      var ast = await kvGet("mama-" + aday);
      if (!amenu) return res.status(200).json({ ok: true, skipped: "no_menu", day: aday });
      var dShort = shortD(amenu.date || aday);
      var result = { ok: true, day: dShort };
      // buy-hist
      var bought = [];
      (amenu.buys || []).forEach(function (b) { if (ast && ast[b.k]) bought.push(b.t); });
      ((ast && ast.extraBuys) || []).forEach(function (b) { if (b.c) bought.push(b.t); });
      if (bought.length) {
        var bh = await kvGet("buy-hist");
        if (!Array.isArray(bh)) bh = [];
        if (bh.some(function (e) { return e.d === dShort; })) { result.buy = "dup"; }
        else {
          bh.push({ d: dShort, t: bought.join("、"), n: bought.length + " 样" });
          await kvSet("buy-hist", JSON.stringify(bh));
          result.buy = "appended:" + bought.length;
        }
      } else result.buy = "empty";
      // eat-hist
      var lines = menuLines(amenu, ast);
      if (lines.length) {
        var eh = await kvGet("eat-hist");
        if (!Array.isArray(eh)) eh = [];
        if (eh.some(function (e) { return e.d === dShort; })) { result.eat = "dup"; }
        else {
          eh.push({ d: dShort, lines: lines });
          await kvSet("eat-hist", JSON.stringify(eh));
          result.eat = "appended:" + lines.length + "行";
        }
      } else result.eat = "empty";
      return res.status(200).json(result);
    }
    // ---------- stage / commitstage ----------
    if (req.method === "GET" && q.stage) {
      var sid = clean(q.stage), idx = clean(q.i);
      if (!sid || idx === "") return res.status(400).json({ ok: false, reason: "bad_stage" });
      await kvSet("stage-" + sid + "-" + idx, JSON.stringify({ p: String(q.b64 || "") }));
      return res.status(200).json({ ok: true, staged: sid + "/" + idx, len: String(q.b64 || "").length });
    }
    if (req.method === "GET" && q.commitstage) {
      var csid = clean(q.commitstage);
      var n = parseInt(q.n, 10);
      var to = String(q.to || "").split(",").map(clean).filter(Boolean);
      if (!csid || !(n > 0) || !to.length) return res.status(400).json({ ok: false, reason: "bad_commit" });
      var full = "";
      for (var i = 0; i < n; i++) {
        var part = await kvGet("stage-" + csid + "-" + i);
        if (!part || typeof part.p !== "string") return res.status(200).json({ ok: false, reason: "missing_part", part: i });
        full += part.p;
      }
      var decoded = b64d(full);
      var parsed = JSON.parse(decoded); // 非法 JSON 会抛错，不会写入
      for (var j = 0; j < to.length; j++) await kvSet(to[j], decoded);
      for (var m2 = 0; m2 < n; m2++) await kvDel("stage-" + csid + "-" + m2);
      return res.status(200).json({ ok: true, wrote: to, bytes: decoded.length, date: parsed.date || null, note: parsed.note || null });
    }
    // ---------- v2 基础操作 ----------
    var key = clean(q.key);
    if (req.method === "GET" && q.setb64) {
      if (!key) return res.status(400).json({ ok: false, reason: "no_key" });
      var val = b64d(q.setb64);
      JSON.parse(val);
      await kvSet(key, val);
      return res.status(200).json({ ok: true, wrote: key, bytes: val.length });
    }
    if (req.method === "GET" && q.appendb64) {
      if (!key) return res.status(400).json({ ok: false, reason: "no_key" });
      var entry = JSON.parse(b64d(q.appendb64));
      var arr = await kvGet(key);
      if (!Array.isArray(arr)) arr = [];
      if (entry && entry.d && arr.some(function (e) { return e && e.d === entry.d; })) {
        return res.status(200).json({ ok: true, skipped: "dup", count: arr.length });
      }
      arr.push(entry);
      await kvSet(key, JSON.stringify(arr));
      return res.status(200).json({ ok: true, appended: key, count: arr.length });
    }
    if (req.method === "GET") {
      if (!key) return res.status(400).json({ ok: false, reason: "no_key" });
      var data = await kvGet(key);
      return res.status(200).json({ ok: true, data: data });
    }
    if (req.method === "POST") {
      if (!key) return res.status(400).json({ ok: false, reason: "no_key" });
      var body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
      if (body.length > 900000) return res.status(413).json({ ok: false, reason: "too_big" });
      await kvSet(key, body);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ ok: false, reason: "method" });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: "error", message: String(e && e.message || e) });
  }
};
