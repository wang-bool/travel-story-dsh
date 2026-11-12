// Travel Story 前端（插件版）—— 整应用原样搬入，自带 React/MapLibre 打包。
// 由 wrapper 通过 window.TravelStoryApp.mount(domNode, opts) 挂载。
// opts: { isOpen(): boolean, subscribeOpen(fn): unsub, onClose() }
// AppAgentBridge 常驻运行（agent 可在面板未展开时通过 navigate 命令自动展开），
// RouteView 仅在面板展开时渲染，避免后台初始化地图/预取瓦片。
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import globalsCss from './app/globals.css'
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css'
import { usePath, getPath, subscribePath } from '@/lib/router'
import { AppAgentBridge } from '@/components/AppAgentBridge'
import { AgentActivityPanel } from '@/components/AgentActivityPanel'
import { SyncStatus } from '@/components/SyncStatus'
import HomePage from './app/page'
import TripPage from './app/trip-page'
import PlayPage from './app/trip/[id]/play/page'
import RecordPage from './app/trip/[id]/record/page'

function injectCss(text, attr) {
  if (typeof document === 'undefined' || !text) return
  if (document.querySelector(`style[${attr}]`)) return
  const s = document.createElement('style')
  s.setAttribute(attr, '1')
  s.textContent = text
  document.head.appendChild(s)
}
injectCss(globalsCss, 'data-travel-globals')
injectCss(maplibreCss, 'data-travel-maplibre-css')

function RouteView() {
  const p = usePath()
  if (/^\/trip\/[^/]+\/play$/.test(p)) return <PlayPage />
  if (/^\/trip\/[^/]+\/record$/.test(p)) return <RecordPage />
  if (/^\/trip\/[^/]+$/.test(p)) return <TripPage />
  return <HomePage />
}

// 地图初始化失败（如 WebGL 不可用）不至于拖垮整个面板
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) return <div style={{ padding: 40, fontSize: 14 }}>页面渲染出错：{String(this.state.error.message || this.state.error)}</div>
    return this.props.children
  }
}

function Shell({ isOpen, subscribeOpen }) {
  const [open, setOpen] = useState(() => isOpen())
  useEffect(() => subscribeOpen(() => setOpen(isOpen())), [])
  const path = usePath()
  const onPlayPage = /^\/trip\/[^/]+\/(play|record)$/.test(path)
  return (
    <AppAgentBridge>
      {open ? <ErrorBoundary><RouteView /></ErrorBoundary> : null}
      <SyncStatus />
      {/* 播放/录制页全屏看画面：Agent 活动面板不展示 */}
      {!onPlayPage && <AgentActivityPanel />}
    </AppAgentBridge>
  )
}

export { getPath, subscribePath }

export function mount(domNode, opts) {
  const root = createRoot(domNode)
  root.render(React.createElement(Shell, { isOpen: opts.isOpen, subscribeOpen: opts.subscribeOpen }))
  return () => { try { root.unmount() } catch (e) {} }
}
