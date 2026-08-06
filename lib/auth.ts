export const ALLOWED_EMAIL_DOMAIN = "imthyderabad.edu.in";

export function isAllowedEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}
