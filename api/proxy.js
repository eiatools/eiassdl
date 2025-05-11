// Vercel Serverless Function
export default async function handler(req, res) {
  const target = req.query.url;
  if (!target) return res.status(400).send('url 파라미터 필요');

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { 'user-agent': req.headers['user-agent'] }
    });

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!/^(x-frame-options|content-security-policy)$/i.test(k))
        res.setHeader(k, v);
    });

    upstream.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(502).send('Proxy error');
  }
}
