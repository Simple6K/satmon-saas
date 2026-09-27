/**
 * 报告章节化预览（PRD US-09 验收 2）：
 * ① 任务与 AOI 概述（含定位截图占位）② 数据源与方法说明 ③ 变化统计表（byType）
 * ④ 重点斑块举证卡（Top10，前后时相占位图）⑤ 附录（数据源清单 + 免责声明）。
 * 根节点挂 .report-print-root，@media print 时成为唯一可见区域（见 reportPrint.css）。
 * 趋势图 / 同比上期为契约 §6 未提供的数据，MVP 不虚构（见页面 notesForIntegration）。
 */
import { Card, Col, Progress, Row, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { MONITOR_TYPE_LABELS, type MonitorType } from '../../api/types'
import type { ReportDetail, ReportStats } from './schemas'

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

interface ReportPreviewProps {
  report: ReportDetail
  tenantName: string
}

export default function ReportPreview({ report, tenantName }: ReportPreviewProps) {
  const { overview, stats, methodology } = report.sections

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
      {/* AOI 地图定位截图占位（MVP 演示策略：地图截图为预置占位图，不依赖现场瓦片网络） */}
      <div className="report-placeholder" style={{ height: 200 }}>
        AOI 地图定位截图（占位）· {overview.aoiName}
      </div>

      {/* ---- ② 数据源与方法说明 ---- */}
      <Typography.Title level={5} className="report-section-title report-page-break">
        二、数据源与方法说明
      </Typography.Title>
      <Typography.Paragraph style={{ textAlign: 'justify' }}>{methodology.note}</Typography.Paragraph>

      {/* ---- ③ 变化统计表 ---- */}
      <Typography.Title level={5} className="report-section-title">
        三、变化统计表（按变化类型）
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

      {/* ---- ④ 重点斑块举证卡（Top10） ---- */}
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                  <div className="report-placeholder" style={{ height: 90 }}>
                    前时相影像（占位）
                  </div>
                  <div className="report-placeholder" style={{ height: 90 }}>
                    后时相影像（占位）
                  </div>
                </div>
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
        STAC，公共领域）；ESA WorldCover 2021 10m（CC-BY-4.0）；NASA GIBS 影像瓦片（公共领域）。
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
