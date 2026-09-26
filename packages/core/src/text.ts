/** "jane.doe@gmail.com" → "j***@gmail.com", for "Sign in as …?" confirmations and safe logs. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}
