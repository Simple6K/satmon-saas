/**
 * 结果页斑块样式与标签辅助（仅本页使用；单一场景直接实现，不上升为共享抽象）。
 * 置信度分色对齐 US-07「半透明红色系高亮」，描边恒可见由 PatchMap 保证。
 */
import type { PatchProperties } from '../../api/types'

/** 结果 GeoJSON 中的单个斑块 Feature（geometry 由 Leaflet 消费，边界处已过 zod 校验） */
export interface PatchFeature {
  type: 'Feature'
  properties: PatchProperties
  geometry: unknown
}

/** 置信度分色：高（≥80%）深红 / 中（60–80%）橙 / 低（<60%）黄 */
export function confidenceColor(conf: number): string {
  if (conf >= 0.8) return '#d4380d'
  if (conf >= 0.6) return '#fa8c16'
  return '#fadb14'
}

export const CONFIDENCE_LEGEND = [
  { label: '高（≥80%）', color: '#d4380d' },
  { label: '中（60–80%）', color: '#fa8c16' },
  { label: '低（<60%）', color: '#fadb14' },
] as const

export const ALERT_LEVEL_LABELS: Record<string, { label: string; color: string }> = {
  high: { label: '告警等级：高', color: 'red' },
  medium: { label: '告警等级：中', color: 'orange' },
  low: { label: '告警等级：低', color: 'blue' },
}

export function alertLevelTagProps(level: string): { label: string; color: string } {
  return ALERT_LEVEL_LABELS[level] ?? { label: `告警等级：${level}`, color: 'default' }
}

export const ALERT_STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: '待处理', color: 'processing' },
  confirmed: { label: '已确认', color: 'success' },
  field_check: { label: '转现场核查', color: 'warning' },
  dismissed: { label: '已忽略（误报）', color: 'default' },
}

/** km² → 公顷（US-07/US-08 面积以公顷展示，保留 2 位小数） */
export function fmtHa(areaKm2: number): string {
  return (areaKm2 * 100).toFixed(2)
}

/** 斑块编号较长，列表中截断展示 */
export function shortPatchId(patchId: string): string {
  return patchId.length > 22 ? `${patchId.slice(0, 19)}…` : patchId
}

/** 斑块属性来自后端响应（外部输入视为不可信），拼 popup HTML 前转义 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return map[c] as string
  })
}
