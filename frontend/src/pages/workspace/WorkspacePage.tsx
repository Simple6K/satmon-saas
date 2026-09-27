/**
 * 工作台（US-05/06/10 的着陆视图）：
 * - 概览统计：活跃任务 / 告警待处理 / 配额用量（AOI 面积、并发任务，Progress）
 * - 任务状态卡片流：排队/检索中/分析中/已完成/失败/已取消 + 降级标记与原因 tooltip，
 *   活跃任务 15s 轮询（对齐后端 scheduler 30s 推进节奏），审批人只读不显示取消按钮
 * - GIBS 底图小地图（复用 MapCanvas）：图层开关 + 瓦片失败降级提示条 + 重试
 * - 消息铃铛联动：与顶栏共享 ['messages'] 查询缓存，最新消息与未读数同源同步
 * 所有数据经 apiFetch + 契约 zod 校验；加载/空/错误/重试态全覆盖（工程原则 5）。
 */
import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Card, Col, Empty, Row, Skeleton, Typography, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import {
  AlertSchema,
  MessageSchema,
  SubscriptionSchema,
  TaskSummarySchema,
} from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import StatsCards from './StatsCards'
import TaskCard from './TaskCard'
import MiniMap from './MiniMap'

/** 活跃（进行中）任务的状态集合 */
const ACTIVE_STATUSES = new Set(['queued', 'retrieving', 'analyzing'])

/** 状态展示顺序：进行中的排最前，失败/取消垫底 */
const STATUS_ORDER: Record<string, number> = {
  retrieving: 0,
  analyzing: 1,
  queued: 2,
  completed: 3,
  failed: 4,
  cancelled: 5,
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function WorkspacePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canWrite = user?.role === 'analyst' || user?.role === 'tenant_admin'

  // ---- 数据获取（契约 §2/§4/§5） ----

  // 任务列表：有活跃任务时 15s 轮询推进状态机（US-06 状态异步刷新）
  const tasksQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: async () => TaskSummarySchema.array().parse(await apiFetch<unknown>('/api/tasks')),
    refetchInterval: 15_000,
  })

  const alertsQuery = useQuery({
    queryKey: ['alerts'],
    queryFn: async () => AlertSchema.array().parse(await apiFetch<unknown>('/api/alerts')),
    refetchInterval: 30_000,
  })

  const subsQuery = useQuery({
    queryKey: ['subscription'],
    queryFn: async () => SubscriptionSchema.parse(await apiFetch<unknown>('/api/subscription')),
  })

  // 与顶栏铃铛共享同一缓存（AppLayout 已挂 30s 轮询），此处只读消费实现联动
  const messagesQuery = useQuery({
    queryKey: ['messages'],
    queryFn: async () => MessageSchema.array().parse(await apiFetch<unknown>('/api/messages')),
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/tasks/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      message.success('任务已取消，并发配额已释放')
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    // 失败提示由 apiFetch 统一 toast，这里无需额外处理
  })

  // ---- 派生数据 ----

  const sortedTasks = useMemo(
    () =>
      [...(tasksQuery.data ?? [])].sort(
        (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
      ),
    [tasksQuery.data],
  )

  const activeTaskCount = useMemo(
    () => (tasksQuery.data ?? []).filter((t) => ACTIVE_STATUSES.has(t.status)).length,
    [tasksQuery.data],
  )

  const pendingAlerts = useMemo(
    () => (alertsQuery.data ?? []).filter((a) => a.status === 'pending'),
    [alertsQuery.data],
  )

  const recentMessages = useMemo(
    () => [...(messagesQuery.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4),
    [messagesQuery.data],
  )
  const unreadCount = useMemo(
    () => (messagesQuery.data ?? []).filter((m) => !m.read).length,
    [messagesQuery.data],
  )

  return (
    <Row gutter={[16, 16]}>
      {/* ---- 概览统计 ---- */}
      <Col span={24}>
        <StatsCards
          activeTaskCount={activeTaskCount}
          pendingAlertCount={pendingAlerts.length}
          subscription={subsQuery.data ?? null}
          subsLoading={subsQuery.isLoading}
          subsError={subsQuery.isError}
          onRetrySubscription={() => void subsQuery.refetch()}
        />
      </Col>

      {/* ---- 左列：任务状态卡片流 ---- */}
      <Col xs={24} lg={14}>
        <Card
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>监测任务状态</span>
              {tasksQuery.isFetching && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  刷新中…
                </Typography.Text>
              )}
            </div>
          }
          extra={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void tasksQuery.refetch()}
            >
              刷新
            </Button>
          }
        >
          {tasksQuery.isLoading ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <Skeleton active paragraph={{ rows: 1 }} />
              <Skeleton active paragraph={{ rows: 1 }} />
              <Skeleton active paragraph={{ rows: 1 }} />
            </div>
          ) : tasksQuery.isError ? (
            <Alert
              type="error"
              showIcon
              message="任务列表加载失败"
              description="服务暂不可达或请求超时，请稍后重试。"
              action={
                <Button size="small" danger onClick={() => void tasksQuery.refetch()}>
                  重试
                </Button>
              }
            />
          ) : sortedTasks.length === 0 ? (
            <Empty description="暂无监测任务">
              <Button type="primary" onClick={() => navigate('/tasks/create')}>
                创建第一个监测任务
              </Button>
            </Empty>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {sortedTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  canCancel={canWrite && cancelMutation.isPending}
                  onCancel={() => cancelMutation.mutate(task.id)}
                  onOpenResults={() => navigate(`/tasks/${task.id}/results`)}
                />
              ))}
            </div>
          )}
        </Card>
      </Col>

      {/* ---- 右列：小地图 + 待处理告警 + 最新消息 ---- */}
      <Col xs={24} lg={10}>
        <div style={{ display: 'grid', gap: 16 }}>
          <MiniMap />

          <Card
            title="告警待处理"
            extra={
              pendingAlerts.length > 0 ? (
                <Typography.Text type="warning" strong>
                  {pendingAlerts.length} 条待处置
                </Typography.Text>
              ) : null
            }
          >
            {alertsQuery.isLoading ? (
              <Skeleton active paragraph={{ rows: 2 }} />
            ) : alertsQuery.isError ? (
              <Alert
                type="error"
                showIcon
                message="告警加载失败"
                action={
                  <Button size="small" danger onClick={() => void alertsQuery.refetch()}>
                    重试
                  </Button>
                }
              />
            ) : pendingAlerts.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待处理告警" />
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {pendingAlerts.slice(0, 4).map((a) => (
                  <div
                    key={a.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <Typography.Text strong style={{ fontSize: 13 }}>
                        {a.changeType}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                        {a.areaKm2.toFixed(2)} km² · {formatDateTime(a.createdAt)}
                      </Typography.Text>
                    </div>
                    <Button size="small" onClick={() => navigate(`/tasks/${a.taskId}/results`)}>
                      查看
                    </Button>
                  </div>
                ))}
                {pendingAlerts.length > 4 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    其余 {pendingAlerts.length - 4} 条请在结果页处置
                  </Typography.Text>
                )}
              </div>
            )}
          </Card>

          <Card
            title="最新消息"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                未读 {unreadCount} 条（顶栏铃铛同步）
              </Typography.Text>
            }
          >
            {messagesQuery.isLoading ? (
              <Skeleton active paragraph={{ rows: 2 }} />
            ) : messagesQuery.isError ? (
              <Alert type="error" showIcon message="消息加载失败" />
            ) : recentMessages.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" />
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {recentMessages.map((m) => (
                  <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        flex: '0 0 auto',
                        alignSelf: 'center',
                        background: m.read ? 'transparent' : '#1677ff',
                      }}
                    />
                    <Typography.Text strong={!m.read} style={{ fontSize: 13 }} ellipsis>
                      {m.title}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12, flex: '0 0 auto' }}>
                      {formatDateTime(m.createdAt)}
                    </Typography.Text>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </Col>
    </Row>
  )
}
