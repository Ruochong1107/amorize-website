// 每日买菜助手 · 云同步接口
// GET  /api/state?key=xxx   读取
// POST /api/state?key=xxx   保存（body = JSON）
// 需带 x-auth 头（页面密码指纹），挡路人
module.exports = async function (req, res) {
  var AUTH = "1a2nw1x";
  var base = process.env.KV_REST_API_URL;
  var token = process.env.KV_REST_API_TOKEN;
  res.setHeader("Cache-Control", "no-store");
  if (!base || !token) return res.status(200).json({ ok: false, reason: "no_kv" });
  var auth = req.headers["x-auth"];
  if (auth !== AUTH) return res.status(403).json({ ok: false, reason: "forbidden" });
  var key = String((req.query && req.query.key) || "").replace(/[^\w.:-]/g, "");
  if (!key) return res.status(400).json({ ok: false, reason: "no_key" });
  var rkey = "mama:" + key;
  try {
    if (req.method === "GET") {
      var r = await fetch(base + "/get/" + encodeURIComponent(rkey), {
        headers: { Authorization: "Bearer " + token }
      });
      var d = await r.json();
      var data = null;
      if (d && d.result) { try { data = JSON.parse(d.result); } catch (e) { data = d.result; } }
      return res.status(200).json({ ok: true, data: data });
    }
    if (req.method === "POST") {
      var body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
      if (body.length > 100000) return res.status(413).json({ ok: false, reason: "too_big" });
      await fetch(base + "/set/" + encodeURIComponent(rkey), {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        body: body
      });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ ok: false, reason: "method" });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: "error", message: String(e && e.message || e) });
  }
};
