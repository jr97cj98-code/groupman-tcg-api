const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function privateMemberLabel(role: "owner" | "member", memberId: string): string {
  if (role === "owner") {
    return "Owner";
  }
  const suffix = memberId.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase();
  return `Member ${suffix || "PRIVATE"}`;
}

export function normalizeCardName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 120 ? name : null;
}

export function cardNameKey(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

export function normalizePlayerName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.replace(/\u00a0/g, " ").trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 12 && /^[A-Za-z0-9 _-]+$/.test(name) ? name : null;
}

export function playerNameKey(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]+/g, " ").trim();
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function randomInviteCode(): string {
  const random = new Uint8Array(12);
  crypto.getRandomValues(random);
  const characters = Array.from(random, (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4, 8).join("")}-${characters.slice(8).join("")}`;
}

export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const compact = value.toUpperCase().replace(/[^A-Z2-9]/g, "");
  if (compact.length !== 12 || [...compact].some((character) => !INVITE_ALPHABET.includes(character))) {
    return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
