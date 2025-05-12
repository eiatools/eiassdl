// /api/proxy.ts – EIASS 프록시 (Node.js 18, Vercel Serverless)
// -----------------------------------------------------------------------------
// 주요 기능
//   • Undici Agent(keep‑alive) 사용해 원본 서버와 재연결 최소화
//   • HTTPS 실패 시 HTTP(80) 한 번만 폴백
//   • HTML 내부 혼합‑콘텐츠 자동 해결(<base>·http→https 치환)
//   • Early‑Hints(103)로 CSS/JS 선로딩, 정적 자원 24h 캐싱
// -----------------------------------------------------------------------------
import type { VercelRequest, VercelResponse } from "vercel";
import { Agent as UndiciAgent } from "undici";

export const config = {
  regions: ["icn1"], // 한국 POP 고정
  maxDuration: 10
};

/* ------------------------------------------------------------------
 * 1. 화이트리스트 – eiass.go.kr 로 제한
 * ---------------------------------------------------------------- */
const ALLOW_HOST = /(?:^|\.)eiass\.go\.kr$/i;

/* ------------------------------------------------------------------
 * 2. Undici Dispatcher (keep‑alive)
 * ---------------------------------------------------------------- */
const httpsDispatcher = new UndiciAgent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000 });
const httpDispatcher  = new UndiciAgent({ keepAliveTimeout: 60_000 });

/* ------------------------------------------------------------------
 * 3. HTTPS 실패 시 HTTP(80) 재시도 helper
 * ---------------------------------------------------------------- */
async function fetchWithFallback(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (url.startsWith("https://")) {
      const httpURL = "http://" + url.slice(8);
      console.warn("[proxy] HTTPS failed – retry HTTP", httpURL);
      return await fetch(httpURL, { ...init, dispatcher: httpDispatcher, redirect: "follow" });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------
 * 4. HTML 리소스 치환 / Early‑Hints 생성
 * ---------------------------------------------------------------- */
function rewriteHtml(html: string) {
  // (1) 절대 http 링크 → https 로 치환
  let modified = html.replace(/http:\/\/www\.eiass\.go\.kr/gi, "https://www.eiass.go.kr");

  // (2) <base> 태그 고정 또는 삽입
  if (/<base[^>]+href=/i.test(modified)) {
    modified = modified.replace(/<base[^>]+href=["'][^"']+["']\s*\/?>/i,
      '<base href="https://www.eiass.go.kr/" />');
  } else {
    modified = modified.replace(/<head[^>]*?>/i,
      m => `${m}\n  <base href="https://www.eiass.go.kr/" />`);
  }

  // (3) Early‑Hints 후보 추출 (상위 5개 CSS/JS)
  const early: string[] = [];
  const rxCSS = /<link[^>]+rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const rxJS  = /<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = rxCSS.exec(modified)) && early.length < 5) early.push(`${m[1]}; rel=preload; as=style`);
  while ((m = rxJS.exec(modified))  && early.length < 5) early.push(`${m[1]}; rel=preload; as=script`);

  return { html: modified, early };
}

function isStatic(ct: string | null) {
  return !!ct && (/text\/css/.test(ct) || /javascript/.test(ct) || /image\//.test(ct));
}

/* ------------------------------------------------------------------
 * 5. 메인 핸들러
 * ---------------------------------------------------------------- */
export default async function proxy(req: VercelRequest, res: VercelResponse) {
  const raw = (req.query.url as string) || "";
  if (!raw) return res.status(400).send("Missing url");

  const upstreamURL = new URL(raw);
  if (!ALLOW_HOST.test(upstreamURL.hostname)) {
    return res.status(403).send("Forbidden host");
  }

  const dispatcher = upstreamURL.protocol === "https:" ? httpsDispatcher : httpDispatcher;

  const init: RequestInit = {
    method:  req.method,
    headers: req.headers as any,
    body:    ["POST", "PUT", "PATCH"].includes(req.method || "") ? req : undefined,
    redirect: "follow",
    cache:    "no-store",
    dispatcher
  };

  let upstream;
  try {
    upstream = await fetchWithFallback(upstreamURL.href, init);
  } catch (e: any) {
    const msg = e.code ? `${e.code}: ${e.message}` : e.message;
    console.error("[proxy] upstream error", e);
    return res.status(502).json({ error: msg });
  }

  const headers = new Headers(upstream.headers);
  headers.set("access-control-allow-origin", "*");

  const ct = headers.get("content-type");
  if (isStatic(ct)) headers.set("cache-control", "public,max-age=86400,immutable");

  // ------------------------- HTML -------------------------
  if (ct?.includes("text/html")) {
    const text = await upstream.text();
    const { html, early } = rewriteHtml(text);

    if (early.length) res.writeHead(103, { Link: early.join(", ") });
    headers.set("content-security-policy", "upgrade-insecure-requests");
    headers.set("content-length", Buffer.byteLength(html).toString());

    res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
    return res.end(html);
  }

  // --------------------- HTML 외 형식 ----------------------
  res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
  if (upstream.body) upstream.body.pipe(res);
  else res.end();
}
