export const config = { runtime: "edge" };

const ALLOW_HOST = /(?:^|\.)eiass\.go\.kr$/i;

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("url");
  if (!raw) return new Response("Missing url", { status: 400 });

  const upstreamURL = new URL(raw);
  if (!ALLOW_HOST.test(upstreamURL.hostname)) {
    return new Response("Forbidden host", { status: 403 });
  }

  /* ───── 금지 헤더 제거 ───── */
  const forwardHeaders = new Headers(req.headers);
  [
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "transfer-encoding",
    "expect",
    "keep-alive"
  ].forEach(h => forwardHeaders.delete(h));

  const upstream = await fetch(upstreamURL, {
    method: req.method,
    headers: forwardHeaders,
    body: ["POST", "PUT", "PATCH"].includes(req.method!) ? req.body : null,
    redirect: "follow",
    cache: "no-store"
  });

  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete("content-security-policy");
  resHeaders.set("access-control-allow-origin", "*");

  /* HTML은 <base> 삽입 후 전달 */
  if ((resHeaders.get("content-type") || "").includes("text/html")) {
    let html = await upstream.text();
    if (!/<base[^>]+href=/i.test(html)) {
      html = html.replace(/<head[^>]*?>/i,
        m => `${m}\n  <base href="${upstreamURL.origin}/">`);
    }
    return new Response(html, { status: upstream.status, headers: resHeaders });
  }

  /* 그 외 형식 스트리밍 */
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}
