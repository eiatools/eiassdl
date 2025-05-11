// /api/proxy.js  (Vercel Edge/Node Serverless Function)

import { parse } from "node:url";

export default async function handler(req, res) {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send("Missing url parameter");

    // ***** 허용 도메인 (www 유무 모두) *****
    const { hostname } = parse(url);
    const allow = /(^|\\.)eiass\\.go\\.kr$/i;
    if (!allow.test(hostname)) return res.status(403).send("Forbidden host");

    // ***** 원본 요청 그대로 전달 *****
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        // 중요 헤더만 복사 (User-Agent 없으면 차단되는 경우 방지)
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
        "Accept": req.headers["accept"] || "*/*",
        "Accept-Language": req.headers["accept-language"] || "ko-KR",
        "Content-Type": req.headers["content-type"] || undefined,
      },
      // 본문이 있는 경우(POST) 전달
      body: ["POST", "PUT", "PATCH"].includes(req.method)
        ? req.body
        : undefined,
    });

    // ***** 헤더에서 X-Frame-Options, CSP 제거 *****
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower === "x-frame-options" || lower === "content-security-policy") return;
      res.setHeader(k, v);
    });

    const data = await upstream.arrayBuffer();
    res.send(Buffer.from(data));
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
}
