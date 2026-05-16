export const DEV_EMAILS = ["vault.ai.hq@gmail.com"];

export function isDeveloperUser(email?: string): boolean {
  if (!email) return false;
  return DEV_EMAILS.includes(email.toLowerCase());
}
