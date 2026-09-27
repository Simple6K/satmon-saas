/**
 * MapCanvas —— 全站唯一地图组件（复用稳定业务语义，不二造地图轮子）。
 *
 * - 底图走 NASA GIBS WMTS epsg3857/best 端点（GoogleMapsCompatible 瓦片），
 *   与 Leaflet 默认 CRS 直接兼容，零自定义投影代码（技术选型报告已实测排除 4326 路线）。
 * - 瓦片并发 ≤6：自定义 TileLayer 子类，createTile 中【推迟设置 img.src】入队等槽位，
 *   tileunload/tileabort 回收槽位——不推迟 src 则限流失效（技术选型报告硬约束）。
 * - 图层加载/失败态经 onLayerStatusChange 回调上报，页面据此渲染加载条与降级提示。
 * - geoman 初始化 AOI 绘制/编辑/删除，绘制完成经 onAoiCreated 回调吐出 GeoJSON。
 *
 * 参数约束（实测结论，禁止改参，对齐 API-CONTRACT §8 / 技术选型报告）：
 * - IMERG 降雨必须使用 2km 瓦片矩阵（TileMatrixSet=2km），6km 返回 400；
 * - VIIRS 夜光必须用 PNG 格式且【不带日期参数】（静态图层，带日期反而 404）；
 * - MODIS 真彩模板 URL 为实测固化常量，不做任意组合。
 */
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import '@geoman-io/leaflet-geoman-free'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import { useEffect, useRef, type CSSProperties } from 'react'
import type { Feature, Polygon } from 'geojson'

// ---------- 图层目录（常量固化） ----------

export type MapLayerKey = 'esri' | 'truecolor' | 'imerg' | 'viirs'

const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'

/** 瓦片加载/失败状态：页面据此展示加载态与降级提示（工程原则 5） */
export interface LayerStatus {
  loading: boolean
  error: boolean
}
export type LayerStatusMap = Record<MapLayerKey, LayerStatus>

interface LayerDef {
  /** UI 显示名 */
  name: string
  /** URL 模板；{date} 由运行时替换 */
  urlTemplate: string
  maxNativeZoom: number
  /** 图层整体最大显示级别：超过后隐藏（避免瓦片拉伸发糊），底层高清图透出 */
  maxZoom?: number
  opacity: number
  attribution: string
}

/**
 * 图层目录。esri 高清底图排在首位（最先加入 → 最底层）：
 * GIBS MODIS 真彩仅 250m/Level9，放大超过 z9 后瓦片被浏览器拉伸发糊——
 * 引入 Esri World Imagery（2026-09-27 本机实测 z10–z15 迪拜/利雅得全 200）
 * 作为高清底座，GIBS 各层（当日影像/降雨/夜光）叠加其上做专题分析。
 * 取舍：Esri 为合成镶嵌底图（非当日），时相语义仍由 GIBS 日期图层承担。
 */
export const LAYER_DEFS: Record<MapLayerKey, LayerDef> = {
  esri: {
    name: '高清卫星底图（Esri）',
    urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxNativeZoom: 19,
    opacity: 1,
    attribution: 'Esri, Maxar, Earthstar Geographics',
  },
  // MODIS Terra 真彩，实测固化模板；影像有 1 天左右延迟，默认取昨天
  // maxZoom 9：超过 z9 隐藏该层（拉伸会发糊），由底层 Esri 高清图接棒
  truecolor: {
    name: 'MODIS 真彩影像（当日，z≤9）',
    urlTemplate: `${GIBS_BASE}/MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
    maxNativeZoom: 9,
    maxZoom: 9,
    opacity: 1,
    attribution: 'Imagery courtesy NASA EOSDIS GIBS',
  },
  // IMERG 降雨：TileMatrixSet 必须为 2km（6km 参数实测返回 400，勿改）
  imerg: {
    name: 'IMERG 降雨（2km）',
    urlTemplate: `${GIBS_BASE}/GPM_3IMERGHH_06_run/default/{date}/2km/{z}/{y}/{x}.png`,
    maxNativeZoom: 6,
    maxZoom: 9,
    opacity: 0.7,
    attribution: 'Imagery courtesy NASA EOSDIS GIBS',
  },
  // VIIRS 夜光：必须 PNG 且 URL 不带日期段（静态图层，带日期参数反而取不到）
  viirs: {
    name: 'VIIRS 夜光',
    urlTemplate: `${GIBS_BASE}/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`,
    maxNativeZoom: 8,
    maxZoom: 9,
    opacity: 0.85,
    attribution: 'Imagery courtesy NASA EOSDIS GIBS',
  },
}

export const MAP_LAYER_KEYS = Object.keys(LAYER_DEFS) as MapLayerKey[]

/** 默认日期：取 3 天前（覆盖 MODIS 与 IMERG 的产品延迟，避免拿空瓦片） */
function defaultLayerDate(): string {
  return new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10)
}

// ---------- 瓦片并发限流 TileLayer 子类 ----------

/** PRD US-04/US-07：并发瓦片请求 ≤6，控制渲染成本与对 GIBS 的请求压力 */
const MAX_CONCURRENT_TILE_REQUESTS = 6

type TileJobState = 'queued' | 'loading' | 'done' | 'canceled'

interface TileJob {
  el: HTMLImageElement
  url: string
  state: TileJobState
}

/**
 * 关键实现：createTile 只创建 img 并入队，【不在此时设置 src】；
 * _satPump 拿到空槽位才赋 src 发起请求；tileunload/tileabort 把对应任务置为
 * canceled 并回收其槽位（Leaflet 移除瓦片时会把 src 置为空白 gif 取消请求，
 * 之后到达的 load/error 事件因 state=canceled 直接丢弃）。
 */
const ThrottledTileLayer = L.TileLayer.extend({
  _satQueue: [] as TileJob[],
  _satActive: 0,

  onAdd(this: any, map: L.Map) {
    // 惰性初始化队列（实例由 extend 工厂创建，不走 TS 构造签名）
    this._satQueue = []
    this._satActive = 0
    this.on('tileunload', (e: L.TileEvent) => this._satCancel(e.tile as HTMLImageElement))
    this.on('tileabort', (e: L.TileEvent) => this._satCancel(e.tile as HTMLImageElement))
    return L.TileLayer.prototype.onAdd.call(this, map)
  },

  createTile(
    this: any,
    coords: L.Coords,
    done: (error?: Error, tile?: HTMLElement) => void,
  ): HTMLImageElement {
    const el = document.createElement('img')
    const job: TileJob = { el, url: this.getTileUrl(coords), state: 'queued' }
    L.DomEvent.on(el, 'load', () => this._satFinish(job, undefined, done))
    L.DomEvent.on(el, 'error', () => this._satFinish(job, new Error('tile load error'), done))
    // 注意：此处不设置 el.src —— 推迟入队等槽位，否则并发限流失效
    this._satQueue.push(job)
    this._satPump()
    return el
  },

  _satFinish(
    this: any,
    job: TileJob,
    err: Error | undefined,
    done: (error?: Error, tile?: HTMLElement) => void,
  ) {
    if (job.state === 'canceled') return
    if (job.state === 'loading') this._satActive--
    job.state = 'done'
    done(err, job.el)
    this._satPump()
  },

  _satCancel(this: any, el: HTMLImageElement) {
    const job = this._satQueue.find(
      (j: TileJob) => j.el === el && (j.state === 'queued' || j.state === 'loading'),
    )
    if (!job) return
    const wasLoading = job.state === 'loading'
    job.state = 'canceled'
    if (wasLoading) {
      this._satActive--
      this._satPump()
    }
  },

  _satPump(this: any) {
    // 先清理已结束/已取消任务，防止队列无限增长
    this._satQueue = this._satQueue.filter(
      (j: TileJob) => j.state === 'queued' || j.state === 'loading',
    )
    while (this._satActive < MAX_CONCURRENT_TILE_REQUESTS) {
      const next = this._satQueue.find((j: TileJob) => j.state === 'queued')
      if (!next) break
      next.state = 'loading'
      this._satActive++
      next.el.src = next.url // 只有拿到槽位才真正发起瓦片请求
    }
  },
}) as unknown as new (url: string, options?: L.TileLayerOptions) => L.TileLayer

// ---------- 组件 ----------

export interface MapCanvasProps {
  /** 初始中心（lat,lng），默认迪拜 */
  center?: [number, number]
  /** 初始缩放 */
  zoom?: number
  /** 受控图层开关：启用哪些 GIBS 图层 */
  activeLayers?: MapLayerKey[]
  /** 真彩/IMERG 共用日期（YYYY-MM-DD），默认 3 天前 */
  date?: string
  /** 图层加载/失败态回调（含未启用图层，未启用时 loading=false error=false） */
  onLayerStatusChange?: (status: LayerStatusMap) => void
  /** 地图实例就绪回调：页面用它在地图上叠加 GeoJSON 斑块等业务图层 */
  onMapReady?: (map: L.Map) => void
  /** geoman 绘制完成 AOI 多边形回调 */
  onAoiCreated?: (geojson: Feature<Polygon>) => void
  className?: string
  style?: CSSProperties
}

const DEFAULT_CENTER: [number, number] = [25.2, 55.27] // 迪拜
const DEFAULT_ZOOM = 10

export default function MapCanvas({
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  activeLayers = ['esri', 'truecolor'] as MapLayerKey[],
  date = defaultLayerDate(),
  onLayerStatusChange,
  onMapReady,
  onAoiCreated,
  className,
  style,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileLayersRef = useRef(new Map<MapLayerKey, L.TileLayer>())
  const statusRef = useRef<LayerStatusMap>(
    Object.fromEntries(MAP_LAYER_KEYS.map((k) => [k, { loading: false, error: false }])) as LayerStatusMap,
  )
  const statusCbRef = useRef(onLayerStatusChange)
  const mapReadyCbRef = useRef(onMapReady)
  const aoiCbRef = useRef(onAoiCreated)
  const activeKeySet = new Set(activeLayers)
  const activeKeyStr = activeLayers.join(',')

  statusCbRef.current = onLayerStatusChange
  mapReadyCbRef.current = onMapReady
  aoiCbRef.current = onAoiCreated

  // 地图与 geoman 初始化（仅一次；center/zoom 只作初始值）
  useEffect(() => {
    if (!containerRef.current) return
    const map = L.map(containerRef.current, {
      center,
      zoom,
      maxZoom: 19, // 高清底图能力上限；GIBS 各层在自身 maxZoom 后隐藏避免拉伸
      attributionControl: true,
      worldCopyJump: true,
    })
    mapRef.current = map

    // geoman：AOI 多边形绘制 + 编辑 + 删除（只开与本产品相关的工具，减少干扰）
    map.pm.addControls({
      position: 'topleft',
      drawPolygon: true,
      drawMarker: false,
      drawCircle: false,
      drawCircleMarker: false,
      drawRectangle: false,
      drawPolyline: false,
      drawText: false,
      editMode: true,
      dragMode: false,
      cutPolygon: false,
      removalMode: true,
      rotateMode: false,
    })
    map.on('pm:create', (e: unknown) => {
      const layer = (e as { layer: L.GeoJSON }).layer
      aoiCbRef.current?.(layer.toGeoJSON() as unknown as Feature<Polygon>)
    })

    mapReadyCbRef.current?.(map)
    return () => {
      map.remove()
      mapRef.current = null
      tileLayersRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 图层状态上报
  function emitStatus() {
    statusCbRef.current?.(
      Object.fromEntries(
        MAP_LAYER_KEYS.map((k) => [k, { ...statusRef.current[k] }]),
      ) as LayerStatusMap,
    )
  }

  // 受控图层同步：activeLayers / date 变化时增删 TileLayer
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    for (const key of MAP_LAYER_KEYS) {
      const shouldShow = activeKeySet.has(key)
      const existing = tileLayersRef.current.get(key)
      if (!shouldShow) {
        if (existing) {
          map.removeLayer(existing)
          tileLayersRef.current.delete(key)
          statusRef.current[key] = { loading: false, error: false }
          emitStatus()
        }
        continue
      }
      const def = LAYER_DEFS[key]
      const url = def.urlTemplate.replace('{date}', date)
      // 已存在且 URL 未变（日期相同；viirs/esri 本身无日期）则复用，否则重建
      const existingUrl = (existing as unknown as { _url?: string } | undefined)?._url
      if (existing && existingUrl === url) continue
      if (existing) {
        map.removeLayer(existing)
        tileLayersRef.current.delete(key)
      }
      const layer = new ThrottledTileLayer(url, {
        maxNativeZoom: def.maxNativeZoom,
        maxZoom: def.maxZoom,
        opacity: def.opacity,
        attribution: def.attribution,
        // 失败瓦片不重试（无边界重试会掩盖外部源故障，工程原则 4）
        // Leaflet 本身对 tileerror 不做自动重试，满足约束
      })
      layer.on('loading', () => {
        statusRef.current[key] = { loading: true, error: false }
        emitStatus()
      })
      layer.on('load', () => {
        statusRef.current[key] = { loading: false, error: statusRef.current[key].error }
        emitStatus()
      })
      layer.on('tileerror', (e: L.TileErrorEvent) => {
        // 瓦片失败占位样式（斜纹灰块）
        ;(e.tile as HTMLElement | undefined)?.classList.add('sat-tile-error')
        statusRef.current[key] = { loading: statusRef.current[key].loading, error: true }
        emitStatus()
      })
      statusRef.current[key] = { loading: true, error: false }
      emitStatus()
      layer.addTo(map)
      tileLayersRef.current.set(key, layer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKeyStr, date])

  return (
    <div
      ref={containerRef}
      className={`sat-map-container${className ? ` ${className}` : ''}`}
      style={style}
    />
  )
}
