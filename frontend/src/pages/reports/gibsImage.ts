/**
 * GIBS WMS 静态影像（报告前后时相举证图 / AOI 定位图）。
 *
 * 数据源（2026-09-27 本机实测）：
 * - 端点：https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi（免登录，ACAO:*）
 * - 图层：MODIS_Terra_CorrectedReflectance_TrueColor（250m，日覆盖）
 * - 当天无 granule 时返回 1148B 纯色空图（多日期 MD5 相同）→ 必须做空白检测
 *   并按日回退取邻近有效影像（HLS 30m 已实测该区域无覆盖，不可用）
 *
 * 约束（对齐工程原则 4）：单次请求 8s 超时；日期回退最多 3 次（共 4 次），
 * 全部失败如实返回 null 由调用方展示降级占位——不做无边界重试。
 */

const WMS_ENDPOINT = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor'
const REQUEST_TIMEOUT_MS = 8000
const MAX_DATE_FALLBACK = 3
const IMG_SIZE = 384

export interface BBox {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}

export interface PhaseImageResult {
  /** objectURL（调用方无需释放：结果进模块缓存，页面级复用） */
  url: string
  /** 实际取到影像的日期（可能与请求日期不同——空白回退后） */
  actualDate: string
  width: number
  height: number
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function buildUrl(bbox: BBox, date: string, size: number): string {
  const b = `${bbox.minLng.toFixed(4)},${bbox.minLat.toFixed(4)},${bbox.maxLng.toFixed(4)},${bbox.maxLat.toFixed(4)}`
  const params = new URLSearchParams({
    VERSION: '1.1.1',
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    LAYERS: LAYER,
    STYLES: '',
    FORMAT: 'image/jpeg',
    WIDTH: String(size),
    HEIGHT: String(size),
    SRS: 'EPSG:4326',
    BBOX: b,
    TIME: date,
  })
  return `${WMS_ENDPOINT}?${params.toString()}`
}

/**
 * 空白图检测：GIBS 无覆盖时返回纯色图。取 16×16 缩略采样，全部像素一致即判空。
 * 城市窗口 15km+ 范围内真实影像不可能全图同色，误判可忽略。
 */
async function isBlankImage(blob: Blob): Promise<boolean> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return false // 无法检测时按有效处理，宁可有图误用不可无图
  }
  ctx.drawImage(bitmap, 0, 0, 16, 16)
  bitmap.close()
  const data = ctx.getImageData(0, 0, 16, 16).data
  const r0 = data[0]
  const g0 = data[1]
  const b0 = data[2]
  for (let i = 4; i < data.length; i += 4) {
    if (Math.abs(data[i] - r0) > 2 || Math.abs(data[i + 1] - g0) > 2 || Math.abs(data[i + 2] - b0) > 2) {
      return false
    }
  }
  return true
}

/** 模块级缓存：预览与 PDF 导出共用，避免同图重复拉取 */
const cache = new Map<string, PhaseImageResult | null>()

function cacheKey(bbox: BBox, date: string, size: number): string {
  return `${bbox.minLng.toFixed(3)},${bbox.minLat.toFixed(3)},${bbox.maxLng.toFixed(3)},${bbox.maxLat.toFixed(3)}@${date}@${size}`
}

/**
 * 取指定范围与日期的影像；当天无数据时按日向前回退（最多 MAX_DATE_FALLBACK 次）。
 * size 控制出图边长（预览 384 / 详情弹窗 1024）。
 * 返回 null 表示不可用（网络失败 / 连续空白），调用方展示降级占位。
 */
export async function getPhaseImage(bbox: BBox, date: string, size = IMG_SIZE): Promise<PhaseImageResult | null> {
  for (let back = 0; back <= MAX_DATE_FALLBACK; back++) {
    const actualDate = shiftDate(date, back)
    const key = cacheKey(bbox, actualDate, size)
    if (cache.has(key)) return cache.get(key) ?? null

    let result: PhaseImageResult | null = null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const resp = await fetch(buildUrl(bbox, actualDate, size), { signal: controller.signal })
      clearTimeout(timer)
      if (resp.ok) {
        const blob = await resp.blob()
        if (blob.type.startsWith('image/') && !(await isBlankImage(blob))) {
          result = {
            url: URL.createObjectURL(blob),
            actualDate,
            width: size,
            height: size,
          }
        }
      }
    } catch {
      result = null // 单次失败继续回退尝试；全部失败由外层统一返回 null
    }
    cache.set(key, result)
    if (result) return result
  }
  return null
}

const ESRI_EXPORT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export'

/**
 * Esri World Imagery 静态高清现状图（2026-09-28 实测：1024px 约 0.5MB / 1.8s）。
 * 注意：Esri 为最新合成镶嵌（无日期维度），仅作「现状高清参考」，时相语义仍由 GIBS 承担。
 */
export async function getEsriCurrentImage(bbox: BBox, size = 1024): Promise<PhaseImageResult | null> {
  const key = cacheKey(bbox, 'esri-current', size)
  if (cache.has(key)) return cache.get(key) ?? null
  let result: PhaseImageResult | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const params = new URLSearchParams({
      bbox: `${bbox.minLng.toFixed(4)},${bbox.minLat.toFixed(4)},${bbox.maxLng.toFixed(4)},${bbox.maxLat.toFixed(4)}`,
      bboxSR: '4326',
      size: `${size},${size}`,
      format: 'jpg',
      f: 'image',
    })
    const resp = await fetch(`${ESRI_EXPORT}?${params}`, { signal: controller.signal })
    clearTimeout(timer)
    if (resp.ok) {
      const blob = await resp.blob()
      if (blob.type.startsWith('image/')) {
        result = { url: URL.createObjectURL(blob), actualDate: '', width: size, height: size }
      }
    }
  } catch {
    result = null
  }
  cache.set(key, result)
  return result
}

/** GeoJSON Polygon 坐标 → 外接 BBox（含 ~20% 边距，举证图不至于贴边） */
export function bboxFromPolygonCoordinates(coords: unknown): BBox | null {
  if (!Array.isArray(coords)) return null
  const points: Array<[number, number]> = []
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      points.push([node[0] as number, node[1] as number])
      return
    }
    node.forEach(walk)
  }
  walk(coords)
  if (points.length < 3) return null
  const lngs = points.map((p) => p[0])
  const lats = points.map((p) => p[1])
  let minLng = Math.min(...lngs)
  let maxLng = Math.max(...lngs)
  let minLat = Math.min(...lats)
  let maxLat = Math.max(...lats)
  // 边距 + 拉成正方形（WIDTH=HEIGHT 要求等比，避免拉伸变形）
  const padLng = Math.max((maxLng - minLng) * 0.2, 0.02)
  const padLat = Math.max((maxLat - minLat) * 0.2, 0.02)
  minLng -= padLng
  maxLng += padLng
  minLat -= padLat
  maxLat += padLat
  const span = Math.max(maxLng - minLng, maxLat - minLat)
  const cLng = (minLng + maxLng) / 2
  const cLat = (minLat + maxLat) / 2
  return { minLng: cLng - span / 2, maxLng: cLng + span / 2, minLat: cLat - span / 2, maxLat: cLat + span / 2 }
}
