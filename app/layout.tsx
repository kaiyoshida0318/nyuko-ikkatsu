import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

const basePath = process.env.NODE_ENV === 'production' ? '/nyuko-ikkatsu' : ''

export const metadata: Metadata = {
  title: '入庫一括',
  description: 'ラクマート到着分の入庫処理を、NE・kintone・倉庫リスト向けに一括処理するWebアプリ。',
  icons: {
    icon: [
      { url: `${basePath}/favicon.ico`, type: 'image/x-icon' },
      { url: `${basePath}/favicon.png`, type: 'image/png' },
    ],
    shortcut: `${basePath}/favicon.ico`,
    apple: `${basePath}/favicon.png`,
  },
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  )
}
