import { button, escapeHtml, layout } from "./layout";

export interface MagicLinkEmail {
  subject: string;
  html: string;
  text: string;
}

/** The sign-in email. The link opens a confirmation page; nothing happens until the reader clicks. */
export function renderMagicLink(url: string, minutes = 15): MagicLinkEmail {
  const subject = "Your ReadLitRPG sign-in link";
  const intro = "[System] A sign-in was requested for this address.";
  const action = `Open the link below within ${minutes} minutes to continue. It works once.`;
  const safety =
    "Didn't ask for this? Ignore this email. Nobody can sign in without clicking the link, and it expires on its own.";
  const html = layout({
    preheader: `Sign in to ReadLitRPG. The link expires in ${minutes} minutes.`,
    bodyHtml: [
      `<p style="margin:0 0 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(intro)}</p>`,
      `<p style="margin:0;">${escapeHtml(action)}</p>`,
      button(url, "Sign in to ReadLitRPG"),
      `<p style="margin:0 0 12px;font-size:13px;color:#6f6a60;">Or paste this address into your browser:<br><span style="word-break:break-all;">${escapeHtml(url)}</span></p>`,
      `<p style="margin:0;font-size:13px;color:#6f6a60;">${escapeHtml(safety)}</p>`,
    ].join("\n"),
    footerText:
      "ReadLitRPG sends sign-in emails only when someone asks for one. We will never ask for a password.",
  });
  const text = [intro, "", action, "", url, "", safety, "", "ReadLitRPG never asks for a password."].join(
    "\n",
  );
  return { subject, html, text };
}
