// 插件内的轻量路由（替代 next/navigation）：路径存 module state，订阅重渲染。
// pathname 与 query 分开存：路由匹配只用 pathname，query 供 useSearchParams 读取。
import { useEffect, useState } from 'react'

let currentPath = '/'
let currentQuery = ''
const listeners = new Set<() => void>()

export function navigate(path: string) {
  const qi = path.indexOf('?')
  const pathname = qi === -1 ? path : path.slice(0, qi)
  const query = qi === -1 ? '' : path.slice(qi + 1)
  if (pathname === currentPath && query === currentQuery) return
  currentPath = pathname
  currentQuery = query
  listeners.forEach((l) => l())
}

export function usePath(): string {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((x) => x + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return currentPath
}

export function getPath(): string { return currentPath }

export function getQuery(): string { return currentQuery }

export function subscribePath(fn: (path: string) => void): () => void {
  const wrapped = () => fn(currentPath)
  listeners.add(wrapped)
  return () => { listeners.delete(wrapped) }
}

export function tripIdFromPath(path: string): string | undefined {
  const m = /^\/trip\/([^/]+)/.exec(path)
  return m ? m[1] : undefined
}
