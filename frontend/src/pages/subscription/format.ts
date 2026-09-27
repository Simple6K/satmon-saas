/**
 * 订阅管理页的时间展示工具。
 * PRD US-12.2：审计日志时间戳须 UTC + 本地时区双显。
 */

const pad = (n: number): string => String(n).padStart(2, '0')

/** 仅本地时区（成员加入时间等非审计展示） */
export function formatLocal(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** UTC + 本地双显（审计日志） */
export function formatUtcAndLocal(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const utc = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${utc} UTC / ${local} 本地`
}

/** 解析为时间戳（失败返回 NaN），用于审计日志时间范围筛选 */
export function toMillis(iso: string): number {
  return new Date(iso).getTime()
}
