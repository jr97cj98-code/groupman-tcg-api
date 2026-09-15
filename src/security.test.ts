import { describe, expect, it } from "vitest";
import {
  cardNameKey,
  normalizeCardName,
  normalizeInviteCode,
  normalizePlayerName,
  playerNameKey,
  privateMemberLabel,
  randomInviteCode,
  randomToken,
  sha256,
} from "./security";

describe("private member labels", () => {
  it("uses role and opaque server IDs rather than RuneScape names", () => {
    expect(privateMemberLabel("owner", "ignored")).toBe("Owner");
    expect(privateMemberLabel("member", "5e8b4bdf-1234-5678-90ab-abcdef123456")).toBe("Member 123456");
  });
});

describe("card names", () => {
  it("normalizes harmless whitespace and makes stable keys", () => {
    expect(normalizeCardName("  Great   Olm ")).toBe("Great Olm");
    expect(cardNameKey("Great Olm")).toBe("great olm");
  });
});

describe("private server player names", () => {
  it("accepts OSRS display names and makes a stable matching key", () => {
    expect(normalizePlayerName("  Sqwiglyy  ")).toBe("Sqwiglyy");
    expect(normalizePlayerName("Iron_ Friend")).toBe("Iron_ Friend");
    expect(playerNameKey("Iron_ Friend")).toBe("iron friend");
  });

  it("rejects names that cannot be RuneScape display names", () => {
    expect(normalizePlayerName("this-name-is-far-too-long")).toBeNull();
    expect(normalizePlayerName("<script>")).toBeNull();
  });
});

describe("credentials", () => {
  it("creates normalized twelve-character invite codes", () => {
    const code = randomInviteCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizeInviteCode(code.toLowerCase().replaceAll("-", " "))).toBe(code);
  });

  it("creates high-entropy URL-safe member tokens", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes credentials deterministically", async () => {
    expect(await sha256("test")).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });
});
