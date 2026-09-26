// The shared email shell. Plain, readable, dark-mode friendly, no remote images or trackers.

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface LayoutParts {
  preheader: string;
  /** Already-escaped HTML for the body. */
  bodyHtml: string;
  footerText: string;
}

export function layout({ preheader, bodyHtml, footerText }: LayoutParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>ReadLitRPG</title>
</head>
<body style="margin:0;padding:0;background:#f6f4ef;color:#1b1a17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ef;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4dfd3;border-radius:10px;">
<tr><td style="padding:24px 28px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;letter-spacing:.08em;color:#6b5f3f;">READLITRPG</td></tr>
<tr><td style="padding:8px 28px 28px;font-size:16px;line-height:1.55;">${bodyHtml}</td></tr>
</table>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#6f6a60;">${escapeHtml(footerText)}</p>
</td></tr>
</table>
</body>
</html>`;
}

export function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:8px;background:#1f5f4a;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;border-radius:8px;">${escapeHtml(label)}</a></td></tr></table>`;
}
