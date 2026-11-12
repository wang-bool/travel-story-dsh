// next/link 的 shim：用插件路由做站内跳转，不整页刷新
import React from 'react'
import { navigate } from '@/lib/router'

export default function Link(props) {
  const { href, children, onClick, ...rest } = props
  return React.createElement('a', {
    href,
    ...rest,
    onClick: function (e) {
      if (typeof href === 'string' && href.startsWith('/')) { e.preventDefault(); navigate(href) }
      if (onClick) onClick(e)
    },
  }, children)
}
