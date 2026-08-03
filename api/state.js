// 每日买菜助手 · 云同步接口 v5
// v5 新增：archive 时按实际菜单×小份食材确定性扣减库存（负流水 🍳M/D 标签，同项同日防重）
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
  var WHON = { wife: "老婆", husb: "老公", nanny: "保姆", dogs: "狗狗" };
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
      ["wife", "husb", "nanny", "dogs"].forEach(function (p) {
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
      var habits = await kvGet("habits-data");
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
            ["wife", "husb", "nanny", "dogs"].forEach(function (p) {
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
      if (Array.isArray(habits) && habits.length) {
        L.push("[固定习惯] " + habits.map(function (h) { return (h.who || "?") + "：" + (h.text || ""); }).join("；"));
      } else {
        L.push("[固定习惯] 未设置，按默认值兜底（见 trigger 说明）");
      }
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
      // v4: 订单识别兜底 —— 归档日（及更早）仍未被页面消费的识别结果，直接合并进 inv-data 并计入当日采购
      var ordAdd = [];
      try {
        var oinbox = await kvGet("order-inbox");
        if (Array.isArray(oinbox) && oinbox.length) {
          var dnum = function (s) { var p = String(s || "").split("-"); return (+p[0] || 0) * 10000 + (+p[1] || 0) * 100 + (+p[2] || 0); };
          var CLS = [
            ["肉蛋海鲜", /肉|蛋(?!糕)|鱼|虾|蟹|螺|蛏|鲍|贝|鸡|鸭|鹅|牛|猪|羊|蹄|排骨|香肠|腊肠|腊肉|火腿|培根|鱿|海参/],
            ["主食", /面包|贝果|吐司|馒头|包子|饺|面条|米饭|年糕|莜面|玉米|燕麦|麦片|粉丝|米粉|挂面/],
            ["豆类与杂粮", /豆$|豆腐|豆干|豆皮|腐竹|花生|莲子|薏米|小米|糙米|藜麦|芝麻|杂粮/],
            ["水果", /苹果|香蕉|橙|橘|柚|桃|李子|梨|莓|葡萄|樱桃|荔枝|龙眼|芒果|菠萝|猕猴桃|火龙果|西瓜|哈密瓜|甜瓜|柿|石榴/],
            ["滋补", /人参|黄芪|枸杞|红枣|桂圆|燕窝|阿胶|石斛|虫草|天麻|当归|茯苓/],
            ["调味与香料", /油$|盐|糖$|醋|酱|生抽|老抽|蚝油|料酒|花椒|八角|桂皮|香叶|胡椒|味精|鸡精|淀粉|香油/],
            ["蔬菜", /菜|瓜|茄|椒|葱|蒜|姜|萝卜|芹|笋|藕|山药|土豆|红薯|紫薯|番茄|西红柿|豆角|豇豆|毛豆|苗$|生|韭|蘑|菇|木耳|银耳|海带/]
          ];
          var eatO = [], keepO = [];
          oinbox.forEach(function (o) {
            if (o && o.status === "parsed" && Array.isArray(o.items) && dnum(o.d) <= dnum(aday)) eatO.push(o);
            else keepO.push(o);
          });
          if (eatO.length) {
            var ainv = await kvGet("inv-data");
            if (Array.isArray(ainv) && ainv.length) {
              eatO.forEach(function (o) {
                o.items.forEach(function (m) {
                  var text = String((m && m.t) || "").trim();
                  if (!text) return;
                  var mm = text.match(/^([^0-9０-９]+?)[\s·，,]*([0-9０-９][\s\S]*)$/);
                  var nm = mm ? mm[1].trim() : text, qq = mm ? mm[2].replace(/\s+/g, "") : "?";
                  var tag = qq + "🛒" + shortD(o.d || aday);
                  var hitIt = null;
                  ainv.forEach(function (grp) { (grp.items || []).forEach(function (it) { if (!hitIt && it.n === nm) hitIt = it; }); });
                  if (!hitIt && nm.length >= 2) ainv.forEach(function (grp) { (grp.items || []).forEach(function (it) { if (!hitIt && it.n && it.n.length >= 2 && (String(it.n).indexOf(nm) !== -1 || nm.indexOf(it.n) !== -1)) hitIt = it; }); });
                  if (hitIt && (hitIt.terms || []).indexOf(tag) !== -1) return; // 已有同日同量标记，防重
                  if (hitIt) { hitIt.terms.push(tag); }
                  else {
                    var lab = m.g ? String(m.g).replace(/^\S+\s/, "") : null;
                    if (!lab) for (var ci = 0; ci < CLS.length; ci++) { if (CLS[ci][1].test(nm)) { lab = CLS[ci][0]; break; } }
                    var tgt = null;
                    if (lab) ainv.forEach(function (grp) { if (!tgt && grp.g.indexOf(lab) !== -1) tgt = grp; });
                    if (!tgt) ainv.forEach(function (grp) { if (grp.g.indexOf("其他") !== -1) tgt = grp; });
                    if (!tgt) tgt = ainv[ainv.length - 1];
                    tgt.items.push({ n: nm, terms: [tag] });
                  }
                  ordAdd.push(text);
                });
              });
              await kvSet("inv-data", JSON.stringify(ainv));
              await kvSet("order-inbox", JSON.stringify(keepO));
              result.orders = "absorbed:" + ordAdd.length;
            }
          }
        }
      } catch (eo) { result.orders = "error:" + String((eo && eo.message) || eo); }
      // v5: 消耗扣减 —— 实际菜单(减删菜/外食/不在家)×份数×小份食材 → 聚合后负流水写回 inv-data
      try {
        var rec5 = await kvGet("rec-data");
        var inv5 = await kvGet("inv-data");
        if (amenu && amenu.meals && rec5 && rec5.list && Array.isArray(inv5) && inv5.length) {
          var del5 = (ast && ast.deleted) || {};
          var port5 = (ast && ast.port) || {};
          var ex5 = (ast && ast.extraEats) || [];
          var byId5 = {}; var byName5 = {};
          rec5.list.forEach(function (r) { byId5[r.id] = r; if (r.n) byName5[r.n] = r; });
          var servings = {}; // 菜谱id -> 总小份数
          ["brunch", "second", "dinner"].forEach(function (mk) {
            if (ast && ((mk === "brunch" && ast.awayBrunch) || (mk === "dinner" && ast.awayDinner))) return;
            var mdef5 = amenu.meals[mk] || {};
            ["wife", "husb", "nanny", "dogs"].forEach(function (p) {
              if (ex5.some(function (e) { return e.meal === mk && e.who === p && e.out; })) return; // 外食：该人该顿不消耗
              (mdef5[p] || []).forEach(function (dd) {
                if (del5[dd.id]) return;
                var r5 = dd.r ? byId5[dd.r] : byName5[dd.t];
                if (!r5) return;
                var pp = port5[dd.id]; pp = (pp === 0.5 || pp === 2) ? pp : 1;
                servings[r5.id] = (servings[r5.id] || 0) + pp;
              });
              ex5.forEach(function (e) {
                if (e.meal !== mk || e.who !== p || e.out || !e.r || !byId5[e.r]) return;
                servings[e.r] = (servings[e.r] || 0) + 1; // 加菜(带菜谱)算1小份
              });
            });
          });
          function num5(s) {
            var m5 = String(s).match(/^([0-9]+(?:\.[0-9]+)?)(?:\/([0-9]+))?$/);
            if (!m5) return null;
            var v = parseFloat(m5[1]);
            if (m5[2]) { var dv = parseFloat(m5[2]); if (!dv) return null; v = v / dv; }
            return v;
          }
          function fmt5(v) { return String(Math.round(v * 100) / 100); }
          var need5 = {}; // "食材名|单位" -> 总量
          Object.keys(servings).forEach(function (rid) {
            var r = byId5[rid];
            if (!r || !r.ing) return;
            String(r.ing).split(/｜|\|/).forEach(function (seg) {
              seg = seg.trim();
              if (/^调[：:]/.test(seg)) return; // 调料不扣
              seg = seg.replace(/^配[：:]\s*/, "");
              if (seg.indexOf("共") !== -1) return; // "黄豆、黑豆…共30g" 无法分摊，跳过
              seg.split("、").forEach(function (item) {
                item = item.trim();
                var mm5 = item.match(/^(.+?)\s+([0-9][0-9.\/]*)\s*([^\s0-9]*)$/);
                if (!mm5) return; // 无数量不扣
                var qv = num5(mm5[2]);
                if (qv == null || !mm5[1].trim()) return;
                var k5 = mm5[1].trim() + "|" + (mm5[3] || "");
                need5[k5] = (need5[k5] || 0) + qv * servings[rid];
              });
            });
          });
          var tag5 = "🍳" + shortD(aday);
          var ded5 = 0, miss5 = [];
          Object.keys(need5).forEach(function (k5) {
            var nm5 = k5.split("|")[0], un5 = k5.split("|")[1];
            var hit5 = null;
            inv5.forEach(function (grp) { (grp.items || []).forEach(function (it) { if (!hit5 && it.n === nm5) hit5 = it; }); });
            if (!hit5 && nm5.length >= 2) inv5.forEach(function (grp) { (grp.items || []).forEach(function (it) { if (!hit5 && it.n && it.n.length >= 2 && (String(it.n).indexOf(nm5) !== -1 || nm5.indexOf(it.n) !== -1)) hit5 = it; }); });
            if (!hit5) { if (miss5.indexOf(nm5) === -1) miss5.push(nm5); return; }
            if (!Array.isArray(hit5.terms)) hit5.terms = [];
            if (hit5.terms.some(function (t) { return String(t).indexOf(tag5) !== -1 && String(t).charAt(0) === "-"; })) return; // 同项同日防重
            hit5.terms.push("-" + fmt5(need5[k5]) + un5 + tag5);
            ded5++;
          });
          if (ded5) await kvSet("inv-data", JSON.stringify(inv5));
          result.consume = "deducted:" + ded5 + (miss5.length ? " untracked:" + miss5.join(",") : "");
        } else result.consume = "skip";
      } catch (ec) { result.consume = "error:" + String((ec && ec.message) || ec); }
      // buy-hist
      var bought = [];
      (amenu.buys || []).forEach(function (b) { if (ast && ast[b.k]) bought.push(b.t); });
      ((ast && ast.extraBuys) || []).forEach(function (b) { if (b.c) bought.push(b.t); });
      ordAdd.forEach(function (t) { bought.push(t + "(订单)"); });
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
