/**
 * 工作台 GIBS 小地图（US-05 影像预览的工作台入口）：
 * - 复用全站唯一地图组件 MapCanvas（真彩 / IMERG 2km / VIIRS 夜光，参数固化不可改）
 * - 图层开关 Checkbox + 日期 DatePicker（真彩/IMERG 共用）
 * - 瓦片失败 → 降级提示条（GIBS 通道与业务接口互相独立，故障不扩散），
 *   「重试」通过重建地图实例实现（瓦片层不自动重试，工程原则 4）
 * - 地图中心按当前租户种子数据定位（迪拜 / 利雅得）
 */
import { useMemo, useState } from 'react'
import { Alert, Button, Card, Checkbox, DatePicker, Space, Spin, Typography, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import MapCanvas, {
  GIBS_LAYERS,
  MAP_LAYER_KEYS,
  type LayerStatusMap,
  type MapLayerKey,
} from '../../components/MapCanvas'
import { useAuth } from '../../auth/AuthContext'
import './minimap.css'

/** 与 MapCanvas 默认一致：3 天前，覆盖 MODIS/IMERG 产品延迟 */
const DEFAULT_DATE = () =>
  new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10)

const TENANT_CENTER: Record<string, [number, number]> = {
  dubai_municipality: [25.2, 55.27], // 迪拜
  mewa_riyadh: [24.8, 46.7], // 利雅得
}

export default function MiniMap() {
  const { user } = useAuth()
  const [activeLayers, setActiveLayers] = useState<MapLayerKey[]>(['truecolor'])
  const [date, setDate] = useState<string>(DEFAULT_DATE())
  const [layerStatus, setLayerStatus] = useState<LayerStatusMap | null>(null)
  /** 递增即整图重建，用于瓦片失败后的显式重试 */
  const [retryKey, setRetryKey] = useState(0)

  const center: [number, number] = useMemo(
    () => TENANT_CENTER[user?.tenantId ?? ''] ?? [25.2, 55.27],
    [user],
  )

  const activeStatus = useMemo(() => {
    const entries = MAP_LAYER_KEYS.filter((k) => activeLayers.includes(k)).map(
      (k) => [k, layerStatus?.[k]] as const,
    )
    return {
      anyLoading: entries.some(([, s]) => s?.loading),
      anyError: entries.some(([, s]) => s?.error),
      errorNames: entries.filter(([, s]) => s?.error).map(([k]) => GIBS_LAYERS[k].name),
    }
  }, [activeLayers, layerStatus])

  const someLayerEnabled = activeLayers.length > 0

  return (
    <Card
      title="区域影像速览（NASA GIBS）"
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {activeStatus.anyLoading ? '图层加载中…' : someLayerEnabled ? '瓦片并发 ≤6' : '未启用图层'}
        </Typography.Text>
      }
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8, alignItems: 'center' }}>
        <Checkbox.Group
          options={MAP_LAYER_KEYS.map((k) => ({ label: GIBS_LAYERS[k].name, value: k }))}
          value={activeLayers}
          onChange={(vals) => setActiveLayers(vals as MapLayerKey[])}
        />
        <Space size={4}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            影像日期
          </Typography.Text>
          <DatePicker
            size="small"
            allowClear={false}
            value={dayjs(date)}
            maxDate={dayjs()}
            disabled={!activeLayers.some((k) => k === 'truecolor' || k === 'imerg')}
            onChange={(d: Dayjs | null) => {
              if (d) setDate(d.format('YYYY-MM-DD'))
            }}
          />
        </Space>
      </div>

      <div className="workspace-minimap" style={{ position: 'relative' }}>
        {activeStatus.anyLoading && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 1000,
              background: 'rgba(255,255,255,0.85)',
              borderRadius: 4,
              padding: '2px 8px',
            }}
          >
            <Spin size="small" />
          </div>
        )}
        <MapCanvas
          /* 租户切换时以新中心重建地图（MapCanvas 的 center 仅作初始值） */
          key={`${retryKey}-${center.join(',')}`}
          center={center}
          zoom={9}
          activeLayers={activeLayers}
          date={date}
          onLayerStatusChange={setLayerStatus}
          style={{ height: 300, borderRadius: 8 }}
        />
      </div>

      {activeStatus.anyError && (
        <Alert
          style={{ marginTop: 8 }}
          type="warning"
          showIcon
          message={`「${activeStatus.errorNames.join('、')}」部分瓦片加载失败`}
          description="GIBS 通道与业务接口相互独立，不影响任务数据。可稍后重试或临时关闭该图层。"
          action={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => {
                setRetryKey((k) => k + 1)
                message.info('已重新加载地图图层')
              }}
            >
              重试
            </Button>
          }
        />
      )}
      {!someLayerEnabled && (
        <Alert
          style={{ marginTop: 8 }}
          type="info"
          showIcon
          message="未启用任何图层"
          description="勾选上方图层开关以叠加真彩影像、IMERG 降雨或 VIIRS 夜光。"
        />
      )}
    </Card>
  )
}
