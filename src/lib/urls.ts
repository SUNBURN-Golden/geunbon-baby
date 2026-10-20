export function safeHttpUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function instagramUrl(handle: string | null | undefined) {
  if (!handle) return null;
  const clean = handle.replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(clean)) return null;
  if (clean.toLowerCase().startsWith("sample")) return null;
  return `https://instagram.com/${clean}`;
}

export function displayHandle(handle: string | null | undefined) {
  if (!handle) return null;
  return handle.startsWith("@") ? handle : `@${handle}`;
}
