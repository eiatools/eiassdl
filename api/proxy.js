// /api/proxy.js

export default async function handler(req, res) {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).send("Missing url parameter");

    // ----- 호스트 추출 -----
    let host = "";
    try {
      host = new URL(raw).hostname;           // https:// 포함해도 안전
    } catch {
      return res.status(400).send("Bad url");
    }

    // ----- 허용 도메인 (www·서브도메인·포트 모두 허용) -----
    const allow = /^([a-z0-9-]+\\.)*eiass\\.go\\.kr$/i;
    if (!allow.test(host)) return res.status(403).send("Forbidden host");

    // ----- 원본 요청 전달 -----
    const upstream = await fetch(raw, {
      method: req.method,
      headers: {
        ...req.headers,
        host                : host,          // EIASS가 host 헤더 검사할 경우 대비
        "x-forwarded-for"   : req.headers["x-forwarded-for"] || req.socket.remoteAddress
      },
      body:
        ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
    });

    // ----- 헤더 필터링 -----
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower === "x-frame-options" || lower.startsWith("content-security")) return;
      res.setHeader(k, v);
    });

    // ----- 응답 전달 -----
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
}
