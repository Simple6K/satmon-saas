/**
 * Esri Wayback 高清历史影像（带日期的高清镶嵌档案，2014-02 至今 196+ 个版本）。
 *
 * 数据源（2026-09-28 本机实测）：
 * - 版本清单：https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json
 *   （{releaseNum: {itemTitle: "World Imagery (Wayback YYYY-MM-DD)", ...}}，可达）
 * - 瓦片：https://wayback.maptiles.arcgis.com/.../tile/{releaseNum}/{z}/{y}/{x}
 *   ⚠️ 该域名在部分网络（含本机）TCP 不可达——因此必须先探测再使用，失败降级 GIBS。
 *
 * 行为契约：
 * - waybackAvailable()：单次 4s 探测（清单 + 一张瓦片），结果全会话缓存；
 *   不可达时 getWaybackImage 直接返回 null，调用方走 GIBS 降级（工程原则 4：如实降级不重试）。
 * - 拼接：按 bbox 选 zoom（瓦片数 ≤4×4=16、上限 z17），任一瓦片失败即整体降级——
 *   部分拼接的缺角高清图比完整低清图更误导。
 */

import type { BBox, PhaseImageResult } from './gibsImage'

const CONFIG_URL = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json'
const TILE_BASE = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile'
const PROBE_TIMEOUT_MS = 4000
const TILE_TIMEOUT_MS = 6000
const MAX_TILES = 16 // 4×4
const MAX_ZOOM = 17

interface Release {
  num: number
  date: string // YYYY-MM-DD
}

let configPromise: Promise<Release[] | null> | null = null
let availablePromise: Promise<boolean> | null = null
const imageCache = new Map<string, PhaseImageResult | null>()

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 版本清单（全会话缓存；失败返回 null） */
function loadReleases(): Promise<Release[] | null> {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const resp = await fetchWithTimeout(CONFIG_URL, PROBE_TIMEOUT_MS)
        if (!resp.ok) return null
        const cfg = (await resp.json()) as Record<string, { itemTitle?: string }>
        const releases: Release[] = []
        for (const [numStr, v] of Object.entries(cfg)) {
          const m = /Wayback (\d{4}-\d{2}-\d{2})/.exec(v?.itemTitle ?? '')
          const num = Number(numStr)
          if (m && Number.isFinite(num)) releases.push({ num, date: m[1] })
        }
        releases.sort((a, b) => a.date.localeCompare(b.date))
        return releases.length > 0 ? releases : null
      } catch {
        return null
      }
    })()
  }
  return configPromise
}

/** 探测瓦片域名可达性（沙特中部 z8 瓦片 110/160(row/col)；只验域名可达性，与业务区域无关；结果全会话缓存） */
async function probeTiles(): Promise<boolean> {
  try {
    const releases = await loadReleases()
    if (!releases) return false
    const latest = releases[releases.length - 1]
    const resp = await fetchWithTimeout(`${TILE_BASE}/${latest.num}/8/110/160`, PROBE_TIMEOUT_MS)
    return resp.ok
  } catch {
    return false
  }
}

function isAvailable(): Promise<boolean> {
  if (!availablePromise) availablePromise = probeTiles()
  return availablePromise
}

/** 就近匹配目标日期的版本（按天数绝对差最小者） */
function pickRelease(releases: Release[], date: string): Release {
  let best = releases[0]
  let bestDiff = Infinity
  const target = Date.parse(date)
  for (const r of releases) {
    const diff = Math.abs((Date.parse(r.date) - target) / 86400000)
    if (diff < bestDiff) {
      bestDiff = diff
      best = r
    }
  }
  return best
}

/** WebMercator 瓦片坐标（GoogleMapsCompatible：z/x/y） */
function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z
}
function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
}

/**
 * 取 bbox 在目标日期的 Wayback 高清拼接图。
 * 返回 null = 不可用（域名不可达 / 无版本 / 任一瓦片失败），调用方降级 GIBS。
 */
export async function getWaybackImage(bbox: BBox, date: string): Promise<PhaseImageResult | null> {
  const key = `${bbox.minLng.toFixed(4)},${bbox.minLat.toFixed(4)},${bbox.maxLng.toFixed(4)},${bbox.maxLat.toFixed(4)}@${date}`
  if (imageCache.has(key)) return imageCache.get(key) ?? null

  let result: PhaseImageResult | null = null
  if (await isAvailable()) {
    const releases = await loadReleases()
    if (releases) {
      const release = pickRelease(releases, date)
      // 选 zoom：从高到低找到瓦片数 ≤ MAX_TILES 的级别
      let z = MAX_ZOOM
      let x0 = 0
      let x1 = 0
      let y0 = 0
      let y1 = 0
      for (; z >= 10; z--) {
        const xa = lngToTileX(bbox.minLng, z)
        const xb = lngToTileX(bbox.maxLng, z)
        const ya = latToTileY(bbox.maxLat, z)
        const yb = latToTileY(bbox.minLat, z)
        x0 = Math.floor(xa)
        x1 = Math.floor(xb)
        y0 = Math.floor(ya)
        y1 = Math.floor(yb)
        if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) break
      }
      const cols = x1 - x0 + 1
      const rows = y1 - y0 + 1
      if (cols >= 1 && rows >= 1 && cols * rows <= MAX_TILES && z >= 10) {
        const urls: string[] = []
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            urls.push(`${TILE_BASE}/${release.num}/${z}/${y}/${x}`)
          }
        }
        const blobs = await Promise.all(
          urls.map(async (u) => {
            try {
              const resp = await fetchWithTimeout(u, TILE_TIMEOUT_MS)
              if (!resp.ok) return null
              const blob = await resp.blob()
              return blob.type.startsWith('image/') ? blob : null
            } catch {
              return null
            }
          }),
        )
        if (blobs.every((b): b is Blob => b !== null)) {
          const canvas = document.createElement('canvas')
          canvas.width = cols * 256
          canvas.height = rows * 256
          const ctx = canvas.getContext('2d')
          if (ctx) {
            let ok = true
            for (let i = 0; i < urls.length && ok; i++) {
              try {
                const bitmap = await createImageBitmap(blobs[i])
                ctx.drawImage(bitmap, ((i % cols) * 256), (Math.floor(i / cols) * 256))
                bitmap.close()
              } catch {
                ok = false
              }
            }
            if (ok) {
              const cropped = await cropToBbox(canvas, bbox, z, x0, y0)
              if (cropped) {
                result = {
                  url: cropped,
                  actualDate: release.date,
                  width: canvas.width,
                  height: canvas.height,
                  source: 'wayback',
                }
              }
            }
          }
        }
      }
    }
  }
  imageCache.set(key, result)
  return result
}

/** 从拼接画布裁出 bbox 精确范围（objectURL, image/jpeg 0.92） */
async function cropToBbox(
  mosaic: HTMLCanvasElement,
  bbox: BBox,
  z: number,
  x0: number,
  y0: number,
): Promise<string | null> {
  const ctx = mosaic.getContext('2d')
  if (!ctx) return null
  const pxPerTile = 256
  const toPx = (lng: number, lat: number): [number, number] => [
    (lngToTileX(lng, z) - x0) * pxPerTile,
    (latToTileY(lat, z) - y0) * pxPerTile,
  ]
  const [lx, ty] = toPx(bbox.minLng, bbox.maxLat)
  const [rx, by] = toPx(bbox.maxLng, bbox.minLat)
  const w = Math.max(Math.round(rx - lx), 8)
  const h = Math.max(Math.round(by - ty), 8)
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const octx = out.getContext('2d')
  if (!octx) return null
  octx.drawImage(mosaic, Math.round(lx), Math.round(ty), w, h, 0, 0, w, h)
  return new Promise((resolve) => {
    out.toBlob(
      (blob) => resolve(blob ? URL.createObjectURL(blob) : null),
      'image/jpeg',
      0.92,
    )
  })
}

/** 探测结果（UI 展示降级说明用；未探测完成时返回 null） */
export function waybackProbeState(): Promise<boolean> {
  return isAvailable()
}
