// /api/proxy.js
import https from "https";
import http  from "http";
import { constants } from "crypto";

const httpsAgent = new https.Agent({
  keepAlive: true,
  family: 4,                                      // ★ IPv4만 사용
  // ★ 구형 TLS 서버와도 연결
  secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT
});
const httpAgent  = new http.Agent({ keepAlive: true, family: 4 });

export default async function handler(req, res) {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).send("Missing url parameter");

    const host = new URL(raw).hostname.trim().replace(/\.$/, "");
    if (!host.endsWith("eiass.go.kr"))
      return res.status(403).send("Forbidden host");

    const upstream = await fetch(raw, {
      method: req.method,
      headers: { ...req.headers, host },
      body: ["POST","PUT","PATCH"].includes(req.method) ? req.body : undefined,
      // ★ 프로토콜별 에이전트 지정
      agent: raw.startsWith("https") ? httpsAgent : httpAgent,
      redirect: "follow",
      cache: "no-store"
    });

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower === "x-frame-options" || lower.startsWith("content-security"))
        return;
      res.setHeader(k, v);
    });

    const data = await upstream.arrayBuffer();
    res.send(Buffer.from(data));
  } catch (e) {
    console.error("proxy error:", e);            // 로그에 전체 스택 출력
    res.status(500).send("Proxy error: " + e.message);
  }
}
