/* HTML 처리 부분만 발췌 */
if ((resHeaders.get("content-type") || "").includes("text/html")) {
  let html = await upstream.text();

  // ① 모든 절대 http:// 링크를 https://로 치환
  html = html.replace(/http:\/\/www\.eiass\.go\.kr/gi, "https://www.eiass.go.kr");

  // ② <base> 태그 삽입 또는 수정해 https:// 기반으로 고정
  if (/<base[^>]+href=/i.test(html)) {
    html = html.replace(/<base[^>]+href=["'][^"']+["']\s*\/?>/i,
      `<base href="https://www.eiass.go.kr/" />`);
  } else {
    html = html.replace(/<head[^>]*?>/i,
      m => `${m}\n  <base href="https://www.eiass.go.kr/" />`);
  }

  // ③ 옵션: 브라우저가 남은 http 요청을 자동 업그레이드하도록 CSP 헤더
  resHeaders.set("content-security-policy", "upgrade-insecure-requests");

  return new Response(html, { status: upstream.status, headers: resHeaders });
}
