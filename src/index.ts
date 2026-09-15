import {
  bearerToken,
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

interface Env {
  DB: D1Database;
  SETUP_KEY?: string;
}

interface MemberRow {
  id: string;
  group_id: string;
  member_label: string;
  player_name: string | null;
  player_name_key: string | null;
  collection_mode: "shared" | "solo";
  role: "owner" | "member";
  status: "pending" | "approved";
  revoked_at: number | null;
  last_seen_at: number;
  owner_member_id: string;
}

interface GroupRow {
  id: string;
  display_name: string;
  owner_member_id: string;
  invite_hash: string;
  invite_expires_at: number;
  collection_version: number;
  created_at: number;
  updated_at: number;
}

interface CardPull {
  name: string;
  foil: boolean;
  isNew: boolean;
}

interface MemberCardInstanceInput {
  sourceInstanceId: string;
  cardName: string;
  foil: boolean;
  debug: boolean;
  pulledAt: number;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const INVITE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MIN_SETUP_KEY_LENGTH = 16;
const MAX_SETUP_KEY_LENGTH = 256;
const TOP_TRUMPS_CHALLENGE_MS = 60_000;
const MAX_ACTIVE_MEMBERS = 50;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: { code: error.code, message: error.message } }, error.status);
      }
      // Do not place request bodies, credentials, identifiers, or gameplay data in Worker logs.
      console.error("Unhandled Group TCG API error");
      return json({ error: { code: "internal_error", message: "The server could not complete the request." } }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && path === "/health") {
    const database = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return json({
      status: database?.ok === 1 ? "ok" : "degraded",
      service: "group-tcg-api",
      version: 4,
      setupReady: validSetupKey(configuredSetupKey(env)),
    });
  }

  if (request.method === "POST" && path === "/v1/groups") {
    return createGroup(request, env);
  }

  if (request.method === "POST" && path === "/v1/join") {
    return joinGroup(request, env);
  }

  const groupMatch = /^\/v1\/groups\/([^/]+)$/.exec(path);
  if (request.method === "GET" && groupMatch) {
    return getGroup(request, env, decodePath(groupMatch[1]));
  }

  const syncMatch = /^\/v1\/groups\/([^/]+)\/sync$/.exec(path);
  if (request.method === "GET" && syncMatch) {
    return syncGroup(request, env, decodePath(syncMatch[1]), url);
  }

  const packsMatch = /^\/v1\/groups\/([^/]+)\/packs$/.exec(path);
  if (request.method === "POST" && packsMatch) {
    return uploadPack(request, env, decodePath(packsMatch[1]));
  }

  const collectionMatch = /^\/v1\/groups\/([^/]+)\/collection$/.exec(path);
  if (request.method === "POST" && collectionMatch) {
    return uploadCollection(request, env, decodePath(collectionMatch[1]));
  }

  const memberCollectionUploadMatch = /^\/v1\/groups\/([^/]+)\/member-collection$/.exec(path);
  if (request.method === "POST" && memberCollectionUploadMatch) {
    return uploadMemberCollection(request, env, decodePath(memberCollectionUploadMatch[1]));
  }

  const memberCollectionsMatch = /^\/v1\/groups\/([^/]+)\/member-collections$/.exec(path);
  if (request.method === "GET" && memberCollectionsMatch) {
    return getMemberCollections(request, env, decodePath(memberCollectionsMatch[1]));
  }

  const memberCardsMatch = /^\/v1\/groups\/([^/]+)\/members\/([^/]+)\/collection$/.exec(path);
  if (request.method === "GET" && memberCardsMatch) {
    return getMemberCollection(request, env, decodePath(memberCardsMatch[1]), decodePath(memberCardsMatch[2]), url);
  }

  const provenanceMatch = /^\/v1\/groups\/([^/]+)\/provenance$/.exec(path);
  if (request.method === "GET" && provenanceMatch) {
    return getCardProvenance(request, env, decodePath(provenanceMatch[1]), url);
  }

  const rotateMatch = /^\/v1\/groups\/([^/]+)\/invite$/.exec(path);
  if (request.method === "POST" && rotateMatch) {
    return rotateInvite(request, env, decodePath(rotateMatch[1]));
  }

  const memberMatch = /^\/v1\/groups\/([^/]+)\/members\/([^/]+)$/.exec(path);
  if (memberMatch && request.method === "POST") {
    return approveMember(request, env, decodePath(memberMatch[1]), decodePath(memberMatch[2]));
  }
  if (memberMatch && request.method === "DELETE") {
    return revokeMember(request, env, decodePath(memberMatch[1]), decodePath(memberMatch[2]));
  }

  const challengeCollectionMatch = /^\/v1\/groups\/([^/]+)\/top-trumps\/challenges$/.exec(path);
  if (request.method === "POST" && challengeCollectionMatch) {
    return createTopTrumpsChallenge(request, env, decodePath(challengeCollectionMatch[1]));
  }

  const challengeResponseMatch = /^\/v1\/groups\/([^/]+)\/top-trumps\/challenges\/([^/]+)\/response$/.exec(path);
  if (request.method === "POST" && challengeResponseMatch) {
    return respondTopTrumpsChallenge(
      request,
      env,
      decodePath(challengeResponseMatch[1]),
      decodePath(challengeResponseMatch[2]),
    );
  }

  throw new ApiError(404, "not_found", "That API route does not exist.");
}

async function createGroup(request: Request, env: Env): Promise<Response> {
  const claimed = await env.DB.prepare("SELECT group_id FROM instance_registration WHERE slot = 1")
    .first<{ group_id: string }>();
  if (claimed) {
    throw new ApiError(409, "instance_claimed", "This private server already belongs to a Group TCG group.");
  }

  const expectedSetupKey = configuredSetupKey(env);
  if (!validSetupKey(expectedSetupKey)) {
    throw new ApiError(503, "setup_not_configured", "The Worker owner must configure its private setup key first.");
  }
  const suppliedSetupKey = (request.headers.get("X-Groupman-Setup-Key") ?? "").trim();
  if (suppliedSetupKey.length < MIN_SETUP_KEY_LENGTH || suppliedSetupKey.length > MAX_SETUP_KEY_LENGTH
    || (await sha256(suppliedSetupKey)) !== (await sha256(expectedSetupKey))) {
    throw new ApiError(403, "invalid_setup_key", "The private Worker setup key is incorrect.");
  }

  const body = await readJson(request);
  const playerName = playerNameField(body.playerName);
  const collectionMode = collectionModeField(body.collectionMode);
  const groupId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const ownerLabel = privateMemberLabel("owner", ownerId);
  const token = randomToken();
  const inviteCode = randomInviteCode();
  const now = Date.now();
  const inviteExpiresAt = now + INVITE_LIFETIME_MS;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO groups
       (id, display_name, owner_member_id, invite_hash, invite_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(groupId, "Private Group", ownerId, await sha256(inviteCode), inviteExpiresAt, now, now),
    env.DB.prepare(
       `INSERT INTO members
       (id, group_id, member_key, member_label, player_name, player_name_key, collection_mode,
        role, status, token_hash, created_at, approved_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', 'approved', ?, ?, ?, ?)`,
    ).bind(ownerId, groupId, `private_${ownerId}`, ownerLabel, playerName,
      playerNameKey(playerName), collectionMode, await sha256(token), now, now, now),
    env.DB.prepare("INSERT INTO instance_registration (slot, group_id) VALUES (1, ?)").bind(groupId),
  ]);

  return json(
    {
      group: { id: groupId, collectionVersion: 0 },
      member: { id: ownerId, label: ownerLabel, playerName, collectionMode,
        role: "owner", status: "approved", token },
      invite: { code: inviteCode, expiresAt: inviteExpiresAt },
    },
    201,
  );
}

function configuredSetupKey(env: Env): string {
  return (env.SETUP_KEY ?? "").trim();
}

function validSetupKey(value: string): boolean {
  return value.length >= MIN_SETUP_KEY_LENGTH && value.length <= MAX_SETUP_KEY_LENGTH;
}

async function joinGroup(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const groupId = stringField(body.groupId, "groupId", 1, 64);
  const playerName = playerNameField(body.playerName);
  const collectionMode = collectionModeField(body.collectionMode);
  const inviteCode = normalizeInviteCode(body.inviteCode);
  if (!inviteCode) {
    throw new ApiError(400, "invalid_invite", "inviteCode is not a valid group invite code.");
  }

  const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(groupId).first<GroupRow>();
  if (!group || group.invite_hash !== (await sha256(inviteCode)) || group.invite_expires_at < Date.now()) {
    throw new ApiError(403, "invalid_invite", "The group invite is invalid or has expired.");
  }

  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM members WHERE group_id = ? AND revoked_at IS NULL",
  )
    .bind(groupId)
    .first<{ count: number }>();
  if ((active?.count ?? 0) >= MAX_ACTIVE_MEMBERS) {
    throw new ApiError(409, "group_full", `This private server already has ${MAX_ACTIVE_MEMBERS} active memberships.`);
  }

  const duplicatePlayer = await env.DB.prepare(
    "SELECT id FROM members WHERE group_id = ? AND player_name_key = ? AND revoked_at IS NULL",
  ).bind(groupId, playerNameKey(playerName)).first<{ id: string }>();
  if (duplicatePlayer) {
    throw new ApiError(409, "player_already_joined", "That RuneScape name is already an active server member.");
  }

  const memberId = crypto.randomUUID();
  const memberLabel = privateMemberLabel("member", memberId);
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO members
     (id, group_id, member_key, member_label, player_name, player_name_key, collection_mode,
      role, status, token_hash, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'member', 'pending', ?, ?, ?)`,
  )
    .bind(memberId, groupId, `private_${memberId}`, memberLabel, playerName,
      playerNameKey(playerName), collectionMode, tokenHash, now, now)
    .run();

  return json({ member: { id: memberId, groupId, label: memberLabel, playerName,
    collectionMode, role: "member", status: "pending", token } }, 202);
}

async function getGroup(request: Request, env: Env, groupId: string): Promise<Response> {
  const member = await authenticate(request, env, groupId, true);
  const group = await getGroupRow(env, groupId);
  const members = await env.DB.prepare(
    `SELECT id, member_label, player_name, collection_mode, role, status,
            created_at, approved_at, revoked_at, last_seen_at
     FROM members WHERE group_id = ? ORDER BY role DESC, id`,
  )
    .bind(groupId)
    .all();

  return json({
    group: publicGroup(group),
    currentMember: publicMember(member),
    members: members.results.map((row) => ({
      id: row.id,
      label: row.member_label,
      playerName: row.player_name,
      collectionMode: row.collection_mode,
      role: row.role,
      status: row.status,
      revoked: row.revoked_at !== null,
      joinedAt: row.created_at,
      approvedAt: row.approved_at,
      lastSeenAt: row.last_seen_at,
    })),
  });
}

async function approveMember(request: Request, env: Env, groupId: string, targetMemberId: string): Promise<Response> {
  await requireOwner(request, env, groupId);
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE members SET status = 'approved', approved_at = ?, revoked_at = NULL
     WHERE id = ? AND group_id = ? AND role = 'member'`,
  )
    .bind(now, targetMemberId, groupId)
    .run();
  if (result.meta.changes !== 1) {
    throw new ApiError(404, "member_not_found", "That pending member does not exist.");
  }
  return json({ memberId: targetMemberId, status: "approved", approvedAt: now });
}

async function revokeMember(request: Request, env: Env, groupId: string, targetMemberId: string): Promise<Response> {
  await requireOwner(request, env, groupId);
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE members SET revoked_at = ?
     WHERE id = ? AND group_id = ? AND role = 'member' AND revoked_at IS NULL`,
  )
    .bind(now, targetMemberId, groupId)
    .run();
  if (result.meta.changes !== 1) {
    throw new ApiError(404, "member_not_found", "That active member does not exist.");
  }
  return json({ memberId: targetMemberId, revokedAt: now });
}

async function rotateInvite(request: Request, env: Env, groupId: string): Promise<Response> {
  await requireOwner(request, env, groupId);
  const code = randomInviteCode();
  const expiresAt = Date.now() + INVITE_LIFETIME_MS;
  await env.DB.prepare("UPDATE groups SET invite_hash = ?, invite_expires_at = ?, updated_at = ? WHERE id = ?")
    .bind(await sha256(code), expiresAt, Date.now(), groupId)
    .run();
  return json({ invite: { code, expiresAt } });
}

async function uploadPack(request: Request, env: Env, groupId: string): Promise<Response> {
  const member = await authenticate(request, env, groupId, true);
  const body = await readJson(request);
  const eventId = stringField(body.eventId, "eventId", 8, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(eventId)) {
    throw new ApiError(400, "invalid_event_id", "eventId may contain only letters, numbers, underscores and hyphens.");
  }
  const openedAt = integerField(body.openedAt, "openedAt", 0, Date.now() + 10 * 60 * 1000);
  const cards = parseCards(body.cards);

  const existing = await env.DB.prepare(
    "SELECT seq, group_id, member_id FROM pack_events WHERE event_id = ?",
  )
    .bind(eventId)
    .first<{ seq: number; group_id: string; member_id: string }>();
  if (existing && (existing.group_id !== groupId || existing.member_id !== member.id)) {
    throw new ApiError(409, "event_id_conflict", "That eventId is already owned by another member or group.");
  }
  if (existing) {
    return json({ eventId, sequence: existing.seq, duplicate: true });
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO pack_events
       (event_id, group_id, member_id, opened_at, cards_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(eventId, groupId, member.id, openedAt, JSON.stringify(cards), now),
  ];
  for (const card of uniqueCards(cards)) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO group_unlocks
         (group_id, card_name_key, card_name, first_member_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_id, card_name_key) DO NOTHING`,
      ).bind(groupId, cardNameKey(card.name), card.name, member.id, openedAt),
    );
  }
  statements.push(
    env.DB.prepare("UPDATE groups SET collection_version = collection_version + 1, updated_at = ? WHERE id = ?").bind(
      now,
      groupId,
    ),
  );
  await env.DB.batch(statements);

  const stored = await env.DB.prepare("SELECT seq FROM pack_events WHERE event_id = ?")
    .bind(eventId)
    .first<{ seq: number }>();
  return json({ eventId, sequence: stored?.seq, duplicate: false }, 201);
}

async function uploadCollection(request: Request, env: Env, groupId: string): Promise<Response> {
  const member = await authenticate(request, env, groupId, true);
  const body = await readJson(request);
  if (!Array.isArray(body.cardNames) || body.cardNames.length < 1 || body.cardNames.length > 500) {
    throw new ApiError(400, "invalid_card_names", "cardNames must contain between 1 and 500 card names.");
  }
  const names = [...new Map(body.cardNames.map((value) => {
    const name = normalizeCardName(value);
    if (!name) {
      throw new ApiError(400, "invalid_card_name", "Every card name must contain between 1 and 120 characters.");
    }
    return [cardNameKey(name), name] as const;
  })).values()];

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < names.length; offset += 18) {
    const chunk = names.slice(offset, offset + 18);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((name) => [groupId, cardNameKey(name), name, member.id, now]);
    statements.push(
      env.DB.prepare(
        `INSERT INTO group_unlocks
         (group_id, card_name_key, card_name, first_member_id, first_seen_at)
         VALUES ${placeholders} ON CONFLICT(group_id, card_name_key) DO NOTHING`,
      ).bind(...bindings),
    );
  }
  statements.push(
    env.DB.prepare("UPDATE groups SET collection_version = collection_version + 1, updated_at = ? WHERE id = ?").bind(
      now,
      groupId,
    ),
  );
  await env.DB.batch(statements);
  const group = await getGroupRow(env, groupId);
  return json({ accepted: names.length, collectionVersion: group.collection_version });
}

async function uploadMemberCollection(request: Request, env: Env, groupId: string): Promise<Response> {
  const member = await authenticate(request, env, groupId, true);
  const body = await readJson(request);
  const collectionMode = collectionModeField(body.collectionMode);
  const snapshotId = stringField(body.snapshotId, "snapshotId", 8, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(snapshotId)) {
    throw new ApiError(400, "invalid_snapshot_id", "snapshotId may contain only letters, numbers, underscores and hyphens.");
  }
  if (!Array.isArray(body.instances) || body.instances.length > 200) {
    throw new ApiError(400, "invalid_instances", "instances must be an array containing no more than 200 card copies.");
  }
  if (typeof body.complete !== "boolean") {
    throw new ApiError(400, "invalid_complete", "complete must indicate whether this is the final snapshot chunk.");
  }

  const instances = body.instances.map(parseMemberCardInstance);
  const uniqueInstances = [...new Map(instances.map((instance) => [instance.sourceInstanceId, instance])).values()];
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < uniqueInstances.length; offset += 9) {
    const chunk = uniqueInstances.slice(offset, offset + 9);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((instance) => [
      groupId,
      member.id,
      instance.sourceInstanceId,
      cardNameKey(instance.cardName),
      instance.cardName,
      instance.foil ? 1 : 0,
      instance.pulledAt,
      acquisitionKind(instance.debug, instance.pulledAt),
      snapshotId,
      now,
    ]);
    statements.push(
      env.DB.prepare(
        `INSERT INTO member_card_instances
         (group_id, member_id, source_instance_id, card_name_key, card_name, foil,
          pulled_at, acquisition_kind, snapshot_id, updated_at)
         VALUES ${placeholders}
         ON CONFLICT(group_id, member_id, source_instance_id) DO UPDATE SET
           card_name_key = excluded.card_name_key,
           card_name = excluded.card_name,
           foil = excluded.foil,
           pulled_at = excluded.pulled_at,
           acquisition_kind = excluded.acquisition_kind,
           snapshot_id = excluded.snapshot_id,
           updated_at = excluded.updated_at`,
      ).bind(...bindings),
    );
  }

  const uniqueCards = [...new Map(uniqueInstances.map((instance) => [
    cardNameKey(instance.cardName),
    instance.cardName,
  ])).values()];
  for (let offset = 0; offset < uniqueCards.length; offset += 18) {
    const chunk = uniqueCards.slice(offset, offset + 18);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((name) => [groupId, cardNameKey(name), name, member.id, now]);
    statements.push(
      env.DB.prepare(
        `INSERT INTO group_unlocks
         (group_id, card_name_key, card_name, first_member_id, first_seen_at)
         VALUES ${placeholders} ON CONFLICT(group_id, card_name_key) DO NOTHING`,
      ).bind(...bindings),
    );
  }
  if (body.complete) {
    statements.push(
      env.DB.prepare(
        "DELETE FROM member_card_instances WHERE group_id = ? AND member_id = ? AND snapshot_id <> ?",
      ).bind(groupId, member.id, snapshotId),
    );
  }
  statements.push(
    env.DB.prepare("UPDATE groups SET collection_version = collection_version + 1, updated_at = ? WHERE id = ?")
      .bind(now, groupId),
  );
  statements.push(
    env.DB.prepare("UPDATE members SET collection_mode = ? WHERE id = ?")
      .bind(collectionMode, member.id),
  );
  await env.DB.batch(statements);

  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS copies, COUNT(DISTINCT card_name_key) AS cards,
            COALESCE(SUM(foil), 0) AS foils
     FROM member_card_instances WHERE group_id = ? AND member_id = ?`,
  )
    .bind(groupId, member.id)
    .first<{ copies: number; cards: number; foils: number }>();
  return json({
    snapshotId,
    accepted: uniqueInstances.length,
    complete: body.complete,
    collection: { cards: counts?.cards ?? 0, copies: counts?.copies ?? 0, foils: counts?.foils ?? 0 },
  });
}

async function getMemberCollections(request: Request, env: Env, groupId: string): Promise<Response> {
  await authenticate(request, env, groupId, true);
  const result = await env.DB.prepare(
    `SELECT m.id, m.member_label, m.player_name, m.collection_mode,
            COUNT(DISTINCT i.card_name_key) AS cards,
            COUNT(i.source_instance_id) AS copies,
            COALESCE(SUM(i.foil), 0) AS foils,
            MIN(NULLIF(i.pulled_at, 0)) AS first_pulled_at,
            MAX(NULLIF(i.pulled_at, 0)) AS last_pulled_at
     FROM members m
     LEFT JOIN member_card_instances i ON i.group_id = m.group_id AND i.member_id = m.id
     WHERE m.group_id = ? AND m.status = 'approved' AND m.revoked_at IS NULL
     GROUP BY m.id, m.member_label, m.player_name, m.collection_mode ORDER BY m.id`,
  )
    .bind(groupId)
    .all();
  return json({
    members: result.results.map((row) => ({
      id: row.id,
      label: row.member_label,
      playerName: row.player_name,
      collectionMode: row.collection_mode,
      cards: row.cards,
      copies: row.copies,
      foils: row.foils,
      firstPulledAt: row.first_pulled_at,
      lastPulledAt: row.last_pulled_at,
    })),
  });
}

async function getMemberCollection(
  request: Request,
  env: Env,
  groupId: string,
  memberId: string,
  url: URL,
): Promise<Response> {
  await authenticate(request, env, groupId, true);
  const limit = queryInteger(url, "limit", 1, 200, 100);
  const offset = queryInteger(url, "offset", 0, 100_000, 0);
  const owner = await env.DB.prepare(
    "SELECT id, member_label FROM members WHERE id = ? AND group_id = ? AND status = 'approved' AND revoked_at IS NULL",
  )
    .bind(memberId, groupId)
    .first<{ id: string; member_label: string }>();
  if (!owner) {
    throw new ApiError(404, "member_not_found", "That approved group member does not exist.");
  }
  const result = await env.DB.prepare(
    `SELECT source_instance_id, card_name, foil, pulled_at, acquisition_kind
     FROM member_card_instances WHERE group_id = ? AND member_id = ?
     ORDER BY card_name_key, pulled_at, source_instance_id LIMIT ? OFFSET ?`,
  )
    .bind(groupId, memberId, limit + 1, offset)
    .all();
  const rows = result.results.slice(0, limit);
  return json({
    member: { id: owner.id, label: owner.member_label },
    offset,
    nextOffset: offset + rows.length,
    hasMore: result.results.length > limit,
    instances: rows.map((row) => ({
      sourceInstanceId: row.source_instance_id,
      cardName: row.card_name,
      foil: row.foil === 1,
      pulledAt: row.pulled_at,
      acquisitionKind: row.acquisition_kind,
    })),
  });
}

async function getCardProvenance(request: Request, env: Env, groupId: string, url: URL): Promise<Response> {
  await authenticate(request, env, groupId, true);
  const cardName = normalizeCardName(url.searchParams.get("cardName"));
  if (!cardName) {
    throw new ApiError(400, "invalid_card_name", "cardName is required.");
  }
  const result = await env.DB.prepare(
    `SELECT i.source_instance_id, i.card_name, i.foil, i.pulled_at,
            i.acquisition_kind, m.id AS member_id, m.member_label
     FROM member_card_instances i JOIN members m ON m.id = i.member_id
     WHERE i.group_id = ? AND i.card_name_key = ? AND m.revoked_at IS NULL
     ORDER BY i.pulled_at, m.id, i.source_instance_id`,
  )
    .bind(groupId, cardNameKey(cardName))
    .all();
  return json({
    cardName,
    currentCopies: result.results.length,
    owners: result.results.map((row) => ({
      member: { id: row.member_id, label: row.member_label },
      sourceInstanceId: row.source_instance_id,
      foil: row.foil === 1,
      pulledAt: row.pulled_at,
      acquisitionKind: row.acquisition_kind,
    })),
  });
}

async function syncGroup(request: Request, env: Env, groupId: string, url: URL): Promise<Response> {
  const member = await authenticate(request, env, groupId, true);
  const after = queryInteger(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
  const topTrumpsAfter = queryInteger(url, "topTrumpsAfter", 0, Number.MAX_SAFE_INTEGER, 0);
  const clientCollectionVersion = queryInteger(url, "collectionVersion", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = queryInteger(url, "limit", 1, 100, 100);
  const group = await getGroupRow(env, groupId);
  const result = await env.DB.prepare(
    `SELECT p.seq, p.event_id, p.opened_at, p.cards_json, p.created_at,
            m.id AS member_id, m.member_label, m.player_name
     FROM pack_events p JOIN members m ON m.id = p.member_id
     WHERE p.group_id = ? AND p.seq > ? ORDER BY p.seq LIMIT ?`,
  )
    .bind(groupId, after, limit + 1)
    .all();
  const rows = result.results.slice(0, limit);
  const hasMore = result.results.length > limit;
  const events = rows.map((row) => ({
    sequence: row.seq,
    eventId: row.event_id,
    openedAt: row.opened_at,
    receivedAt: row.created_at,
    member: { id: row.member_id, label: row.member_label, playerName: row.player_name },
    cards: safeCardsJson(row.cards_json),
  }));

  let unlocks: string[] | undefined;
  if (clientCollectionVersion !== group.collection_version) {
    const unlockResult = await env.DB.prepare(
      "SELECT card_name FROM group_unlocks WHERE group_id = ? ORDER BY card_name COLLATE NOCASE",
    )
      .bind(groupId)
      .all<{ card_name: string }>();
    unlocks = unlockResult.results.map((row) => row.card_name);
  }

  const duelResult = await env.DB.prepare(
    `SELECT e.seq, e.challenge_id, e.event_type, e.challenger_card, e.challenged_card, e.created_at,
            c.expires_at,
            challenger.id AS challenger_id, challenger.member_label AS challenger_label,
            challenger.player_name AS challenger_player_name,
            challenged.id AS challenged_id, challenged.member_label AS challenged_label,
            challenged.player_name AS challenged_player_name
     FROM top_trumps_events e
     JOIN top_trumps_challenges c ON c.id = e.challenge_id
     JOIN members challenger ON challenger.id = e.challenger_member_id
     JOIN members challenged ON challenged.id = e.challenged_member_id
     WHERE e.group_id = ? AND e.seq > ?
       AND (e.challenger_member_id = ? OR e.challenged_member_id = ?)
     ORDER BY e.seq LIMIT 100`,
  ).bind(groupId, topTrumpsAfter, member.id, member.id).all();
  const topTrumpsEvents = duelResult.results.map((row) => ({
    sequence: row.seq,
    challengeId: row.challenge_id,
    type: row.event_type,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    challenger: { id: row.challenger_id, label: row.challenger_label, playerName: row.challenger_player_name },
    challenged: { id: row.challenged_id, label: row.challenged_label, playerName: row.challenged_player_name },
    challengerCard: row.challenger_card,
    challengedCard: row.challenged_card,
  }));

  return json({
    serverTime: Date.now(),
    nextCursor: events.length > 0 ? events[events.length - 1]?.sequence : after,
    hasMore,
    events,
    topTrumpsNextCursor: topTrumpsEvents.length > 0
      ? topTrumpsEvents[topTrumpsEvents.length - 1]?.sequence
      : topTrumpsAfter,
    topTrumpsEvents,
    collection: {
      version: group.collection_version,
      changed: clientCollectionVersion !== group.collection_version,
      ...(unlocks ? { unlocks } : {}),
    },
  });
}

async function createTopTrumpsChallenge(request: Request, env: Env, groupId: string): Promise<Response> {
  const challenger = await authenticate(request, env, groupId, true);
  const body = await readJson(request);
  const targetMemberId = stringField(body.targetMemberId, "targetMemberId", 8, 64);
  if (targetMemberId === challenger.id) {
    throw new ApiError(400, "self_challenge", "You cannot challenge yourself.");
  }
  const challenged = await env.DB.prepare(
    `SELECT m.id, m.group_id, m.member_label, m.player_name, m.player_name_key,
            m.collection_mode, m.role, m.status, m.revoked_at, m.last_seen_at,
            g.owner_member_id
     FROM members m JOIN groups g ON g.id = m.group_id
     WHERE m.id = ? AND m.group_id = ? AND m.status = 'approved' AND m.revoked_at IS NULL`,
  ).bind(targetMemberId, groupId).first<MemberRow>();
  if (!challenged) {
    throw new ApiError(404, "member_not_found", "That approved server member does not exist.");
  }
  if (!(await hasTopTrumpsCards(env, groupId, challenger))
    || !(await hasTopTrumpsCards(env, groupId, challenged))) {
    throw new ApiError(409, "insufficient_cards", "Both players need at least one card in their selected collection mode.");
  }

  const now = Date.now();
  await env.DB.prepare(
    "UPDATE top_trumps_challenges SET status = 'expired' WHERE group_id = ? AND status = 'pending' AND expires_at < ?",
  ).bind(groupId, now).run();
  const existing = await env.DB.prepare(
    `SELECT id FROM top_trumps_challenges
     WHERE group_id = ? AND challenger_member_id = ? AND status = 'pending' AND expires_at >= ?`,
  ).bind(groupId, challenger.id, now).first<{ id: string }>();
  if (existing) {
    throw new ApiError(409, "challenge_pending", "Wait for your current Top Trumps challenge to finish.");
  }

  const challengeId = crypto.randomUUID();
  const expiresAt = now + TOP_TRUMPS_CHALLENGE_MS;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO top_trumps_challenges
       (id, group_id, challenger_member_id, challenged_member_id, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(challengeId, groupId, challenger.id, challenged.id, expiresAt, now),
    env.DB.prepare(
      `INSERT INTO top_trumps_events
       (group_id, challenge_id, event_type, challenger_member_id, challenged_member_id, created_at)
       VALUES (?, ?, 'challenge', ?, ?, ?)`,
    ).bind(groupId, challengeId, challenger.id, challenged.id, now),
  ]);
  return json({ challengeId, expiresAt }, 201);
}

async function respondTopTrumpsChallenge(
  request: Request,
  env: Env,
  groupId: string,
  challengeId: string,
): Promise<Response> {
  const challenged = await authenticate(request, env, groupId, true);
  const body = await readJson(request);
  if (typeof body.accepted !== "boolean") {
    throw new ApiError(400, "invalid_accepted", "accepted must be a boolean.");
  }
  const challenge = await env.DB.prepare(
    `SELECT id, challenger_member_id, challenged_member_id, status, expires_at
     FROM top_trumps_challenges WHERE id = ? AND group_id = ?`,
  ).bind(challengeId, groupId).first<{
    id: string;
    challenger_member_id: string;
    challenged_member_id: string;
    status: string;
    expires_at: number;
  }>();
  if (!challenge || challenge.challenged_member_id !== challenged.id) {
    throw new ApiError(404, "challenge_not_found", "That Top Trumps challenge does not exist for this member.");
  }
  if (challenge.status !== "pending") {
    throw new ApiError(409, "challenge_finished", "That Top Trumps challenge has already finished.");
  }
  const now = Date.now();
  if (challenge.expires_at < now) {
    await env.DB.prepare("UPDATE top_trumps_challenges SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .bind(challengeId).run();
    throw new ApiError(410, "challenge_expired", "That Top Trumps challenge has expired.");
  }

  if (!body.accepted) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE top_trumps_challenges SET status = 'declined', responded_at = ? WHERE id = ? AND status = 'pending'",
      ).bind(now, challengeId),
      env.DB.prepare(
        `INSERT INTO top_trumps_events
         (group_id, challenge_id, event_type, challenger_member_id, challenged_member_id, created_at)
         VALUES (?, ?, 'declined', ?, ?, ?)`,
      ).bind(groupId, challengeId, challenge.challenger_member_id, challenge.challenged_member_id, now),
    ]);
    return json({ challengeId, status: "declined" });
  }

  const challenger = await getApprovedMember(env, groupId, challenge.challenger_member_id);
  if (!challenger) {
    throw new ApiError(409, "challenger_unavailable", "The challenger is no longer an approved server member.");
  }
  const challengerCard = await drawTopTrumpsCard(env, groupId, challenger);
  const challengedCard = await drawTopTrumpsCard(env, groupId, challenged);
  if (!challengerCard || !challengedCard) {
    throw new ApiError(409, "insufficient_cards", "Both players need at least one card in their selected collection mode.");
  }

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE top_trumps_challenges SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'",
    ).bind(now, challengeId),
    env.DB.prepare(
      `INSERT INTO top_trumps_events
       (group_id, challenge_id, event_type, challenger_member_id, challenged_member_id,
        challenger_card, challenged_card, created_at)
       VALUES (?, ?, 'result', ?, ?, ?, ?, ?)`,
    ).bind(groupId, challengeId, challenge.challenger_member_id, challenge.challenged_member_id,
      challengerCard, challengedCard, now),
  ]);
  return json({ challengeId, status: "accepted", challengerCard, challengedCard });
}

async function getApprovedMember(env: Env, groupId: string, memberId: string): Promise<MemberRow | null> {
  return env.DB.prepare(
    `SELECT m.id, m.group_id, m.member_label, m.player_name, m.player_name_key,
            m.collection_mode, m.role, m.status, m.revoked_at, m.last_seen_at,
            g.owner_member_id
     FROM members m JOIN groups g ON g.id = m.group_id
     WHERE m.id = ? AND m.group_id = ? AND m.status = 'approved' AND m.revoked_at IS NULL`,
  ).bind(memberId, groupId).first<MemberRow>();
}

async function hasTopTrumpsCards(env: Env, groupId: string, member: MemberRow): Promise<boolean> {
  return (await drawTopTrumpsCard(env, groupId, member)) !== null;
}

async function drawTopTrumpsCard(env: Env, groupId: string, member: MemberRow): Promise<string | null> {
  if (member.collection_mode === "solo") {
    const row = await env.DB.prepare(
      `SELECT card_name FROM member_card_instances
       WHERE group_id = ? AND member_id = ? GROUP BY card_name_key ORDER BY RANDOM() LIMIT 1`,
    ).bind(groupId, member.id).first<{ card_name: string }>();
    return row?.card_name ?? null;
  }
  const row = await env.DB.prepare(
    "SELECT card_name FROM group_unlocks WHERE group_id = ? ORDER BY RANDOM() LIMIT 1",
  ).bind(groupId).first<{ card_name: string }>();
  return row?.card_name ?? null;
}

async function authenticate(request: Request, env: Env, groupId: string, requireApproved: boolean): Promise<MemberRow> {
  const token = bearerToken(request);
  if (!token || token.length < 32 || token.length > 128) {
    throw new ApiError(401, "unauthorized", "A valid member bearer token is required.");
  }
  const member = await env.DB.prepare(
    `SELECT m.id, m.group_id, m.member_label, m.player_name, m.player_name_key,
            m.collection_mode, m.role, m.status, m.revoked_at, m.last_seen_at,
            g.owner_member_id
     FROM members m JOIN groups g ON g.id = m.group_id
     WHERE m.token_hash = ? AND m.group_id = ? AND m.revoked_at IS NULL`,
  )
    .bind(await sha256(token), groupId)
    .first<MemberRow>();
  if (!member) {
    throw new ApiError(401, "unauthorized", "The member token is invalid or has been revoked.");
  }
  if (requireApproved && member.status !== "approved") {
    throw new ApiError(403, "approval_required", "The group owner has not approved this membership yet.");
  }
  if (Date.now() - member.last_seen_at > 5 * 60 * 1000) {
    await env.DB.prepare("UPDATE members SET last_seen_at = ? WHERE id = ?").bind(Date.now(), member.id).run();
  }
  return member;
}

async function requireOwner(request: Request, env: Env, groupId: string): Promise<MemberRow> {
  const member = await authenticate(request, env, groupId, true);
  if (member.role !== "owner" || member.id !== member.owner_member_id) {
    throw new ApiError(403, "owner_required", "Only the group owner can perform this action.");
  }
  return member;
}

async function getGroupRow(env: Env, groupId: string): Promise<GroupRow> {
  const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(groupId).first<GroupRow>();
  if (!group) {
    throw new ApiError(404, "group_not_found", "That group does not exist.");
  }
  return group;
}

function parseCards(value: unknown): CardPull[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new ApiError(400, "invalid_cards", "cards must contain between 1 and 10 card pulls.");
  }
  return value.map((entry) => {
    if (!isObject(entry)) {
      throw new ApiError(400, "invalid_card", "Each card pull must be an object.");
    }
    const name = normalizeCardName(entry.name);
    if (!name || typeof entry.foil !== "boolean" || typeof entry.isNew !== "boolean") {
      throw new ApiError(400, "invalid_card", "Each card requires a valid name, foil flag and isNew flag.");
    }
    return { name, foil: entry.foil, isNew: entry.isNew };
  });
}

function parseMemberCardInstance(value: unknown): MemberCardInstanceInput {
  if (!isObject(value)) {
    throw new ApiError(400, "invalid_instance", "Each collection instance must be an object.");
  }
  const sourceInstanceId = stringField(value.sourceInstanceId, "sourceInstanceId", 1, 100);
  if (!/^[A-Za-z0-9_-]+$/.test(sourceInstanceId)) {
    throw new ApiError(
      400,
      "invalid_instance_id",
      "sourceInstanceId may contain only letters, numbers, underscores and hyphens.",
    );
  }
  const cardName = normalizeCardName(value.cardName);
  if (!cardName) {
    throw new ApiError(400, "invalid_card_name", "Every card name must contain between 1 and 120 characters.");
  }
  if (typeof value.foil !== "boolean") {
    throw new ApiError(400, "invalid_foil", "foil must be a boolean.");
  }
  if (typeof value.debug !== "boolean") {
    throw new ApiError(400, "invalid_debug", "debug must be a boolean.");
  }
  const pulledAt = integerField(value.pulledAt, "pulledAt", 0, Date.now() + 10 * 60 * 1000);
  return { sourceInstanceId, cardName, foil: value.foil, debug: value.debug, pulledAt };
}

function acquisitionKind(debug: boolean, pulledAt: number): "debug" | "pack_or_trade" | "unknown" {
  if (debug) {
    return "debug";
  }
  return pulledAt > 0 ? "pack_or_trade" : "unknown";
}

function uniqueCards(cards: CardPull[]): CardPull[] {
  return [...new Map(cards.map((card) => [cardNameKey(card.name), card])).values()];
}

function safeCardsJson(value: unknown): CardPull[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? (parsed as CardPull[]) : [];
  } catch {
    return [];
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "The request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "The request body is too large.");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new ApiError(400, "invalid_json", "The request body must be a JSON object.");
  }
}

function stringField(value: unknown, field: string, minLength: number, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_field", `${field} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new ApiError(400, "invalid_field", `${field} must contain between ${minLength} and ${maxLength} characters.`);
  }
  return normalized;
}

function playerNameField(value: unknown): string {
  const normalized = normalizePlayerName(value);
  if (!normalized) {
    throw new ApiError(400, "invalid_player_name", "playerName must contain 1 to 12 valid RuneScape-name characters.");
  }
  return normalized;
}

function collectionModeField(value: unknown): "shared" | "solo" {
  if (value !== "shared" && value !== "solo") {
    throw new ApiError(400, "invalid_collection_mode", "collectionMode must be shared or solo.");
  }
  return value;
}

function integerField(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiError(400, "invalid_field", `${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function queryInteger(url: URL, field: string, minimum: number, maximum: number, fallback: number): number {
  const value = url.searchParams.get(field);
  if (value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new ApiError(400, "invalid_query", `${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function publicGroup(group: GroupRow) {
  return {
    id: group.id,
    ownerMemberId: group.owner_member_id,
    collectionVersion: group.collection_version,
    inviteExpiresAt: group.invite_expires_at,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
  };
}

function publicMember(member: MemberRow) {
  return {
    id: member.id,
    groupId: member.group_id,
    label: member.member_label,
    playerName: member.player_name,
    collectionMode: member.collection_mode,
    role: member.role,
    status: member.status,
  };
}

function decodePath(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    throw new ApiError(400, "invalid_path", "The URL path is invalid.");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
