// Share cards served as SVG (the PNG versions are rendered by the jobs Worker, DESIGN §7.10).

export function svgResponse(svg: string, maxAge = 86_400): Response {
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
      // An SVG opened directly must not run anything.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
