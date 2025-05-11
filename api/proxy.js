// /api/proxy.js

export default async function handler(req, res) {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).send("Missing url parameter");

    let host = "";
    try {
      host = new URL(raw).hostname.trim();   // 좌우 공백 제거
    } catch {
      return res.status(400).send("Bad url");
    }

    /* ----- 디버그 ----- */
    console.log("proxy host:", `"${host}"`);  // Vercel 로그에서 확인
    /* ------------------ */

    // ★ 훨씬 느슨하게: ‘eiass.go.kr’로 끝나면 OK
    if (!host.replace(/\.$/, "").toLowerCase().endsWith("eiass.go.kr")) {
      return res.status(403).send("Forbidden host");
    }

    /* 이하 동일 */
    const upstream = await fetch(raw, {
      method: req.method,
      headers: {
        ...req.headers,
        host,
        "x-forwarded-for": req.headers["x-forwarded-for"] || req.socket?.remoteAddress
      },
      body: ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
    });

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower === "x-frame-options" || lower.startsWith("content-security")) return;
      res.setHeader(k, v);
    });

    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
}
