/**
 * 报告章节化预览（PRD US-09 验收 2）：
 * ① 任务与 AOI 概述（GIBS WMS 真实定位影像）② 数据源与方法说明
 * ③ 变化统计：类型 × 告警等级矩阵（热度着色）+ 面积占比条 + byType 表
 * ④ 重点斑块举证卡（Top10，GIBS WMS 前后时相真实影像，当日无数据回退邻近日期）
 * ⑤ 附录（数据源清单 + 免责声明）。
 * 根节点挂 .report-print-root，@media print 时成为唯一可见区域（见 reportPrint.css）。
 * 影像来自 GIBS WMS（免登录、ACAO:*，2026-09-27 实测）；失败降级为占位框（工程原则 4/5）。
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Col, Progress, Row, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { apiFetch } from '../../api/client'
import { MONITOR_TYPE_LABELS, type MonitorType } from '../../api/types'
import type { ReportDetail, ReportStats } from './schemas'
import PhaseImage, { AoiImage } from './PhaseImage'
import { bboxFromPolygonCoordinates, type BBox } from './gibsImage'

const ALERT_LEVEL_TAGS: Record<string, { label: string; color: string }> = {
  high: { label: '高', color: 'red' },
  medium: { label: '中', color: 'orange' },
  low: { label: '低', color: 'blue' },
}

function alertTag(level: string): { label: string; color: string } {
  return ALERT_LEVEL_TAGS[level] ?? { label: level, color: 'default' }
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const BY_TYPE_COLUMNS: ColumnsType<ReportStats['byType'][number]> = [
  { title: '变化类型', dataIndex: 'changeType', key: 'changeType' },
  { title: '斑块数', dataIndex: 'count', key: 'count', align: 'right' },
  {
    title: '面积（km²）',
    dataIndex: 'areaKm2',
    key: 'areaKm2',
    align: 'right',
    render: (v: number) => v.toFixed(4),
  },
]

const LEVEL_ORDER = ['high', 'medium', 'low'] as const

/** 结果 GeoJSON 斑块（契约 §5）：举证图 bbox 与统计矩阵的数据源 */
interface PatchFeature {
  patchId: string
  changeType: string
  alertLevel: string
  areaKm2: number
  bbox: BBox | null
}

/** 拉取任务结果并转换为轻量斑块记录（与结果查看页同一契约端点，react-query 缓存共享） */
function usePatchFeatures(taskId: string): PatchFeature[] {
  const query = useQuery({
    queryKey: ['task-results-raw', taskId],
    // 页面边界校验：只取本页消费的字段，脏数据跳过不崩（外部响应视为不可信）
    queryFn: async (): Promise<PatchFeature[]> => {
      const raw = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/results`)
      const fc = (raw as { geojson?: { features?: unknown[] } }).geojson
      const features = Array.isArray(fc?.features) ? fc.features : []
      const out: PatchFeature[] = []
      for (const f of features) {
        const props = (f as { properties?: Record<string, unknown> }).properties
        const geom = (f as { geometry?: { coordinates?: unknown } }).geometry
        if (!props || typeof props.patchId !== 'string') continue
        out.push({
          patchId: props.patchId,
          changeType: String(props.changeType ?? '未知'),
          alertLevel: String(props.alertLevel ?? 'low'),
          areaKm2: typeof props.areaKm2 === 'number' ? props.areaKm2 : 0,
          bbox: bboxFromPolygonCoordinates(geom?.coordinates),
        })
      }
      return out
    },
    retry: 1,
    staleTime: 5 * 60 * 1000,
  })
  return query.data ?? []
}

/** 类型 × 告警等级矩阵（计数，背景色深浅按行占比） */
function StatsMatrix({ patches }: { patches: PatchFeature[] }) {
  const { types, matrix, rowMax } = useMemo(() => {
    const typeSet = new Map<string, number>() // type → 总数（保序）
    const cell = new Map<string, number>()
    for (const p of patches) {
      typeSet.set(p.changeType, (typeSet.get(p.changeType) ?? 0) + 1)
      cell.set(`${p.changeType}|${p.alertLevel}`, (cell.get(`${p.changeType}|${p.alertLevel}`) ?? 0) + 1)
    }
    const m = new Map<string, { count: number; intensity: number }>()
    let max = 1
    for (const t of typeSet.keys()) {
      const total = typeSet.get(t) ?? 0
      max = Math.max(max, total)
      for (const lv of LEVEL_ORDER) {
        const count = cell.get(`${t}|${lv}`) ?? 0
        m.set(`${t}|${lv}`, { count, intensity: total === 0 ? 0 : count / total })
      }
    }
    return { types: [...typeSet.keys()], matrix: m, rowMax: max }
  }, [patches])

  if (patches.length === 0) return null
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        className="report-matrix"
        style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}
      >
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>变化类型 ＼ 告警等级</th>
            {LEVEL_ORDER.map((lv) => (
              <th key={lv} style={{ textAlign: 'center' }}>
                {ALERT_LEVEL_TAGS[lv].label}
              </th>
            ))}
            <th style={{ textAlign: 'center' }}>合计</th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => {
            const total = patches.filter((p) => p.changeType === t).length
            return (
              <tr key={t}>
                <td>{t}</td>
                {LEVEL_ORDER.map((lv) => {
                  const cell = matrix.get(`${t}|${lv}`)!
                  // 行内占比越高底色越深（rgba 蓝），0 为空白格
                  const bg = cell.count === 0 ? 'transparent' : `rgba(22, 119, 255, ${0.08 + cell.intensity * 0.42})`
                  return (
                    <td
                      key={lv}
                      style={{ textAlign: 'center', background: bg, color: cell.intensity > 0.6 ? '#fff' : undefined }}
                    >
                      {cell.count || ''}
                    </td>
                  )
                })}
                <td style={{ textAlign: 'center', fontWeight: 600 }}>{total}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        行合计 {patches.length} 个斑块 · 底色深浅 = 该类型内各等级占比（{rowMax} 为单类型最大值仅作展示参考）
      </Typography.Text>
    </div>
  )
}

/** 各类型面积占比条（纯 CSS，打印友好，无图表库依赖） */
function AreaShareBars({ byType }: { byType: ReportStats['byType'] }) {
  const max = Math.max(...byType.map((r) => r.areaKm2), 0.0001)
  const colors = ['#1677ff', '#fa8c16', '#52c41a', '#722ed1', '#eb2f96']
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {byType.map((r, i) => (
        <div key={r.changeType} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 90px', alignItems: 'center', gap: 8 }}>
          <Typography.Text style={{ fontSize: 12 }}>{r.changeType}</Typography.Text>
          <div style={{ background: '#f0f0f0', height: 14, borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max((r.areaKm2 / max) * 100, 2)}%`,
                height: '100%',
                background: colors[i % colors.length],
              }}
              title={`${r.changeType}：${r.areaKm2.toFixed(4)} km²`}
            />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>
            {r.areaKm2.toFixed(2)} km² · {((r.areaKm2 / (byType.reduce((s, x) => s + x.areaKm2, 0) || 1)) * 100).toFixed(0)}%
          </Typography.Text>
        </div>
      ))}
    </div>
  )
}

interface ReportPreviewProps {
  report: ReportDetail
  tenantName: string
}

export default function ReportPreview({ report, tenantName }: ReportPreviewProps) {
  const { overview, stats, methodology } = report.sections
  const patches = usePatchFeatures(report.taskId)
  const patchBBoxById = useMemo(() => new Map(patches.map((p) => [p.patchId, p.bbox])), [patches])
  const aoiBBox = useMemo(
    () => bboxFromPolygonCoordinates(overview.aoiGeojson?.coordinates),
    [overview.aoiGeojson],
  )

  return (
    <div className="report-print-root">
      {/* ---- 封面 / 页眉：组织名称 · 报告期次 · 生成时间戳（US-09 验收 4） ---- */}
      <div style={{ borderBottom: '2px solid #1677ff', paddingBottom: 12, marginBottom: 4 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {tenantName} · 监测报告
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          报告编号 {report.id} · 生成时间 {formatDateTime(report.generatedAt)} · 卫星遥感监测平台
        </Typography.Text>
      </div>

      {/* ---- ① 任务与 AOI 概述 ---- */}
      <Typography.Title level={5} className="report-section-title" style={{ marginTop: 16 }}>
        一、任务与 AOI 概述
      </Typography.Title>
      <Row gutter={[12, 4]}>
        <Col span={12}>
          <Typography.Text type="secondary">任务名称：</Typography.Text>
          <Typography.Text strong>{overview.taskName}</Typography.Text>
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary">监测类型：</Typography.Text>
          <Typography.Text strong>
            {overview.monitorTypeLabel || MONITOR_TYPE_LABELS[overview.monitorType as MonitorType] || overview.monitorType}
          </Typography.Text>
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary">AOI：</Typography.Text>
          <Typography.Text strong>
            {overview.aoiName}（{overview.aoiAreaKm2.toFixed(2)} km²）
          </Typography.Text>
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary">时间窗：</Typography.Text>
          <Typography.Text strong>
            {overview.timeWindow.start} ~ {overview.timeWindow.end}
          </Typography.Text>
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary">云量上限：</Typography.Text>
          <Typography.Text strong>{overview.cloudMaxPct}%</Typography.Text>
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary">影像景数：</Typography.Text>
          <Typography.Text strong>{overview.dataSource.sceneCount} 景</Typography.Text>
        </Col>
      </Row>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 12 }}>
        数据源：{overview.dataSource.note}
      </Typography.Paragraph>
      {/* AOI 定位影像：GIBS WMS 按 AOI 范围实时出图（时间窗末日），不可用时降级占位 */}
      <AoiImage bbox={aoiBBox} date={overview.timeWindow.end} />

      {/* ---- ② 数据源与方法说明 ---- */}
      <Typography.Title level={5} className="report-section-title report-page-break">
        二、数据源与方法说明
      </Typography.Title>
      <Typography.Paragraph style={{ textAlign: 'justify' }}>{methodology.note}</Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, textAlign: 'justify' }}>
        举证影像说明：斑块前后时相影像取自 NASA GIBS WMS（MODIS 真彩 250m，免登录公开数据），
        按斑块外接范围实时出图；所指日期当日无覆盖时自动回退至邻近可用日期并在图下如实标注。
      </Typography.Paragraph>

      {/* ---- ③ 变化统计：矩阵 + 占比条 + byType 表 ---- */}
      <Typography.Title level={5} className="report-section-title">
        三、变化统计（类型 × 告警等级矩阵）
      </Typography.Title>
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col span={12}>
          <Card size="small">
            <Typography.Text type="secondary">斑块总数</Typography.Text>
            <Typography.Title level={3} style={{ margin: '4px 0 0' }}>
              {stats.patchCount} 个
            </Typography.Title>
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small">
            <Typography.Text type="secondary">变化总面积</Typography.Text>
            <Typography.Title level={3} style={{ margin: '4px 0 0' }}>
              {stats.totalAreaKm2.toFixed(4)} km²
            </Typography.Title>
          </Card>
        </Col>
      </Row>
      <StatsMatrix patches={patches} />
      <div style={{ height: 12 }} />
      <AreaShareBars byType={stats.byType} />
      <div style={{ height: 12 }} />
      <Table<ReportStats['byType'][number]>
        rowKey="changeType"
        columns={BY_TYPE_COLUMNS}
        dataSource={stats.byType}
        pagination={false}
        size="small"
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <Typography.Text strong>{stats.patchCount}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">
                <Typography.Text strong>{stats.totalAreaKm2.toFixed(4)}</Typography.Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />

      {/* ---- ④ 重点斑块举证卡（Top10，前后时相真实影像） ---- */}
      <Typography.Title level={5} className="report-section-title report-page-break">
        四、重点斑块举证（Top 10）
      </Typography.Title>
      <Row gutter={[12, 12]}>
        {stats.top10Patches.map((p) => {
          const lv = alertTag(p.alertLevel)
          return (
            <Col key={p.patchId} xs={24} md={12}>
              <Card size="small" title={p.patchId} extra={<Tag color={lv.color}>告警 {lv.label}</Tag>}>
                <Typography.Paragraph style={{ marginBottom: 4 }} type="secondary">
                  {p.changeType} · {p.areaKm2.toFixed(4)} km² · 前时相 {p.beforeDate} / 后时相 {p.afterDate}
                </Typography.Paragraph>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#888' }}>置信度</span>
                  <Progress
                    percent={Math.round(p.confidence * 100)}
                    size="small"
                    style={{ flex: 1, marginBottom: 0 }}
                  />
                </div>
                <PhaseImage
                  bbox={patchBBoxById.get(p.patchId) ?? null}
                  beforeDate={p.beforeDate}
                  afterDate={p.afterDate}
                />
              </Card>
            </Col>
          )
        })}
      </Row>

      {/* ---- ⑤ 附录 ---- */}
      <Typography.Title level={5} className="report-section-title report-page-break">
        五、附录：数据源清单与免责声明
      </Typography.Title>
      <Typography.Paragraph style={{ textAlign: 'justify' }}>
        数据源清单：Sentinel-2 L2A 10m（Copernicus Data Space，CC-BY-4.0）；Landsat 8/9 15–30m（USGS
        STAC，公共领域）；ESA WorldCover 2021 10m（CC-BY-4.0）；NASA GIBS 影像瓦片与 WMS 影像（公共领域）。
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ textAlign: 'justify' }}>
        免责声明：本报告基于公开卫星数据自动生成，变化斑块为算法初步识别结果，正式执法或对外发布前须结合现场核查确认。
      </Typography.Paragraph>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {tenantName} · 卫星遥感监测平台 · 报告编号 {report.id}
      </Typography.Text>
    </div>
  )
}
