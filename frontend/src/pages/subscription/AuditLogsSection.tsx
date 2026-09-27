/**
 * 审计日志只读表（US-12）：本组织敏感操作历史，时间倒序、UTC + 本地双显。
 * - 仅租户管理员可见（US-12.3）；其余角色在页面层直接拦截并提示权限不足
 * - 契约 §2 仅有 limit 参数，操作者/动作/时间范围筛选在前端本地完成
 * - CSV 导出为纯前端生成（契约无导出端点，数据源即当前加载的日志）
 */
import { useMemo, useState } from 'react'
import { Alert, Button, Card, Empty, Select, Skeleton, Table, Tag, Typography, message } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import type { AuditLog } from '../../api/types'
import { formatUtcAndLocal, toMillis } from './format'

interface AuditLogsSectionProps {
  logs: AuditLog[]
  loading: boolean
  error: boolean
  onRetry: () => void
  /** 导出文件名中的组织名（US-12.4：命名含组织名与时间范围） */
  tenantName: string
}

/** 动作 → 标签色（覆盖契约 §2 列举的敏感操作类型，其余默认展示） */
const ACTION_COLOR: Record<string, string> = {
  订阅开通: 'purple',
  订阅变更: 'purple',
  成员邀请: 'gold',
  'AOI 创建': 'blue',
  'AOI 删除': 'red',
  任务创建: 'blue',
  告警处置: 'orange',
  报告生成: 'cyan',
}

const RANGE_OPTIONS = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '全部' },
] as const

type RangeValue = (typeof RANGE_OPTIONS)[number]['value']

function rangeStartMillis(range: RangeValue): number {
  if (range === 'all') return Number.NEGATIVE_INFINITY
  const now = Date.now()
  if (range === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const days = range === '7d' ? 7 : 30
  return now - days * 24 * 60 * 60 * 1000
}

/** CSV 单元格转义：引号包裹并双写内部引号 */
function csvCell(v: string): string {
  return `"${v.replaceAll('"', '""')}"`
}

export default function AuditLogsSection({ logs, loading, error, onRetry, tenantName }: AuditLogsSectionProps) {
  const [actorFilter, setActorFilter] = useState<string>('all')
  const [actionFilter, setActionFilter] = useState<string>('all')
  const [range, setRange] = useState<RangeValue>('all')

  const actors = useMemo(
    () => Array.from(new Set(logs.map((l) => l.actor))).sort(),
    [logs],
  )
  const actions = useMemo(
    () => Array.from(new Set(logs.map((l) => l.action))).sort(),
    [logs],
  )

  const filtered = useMemo(() => {
    const start = rangeStartMillis(range)
    return logs.filter(
      (l) =>
        (actorFilter === 'all' || l.actor === actorFilter) &&
        (actionFilter === 'all' || l.action === actionFilter) &&
        toMillis(l.at) >= start,
    )
  }, [logs, actorFilter, actionFilter, range])

  const exportCsv = () => {
    if (filtered.length === 0) {
      message.warning('当前筛选下没有可导出的日志')
      return
    }
    const header = '时间(UTC/本地),操作者,动作,详情'
    const rows = filtered.map((l) =>
      [formatUtcAndLocal(l.at), l.actor, l.action, l.detail].map(csvCell).join(','),
    )
    const blob = new Blob([`\uFEFF${[header, ...rows].join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    a.href = url
    a.download = `审计日志_${tenantName}_${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}.csv`
    a.click()
    URL.revokeObjectURL(url)
    message.success(`已导出 ${filtered.length} 条审计日志（CSV）`)
  }

  return (
    <Card
      title={
        <span>
          审计日志 <Tag color="default">只读 · 仅租户管理员可见</Tag>
        </span>
      }
      extra={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
            刷新
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={exportCsv}>
            导出 CSV
          </Button>
        </div>
      }
    >
      {/* ---- 本地筛选（操作者 / 动作类型 / 时间范围，US-12.3） ---- */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Select
          size="small"
          style={{ minWidth: 140 }}
          value={actorFilter}
          onChange={setActorFilter}
          options={[
            { value: 'all', label: '全部操作者' },
            ...actors.map((a) => ({ value: a, label: `操作者：${a}` })),
          ]}
        />
        <Select
          size="small"
          style={{ minWidth: 140 }}
          value={actionFilter}
          onChange={setActionFilter}
          options={[
            { value: 'all', label: '全部动作' },
            ...actions.map((a) => ({ value: a, label: a })),
          ]}
        />
        <Select
          size="small"
          style={{ minWidth: 100 }}
          value={range}
          onChange={setRange}
          options={RANGE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>

      {loading ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message="审计日志加载失败"
          description="服务暂不可达或请求超时，请稍后重试。"
          action={
            <Button size="small" danger onClick={onRetry}>
              重试
            </Button>
          }
        />
      ) : logs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本组织暂无审计记录" />
      ) : filtered.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选条件下无匹配日志" />
      ) : (
        <>
          <Table
            size="small"
            rowKey={(r) => `${r.at}-${r.actor}-${r.detail}`}
            dataSource={filtered}
            pagination={{ pageSize: 10, hideOnSinglePage: true, showTotal: (t) => `共 ${t} 条` }}
            columns={[
              {
                title: '时间（UTC / 本地）',
                dataIndex: 'at',
                width: 250,
                render: (v: string) => (
                  <Typography.Text style={{ fontSize: 12 }}>{formatUtcAndLocal(v)}</Typography.Text>
                ),
              },
              { title: '操作者', dataIndex: 'actor', width: 100 },
              {
                title: '动作',
                dataIndex: 'action',
                width: 110,
                render: (v: string) => <Tag color={ACTION_COLOR[v] ?? 'default'}>{v}</Tag>,
              },
              { title: '详情', dataIndex: 'detail' },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            记录范围：任务创建/删除、AOI 变更、订阅变更、成员邀请、告警处置等本组织敏感操作（契约 §2，
            最近 {logs.length} 条）；日志仅本组织可见。
          </Typography.Text>
        </>
      )}
    </Card>
  )
}
