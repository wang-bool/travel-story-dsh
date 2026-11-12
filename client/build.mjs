// 打包整个 Travel Story 前端 → lib/client.js（自包含：React/MapLibre/turf 全部内联）
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const dir = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(dir, 'dist', 'app.js')
const out = path.join(dir, '..', 'lib', 'client.js')

await build({
  entryPoints: [path.join(dir, 'app.jsx')],
  outfile: dist,
  bundle: true,
  format: 'iife',
  globalName: 'TravelStoryApp',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  alias: {
    '@': dir,
    'next/link': path.join(dir, 'shims/next-link.jsx'),
    'next/navigation': path.join(dir, 'shims/next-navigation.jsx'),
  },
  nodePaths: [path.join(dir, '..', 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ts': 'ts', '.tsx': 'tsx', '.css': 'text' },
  logLevel: 'warning',
})

const wrapper = fs.readFileSync(path.join(dir, 'wrapper.js'), 'utf8')
const bundle = fs.readFileSync(dist, 'utf8')
fs.writeFileSync(out, '/* travel-agent: Travel Story frontend (bundled, self-contained) */\n' + bundle + '\n' + wrapper)
console.log('wrote', out, '(', (fs.statSync(out).size / 1024 / 1024).toFixed(2), 'MB )')

// 同步 MapLibre worker 静态文件（host 端 /travel-agent/maplibre/* 路由 serve，
// 客户端 setWorkerUrl 指向它；worker 按相对路径 import ./maplibre-gl-shared.mjs）
try {
  const require2 = createRequire(path.join(dir, 'app.jsx'))
  const pkgJson = require2.resolve('maplibre-gl/package.json', { paths: [path.join(dir, '..', 'node_modules')] })
  const distDir = path.join(path.dirname(pkgJson), 'dist')
  const staticDir = path.join(dir, '..', 'lib', 'static', 'maplibre')
  fs.mkdirSync(staticDir, { recursive: true })
  for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) fs.copyFileSync(path.join(distDir, f), path.join(staticDir, f))
  console.log('synced maplibre worker ->', staticDir)
} catch (e) { console.warn('maplibre worker 同步失败（保留 lib/static/maplibre 现有文件）:', e && e.message) }
