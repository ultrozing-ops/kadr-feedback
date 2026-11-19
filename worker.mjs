const VERSION = "2022-11-28";
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_BODY = Math.ceil(MAX_IMAGE * 4 / 3) + 32768;
const CODE = /^[a-zA-Z0-9_-]{24,128}$/;
const KEY = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const PNG_HEADER = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82);
const PREFIX = "<!-- kadr-feedback:v1:";
const encode = new TextEncoder();
const decode = new TextDecoder("utf-8", { fatal: true });

class Failure extends Error {
    constructor(status, upstream = 0) {
        super(String(status));
        this.status = status;
        this.upstream = upstream;
    }
}

function check(condition, status) {
    if (!condition) throw new Failure(status);
}

function json(body, status = 200) {
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function settings(env) {
    const repo = env.GITHUB_REPO;
    const issue = integer(env.GITHUB_ISSUE, 503);
    const authorId = integer(env.GITHUB_AUTHOR_ID, 503);
    const branch = env.GITHUB_IMAGE_BRANCH || "main";
    const authorName = env.KADR_AUTHOR_NAME || "Павлюк А.И.";
    const admin = env.KADR_AUTHOR_CODE;
    const members = (env.KADR_MEMBER_CODES || "").trim().split(/\s+/);
    check(/^[\w.-]+\/[\w.-]+$/.test(repo || "") && issue && authorId, 503);
    check(/^[A-Za-z0-9_-]+$/.test(branch) && nameOk(authorName), 503);
    check(env.GITHUB_TOKEN && CODE.test(admin || "") && members.every(code => CODE.test(code) && code !== admin), 503);
    return { repo, issue, branch, authorId, authorName, admin, members, token: env.GITHUB_TOKEN };
}

function integer(value, status = 400) {
    check(/^[0-9]{1,16}$/.test(value || "") && Number.isSafeInteger(Number(value)), status);
    return Number(value);
}

function nameOk(name) {
    return typeof name === "string" && name.length >= 1 && name.length <= 64 && !/[\p{C}\r\n]/u.test(name);
}

function equal(a, b) {
    let difference = a.length ^ b.length;
    for (let i = 0; i < 128; i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return difference === 0;
}

function authorize(request, cfg) {
    const code = (request.headers.get("Authorization") || "").match(/^Bearer ([a-zA-Z0-9_-]{24,128})$/)?.[1];
    check(code, 401);
    if (equal(code, cfg.admin)) return true;
    check(cfg.members.some(member => equal(code, member)), 401);
    return false;
}

async function github(path, cfg, request = {}) {
    const headers = {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + cfg.token,
        "User-Agent": "KADR-Feedback",
        "X-GitHub-Api-Version": VERSION,
    };
    if (request.body) headers["Content-Type"] = "application/json";
    try {
        return await fetch("https://api.github.com" + path, { ...request, headers, redirect: "manual" });
    } catch (error) {
        const failure = new Failure(502);
        const message = String(error?.message || "");
        failure.reason = /^[a-zA-Z0-9 .,:()/-]{1,160}$/.test(message) ? message : "GitHub request failed";
        throw failure;
    }
}

async function githubJson(path, cfg, request) {
    const response = await github(path, cfg, request);
    if (!response.ok) throw new Failure(response.status === 409 || response.status === 422 ? 503 : 502, response.status);
    try {
        return await response.json();
    } catch {
        const failure = new Failure(502, response.status);
        failure.reason = "GitHub response was not JSON";
        throw failure;
    }
}

async function body(request) {
    check(request.headers.get("Content-Type")?.split(";")[0] === "application/json", 415);
    check(request.body && Number(request.headers.get("Content-Length") || 0) <= MAX_BODY, 413);
    const reader = request.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > MAX_BODY) {
                await reader.cancel();
                throw new Failure(413);
            }
            chunks.push(part.value);
        }
    } finally {
        reader.releaseLock();
    }
    let payload;
    try {
        const data = new Uint8Array(bytes);
        let position = 0;
        for (const chunk of chunks) {
            data.set(chunk, position);
            position += chunk.length;
        }
        payload = JSON.parse(decode.decode(data));
    } catch {
        throw new Failure(400);
    }
    check(payload && typeof payload === "object" && !Array.isArray(payload), 400);
    return payload;
}

function imageBytes(encoded) {
    check(typeof encoded === "string" && encoded.length <= Math.ceil(MAX_IMAGE / 3) * 4, 413);
    let bytes;
    try {
        bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    } catch {
        throw new Failure(400);
    }
    check(bytes.length <= MAX_IMAGE, 413);
    check(bytes.length >= 33 && PNG_HEADER.every((part, i) => part === bytes[i]), 400);
    const view = new DataView(bytes.buffer);
    const w = view.getUint32(16);
    const h = view.getUint32(20);
    check(w > 0 && h > 0 && w <= 4096 && h <= 4096 && w * h <= 12_000_000, 413);
    return bytes;
}

async function hex(algorithm, bytes) {
    const digest = await crypto.subtle.digest(algorithm, bytes);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

function rawImage(cfg, hash) {
    return `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/feedback-images/${hash}.png`;
}

async function saveImage(cfg, hash, bytes, encoded) {
    const address = `/repos/${cfg.repo}/contents/feedback-images/${hash}.png`;
    const result = await github(address, cfg, {
        method: "PUT",
        body: JSON.stringify({ message: "Add KADR feedback screenshot", content: encoded, branch: cfg.branch }),
    });
    if (result.ok) return;
    check(result.status === 409 || result.status === 422, 502);
    // A previous attempt or another client may already have committed the same image.
    const existing = await githubJson(address + "?ref=" + cfg.branch, cfg);
    const header = encode.encode("blob " + bytes.length + "\0");
    const blob = new Uint8Array(header.length + bytes.length);
    blob.set(header);
    blob.set(bytes, header.length);
    check(existing.sha === await hex("SHA-1", blob), 503);
}

function encodedMetadata(data) {
    const bytes = encode.encode(JSON.stringify(data));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readMetadata(comment, cfg) {
    if (comment.user?.id !== cfg.authorId || typeof comment.body !== "string") return null;
    const marker = comment.body.startsWith(PREFIX) ? comment.body.slice(PREFIX.length).split(" -->", 1)[0] : "";
    if (!marker) return { author: true, name: cfg.authorName, body: comment.body.slice(0, 4000), image: "" };
    try {
        const data = JSON.parse(decode.decode(Uint8Array.from(
            atob(marker.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0)
        )));
        if (!KEY.test(data.key || "") || !nameOk(data.name) || typeof data.author !== "boolean" ||
            typeof data.body !== "string" || (data.image && !HASH.test(data.image))) return null;
        return data;
    } catch {
        return null;
    }
}

function safeMarkdown(text) {
    return text.replace(/[&<>@#]/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "@": "&#64;", "#": "&#35;" }[s]))
        .replace(/[\\`*_~!|\[\]()]/g, "\\$&");
}

function commentBody(data, cfg) {
    const heading = data.author ? safeMarkdown(cfg.authorName) : safeMarkdown(data.name) + " · участник КАДРа";
    const image = data.image ? "\n\n![Скриншот](" + rawImage(cfg, data.image) + ")" : "";
    return PREFIX + encodedMetadata(data) + " -->\n**" + heading + "**\n\n" + safeMarkdown(data.body) + image;
}

function issuePath(cfg) {
    return `/repos/${cfg.repo}/issues/${cfg.issue}/comments`;
}

async function listGithub(cfg, since) {
    const suffix = since ? "&since=" + encodeURIComponent(since) : "";
    const comments = [];
    for (let page = 1; ; page++) {
        const reply = await github(issuePath(cfg) + "?per_page=100&page=" + page + suffix, cfg);
        check(reply.ok, 502);
        const batch = await reply.json();
        check(Array.isArray(batch), 502);
        comments.push(...batch);
        if (!/rel="next"/.test(reply.headers.get("Link") || "")) break;
    }
    return comments;
}

// Cache decoded data only. Cloudflare request I/O must stay in its own invocation.
const reads = new Map();
async function history(cfg, after) {
    const key = cfg.repo + "#" + cfg.issue + "@" + after;
    const saved = reads.get(key);
    if (saved && saved.expiry > Date.now()) return saved.comments;
    const comments = await (async () => {
        if (!after) {
            const issue = await githubJson(`/repos/${cfg.repo}/issues/${cfg.issue}`, cfg);
            const page = Math.max(1, Math.ceil(issue.comments / 100));
            const getPage = number => githubJson(issuePath(cfg) + "?per_page=100&page=" + number, cfg);
            const newest = await getPage(page);
            if (page === 1 || newest.length >= 50) return newest;
            return (await getPage(page - 1)).concat(newest);
        }
        const response = await github(`/repos/${cfg.repo}/issues/comments/${after}`, cfg);
        if (response.status === 404) return history(cfg, 0);
        check(response.ok, 502);
        const last = await response.json();
        const expected = `https://api.github.com/repos/${cfg.repo}/issues/${cfg.issue}`;
        check(last.issue_url === expected, 404);
        const since = new Date(Date.parse(last.created_at) - 1000).toISOString();
        return listGithub(cfg, since);
    })();
    if (reads.size >= 64) reads.clear();
    reads.set(key, { comments, expiry: Date.now() + 8000 });
    return comments;
}

async function historyResponse(cfg, after) {
    const result = [];
    for (const comment of await history(cfg, after)) {
        if (!Number.isSafeInteger(comment.id) || comment.id <= after) continue;
        const message = readMetadata(comment, cfg);
        if (!message) continue;
        result.push({
            id: comment.id, name: message.name, body: message.body,
            author: message.author, sent_at: comment.created_at, has_image: Boolean(message.image),
        });
    }
    result.sort((a, b) => a.id - b.id);
    return json({ messages: after ? result.slice(0, 50) : result.slice(-50) });
}

async function send(request, cfg, author) {
    const raw = await body(request);
    const name = author ? cfg.authorName : typeof raw.name === "string" ? raw.name.trim() : "";
    check(nameOk(name), 400);
    check(author || name.toLowerCase() !== cfg.authorName.toLowerCase(), 409);
    check(KEY.test(raw.client_id || "") && typeof raw.body === "string" && raw.body.length <= 4000, 400);
    const text = raw.body.trim();
    const screenshot = raw.image ?? "";
    check(typeof screenshot === "string" && (text || screenshot), 400);
    const bytes = screenshot ? imageBytes(screenshot) : null;
    const image = bytes ? await hex("SHA-256", bytes) : "";
    const data = { key: raw.client_id, author, name, body: text, image };

    const account = await githubJson("/user", cfg);
    check(account.id === cfg.authorId, 503);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const comment of await listGithub(cfg, since)) {
        const previous = readMetadata(comment, cfg);
        if (previous?.key !== data.key || previous.author !== author) continue;
        check(previous.name === name && previous.body === text && (previous.image || "") === image, 409);
        return json({ id: comment.id });
    }
    if (bytes) await saveImage(cfg, image, bytes, screenshot);
    const comment = await githubJson(issuePath(cfg), cfg, {
        method: "POST", body: JSON.stringify({ body: commentBody(data, cfg) }),
    });
    check(comment.user?.id === cfg.authorId && Number.isSafeInteger(comment.id), 502);
    reads.clear();
    return json({ id: comment.id });
}

async function imageResponse(cfg, id) {
    const comment = await githubJson(`/repos/${cfg.repo}/issues/comments/${id}`, cfg);
    check(comment.issue_url === `https://api.github.com/repos/${cfg.repo}/issues/${cfg.issue}`, 404);
    const message = readMetadata(comment, cfg);
    check(message?.image, 404);
    // Public file endpoint. Never forward the GitHub token here.
    const response = await fetch(rawImage(cfg, message.image), { redirect: "manual" });
    check(response.ok && Number(response.headers.get("Content-Length") || 0) <= MAX_IMAGE, 502);
    return new Response(response.body, {
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
}

const writes = new Set();
async function publish(request, cfg, author) {
    const key = cfg.repo + "#" + cfg.issue;
    check(!writes.has(key), 503);
    writes.add(key);
    try {
        return await send(request, cfg, author);
    } finally {
        writes.delete(key);
    }
}

const PRESENCE_TTL_MS = 65000;
async function updatePresence(request, db, cfg, author, leaving) {
    check(db, 503);
    const payload = await body(request);
    check(typeof payload.session === "string" && KEY.test(payload.session), 400);
    const key = await hex("SHA-256", encode.encode(request.headers.get("Authorization") + ":" + payload.session));
    const now = Date.now();
    await db.prepare(
        "CREATE TABLE IF NOT EXISTS kadr_presence (session TEXT PRIMARY KEY, name TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    ).run();
    if (leaving) {
        await db.prepare("DELETE FROM kadr_presence WHERE session = ?").bind(key).run();
        return json({ online: [] });
    }
    const name = author ? cfg.authorName : typeof payload.name === "string" ? payload.name.trim() : "";
    check(nameOk(name) && (author || name.toLowerCase() !== cfg.authorName.toLowerCase()), 400);
    const results = await db.batch([
        db.prepare("DELETE FROM kadr_presence WHERE expires_at <= ?").bind(now),
        db.prepare(
            "INSERT INTO kadr_presence (session, name, expires_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(session) DO UPDATE SET name = excluded.name, expires_at = excluded.expires_at"
        ).bind(key, name, now + PRESENCE_TTL_MS),
        db.prepare("SELECT DISTINCT name FROM kadr_presence WHERE expires_at > ? ORDER BY name LIMIT 100").bind(now),
    ]);
    return json({ online: results[2].results.map(row => row.name).sort((a, b) => a.localeCompare(b, "ru")) });
}

export default {
    async fetch(request, env) {
        try {
            const cfg = settings(env);
            const author = authorize(request, cfg);
            const url = new URL(request.url);
            if (request.method === "POST" && (url.pathname === "/presence" || url.pathname === "/presence/leave"))
                return await updatePresence(request, env.CHAT_PRESENCE, cfg, author, url.pathname.endsWith("/leave"));
            if (url.pathname === "/messages") {
                if (request.method === "GET") return await historyResponse(cfg, integer(url.searchParams.get("after") ?? "0"));
                if (request.method === "POST") return await publish(request, cfg, author);
            }
            const match = url.pathname.match(/^\/images\/([0-9]+)$/);
            if (match && request.method === "GET") return await imageResponse(cfg, integer(match[1]));
            return json({ error: 404 }, 404);
        } catch (error) {
            const status = error instanceof Failure ? error.status : 502;
            const upstream = error instanceof Failure ? error.upstream : 0;
            const diagnostic = { error: status };
            if (upstream) diagnostic.github_status = upstream;
            if (error instanceof Failure && error.reason) diagnostic.reason = error.reason;
            return json(diagnostic, status);
        }
    },
};
