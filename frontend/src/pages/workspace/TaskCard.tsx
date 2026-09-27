/**
 * 单个监测任务状态卡片（US-06 跟踪任务执行状态）：
 * - 状态徽标（排队/检索中/分析中/已完成/失败/已取消）+ 分阶段耗时 + 当前阶段文案
 * - 降级标记：degraded=true 时橙色 Tag，Tooltip 展示降级原因
 *   （契约 §4 列表仅含 degraded 布尔值，原因文案取 stage.current；后端若补充
 *   明确 reason 字段，见页面目录 README 注记，由集成代理统一接线）
 * - completed 显示「查看结果」入口；queued/retrieving 且有写权限显示「取消」
 */
import { Button, Card, Tag, Tooltip, Typography } from 'antd'
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'
import { MONITOR_TYPE_LABELS, type TaskStatus, type TaskSummary } from '../../api/types'

const STATUS_META: Record<
  TaskStatus,
  { label: string; color: string; icon: ReactNode }
> = {
  queued: { label: '排队中', color: 'default', icon: <ClockCircleOutlined /> },
  retrieving: { label: '检索影像中', color: 'processing', icon: <SearchOutlined /> },
  analyzing: { label: '变化检测分析中', color: 'processing', icon: <LoadingOutlined /> },
  completed: { label: '已完成', color: 'success', icon: <CheckCircleOutlined /> },
  failed: { label: '失败', color: 'error', icon: <CloseCircleOutlined /> },
  cancelled: { label: '已取消', color: 'warning', icon: <MinusCircleOutlined /> },
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

function formatCreatedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 降级/失败原因：优先 stage.current（后端状态机写入的卡点/原因文案） */
function degradeReason(task: TaskSummary): string {
  const current = task.stage.current?.trim()
  if (current) return current
  return '外部数据源故障，系统将在下一调度周期自动重试（PRD 5.2 降级路径）'
}

export default function TaskCard({
  task,
  canCancel,
  onCancel,
  onOpenResults,
}: {
  task: TaskSummary
  /** 有写权限且无取消请求进行中 */
  canCancel: boolean
  onCancel: () => void
  onOpenResults: () => void
}) {
  const meta = STATUS_META[task.status]
  const isActive = task.status === 'queued' || task.status === 'retrieving'
  const cancellable = isActive && canCancel

  return (
    <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Typography.Text strong>{task.name}</Typography.Text>
        <Tag>{MONITOR_TYPE_LABELS[task.monitorType]}</Tag>
        <Tag color={meta.color}>
          {meta.icon} {meta.label}
        </Tag>
        {task.degraded && (
          <Tooltip title={degradeReason(task)}>
            <Tag color="orange" style={{ cursor: 'help' }}>
              降级
            </Tag>
          </Tooltip>
        )}
        <span style={{ flex: 1 }} />
        {task.status === 'completed' && (
          <Button size="small" type="primary" ghost onClick={onOpenResults}>
            查看结果
          </Button>
        )}
        {cancellable && (
          <Button size="small" danger onClick={onCancel}>
            取消任务
          </Button>
        )}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        监测区域：{task.aoiName} · 创建于 {formatCreatedAt(task.createdAt)}
      </Typography.Text>
      {(task.status === 'retrieving' ||
        task.status === 'analyzing' ||
        task.status === 'completed' ||
        task.status === 'failed') && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }} ellipsis={{ rows: 1 }}>
          阶段耗时：检索 {formatMs(task.stage.retrievalMs)} / 分析 {formatMs(task.stage.analysisMs)}
          {task.stage.current ? ` · ${task.stage.current}` : ''}
        </Typography.Paragraph>
      )}
      {task.status === 'failed' && (
        <Typography.Paragraph type="danger" style={{ fontSize: 12, marginBottom: 0 }} ellipsis={{ rows: 1 }}>
          失败原因：{degradeReason(task)}
        </Typography.Paragraph>
      )}
    </Card>
  )
}
