import type { FileRole } from './types'

export function detectFileRole(file: File): FileRole {
  const lower = file.name.toLowerCase()

  if (lower.endsWith('.xlsx') && lower.startsWith('p')) return 'packing'
  return 'unknown'
}

export function fileRoleLabel(role: FileRole) {
  switch (role) {
    case 'packing':
      return 'ラクマート配送依頼書'
    default:
      return '未判定'
  }
}
