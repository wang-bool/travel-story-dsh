// next/navigation 的 shim：router / useParams / usePathname / useSearchParams 接到插件路由
import { navigate, usePath, getQuery, tripIdFromPath } from '@/lib/router'

export function useRouter() {
  return {
    push: (p) => navigate(p),
    replace: (p) => navigate(p),
    back: () => navigate('/'),
    refresh: () => {},
    prefetch: () => {},
  }
}

export function usePathname() { return usePath() }

export function useParams() {
  const p = usePath()
  return { id: tripIdFromPath(p) }
}

export function useSearchParams() {
  usePath() // 订阅路由变化，query 更新时重渲染
  return new URLSearchParams(getQuery())
}
