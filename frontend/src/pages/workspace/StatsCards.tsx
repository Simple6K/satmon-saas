/**
 * 概览统计卡片（US-01/US-12 配额用量的工作台侧入口）：
 * - 活跃任务数、告警待处理数（Statistic）
 * - AOI 面积与并发任务配额 Progress（订阅接口 usage；用量 ≥90% 转警示色）
 * 订阅接口失败时配额区展示错误态与重试，不阻断前两张统计卡。
 */
import { Alert, Button, Card, Col, Progress, Row, Skeleton, Statistic, Typography } from 'antd'
import { AlertOutlined, CloudUploadOutlined, HddOutlined } from '@ant-design/icons'
import type { Subscription } from '../../api/types'

interface StatsCardsProps {
  /** 由任务列表实时计算的进行中任务数（US-06） */
  activeTaskCount: number
  /** 待处理告警数（US-10） */
  pendingAlertCount: number
  subscription: Subscription | null
  subsLoading: boolean
  subsError: boolean
  onRetrySubscription: () => void
}

function quotaColor(percent: number): string | undefined {
  if (percent >= 100) return '#ff4d4f'
  if (percent >= 90) return '#faad14'
  return undefined
}

export default function StatsCards({
  activeTaskCount,
  pendingAlertCount,
  subscription,
  subsLoading,
  subsError,
  onRetrySubscription,
}: StatsCardsProps) {
  const usage = subscription?.usage ?? null

  return (
    <Row gutter={[16, 16]}>
      <Col xs={12} md={6}>
        <Card>
          <Statistic
            title="活跃任务"
            value={activeTaskCount}
            prefix={<CloudUploadOutlined />}
            valueStyle={{ color: activeTaskCount > 0 ? '#1677ff' : undefined }}
            suffix={
              usage ? (
                <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                  {' '}/ 并发上限 {usage.concurrentLimit}
                </Typography.Text>
              ) : null
            }
          />
        </Card>
      </Col>
      <Col xs={12} md={6}>
        <Card>
          <Statistic
            title="告警待处理"
            value={pendingAlertCount}
            prefix={<AlertOutlined />}
            valueStyle={{ color: pendingAlertCount > 0 ? '#faad14' : undefined }}
            suffix="条"
          />
        </Card>
      </Col>
      <Col xs={24} md={12}>
        <Card title="配额用量">
          {subsLoading ? (
            <Skeleton active paragraph={{ rows: 1 }} />
          ) : subsError ? (
            <Alert
              type="error"
              showIcon
              message="订阅配额加载失败"
              action={
                <Button size="small" danger onClick={onRetrySubscription}>
                  重试
                </Button>
              }
            />
          ) : usage ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <Typography.Text style={{ fontSize: 13 }}>
                  <HddOutlined /> AOI 监测面积
                  <Typography.Text type="secondary">（{usage.aoiAreaKm2.toFixed(0)} / {usage.aoiAreaLimitKm2.toFixed(0)} km²）</Typography.Text>
                </Typography.Text>
                <Progress
                  percent={Math.min(100, (usage.aoiAreaKm2 / usage.aoiAreaLimitKm2) * 100)}
                  format={(p) => `${Math.round(p ?? 0)}%`}
                  status={usage.aoiAreaKm2 / usage.aoiAreaLimitKm2 >= 1 ? 'exception' : 'normal'}
                  strokeColor={quotaColor((usage.aoiAreaKm2 / usage.aoiAreaLimitKm2) * 100)}
                />
              </div>
              <div>
                <Typography.Text style={{ fontSize: 13 }}>
                  <CloudUploadOutlined /> 并发任务
                  <Typography.Text type="secondary">（{usage.concurrentTasks} / {usage.concurrentLimit}）</Typography.Text>
                </Typography.Text>
                <Progress
                  percent={Math.min(100, (usage.concurrentTasks / usage.concurrentLimit) * 100)}
                  format={(p) => `${Math.round(p ?? 0)}%`}
                  status={usage.concurrentTasks / usage.concurrentLimit >= 1 ? 'exception' : 'normal'}
                  strokeColor={quotaColor((usage.concurrentTasks / usage.concurrentLimit) * 100)}
                  size="small"
                />
              </div>
              {subscription && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  当前套餐 {subscription.planId.toUpperCase()} · 续订日{' '}
                  {subscription.renewalAt.slice(0, 10)}
                </Typography.Text>
              )}
            </div>
          ) : null}
        </Card>
      </Col>
    </Row>
  )
}
