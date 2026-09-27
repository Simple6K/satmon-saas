/**
 * AOI 几何边界校验（工程原则 2：外部输入在边界处校验后才进入视图层）。
 *
 * 上传的 GeoJSON 是不可信输入：这里只提取几何结构并逐环校验
 * （非数值坐标 / 未闭合 / 点数不足 / 自相交 / 顶点数上限），
 * 任何属性字段一律丢弃，异常内容不进入日志（工程原则 3）。
 * 面积用 turf 球面面积（m² → km²），服务端另有 shapely 二次校验（契约 §3）。
 */
import area from '@turf/area'
import booleanValid from '@turf/boolean-valid'
import type { Polygon } from 'geojson'

/** 顶点数上限（US-04：单多边形顶点数上限校验） */
export const MAX_AOI_VERTICES = 500

export type GeometryParseResult =
  | { ok: true; geometry: Polygon; areaKm2: number }
  | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * 解析不可信的 GeoJSON 输入为 Polygon 几何。
 * 接受 Polygon 或 Feature<Polygon>（上传文件两种常见形态），其余一律拒绝。
 */
export function parseAoiGeometry(raw: unknown): GeometryParseResult {
  let geometry: unknown = null
  if (isRecord(raw)) {
    if (raw.type === 'Feature' && isRecord(raw.geometry)) {
      geometry = raw.geometry
    } else if (raw.type === 'Polygon') {
      geometry = raw
    }
  }
  if (!isRecord(geometry) || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
    return { ok: false, error: '不是有效的多边形 GeoJSON（需要 Polygon 或 Feature<Polygon>）' }
  }

  const rings = geometry.coordinates as unknown[]
  if (rings.length === 0) return { ok: false, error: '多边形缺少坐标环' }

  let vertices = 0
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]
    if (!Array.isArray(ring) || ring.length < 4) {
      return { ok: false, error: `第 ${r + 1} 个坐标环点数不足（闭合环至少 4 个点）` }
    }
    for (const pt of ring) {
      if (
        !Array.isArray(pt) ||
        pt.length < 2 ||
        typeof pt[0] !== 'number' ||
        typeof pt[1] !== 'number' ||
        !Number.isFinite(pt[0]) ||
        !Number.isFinite(pt[1])
      ) {
        return { ok: false, error: `第 ${r + 1} 个坐标环包含非数值坐标` }
      }
    }
    const first = ring[0] as number[]
    const last = ring[ring.length - 1] as number[]
    if (Math.abs(first[0] - last[0]) > 1e-9 || Math.abs(first[1] - last[1]) > 1e-9) {
      return { ok: false, error: `第 ${r + 1} 个坐标环未闭合（首尾坐标不一致）` }
    }
    vertices += ring.length
  }
  if (vertices > MAX_AOI_VERTICES) {
    return { ok: false, error: `顶点数 ${vertices} 超过上限 ${MAX_AOI_VERTICES}，请简化边界` }
  }

  const geom: Polygon = { type: 'Polygon', coordinates: rings as number[][][] }
  if (!booleanValid(geom)) {
    return { ok: false, error: '多边形几何无效（可能存在自相交），请调整边界' }
  }
  const km2 = area(geom) / 1_000_000
  if (!Number.isFinite(km2) || km2 <= 0) {
    return { ok: false, error: '面积计算结果无效，请检查坐标' }
  }
  return { ok: true, geometry: geom, areaKm2: km2 }
}

/** turf 球面面积（km²），绘制结果与上传几何共用 */
export function polygonAreaKm2(geom: Polygon): number {
  return area(geom) / 1_000_000
}
