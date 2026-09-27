/**
 * 监测结果查看页（US-05/07/08/10/11 结果侧）：
 * - 地图：MapCanvas GIBS 底图 + 变化斑块 GeoJSON 叠加（置信度分色、点击摘要弹窗），
 *   斑块填充透明度滑杆（0–100%，描边恒可见）；图层开关与瓦片失败降级提示 + 显式重试
 * - 斑块列表 ↔ 地图双向联动：列表点击飞至斑块并高亮开弹窗；地图点击同步选中列表
 * - 双时相对比：前 / 后时相 Segmented 切换（日期取结果集最早 beforeDate / 最晚 afterDate），
 *   GIBS 真彩底图按所选时相日期重新渲染；支持键盘 ←/→ 切换（US-08 微调语义的 MVP 简化）
 * - 斑块详情卡：上下文佐证图层 available/unavailable 逐层状态（POI「暂不可用」降级态）+ 告警处置
 * - 加载 / 空 / 错误（含 404 跨租户与任务未就绪）/ 重试态全覆盖（工程原则 5）
 * - 侧边菜单占位路由 /tasks/0/results 自动跳到最近完成的任务（真实入口需要任务 id）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Result,
  Row,
  Segmented,
  Skeleton,
  Slider,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { z } from 'zod'
import { apiFetch, ApiError } from '../../api/client'
import {
  AlertSchema,
  type Alert as AlertDto,
  AoiGeojsonSchema,
  MonitorTypeSchema,
  MONITOR_TYPE_LABELS,
  ResultsRespSchema,
  TaskStatusSchema,
  TaskSummarySchema,
} from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { LAYER_DEFS, MAP_LAYER_KEYS, type LayerStatusMap, type MapLayerKey } from '../../components/MapCanvas'
import PatchMap, { type PatchFocus } from './PatchMap'
import PatchList from './PatchList'
import PatchDetailCard from './PatchDetailCard'
import { CONFIDENCE_LEGEND } from './patchStyle'
import './results.css'

/** 任务详情只解析本页消费的字段（契约 §4：详情含 AOI geojson / 时间窗） */
const TaskDetailLiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  monitorType: MonitorTypeSchema,
  status: TaskStatusSchema,
  startDate: z.string(),
  endDate: z.string(),
  aoi: z.object({ name: z.string(), geojson: AoiGeojsonSchema }),
})

/** 与 MapCanvas 默认一致的兜底日期（覆盖 MODIS/IMERG 产品延迟） */
const FALLBACK_DATE = () => new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10)

const TENANT_CENTER: Record<string, [number, number]> = {
  dubai_municipality: [25.2, 55.27], // 迪拜
  mewa_riyadh: [24.8, 46.7], // 利雅得
}

export default function TaskResultsPage() {
  const { id: routeId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const canWrite = user?.role === 'analyst' || user?.role === 'tenant_admin'
  /** 侧边菜单占位入口（AppLayout RESULTS_PLACEHOLDER_KEY）经最近完成任务解析真实 id */
  const isPlaceholderEntry = routeId === '0'
  const taskId = isPlaceholderEntry ? '' : (routeId ?? '')

  // ---- 占位入口解析：跳到最近完成的任务 ----
  const tasksQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: async () => TaskSummarySchema.array().parse(await apiFetch<unknown>('/api/tasks')),
    enabled: isPlaceholderEntry,
  })
  useEffect(() => {
    if (!isPlaceholderEntry) return
    const tasks = tasksQuery.data
    if (!tasks) return
    const latest = tasks
      .filter((t) => t.status === 'completed')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (latest) {
      navigate(`/tasks/${latest.id}/results`, { replace: true })
    }
  }, [isPlaceholderEntry, tasksQuery.data, navigate])

  // ---- 数据获取 ----
  const taskDetailQuery = useQuery({
    queryKey: ['taskDetail', taskId],
    queryFn: async () => TaskDetailLiteSchema.parse(await apiFetch<unknown>(`/api/tasks/${taskId}`)),
    enabled: !!taskId,
  })

  const resultsQuery = useQuery({
    queryKey: ['taskResults', taskId],
    queryFn: async () => ResultsRespSchema.parse(await apiFetch<unknown>(`/api/tasks/${taskId}/results`)),
    enabled: !!taskId,
  })

  const alertsQuery = useQuery({
    queryKey: ['alerts'],
    queryFn: async () => AlertSchema.array().parse(await apiFetch<unknown>('/api/alerts')),
    enabled: !!taskId,
  })

  // ---- 页面状态 ----
  const [selectedPatchId, setSelectedPatchId] = useState<string | null>(null)
  const [focus, setFocus] = useState<PatchFocus | null>(null)
  const [opacityPct, setOpacityPct] = useState(60)
  const [compareMode, setCompareMode] = useState<'before' | 'after'>('after')
  const [activeLayers, setActiveLayers] = useState<MapLayerKey[]>(['esri', 'truecolor'])
  const [layerStatus, setLayerStatus] = useState<LayerStatusMap | null>(null)
  /** 递增即整图重建：GIBS 瓦片失败后的显式重试（瓦片层不自动重试，工程原则 4） */
  const [retryKey, setRetryKey] = useState(0)
  // 任务切换后清选中态（避免跨任务残留高亮）
  useEffect(() => {
    setSelectedPatchId(null)
    setFocus(null)
  }, [taskId])

  // 结果加载成功反馈（仅首次/换任务提示一次，轮询与重试不刷屏）
  const announcedTaskRef = useRef<string | null>(null)
  const results = resultsQuery.data
  useEffect(() => {
    if (!results || announcedTaskRef.current === results.taskId) return
    announcedTaskRef.current = results.taskId
    if (results.stats.patchCount > 0) {
      message.success(`已加载 ${results.stats.patchCount} 个变化斑块，共 ${results.stats.totalAreaKm2.toFixed(2)} km²`)
    }
  }, [results])

  // ---- 派生数据 ----
  const features = useMemo(() => results?.geojson.features ?? [], [results])
  const selectedPatch = useMemo(
    () => features.find((f) => f.properties.patchId === selectedPatchId)?.properties ?? null,
    [features, selectedPatchId],
  )
  const alertByPatch = useMemo(() => {
    const m = new Map<string, AlertDto>()
    for (const a of alertsQuery.data ?? []) {
      if (a.taskId === taskId) m.set(a.patchId, a)
    }
    return m
  }, [alertsQuery.data, taskId])

  /** 对比时相：结果集最早 beforeDate / 最晚 afterDate，缺省回落任务时间窗或 3 天前 */
  const compareDates = useMemo(() => {
    const befores = features.map((f) => f.properties.beforeDate).sort()
    const afters = features.map((f) => f.properties.afterDate).sort()
    return {
      before: befores[0] ?? taskDetailQuery.data?.startDate.slice(0, 10) ?? FALLBACK_DATE(),
      after: afters[afters.length - 1] ?? taskDetailQuery.data?.endDate.slice(0, 10) ?? FALLBACK_DATE(),
    }
  }, [features, taskDetailQuery.data])
  const activeCompareDate = compareMode === 'before' ? compareDates.before : compareDates.after

  const center: [number, number] = useMemo(
    () => TENANT_CENTER[user?.tenantId ?? ''] ?? [25.2, 55.27],
    [user],
  )

  const activeLayerStatus = useMemo(() => {
    const entries = MAP_LAYER_KEYS.filter((k) => activeLayers.includes(k)).map(
      (k) => [k, layerStatus?.[k]] as const,
    )
    return {
      anyLoading: entries.some(([, s]) => s?.loading),
      anyError: entries.some(([, s]) => s?.error),
      errorNames: entries.filter(([, s]) => s?.error).map(([k]) => LAYER_DEFS[k].name),
    }
  }, [activeLayers, layerStatus])

  const taskAlerts = useMemo(
    () => (alertsQuery.data ?? []).filter((a) => a.taskId === taskId),
    [alertsQuery.data, taskId],
  )

  /** 404：任务不存在 / 不属于当前组织（跨租户不泄露存在性，US-11）或结果尚未生成 */
  const notFound =
    (taskDetailQuery.error instanceof ApiError && taskDetailQuery.error.status === 404) ||
    (resultsQuery.error instanceof ApiError && resultsQuery.error.status === 404)

  // ---- 占位入口解析中的过渡态 ----
  if (isPlaceholderEntry) {
    if (tasksQuery.isLoading) {
      return (
        <div style={{ padding: '80px 0', display: 'grid', gap: 12, justifyItems: 'center' }}>
          <Spin size="large" />
          <Typography.Text type="secondary">正在定位最近完成的监测任务…</Typography.Text>
        </div>
      )
    }
    if (tasksQuery.isError) {
      return (
        <Result
          status="warning"
          title="任务列表加载失败"
          subTitle="无法定位最近完成的任务，请稍后重试。"
          extra={
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => void tasksQuery.refetch()}>
              重试
            </Button>
          }
        />
      )
    }
    const hasCompleted = (tasksQuery.data ?? []).some((t) => t.status === 'completed')
    if (hasCompleted) {
      // 上方 effect 已在跳转中，这里只渲染过渡态
      return (
        <div style={{ padding: '80px 0', display: 'grid', gap: 12, justifyItems: 'center' }}>
          <Spin size="large" />
          <Typography.Text type="secondary">正在跳转到最近完成的任务…</Typography.Text>
        </div>
      )
    }
    return (
      <Result
        status="info"
        title="暂无已完成任务"
        subTitle="任务完成并产出变化检测结果后，可在此查看结果地图。"
        extra={
          <Space>
            <Button onClick={() => navigate('/workspace')}>返回工作台</Button>
            <Button type="primary" onClick={() => navigate('/tasks/create')}>
              创建监测任务
            </Button>
          </Space>
        }
      />
    )
    // 有完成任务时上方 effect 已触发跳转，渲染到此说明正在切换
  }

  if (notFound) {
    return (
      <Result
        status="404"
        title="结果不存在或不可访问"
        subTitle="任务可能仍在执行尚未产出结果，或该资源不在当前组织空间（跨租户访问返回 404，不泄露存在性）。"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => {
              void taskDetailQuery.refetch()
              void resultsQuery.refetch()
            }}>
              重试
            </Button>
            <Button type="primary" onClick={() => navigate('/workspace')}>
              返回工作台
            </Button>
          </Space>
        }
      />
    )
  }

  const taskName = taskDetailQuery.data?.name ?? '监测结果'
  const stats = results?.stats

  return (
    <Row gutter={[16, 16]}>
      {/* ---- 顶部：任务信息与统计 ---- */}
      <Col span={24}>
        <Card
          title={taskName}
          extra={
            taskDetailQuery.data ? (
              <Space size={8} wrap>
                <Tag>{MONITOR_TYPE_LABELS[taskDetailQuery.data.monitorType]}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  监测窗 {taskDetailQuery.data.startDate.slice(0, 10)} ~{' '}
                  {taskDetailQuery.data.endDate.slice(0, 10)}
                </Typography.Text>
              </Space>
            ) : null
          }
        >
          {resultsQuery.isLoading || taskDetailQuery.isLoading ? (
            <Skeleton active paragraph={{ rows: 1 }} />
          ) : resultsQuery.isError ? (
            <Alert
              type="error"
              showIcon
              message="变化检测结果加载失败"
              description="服务暂不可达或请求超时，请重试。"
              action={
                <Button size="small" danger icon={<ReloadOutlined />} onClick={() => void resultsQuery.refetch()}>
                  重试
                </Button>
              }
            />
          ) : stats ? (
            <Space size={16} wrap>
              <Typography.Text>
                斑块 <b>{stats.patchCount}</b> 个
              </Typography.Text>
              <Typography.Text>
                变化总面积 <b>{stats.totalAreaKm2.toFixed(2)}</b> km²
              </Typography.Text>
              {Object.entries(stats.byType).map(([type, area]) => (
                <Tag key={type}>
                  {type} {area.toFixed(2)} km²
                </Tag>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                斑块时相 Sentinel-2 L2A；底图 NASA GIBS
              </Typography.Text>
            </Space>
          ) : null}
        </Card>
      </Col>

      {/* ---- 左列：结果地图 ---- */}
      <Col xs={24} lg={15}>
        <Card
          title="变化检测结果地图"
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {activeLayerStatus.anyLoading ? '底图加载中…' : '瓦片并发 ≤6'}
            </Typography.Text>
          }
        >
          {resultsQuery.isLoading ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : resultsQuery.isError ? (
            <Alert
              type="error"
              showIcon
              message="结果加载失败，地图暂不可用"
              description="请稍后重试；重试成功后地图将自动叠加变化斑块。"
              action={
                <Button size="small" danger icon={<ReloadOutlined />} onClick={() => void resultsQuery.refetch()}>
                  重试
                </Button>
              }
            />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {/* 工具条：双时相对比 + 透明度 + 底图图层开关 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
                {/* 键盘 ←/→ 切换前后时相（聚焦本区域后生效，US-08 微调语义的简化实现） */}
                <div
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') setCompareMode('before')
                    if (e.key === 'ArrowRight') setCompareMode('after')
                  }}
                  style={{ outline: 'none' }}
                >
                  <Segmented
                    value={compareMode}
                    onChange={(v) => setCompareMode(v as 'before' | 'after')}
                    options={[
                      { label: `前时相 ${compareDates.before}`, value: 'before' },
                      { label: `后时相 ${compareDates.after}`, value: 'after' },
                    ]}
                  />
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  底图按所选时相日期渲染（←/→ 切换）
                </Typography.Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 180 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12, flex: '0 0 auto' }}>
                    斑块透明度
                  </Typography.Text>
                  <Slider
                    style={{ flex: 1, margin: 0 }}
                    min={0}
                    max={100}
                    value={opacityPct}
                    onChange={setOpacityPct}
                    tooltip={{ formatter: (v) => `${v}%` }}
                  />
                </div>
                <Checkbox.Group
                  options={MAP_LAYER_KEYS.map((k) => ({ label: LAYER_DEFS[k].name, value: k }))}
                  value={activeLayers}
                  onChange={(vals) => setActiveLayers(vals as MapLayerKey[])}
                />
              </div>

              <div style={{ position: 'relative' }}>
                {activeLayerStatus.anyLoading && (
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
                <PatchMap
                  key={`${taskId}-${retryKey}`}
                  center={center}
                  patches={features}
                  aoiGeojson={taskDetailQuery.data?.aoi.geojson ?? null}
                  opacityPct={opacityPct}
                  selectedPatchId={selectedPatchId}
                  focus={focus}
                  date={activeCompareDate}
                  activeLayers={activeLayers}
                  onLayerStatusChange={setLayerStatus}
                  onPatchClick={(patchId) => setSelectedPatchId(patchId)}
                  style={{ height: 520, borderRadius: 8 }}
                />
              </div>

              {/* 图例：置信度分色 + AOI 边界 */}
              <div className="results-map-legend">
                <span>置信度：</span>
                {CONFIDENCE_LEGEND.map((c) => (
                  <span key={c.label}>
                    <span className="dot" style={{ background: c.color }} />
                    {c.label}
                  </span>
                ))}
                <span>
                  <span
                    className="dot"
                    style={{
                      background: 'transparent',
                      border: '2px dashed #1677ff',
                      width: 8,
                      height: 8,
                    }}
                  />
                  监测 AOI 边界
                </span>
              </div>

              {activeLayerStatus.anyError && (
                <Alert
                  type="warning"
                  showIcon
                  message={`「${activeLayerStatus.errorNames.join('、')}」部分瓦片加载失败`}
                  description="GIBS 底图通道与业务接口相互独立：斑块图层与详情不受影响，仍可交互。可点击重试重建底图。"
                  action={
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => {
                        setRetryKey((k) => k + 1)
                        message.info('已重新加载底图图层')
                      }}
                    >
                      重试
                    </Button>
                  }
                />
              )}
              {activeLayers.length === 0 && (
                <Alert type="info" showIcon message="未启用任何底图图层" description="可勾选真彩 / IMERG / 夜光图层辅助判读变化斑块。" />
              )}
            </div>
          )}
        </Card>
      </Col>

      {/* ---- 右列：斑块列表 + 斑块详情 ---- */}
      <Col xs={24} lg={9}>
        <div style={{ display: 'grid', gap: 16 }}>
          <Card
            title={`变化斑块（${features.length}）`}
            extra={
              taskAlerts.length > 0 ? (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  其中 {taskAlerts.length} 个已触发告警
                </Typography.Text>
              ) : null
            }
          >
            {alertsQuery.isLoading && resultsQuery.isLoading ? (
              <Skeleton active paragraph={{ rows: 4 }} />
            ) : features.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="本轮变化检测未检出斑块"
              >
                <Button onClick={() => navigate('/workspace')}>返回工作台</Button>
              </Empty>
            ) : (
              <PatchList
                patches={features}
                selectedPatchId={selectedPatchId}
                alertByPatch={alertByPatch}
                onSelect={(patchId) => {
                  setSelectedPatchId(patchId)
                  setFocus({ patchId, ts: Date.now() })
                }}
              />
            )}
          </Card>

          <Card title="斑块详情与举证">
            {!taskId ? null : (
              <PatchDetailCard
                taskId={taskId}
                patch={selectedPatch}
                alerts={taskAlerts}
                canWrite={canWrite}
              />
            )}
          </Card>
        </div>
      </Col>
    </Row>
  )
}
