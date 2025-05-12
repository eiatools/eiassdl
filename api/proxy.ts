/* /api/proxy.ts — Vercel Edge Function */

export const config = { runtime: "edge" };

/* ------------------------------------------------------------------ */
/* 1. 대상 호스트 화이트리스트                                         */
/* ------------------------------------------------------------------ */
const ALLOW_HOST = /(?:^|\.)eiass\.go\.kr$/i;

/* ------------------------------------------------------------------ */
/* 2. HTTPS가 실패할 때 HTTP(80)로 한 번 더 시도하는 헬퍼              */
/* ------------------------------------------------------------------ */
async function tryFetch(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);               // 1차: HTTPS 또는 원래 URL
  } catch (e) {
    if (url.startsWith("https://")) {
      const httpURL = "http://" + url.slice(8);  // 2차: HTTP로 폴백
      console.warn("[proxy] HTTPS failed → retry HTTP:", httpURL);
      return await fetch(httpURL, { ...init, redirect: "follow" });
    }
    throw e;                                     // HTTP도 실패하면 예외 전파
  }
}

/* ------------------------------------------------------------------ */
/* 3. 메인 핸들러                                                      */
/* ------------------------------------------------------------------ */
export default async function handler(req: Request): Promise<Response> {
  const reqUrl = new URL(req.url);
  const raw    = reqUrl.searchParams.get("url");      // /api/proxy?url=...
  if (!raw) return new Response("Missing url", { status: 400 });

  /* ───── 대상 URL 검증 ───── */
  const upstreamURL = new URL(raw);
  if (!ALLOW_HOST.test(upstreamURL.hostname)) {
    return new Response("Forbidden host", { status: 403 });
  }

  /* ───── 원본 요청을 그대로 전달할 준비 ───── */
  const init: RequestInit = {
    method:  req.method,
    headers: req.headers,
    body:    ["POST", "PUT", "PATCH"].includes(req.method || "") ? req.body : null,
    redirect: "follow",
    cache: "no-store"
  };

  /* ───── upstream 호출 (HTTPS → 실패 시 HTTP) ───── */
  const upstream = await tryFetch(upstreamURL.href, init);

  /* ───── 응답 헤더 정리 ───── */
  const resHeaders = new Headers(upstream.headers);
  resHeaders.set("access-control-allow-origin", "*");               // CORS
  resHeaders.delete("content-security-policy");                     // 충돌 방지

  /* ----------------------------------------------------------------
     4. HTML 응답일 때: 혼합-콘텐츠 해결용 치환 로직
     ---------------------------------------------------------------- */
  if ((resHeaders.get("content-type") || "").includes("text/html")) {
    let html = await upstream.text();

    /* ① 절대 URL(http) → https 로 치환 */
    html = html.replace(/http:\/\/www\.eiass\.go\.kr/gi,
                        "https://www.eiass.go.kr");

    /* ② <base> 태그가 있으면 https:// 로 고정, 없으면 삽입 */
    if (/<base[^>]+href=/i.test(html)) {
      html = html.replace(
        /<base[^>]+href=["'][^"']+["']\s*\/?>/i,
        `<base href="https://www.eiass.go.kr/" />`
      );
    } else {
      html = html.replace(
        /<head[^>]*?>/i,
        m => `${m}\n  <base href="https://www.eiass.go.kr/" />`
      );
    }

    /* ③ 남은 http 리소스 요청을 브라우저가 자동으로 업그레이드 */
    resHeaders.set("content-security-policy", "upgrade-insecure-requests");

    return new Response(html, { status: upstream.status, headers: resHeaders });
  }

  /* ----------------------------------------------------------------
     5. HTML 외 형식(PDF, 이미지, CSS 등)은 스트리밍 그대로 전달
     ---------------------------------------------------------------- */
  return new Response(upstream.body, {
    status:  upstream.status,
    headers: resHeaders
  });
}
