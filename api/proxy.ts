// /api/proxy.ts – 완전 통합 버전
// ------------------------------------------------------------
// EIASS 프록시 (Vercel Serverless / Node.js 18)
//   • HTTPS 실패 시 HTTP(80) 폴백
//   • Keep‑Alive Agent 로 원본 연결 재사용
//   • HTML 내 혼합‑콘텐츠 자동 수정(base, https 치환)
//   • Early‑Hints(103) + preload / preconnect 헤더
//   • 정적 리소스 Cache‑Control + immutable
// ------------------------------------------------------------

import type { VercelRequest, VercelResponse } from "vercel";
import https from "node:https";
import http from "node:http";
import { constants as tlsConst } from "node:https";

export const config = {
  runtime: "nodejs18.x",
  regions: ["icn1"],             // 한국 POP 고정 → 지연 최소화
};

/* ------------------------------------------------------------------
 * 1. 화이트리스트 – eiass.go.kr 로 제한
 * ---------------------------------------------------------------- */
const ALLOW_HOST = /(?:^|\.)eiass\.go\.kr$/i;

/* ------------------------------------------------------------------
 * 2. Keep‑Alive Agent (TLS1.0~1.2 + RSA cipher 허용)
 * ---------------------------------------------------------------- */
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxFreeSockets: 64,
  minVersion: "TLSv1",
  maxVersion: "TLSv1.2",
  // 구형 RSA‑only 서버 호환 옵션
  secureOptions: tlsConst.SSL_OP_LEGACY_SERVER_CONNECT,
});
const httpAgent = new http.Agent({ keepAlive: true, maxFreeSockets: 64 });

/* ------------------------------------------------------------------
 * 3. HTTPS 실패 시 HTTP(80) 재시도 helper
 * ---------------------------------------------------------------- */
async function fetchWithFallback(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (url.startsWith("https://")) {
      const httpURL = "http://" + url.slice(8);
      console.warn("[proxy] HTTPS failed – retrying HTTP", httpURL);
      return await fetch(httpURL, { ...init, redirect: "follow", agent: httpAgent });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------
 * 4. HTML 리소스 치환 / Early‑Hints
 * ---------------------------------------------------------------- */
function rewriteHtml(html: string): { html: string; earlyLinks: string[] } {
  // ① 모든 절대 http:// → https:// 치환
  let modified = html.replace(/http:\/\/www\.eiass\.go\.kr/gi, "https://www.eiass.go.kr");

  // ② <base> 태그 고정 or 삽입
  if (/<base[^>]+href=/i.test(modified)) {
    modified = modified.replace(
      /<base[^>]+href=["'][^"']+["']\s*\/?>/i,
      '<base href="https://www.eiass.go.kr/" />',
    );
  } else {
    modified = modified.replace(
      /<head[^>]*?>/i,
      (m) => `${m}\n  <base href="https://www.eiass.go.kr/" />`,
    );
  }

  // ③ Early‑Hints 후보 링크 추출 (상위 5개 CSS/JS)
  const earlyLinks: string[] = [];
  const linkRegex = /<link[^>]+rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const scriptRegex = /<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi;
  let m;
  while ((m = linkRegex.exec(modified)) !== null && earlyLinks.length < 5) {
    earlyLinks.push(`${m[1]}; rel=preload; as=style`);
  }
  while ((m = scriptRegex.exec(modified)) !== null && earlyLinks.length < 5) {
    earlyLinks.push(`${m[1]}; rel=preload; as=script`);
  }
  return { html: modified, earlyLinks };
}

/* ------------------------------------------------------------------
 * 5. 정적 자원인지 여부
 * ---------------------------------------------------------------- */
function isStatic(ct: string | null): boolean {
  return !!ct && (/text\/css/.test(ct) || /javascript/.test(ct) || /image\//.test(ct));
}

/* ------------------------------------------------------------------
 * 6. 메인 핸들러
 * ---------------------------------------------------------------- */
export default async function proxy(req: VercelRequest, res: VercelResponse) {
  const raw = (req.query.url as string) || "";
  if (!raw) return res.status(400).send("Missing url");

  // 호스트 검증
  const upstreamURL = new URL(raw);
  if (!ALLOW_HOST.test(upstreamURL.hostname)) {
    return res.status(403).send("Forbidden host");
  }

  // 원본 요청 그대로 전달 준비
  const init: RequestInit = {
    method: req.method,
    headers: req.headers as any,
    body: ["POST", "PUT", "PATCH"].includes(req.method || "") ? req : undefined,
    redirect: "follow",
    cache: "no-store",
    agent: upstreamURL.protocol === "https:" ? httpsAgent : httpAgent,
  };

  let upstream;
  try {
    upstream = await fetchWithFallback(upstreamURL.href, init);
  } catch (e: any) {
    console.error("[proxy] upstream error", e);
    return res.status(502).json({ error: e.message });
  }

  // -----------------------------------------------------------------
  // 응답 헤더 공통 처리
  // -----------------------------------------------------------------
  const headers = new Headers(upstream.headers);
  headers.set("access-control-allow-origin", "*");

  // 정적 자원 캐싱 (24h + immutable)
  const ct = headers.get("content-type");
  if (isStatic(ct)) {
    headers.set("cache-control", "public,max-age=86400,immutable");
  }

  // -----------------------------------------------------------------
  // HTML 특수 처리 (혼합‑콘텐츠 해결 + Early‑Hints)
  // -----------------------------------------------------------------
  if (ct?.includes("text/html")) {
    const text = await upstream.text();
    const { html, earlyLinks } = rewriteHtml(text);

    // Early‑Hints (103)
    if (earlyLinks.length) {
      res.writeHead(103, { Link: earlyLinks.join(", ") });
    }
    // CSP: upgrade insecure requests
    headers.set("content-security-policy", "upgrade-insecure-requests");

    // 최종 HTML 전송
    headers.set("content-length", Buffer.byteLength(html).toString());
    res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
    return res.end(html);
  }

  // -----------------------------------------------------------------
  // HTML 이외: 스트리밍 전달 (첫 바이트 지연 최소화)
  // -----------------------------------------------------------------
  res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
  if (upstream.body) upstream.body.pipe(res);
  else res.end();
}
