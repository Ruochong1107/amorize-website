// 每日买菜助手 · 云同步接口 v2
// GET  /api/state?key=xxx                    读取（x-auth 头 或 k= 参数鉴权）
// POST /api/state?key=xxx                    保存（body = JSON）
// GET  /api/state?key=xxx&setb64=...         保存（值 = base64url(UTF-8 JSON)，供定时管道用）
// GET  /api/state?key=xxx&appendb64=...      向数组键追加一条（带 d 字段自动去重，供归档用）
module.exports = async function (req, res) {
  var AUTH = "1a2nw1x";
  var base = process.env.KV_REST_API_URL;
  var token = process.env.KV_REST_API_TOKEN;
  res.setHeader("Cache-Control", "no-store");
  if (!base || !token) return res.status(200).json({ ok: false, reason: "no_kv" });
  var q = req.query || {};
  var auth = req.headers["x-auth"] || q.k;
  if (auth !== AUTH) return res.status(403).json({ ok: false, reason: "forbidden" });
  var key = String(q.key || "").replace(/[^\w.:-]/g, "");
  if (!key) return res.status(400).json({ ok: false, reason: "no_key" });
  var rkey = "mama:" + key;
  function b64d(s) {
    return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  }
  async function kvGet() {
    var r = await fetch(base + "/get/" + encodeURIComponent(rkey), { headers: { Authorization: "Bearer " + token } });
    var d = await r.json();
    var data = null;
    if (d && d.result) { try { data = JSON.parse(d.result); } catch (e) { data = d.result; } }
    return data;
  }
  async function kvSet(body) {
    if (body.length > 900000) throw new Error("too_big");
    await fetch(base + "/set/" + encodeURIComponent(rkey), {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: body
    });
  }
  try {
    if (req.method === "GET" && q.setb64) {
      var val = b64d(q.setb64);
      JSON.parse(val);
      await kvSet(val);
      return res.status(200).json({ ok: true, wrote: key, bytes: val.length });
    }
    if (req.method === "GET" && q.appendb64) {
      var entryRaw = b64d(q.appendb64);
      var entry = JSON.parse(entryRaw);
      var arr = await kvGet();
      if (!Array.isArray(arr)) arr = [];
      if (entry && entry.d) {
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] && arr[i].d === entry.d) return res.status(200).json({ ok: true, skipped: "dup", count: arr.length });
        }
      }
      arr.push(entry);
      await kvSet(JSON.stringify(arr));
      return res.status(200).json({ ok: true, appended: key, count: arr.length });
    }
    if (req.method === "GET") {
      var data = await kvGet();
      return res.status(200).json({ ok: true, data: data });
    }
    if (req.method === "POST") {
      var body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
      if (body.length > 900000) return res.status(413).json({ ok: false, reason: "too_big" });
      await kvSet(body);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ ok: false, reason: "method" });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: "error", message: String(e && e.message || e) });
  }
};
