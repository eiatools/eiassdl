// /api/proxy.ts  (Vercel Edge Function)
export const config = { runtime: "edge" };

const ALLOW_HOST = /(?:^|\.)eiass\.go\.kr$/i;

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("url");
  if (!raw) return new Response("Missing url", { status: 400 });

  const host = new URL(raw).hostname.replace(/\.$/, "");
  if (!ALLOW_HOST.test(host)) return new Response("Forbidden host", { status: 403 });

  const upstream = await fetch(raw, {
    method: req.method,
    headers: { ...Object.fromEntries(req.headers), host },
    body: ["POST", "PUT", "PATCH"].includes(req.method!) ? req.body : null,
    redirect: "follow",
    cache: "no-store",
  });

  /* ---------- 응답 헤더 일부 정리 ---------- */
  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete("content-security-policy");   // 필요 시 제거
  resHeaders.set("access-control-allow-origin", "*");

  /* ---------- ① HTML일 때 <base> 자동 삽입 ---------- */
  if ((resHeaders.get("content-type") || "").includes("text/html")) {
    let html = await upstream.text();
    if (!/<base[^>]+href=/i.test(html)) {
      html = html.replace(/<head[^>]*?>/i, m => `${m}\n  <base href="https://www.eiass.go.kr/">`);
    }
    return new Response(html, { status: upstream.status, headers: resHeaders });
  }

  /* ---------- ② 그 외 형식은 스트림 그대로 전달 ---------- */
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}
