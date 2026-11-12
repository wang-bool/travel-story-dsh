// travel-agent 宿主侧存储与媒体/录像/瓦片服务（自包含，存储于 $DSH_HOME/travel-agent-data）
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const DATA_DIR = process.env.TRAVEL_AGENT_DATA_DIR || (process.env.DSH_HOME || process.env.HOME + '/.dsh') + '/travel-agent-data'
export const MEDIA_DIR = path.join(DATA_DIR, 'media')
export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings')
const TILE_CACHE = path.join(DATA_DIR, 'tile-cache')
export const TILES_UPSTREAM = 'https://tiles.openfreemap.org'

// ── 通用 ───────────────────────────────────────────────────────────────────
export const isMediaId = (id) => typeof id === 'string' && /^[\w-]+$/.test(id)
export const isSessionId = (s) => typeof s === 'string' && /^[\w-]+$/.test(s)
export const isFrameName = (n) => typeof n === 'string' && /^\d{6}\.jpg$/.test(n)
export const getLimitBytes = (mb, def) => { const n = Number(mb); return (Number.isFinite(n) && n > 0 ? n : def) * 1024 * 1024 }
const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'])
export const isAllowedMediaType = (t) => ALLOWED_MEDIA.has(String(t || '').toLowerCase())
export const isAllowedVideoType = (t, ext) => String(t || '').toLowerCase().startsWith('video/') && ['.mp4', '.webm'].includes('.' + ext)
const safeName = (n, def) => (typeof n === 'string' && n.trim() ? n : def).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)

async function writeAtomic(file, data) {
  try { await fs.promises.mkdir(path.dirname(file), { recursive: true }); const tmp = file + '.' + randomUUID() + '.tmp'; await fs.promises.writeFile(tmp, data); await fs.promises.rename(tmp, file) } catch (e) {}
}

// ── 请求体读取 ─────────────────────────────────────────────────────────────
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    req.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(); reject(Object.assign(new Error('too large'), { code: 413 })) } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// 简易 multipart 解析（二进制安全），返回 [{name, filename, type, data}]
export function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary); const parts = []; let idx = 0
  while (true) {
    const start = buf.indexOf(delim, idx); if (start === -1) break
    const headerStart = start + delim.length
    const next = buf.indexOf(delim, headerStart); if (next === -1) break
    let part = buf.subarray(headerStart, next)
    // 去掉前导 \r\n 和尾部 \r\n
    if (part.length >= 2 && part[0] === 13 && part[1] === 10) part = part.subarray(2)
    const sep = part.indexOf(Buffer.from('\r\n\r\n'))
    if (sep !== -1) {
      const headers = part.subarray(0, sep).toString('latin1')
      let data = part.subarray(sep + 4)
      if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) data = data.subarray(0, data.length - 2)
      const nm = /name="([^"]+)"/.exec(headers); const fn = /filename="([^"]*)"/.exec(headers); const ct = /content-type:\s*([^\r\n]+)/i.exec(headers)
      if (nm) parts.push({ name: nm[1], filename: fn ? fn[1] : undefined, type: ct ? ct[1].trim() : '', data })
    }
    idx = next
  }
  return parts
}

// ── 素材 ───────────────────────────────────────────────────────────────────
const mediaPath = (id) => path.join(MEDIA_DIR, id)
export async function writeMedia(id, buf, meta) { await fs.promises.mkdir(MEDIA_DIR, { recursive: true }); await writeAtomic(mediaPath(id), buf); await writeAtomic(mediaPath(id) + '.json', JSON.stringify(meta)) }
export async function readMedia(id) {
  try { const buf = await fs.promises.readFile(mediaPath(id)); let meta = { contentType: 'application/octet-stream', name: id }; try { meta = JSON.parse(await fs.promises.readFile(mediaPath(id) + '.json', 'utf8')) } catch (e) {} return { buf, meta } } catch (e) { return null }
}
export async function deleteMedia(id) { await fs.promises.unlink(mediaPath(id)).catch(() => {}); await fs.promises.unlink(mediaPath(id) + '.json').catch(() => {}) }

// ── 录像（ffmpeg 转码/合成） ───────────────────────────────────────────────
function runFfmpeg(args, timeout = 240000) { return new Promise((resolve, reject) => { execFile('ffmpeg', args, { timeout }, (err, _o, stderr) => { if (err) reject(new Error('ffmpeg: ' + String(stderr || '').slice(-400))); else resolve() }) }) }
export async function saveRecording(buf, tripName, ext) {
  await fs.promises.mkdir(RECORDINGS_DIR, { recursive: true })
  const name = safeName(tripName, '纪录片'); const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '').replace(/-/g, '')
  const base = ts + '-' + name; const rawPath = path.join(RECORDINGS_DIR, base + '.' + ext)
  await fs.promises.writeFile(rawPath, buf)
  let finalFile = base + '.' + ext
  if (ext === 'mp4') {
    try { await runFfmpeg(['-v', 'error', '-i', rawPath, '-map', '0:v:0', '-f', 'null', '-']) } catch (e) { await fs.promises.unlink(rawPath).catch(() => {}); throw Object.assign(new Error('invalid-video-stream'), { code: 422 }) }
  } else {
    const mp4 = path.join(RECORDINGS_DIR, base + '.mp4')
    try { await runFfmpeg(['-y', '-i', rawPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]); await fs.promises.unlink(rawPath); finalFile = base + '.mp4' } catch (e) {}
  }
  const stat = await fs.promises.stat(path.join(RECORDINGS_DIR, finalFile))
  return { file: finalFile, url: '/travel-agent/recordings/' + finalFile, size: stat.size }
}
export async function readRecording(file, download) {
  const safe = path.basename(file)
  if (safe !== file || !/\.(mp4|webm)$/.test(safe)) return null
  try { const buf = await fs.promises.readFile(path.join(RECORDINGS_DIR, safe)); const mp4 = safe.endsWith('.mp4'); const headers = { 'Content-Type': mp4 ? 'video/mp4' : 'video/webm', 'Content-Length': String(buf.length), ...(download ? { 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(safe) } : {}) }; return { buf, headers } } catch (e) { return null }
}

const framesDir = (s) => path.join(RECORDINGS_DIR, 'frames-' + s)
export async function saveFrames(session, files) { await fs.promises.mkdir(framesDir(session), { recursive: true }); await Promise.all(files.map((f) => fs.promises.writeFile(path.join(framesDir(session), f.name), f.data))); return files.length }
export async function finalizeFrames(session, tripName, fps) {
  const dir = framesDir(session); const names = await fs.promises.readdir(dir).catch(() => [])
  if (!names.some(isFrameName)) throw Object.assign(new Error('missing-frames'), { code: 400 })
  const name = safeName(tripName, '纪录片'); const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '').replace(/-/g, '')
  const finalFile = ts + '-' + name + '.mp4'; const out = path.join(RECORDINGS_DIR, finalFile)
  await fs.promises.mkdir(RECORDINGS_DIR, { recursive: true })
  const input = path.join(dir, '%06d.jpg')
  const f = Number.isInteger(fps) && fps >= 1 && fps <= 120 ? fps : 60
  try { await runFfmpeg(['-y', '-framerate', String(f), '-start_number', '0', '-i', input, '-c:v', 'h264_nvenc', '-preset', 'slow', '-rc', 'vbr', '-cq', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], 280000) }
  catch (e) { await runFfmpeg(['-y', '-framerate', String(f), '-start_number', '0', '-i', input, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], 280000) }
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
  const stat = await fs.promises.stat(out)
  return { file: finalFile, url: '/travel-agent/recordings/' + finalFile, size: stat.size }
}
export async function deleteFrames(session) { await fs.promises.rm(framesDir(session), { recursive: true, force: true }).catch(() => {}) }

// ── 瓦片代理 ───────────────────────────────────────────────────────────────
const H_PBF = { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'public, max-age=31536000, immutable' }
async function readFileSafe(f) { try { return await fs.promises.readFile(f) } catch (e) { return null } }
async function fetchUpstream(rel) { try { const res = await fetch(new URL(rel, TILES_UPSTREAM + '/'), { signal: AbortSignal.timeout(20000) }); if (!res.ok) return null; return Buffer.from(await res.arrayBuffer()) } catch (e) { return null } }
const inflight = new Map()
async function fetchDedup(rel) {
  if (inflight.has(rel)) return inflight.get(rel)
  const p = (async () => { const data = await fetchUpstream(rel); if (data) await writeAtomic(path.join(TILE_CACHE, rel), data); inflight.delete(rel); return data })()
  inflight.set(rel, p); return p
}
export async function serveTileJSON(origin) {
  let raw = await readFileSafe(path.join(TILE_CACHE, '_tilejson.json'))
  if (!raw || Date.now() - (await fs.promises.stat(path.join(TILE_CACHE, '_tilejson.json')).catch(() => ({ mtimeMs: 0 }))).mtimeMs >= 24 * 3600 * 1000) {
    const fetched = await fetchUpstream('planet'); if (fetched) { raw = fetched; await writeAtomic(path.join(TILE_CACHE, '_tilejson.json'), fetched) }
  }
  if (!raw) return null
  try { const json = JSON.parse(raw.toString('utf8')); if (Array.isArray(json.tiles)) json.tiles = json.tiles.map((u) => u.replace(TILES_UPSTREAM, origin + '/travel-agent/tiles')); return JSON.stringify(json) } catch (e) { return null }
}
export async function servePbf(rel) {
  const cached = await readFileSafe(path.join(TILE_CACHE, rel)); if (cached) return cached
  const data = await fetchDedup(rel); return data || null
}
export { H_PBF }

// ---- 由 host 路由调用：统一的 JSON 响应辅助 ----
export function sendJson(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
