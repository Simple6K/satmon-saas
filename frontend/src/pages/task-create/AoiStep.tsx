/**
 * 向导第 1 步：圈定监测区域（AOI）—— US-03 / US-04。
 *
 * - 三种来源：组织 AOI 库选择（GET /api/aois）/ 地图绘制（geoman，MapCanvas 内置）
 *   / GeoJSON 文件上传（边界处校验，见 geo.ts）
 * - 新建 AOI 用 turf 实时算面积并对照订阅剩余额度，超限红条阻断（US-04 验收）
 * - GIBS 底图瓦片失败只提示 + 「重试底图」（整图重挂载），绘制/上传不依赖底图，
 *   不出现白屏（US-04 异常分支）
 * - 新建 AOI 暂存几何，等第 2 步选定监测类型后才 POST /api/aois 落库（契约 §3
 *   要求 monitorType）
 */
import L from 'leaflet'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AimOutlined, ClearOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Input, message, Radio, Skeleton, Tag, Typography, Upload } from 'antd'
import type { Feature, Polygon } from 'geojson'
import MapCanvas, { type LayerStatusMap } from '../../components/MapCanvas'
import { apiFetch } from '../../api/client'
import { AoiSchema, MONITOR_TYPE_LABELS, type SubscriptionUsage } from '../../api/types'
import { parseAoiGeometry, polygonAreaKm2 } from './geo'
import type { AoiSelection } from './types'

/** 快速定位预设（US-04）：迪拜 42RVR / 利雅得 38RKR·38RKS */
const PRESETS: { label: string; center: [number, number]; mgrs: string }[] = [
  { label: '迪拜', center: [25.2, 55.27], mgrs: 'MGRS 42RVR' },
  { label: '利雅得', center: [24.8, 46.7], mgrs: 'MGRS 38RKR / 38RKS' },
]

const SOURCE_LABELS: Record<AoiSelection['source'], string> = {
  library: 'AOI 库',
  drawn: '地图绘制',
  upload: 'GeoJSON 上传',
}

interface AoiStepProps {
  selection: AoiSelection | null
  usage: SubscriptionUsage | undefined
  usageLoading: boolean
  /** 用户点过「下一步」但本步未通过时高亮缺失项 */
  showErrors: boolean
  onChange: (sel: AoiSelection | null) => void
}

export default function AoiStep({
  selection,
  usage,
  usageLoading,
  showErrors,
  onChange,
}: AoiStepProps) {
  const [mode, setMode] = useState<'library' | 'new'>(selection?.source === 'library' ? 'library' : 'new')
  const [layerStatus, setLayerStatus] = useState<LayerStatusMap | null>(null)
  /** 底图重试：整体重挂载 MapCanvas，避免半新半旧的瓦片状态 */
  const [mapEpoch, setMapEpoch] = useState(0)
  const mapRef = useRef<L.Map | null>(null)
  const overlayRef = useRef<L.GeoJSON | null>(null)

  // 组织 AOI 库（本租户，服务端按 token tenantId 隔离）
  const aoisQuery = useQuery({
    queryKey: ['aois'],
    queryFn: async () => AoiSchema.array().parse(await apiFetch<unknown>('/api/aois')),
  })

  // 选中 AOI 的地图高亮（绘制来源除外：geoman 自绘图形已在地图上）
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (overlayRef.current) {
      map.removeLayer(overlayRef.current)
      overlayRef.current = null
    }
    if (!selection || selection.source === 'drawn') return
    const layer = L.geoJSON(selection.geometry, {
      style: { color: '#faad14', weight: 2, fillColor: '#faad14', fillOpacity: 0.12 },
    })
    layer.addTo(map)
    overlayRef.current = layer
    try {
      map.fitBounds(layer.getBounds(), { padding: [24, 24] })
    } catch {
      // 空边界兜底：fitBounds 抛错时保持当前视野，不阻塞选择流程
    }
  }, [selection])

  function handleDrawn(feature: Feature<Polygon>) {
    // 绘制结果同样走边界校验（自相交等异常在进入状态前拦截）
    const res = parseAoiGeometry(feature.geometry)
    if (!res.ok) {
      message.error(`绘制的多边形无效：${res.error}`)
      return
    }
    onChange({
      source: 'drawn',
      name: selection?.source === 'drawn' ? selection.name : '',
      areaKm2: polygonAreaKm2(res.geometry),
      geometry: res.geometry,
    })
  }

  function handleUploadFile(file: File) {
    void file.text()
      .then((text) => {
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch {
          message.error('文件不是合法的 JSON')
          return
        }
        const res = parseAoiGeometry(raw)
        if (!res.ok) {
          message.error(`GeoJSON 校验失败：${res.error}`)
          return
        }
        onChange({
          source: 'upload',
          name: file.name.replace(/\.(geo)?json$/i, ''),
          areaKm2: res.areaKm2,
          geometry: res.geometry,
        })
        message.success(`GeoJSON 解析成功：${res.areaKm2.toFixed(2)} km²`)
      })
      .catch(() => message.error('文件读取失败，请重试'))
  }

  /** 清空当前选择与地图上的矢量（geoman 图形 + 选中高亮层） */
  function clearAll() {
    const map = mapRef.current
    if (map) {
      if (overlayRef.current) map.removeLayer(overlayRef.current)
      overlayRef.current = null
      map.eachLayer((l) => {
        if (l instanceof L.Path) map.removeLayer(l)
      })
    }
    onChange(null)
  }

  function switchMode(next: 'library' | 'new') {
    if (next === mode) return
    setMode(next)
    clearAll()
  }

  const isNew = selection?.source === 'drawn' || selection?.source === 'upload'
  const nameInvalid = isNew && !selection.name.trim()
  // 剩余额度（新 AOI 不在已用统计内，提交落库时服务端会二次校验）
  const remainingKm2 = usage ? usage.aoiAreaLimitKm2 - usage.aoiAreaKm2 : undefined
  const areaExceeded =
    usage !== undefined && remainingKm2 !== undefined && isNew && selection.areaKm2 > remainingKm2

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap' }}>
      <Card size="small" title="地图（绘制 / 核对监测区域）" style={{ flex: '1 1 560px', minWidth: 480 }}>
        <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <AimOutlined />
          <span style={{ fontSize: 13 }}>快速定位：</span>
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              size="small"
              onClick={() => mapRef.current?.flyTo(p.center, 10, { duration: 0.8 })}
            >
              {p.label}
            </Button>
          ))}
          <Tag>{PRESETS.map((p) => p.mgrs).join(' · ')}</Tag>
        </div>
        {layerStatus?.truecolor.loading && (
          <div style={{ marginBottom: 8 }}>
            <Tag color="processing">GIBS 底图瓦片加载中…</Tag>
          </div>
        )}
        {layerStatus?.truecolor.error && (
          <div style={{ marginBottom: 8 }}>
            <Alert
              type="warning"
              showIcon
              message="GIBS 底图瓦片加载失败"
              description="绘制与 GeoJSON 上传不依赖底图，可继续操作；也可重试重新加载底图。"
              action={
                <Button size="small" danger onClick={() => setMapEpoch((e) => e + 1)}>
                  重试底图
                </Button>
              }
            />
          </div>
        )}
        <div
          style={{
            height: 420,
            borderRadius: 8,
            overflow: 'hidden',
            border: '1px solid #f0f0f0',
          }}
        >
          <MapCanvas
            key={mapEpoch}
            onMapReady={(map) => {
              mapRef.current = map
            }}
            onLayerStatusChange={setLayerStatus}
            onAoiCreated={handleDrawn}
          />
        </div>
      </Card>

      <Card size="small" title="选择监测区域" style={{ flex: '1 1 320px', minWidth: 300 }}>
        <Radio.Group
          value={mode}
          onChange={(e) => switchMode(e.target.value as 'library' | 'new')}
          style={{ marginBottom: 16, display: 'flex', gap: 16 }}
        >
          <Radio value="library">从 AOI 库选择</Radio>
          <Radio value="new">绘制 / 上传新 AOI</Radio>
        </Radio.Group>

        {mode === 'library' ? (
          <>
            <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
              组织级 AOI 库（本租户内共享；以下为面积与监测类型）
            </Typography.Paragraph>
            {aoisQuery.isLoading ? (
              <Skeleton active paragraph={{ rows: 4 }} />
            ) : aoisQuery.isError ? (
              <Alert
                type="error"
                showIcon
                message="AOI 库加载失败"
                description={(aoisQuery.error as Error).message}
                action={
                  <Button size="small" onClick={() => void aoisQuery.refetch()}>
                    重试
                  </Button>
                }
              />
            ) : (aoisQuery.data ?? []).length === 0 ? (
              <Empty description="组织 AOI 库为空，可切换到「绘制 / 上传」新建" style={{ margin: '24px 0' }} />
            ) : (
              <Radio.Group
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                value={selection?.source === 'library' ? selection.aoiId : ''}
                onChange={(e) => {
                  const aoi = (aoisQuery.data ?? []).find((a) => a.id === e.target.value)
                  if (!aoi) return
                  onChange({
                    source: 'library',
                    aoiId: aoi.id,
                    name: aoi.name,
                    areaKm2: aoi.areaKm2,
                    geometry: aoi.geojson,
                  })
                }}
              >
                {(aoisQuery.data ?? []).map((aoi) => (
                  <Radio key={aoi.id} value={aoi.id} style={{ alignItems: 'flex-start' }}>
                    <span>{aoi.name}</span>
                    <Tag style={{ marginInlineStart: 8 }}>{MONITOR_TYPE_LABELS[aoi.monitorType]}</Tag>
                    <Typography.Text type="secondary">{aoi.areaKm2.toFixed(1)} km²</Typography.Text>
                  </Radio>
                ))}
              </Radio.Group>
            )}
          </>
        ) : (
          <>
            <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
              使用地图左上角的多边形工具绘制，或上传 GeoJSON 文件（.json / .geojson）。
              上传内容在边界处校验（闭合、自相交、顶点数、面积），异常属性不会保留。
            </Typography.Paragraph>
            <Upload
              accept=".json,.geojson"
              maxCount={1}
              showUploadList={false}
              beforeUpload={(file) => {
                handleUploadFile(file)
                return false // 阻止 antd 自动上传，只取文件内容本地解析
              }}
            >
              <Button icon={<UploadOutlined />}>上传 GeoJSON 文件</Button>
            </Upload>
            <div style={{ marginTop: 12 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                AOI 名称 <Typography.Text type="danger">*</Typography.Text>
              </Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                placeholder="例如：迪拜-Al Maktoum 国际机场周边"
                maxLength={50}
                status={showErrors && nameInvalid ? 'error' : undefined}
                value={isNew ? selection.name : ''}
                onChange={(e) => {
                  if (!isNew) return
                  onChange({ ...selection, name: e.target.value })
                }}
                disabled={!isNew}
              />
              {showErrors && nameInvalid && (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  请为新建 AOI 命名（保存进组织 AOI 库）
                </Typography.Text>
              )}
            </div>
            {isNew && (
              <div style={{ marginTop: 16 }}>
                <Typography.Paragraph style={{ marginBottom: 4 }}>
                  <Tag color="blue">{SOURCE_LABELS[selection.source]}</Tag>
                  面积：
                  <Typography.Text strong>{selection.areaKm2.toFixed(2)} km²</Typography.Text>
                  <Typography.Text type="secondary">（turf 球面面积实时计算）</Typography.Text>
                </Typography.Paragraph>
                {usageLoading ? (
                  <Skeleton active paragraph={{ rows: 1 }} />
                ) : usage ? (
                  areaExceeded ? (
                    <Alert
                      type="error"
                      showIcon
                      message={`面积超出订阅剩余额度`}
                      description={`新 AOI 面积 ${selection.areaKm2.toFixed(1)} km² > 剩余 ${remainingKm2?.toFixed(1)} km²（已用 ${usage.aoiAreaKm2.toFixed(1)} / 上限 ${usage.aoiAreaLimitKm2} km²）。请缩小范围，或升级套餐后重试。`}
                    />
                  ) : (
                    <Alert
                      type="success"
                      showIcon
                      message={`面积校验通过：剩余额度 ${remainingKm2?.toFixed(1)} km²`}
                      description={`已用 ${usage.aoiAreaKm2.toFixed(1)} / 上限 ${usage.aoiAreaLimitKm2} km²，本 AOI ${selection.areaKm2.toFixed(1)} km²。`}
                    />
                  )
                ) : null}
                <Button style={{ marginTop: 12 }} icon={<ClearOutlined />} onClick={clearAll}>
                  清除绘制 / 上传内容
                </Button>
              </div>
            )}
            {!isNew && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
                尚未绘制或上传任何区域；绘制完成后面积将实时显示并与配额比对。
              </Typography.Paragraph>
            )}
          </>
        )}
      </Card>
    </div>
  )
}
