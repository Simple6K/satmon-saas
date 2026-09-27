/**
 * 套餐区（US-01/02）：三档套餐卡片（当前档高亮）+ 横向对比表 + 变更套餐 Modal。
 * 三维分档：监测面积 × 监测类型 × 重访频率；席位/并发为附属属性；
 * 每档标注数据源能力说明（对齐 PRD US-01「能力可溯源至具名公开数据源」）。
 * 变更走 PUT /api/subscription/plan，成功后刷新订阅与审计缓存（契约 §2）。
 */
import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Card, Col, Modal, Row, Skeleton, Table, Tag, Tooltip, Typography, message } from 'antd'
import { CheckCircleFilled } from '@ant-design/icons'
import { apiFetch } from '../../api/client'
import { SubscriptionSchema, type Plan, type Subscription } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { formatLocal } from './format'

/** 契约 §2 三档重访语义的中文标签（后端 revisit 原值兜底展示） */
const REVISIT_LABELS: Record<string, string> = {
  monthly: '月度重访',
  'monthly+quarterly_rush': '月度 + 每季度 1 次加急复核',
  biweekly: '双周重访',
}

const revisitLabel = (p: Plan): string => REVISIT_LABELS[p.revisit] ?? p.revisit

interface PlanSectionProps {
  plans: Plan[]
  loading: boolean
  error: boolean
  onRetry: () => void
  /** 当前订阅（失败时为 null：卡片不高亮、禁用变更） */
  subscription: Subscription | null
  subscriptionLoading: boolean
}

export default function PlanSection({
  plans,
  loading,
  error,
  onRetry,
  subscription,
  subscriptionLoading,
}: PlanSectionProps) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  // 契约 §0：写操作要求 analyst 或 tenant_admin；approver 只读
  const canWrite = user?.role === 'analyst' || user?.role === 'tenant_admin'

  const [targetPlan, setTargetPlan] = useState<Plan | null>(null)

  const changePlanMutation = useMutation({
    mutationFn: async (planId: Plan['id']) =>
      SubscriptionSchema.parse(
        await apiFetch<unknown>('/api/subscription/plan', {
          method: 'PUT',
          body: JSON.stringify({ planId }),
        }),
      ),
    onSuccess: (sub) => {
      message.success(`套餐已变更为「${sub.planId}」，配额已按新套餐刷新`)
      setTargetPlan(null)
      // 订阅用量与审计日志（契约：变更写审计）同时失效重建
      void queryClient.invalidateQueries({ queryKey: ['subscription'] })
      void queryClient.invalidateQueries({ queryKey: ['audit-logs'] })
    },
    // 失败提示由 apiFetch 统一 toast（含 400/404 的后端 msg），这里只负责关闭确认框
    onError: () => setTargetPlan(null),
  })

  const plansById = useMemo(() => new Map(plans.map((p) => [p.id, p])), [plans])
  const currentPlanId = subscription ? subscription.planId : null
  const currentPlan = currentPlanId ? plansById.get(currentPlanId) ?? null : null

  if (loading) {
    return (
      <Card title="订阅套餐">
        <Row gutter={[16, 16]}>
          {[0, 1, 2].map((i) => (
            <Col key={i} xs={24} md={8}>
              <Skeleton active paragraph={{ rows: 4 }} />
            </Col>
          ))}
        </Row>
      </Card>
    )
  }

  if (error) {
    return (
      <Card title="订阅套餐">
        <Alert
          type="error"
          showIcon
          message="套餐目录加载失败"
          description="服务暂不可达或请求超时，无法展示套餐分档，请稍后重试。"
          action={
            <Button size="small" danger onClick={onRetry}>
              重试
            </Button>
          }
        />
      </Card>
    )
  }

  return (
    <Card
      title="订阅套餐"
      extra={
        subscription ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            状态 {subscription.status === 'active' ? '生效中' : subscription.status} · 续订日{' '}
            {formatLocal(subscription.renewalAt)}
          </Typography.Text>
        ) : null
      }
    >
      <Row gutter={[16, 16]}>
        {plans.map((plan) => {
          const isCurrent = plan.id === currentPlanId
          return (
            <Col key={plan.id} xs={24} md={8}>
              <Card
                size="small"
                style={{
                  height: '100%',
                  borderColor: isCurrent ? '#1677ff' : undefined,
                  borderWidth: isCurrent ? 2 : 1,
                }}
                styles={{ body: { display: 'flex', flexDirection: 'column', gap: 8 } }}
                title={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    {plan.name}
                    {subscriptionLoading ? (
                      <Skeleton.Button active size="small" style={{ width: 64, height: 18 }} />
                    ) : isCurrent ? (
                      <Tag color="blue">当前套餐</Tag>
                    ) : null}
                  </span>
                }
                extra={
                  <Tooltip
                    title={
                      !canWrite
                        ? '审批人为只读角色，无法变更套餐（US-02 角色区分）'
                        : isCurrent
                          ? '已是当前套餐'
                          : undefined
                    }
                  >
                    <Button
                      size="small"
                      type={isCurrent ? 'default' : 'primary'}
                      disabled={!canWrite || isCurrent}
                      onClick={() => setTargetPlan(plan)}
                    >
                      {isCurrent ? '使用中' : '变更为此套餐'}
                    </Button>
                  </Tooltip>
                }
              >
                <Typography.Text strong>
                  监测面积 ≤ {plan.areaLimitKm2.toLocaleString()} km²
                </Typography.Text>
                <Typography.Text>
                  {plan.monitorTypes ?? `可选 ${plan.monitorTypeCount} 类监测类型`}
                </Typography.Text>
                <Typography.Text>重访频率：{revisitLabel(plan)}</Typography.Text>
                <Typography.Text type="secondary">
                  附属配额：席位 {plan.seats} 个 · 并发任务 {plan.maxConcurrentTasks} 个
                </Typography.Text>
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginBottom: 0, fontSize: 12 }}
                  ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}
                >
                  {plan.dataSourceNote ?? '—'}
                </Typography.Paragraph>
              </Card>
            </Col>
          )
        })}
      </Row>

      {/* ---- 三档横向对比表（US-01：三维分档一目了然） ---- */}
      <Typography.Title level={5} style={{ marginTop: 24, marginBottom: 8 }}>
        套餐对比
      </Typography.Title>
      <PlanCompareTable plans={plans} currentPlanId={currentPlanId} />

      {/* ---- 变更确认 Modal（US-02：变更后配额立即刷新、已有任务不受影响） ---- */}
      <Modal
        title="变更套餐确认"
        open={targetPlan !== null}
        confirmLoading={changePlanMutation.isPending}
        okText="确认变更"
        cancelText="取消"
        okButtonProps={{ disabled: !canWrite }}
        onOk={() => targetPlan && changePlanMutation.mutate(targetPlan.id)}
        onCancel={() => setTargetPlan(null)}
      >
        {targetPlan && (
          <div style={{ display: 'grid', gap: 8 }}>
            <Typography.Text>
              即将把组织套餐由「{currentPlan?.name ?? '未知'}」变更为
              <Typography.Text strong>「{targetPlan.name}」</Typography.Text>。
            </Typography.Text>
            {currentPlan && (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                配额变化：面积上限 {currentPlan.areaLimitKm2.toLocaleString()} →{' '}
                {targetPlan.areaLimitKm2.toLocaleString()} km²；并发任务 {currentPlan.maxConcurrentTasks} →{' '}
                {targetPlan.maxConcurrentTasks}；席位 {currentPlan.seats} → {targetPlan.seats}
              </Typography.Text>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              变更立即生效，已有监测任务不受影响；本次操作将写入审计日志。
            </Typography.Text>
          </div>
        )}
      </Modal>
    </Card>
  )
}

/** 对比表：行 = 维度，列 = 三档套餐，当前档列头打标（独立小组件，避免主组件过长） */
function PlanCompareTable({ plans, currentPlanId }: { plans: Plan[]; currentPlanId: Plan['id'] | null }) {
  interface CompareRow {
    key: string
    dim: string
    render: (p: Plan) => string
  }
  const rows: CompareRow[] = [
    { key: 'area', dim: '监测面积上限', render: (p) => `≤ ${p.areaLimitKm2.toLocaleString()} km²` },
    { key: 'types', dim: '监测类型', render: (p) => p.monitorTypes ?? `可选 ${p.monitorTypeCount} 类` },
    { key: 'revisit', dim: '重访频率', render: (p) => revisitLabel(p) },
    { key: 'seats', dim: '成员席位', render: (p) => `${p.seats} 个` },
    { key: 'concurrent', dim: '并发任务', render: (p) => `${p.maxConcurrentTasks} 个` },
    { key: 'source', dim: '数据源能力', render: (p) => p.dataSourceNote ?? '—' },
  ]
  return (
    <Table
      size="small"
      pagination={false}
      dataSource={rows}
      rowKey="key"
      columns={[
        { title: '维度', dataIndex: 'dim', width: 120 },
        ...plans.map((p) => ({
          title: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {p.id === currentPlanId && <CheckCircleFilled style={{ color: '#1677ff' }} />}
              {p.name}
              {p.id === currentPlanId && <Tag color="blue">当前</Tag>}
            </span>
          ),
          dataIndex: p.id,
          render: (_: unknown, row: CompareRow) => row.render(p),
        })),
      ]}
    />
  )
}
