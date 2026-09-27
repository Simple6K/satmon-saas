/**
 * 结果页地图：MapCanvas（GIBS 底图，图层与日期由父级受控）+ 变化斑块 GeoJSON 叠加。
 * - 斑块按置信度分色，填充透明度受滑杆控制（0–100%），描边恒可见（US-07 验收 1）
 * - 点击斑块弹出摘要卡片并回调父级选中（地图 → 列表联动）
 * - 列表点击经 focus 属性飞至斑块并高亮开弹窗（列表 → 地图联动）
 * - AOI 边界以蓝色虚线描出（来自任务详情 geojson），不参与交互
 * - 重建策略：任务切换/显式重试由父级换 key 整图重建；数据后到时在地图就绪后叠加
 */
import L from 'leaflet'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Polygon } from 'geojson'
import MapCanvas, { type LayerStatusMap, type MapLayerKey } from '../../components/MapCanvas'
import type { PatchProperties } from '../../api/types'
import {
  confidenceColor,
  escapeHtml,
  fmtHa,
  shortPatchId,
  type PatchFeature,
} from './patchStyle'

export interface PatchFocus {
  patchId: string
  ts: number
}

interface PatchMapProps {
  /** 地图初始中心（按租户种子区域） */
  center: [number, number]
  patches: PatchFeature[]
  aoiGeojson?: Polygon | null
  /** 斑块填充透明度 0–100 */
  opacityPct: number
  selectedPatchId: string | null
  focus: PatchFocus | null
  date: string
  activeLayers: MapLayerKey[]
  onLayerStatusChange?: (s: LayerStatusMap) => void
  onPatchClick: (patchId: string) => void
  style?: CSSProperties
}

/** 斑块描边/填充样式：描边不随透明度滑杆变淡（US-07：低于 30% 时边界仍可见） */
function patchStyle(p: PatchProperties, selected: boolean, opacityPct: number): L.PathOptions {
  const c = confidenceColor(p.confidence)
  return {
    color: c,
    weight: selected ? 3.5 : 1.5,
    opacity: 1,
    fillColor: c,
    fillOpacity: (opacityPct / 100) * 0.75,
  }
}

/** 点击斑块的摘要弹窗（属性值经 escapeHtml 转义后再拼 HTML） */
function popupHtml(p: PatchProperties): string {
  const e = escapeHtml
  return (
    `<div style="min-width:220px;line-height:1.7">` +
    `<div style="font-weight:600">${e(p.changeType)} · 置信度 ${(p.confidence * 100).toFixed(0)}%</div>` +
    `<div style="font-family:monospace;font-size:12px;color:#595959">${e(shortPatchId(p.patchId))}</div>` +
    `<div>变化面积 <b>${fmtHa(p.areaKm2)}</b> 公顷</div>` +
    `<div>前时相 ${e(p.beforeDate)} → 后时相 ${e(p.afterDate)}</div>` +
    `<div style="color:#8c8c8c;font-size:12px">已在右侧「斑块详情」中选中</div>` +
    `</div>`
  )
}

export default function PatchMap({
  center,
  patches,
  aoiGeojson,
  opacityPct,
  selectedPatchId,
  focus,
  date,
  activeLayers,
  onLayerStatusChange,
  onPatchClick,
  style,
}: PatchMapProps) {
  const [map, setMap] = useState<L.Map | null>(null)
  /** patchId → {图层实例, 属性}，用于样式更新与聚焦飞行 */
  const layerIndexRef = useRef(new Map<string, { layer: L.Path; props: PatchProperties }>())
  const patchGroupRef = useRef<L.FeatureGroup | null>(null)
  const aoiLayerRef = useRef<L.Layer | null>(null)
  const opacityRef = useRef(opacityPct)
  const selectedRef = useRef(selectedPatchId)
  const clickCbRef = useRef(onPatchClick)
  opacityRef.current = opacityPct
  selectedRef.current = selectedPatchId
  clickCbRef.current = onPatchClick

  // 斑块图层重建（地图就绪 / 数据集变化）
  useEffect(() => {
    layerIndexRef.current.clear()
    if (patchGroupRef.current) {
      patchGroupRef.current.remove()
      patchGroupRef.current = null
    }
    if (!map || patches.length === 0) return

    const group = L.featureGroup()
    for (const f of patches) {
      const p = f.properties
      const layer = L.geoJSON(f.geometry as never, {
        style: () => patchStyle(p, selectedRef.current === p.patchId, opacityRef.current),
        interactive: true,
      })
      const path = layer.getLayers()[0] as L.Path
      path.on('click', () => clickCbRef.current(p.patchId))
      path.bindPopup(popupHtml(p), { maxWidth: 300 })
      layerIndexRef.current.set(p.patchId, { layer: path, props: p })
      group.addLayer(path)
    }
    patchGroupRef.current = group
    group.addTo(map)
    // 首次/换任务自动框住全部斑块（无斑块时由 AOI 兜底）
    const bounds = group.getBounds()
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] })
    // patches 由父级 memo 化，身份变化即换任务数据集
  }, [map, patches])

  // AOI 边界虚线层
  useEffect(() => {
    if (aoiLayerRef.current) {
      aoiLayerRef.current.remove()
      aoiLayerRef.current = null
    }
    if (!map || !aoiGeojson) return
    const layer = L.geoJSON(aoiGeojson as never, {
      style: { color: '#1677ff', weight: 2, dashArray: '6 6', fill: false },
      interactive: false,
    })
    aoiLayerRef.current = layer
    layer.addTo(map)
    // 斑块为空时以 AOI 定位，避免空地图
    if (patches.length === 0) {
      const b = layer.getBounds()
      if (b.isValid()) map.fitBounds(b, { padding: [24, 24] })
    }
  }, [map, aoiGeojson, patches.length])

  // 透明度滑杆 / 选中态变化 → 就地 setStyle，不重建图层
  useEffect(() => {
    layerIndexRef.current.forEach(({ layer, props }) => {
      layer.setStyle(patchStyle(props, selectedPatchId === props.patchId, opacityPct))
    })
  }, [selectedPatchId, opacityPct, patches])

  // 列表联动：飞至斑块并打开弹窗（flyToBounds 自带动画，弹窗延迟到飞行基本结束后）
  useEffect(() => {
    if (!focus || !map) return
    const entry = layerIndexRef.current.get(focus.patchId)
    if (!entry) return
    map.flyToBounds((entry.layer as L.Polygon).getBounds(), { padding: [48, 48], maxZoom: 15 })
    const timer = window.setTimeout(() => entry.layer.openPopup(), 650)
    return () => window.clearTimeout(timer)
    // focus 为父级生成的 {patchId, ts}，每次列表点击均新对象
  }, [focus, map])

  return (
    <MapCanvas
      center={center}
      zoom={11}
      activeLayers={activeLayers}
      date={date}
      onLayerStatusChange={onLayerStatusChange}
      onMapReady={setMap}
      className="results-map"
      style={style}
    />
  )
}
