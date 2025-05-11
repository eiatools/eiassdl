// /api/proxy.js — Vercel Serverless Function
// TLS 검증 임시 OFF (테스트용)  ★ 운영 시 중간 CA 방식으로 전환 권장
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import http from "http";
import https from "https";
import { constants } from "crypto";

/* -------------------------------------------------------------------------- */
/*  HTTPS / HTTP 에이전트                                                       */
/* -------------------------------------------------------------------------- */
const httpsAgent = new https.Agent({
  keepAlive: true,
  family: 4,                       // IPv4 우선
  rejectUnauthorized: false,       // 검증 OFF (이미 env 로 꺼둠) – 테스트용
  minVersion: "TLSv1",            // 구형 TLS 허용
  secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
  ciphers: "DEFAULT@SECLEVEL=1"    // OpenSSL 보안 레벨 1
});
const httpAgent = new http.Agent({ keepAlive: true, family: 4 });

/* -------------------------------------------------------------------------- */
/*  도우미                                                                     */
/* -------------------------------------------------------------------------- */
const isHtml = (headers) => {
  const ct = headers.get("content-type") || "";
  return ct.includes("text/html");
};

/* -------------------------------------------------------------------------- */
/*  메인 핸들러                                                                */
/* -------------------------------------------------------------------------- */
export default async function handler(req, res) {
  try {
    // -----------------------------------------------------------------------
    // 0) 파라미터 확인 & 허용 도메인 필터링
    // -----------------------------------------------------------------------
    const raw = req.query.url;
    if (!raw) return res.status(400).send("Missing url parameter");

    const host = new URL(raw).hostname.trim().replace(/\.$/, "").toLowerCase();
    if (!host.endsWith("eiass.go.kr")) return res.status(403).send("Forbidden host");

    // -----------------------------------------------------------------------
    // 1) Upstream 요청 전송
    // -----------------------------------------------------------------------
    const upstream = await fetch(raw, {
      method : req.method,
      headers: { ...req.headers, host },
      body   : ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
      agent  : raw.startsWith("https") ? httpsAgent : httpAgent,
      redirect: "follow",
      cache   : "no-store"
    });

    // -----------------------------------------------------------------------
    // 2) 응답 헤더 복사 (XFO / CSP 제거)
    // -----------------------------------------------------------------------
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower === "x-frame-options" || lower.startsWith("content-security")) return;
      res.setHeader(k, v);
    });

    // -----------------------------------------------------------------------
    // 3) HTML 이면 <base href="https://www.eiass.go.kr/"> 삽입
    // -----------------------------------------------------------------------
    if (isHtml(upstream.headers)) {
      let html = await upstream.text();
      // 이미 <base> 가 없을 때만 삽입
      if (!/<base[^>]+href=/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}\n  <base href=\"https://www.eiass.go.kr/\">`);
      }
      return res.send(html);
    }

    // -----------------------------------------------------------------------
    // 4) HTML 외 형식은 Buffer 그대로 전달
    // -----------------------------------------------------------------------
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error("proxy error:", e);
    res.status(500).send("Proxy error: " + e.message);
  }
}
