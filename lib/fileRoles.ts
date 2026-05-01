import type { FileRole } from './types'

export function detectFileRole(file: File): FileRole {
  const name = file.name
  const lower = name.toLowerCase()

  if (lower.endsWith('.xlsx') && lower.startsWith('p')) return 'packing'
  if (lower.endsWith('.csv') && (name.includes('商品リスト') || name.includes('オーダー') || lower.includes('order'))) return 'orders'
  if (lower.endsWith('.csv') && name.includes('商品情報')) return 'master'
  return 'unknown'
}

export function fileRoleLabel(role: FileRole) {
  switch (role) {
    case 'packing':
      return 'ラクマート配送依頼書'
    case 'orders':
      return 'オーダー状況CSV'
    case 'master':
      return '商品情報CSV'
    default:
      return '未判定'
  }
}
