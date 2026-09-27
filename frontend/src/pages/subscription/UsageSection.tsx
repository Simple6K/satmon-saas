/**
 * 配额用量区（US-01 验收 4 / US-12.1）：AOI 面积 / 并发任务 / 成员席位三项 Progress。
 * 任一项使用率 ≥ 80% 显示预警标识（PRD US-12.1）。
 * 席位用量 = 成员数 / 当前套餐 seats（契约 §2 usage 不含席位，前端由两接口数据派生）。
 */
import { Alert, Button, Card, Progress, Skeleton, Tag, Typography } from 'antd'
import { WarningOutlined } from '@ant-design/icons'
import type { Plan, Subscription } from '../../api/types'

interface UsageSectionProps {
  subscription: Subscription | null
  loading: boolean
  error: boolean
  onRetry: () => void
  currentPlan: Plan | null
  /** 本租户成员数（成员接口失败时为 null，席位项显示为不可用而非报错） */
  memberCount: number | null
}

/** 使用率 ≥ 80% 判预警（PRD US-12.1） */
const WARN_THRESHOLD = 0.8

function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.min(100, (used / limit) * 100)
}

function isWarning(used: number, limit: number): boolean {
  return limit > 0 && used / limit >= WARN_THRESHOLD
}

function WarnTag(): React.ReactElement {
  return (
    <Tag color="red" icon={<WarningOutlined />} style={{ marginLeft: 8 }}>
      预警 ≥80%
    </Tag>
  )
}

function strokeColor(warn: boolean): string | undefined {
  return warn ? '#faad14' : undefined
}

export default function UsageSection({ subscription, loading, error, onRetry, currentPlan, memberCount }: UsageSectionProps) {
  if (loading) {
    return (
      <Card title="配额用量">
        <div style={{ display: 'grid', gap: 16 }}>
          <Skeleton active paragraph={{ rows: 1 }} />
          <Skeleton active paragraph={{ rows: 1 }} />
          <Skeleton active paragraph={{ rows: 1 }} />
        </div>
      </Card>
    )
  }

  if (error || !subscription) {
    return (
      <Card title="配额用量">
        <Alert
          type="error"
          showIcon
          message="配额用量加载失败"
          description="无法获取当前订阅与用量（服务不可达或超时），创建任务前的配额校验仍由服务端兜底。"
          action={
            <Button size="small" danger onClick={onRetry}>
              重试
            </Button>
          }
        />
      </Card>
    )
  }

  const u = subscription.usage
  const areaWarn = isWarning(u.aoiAreaKm2, u.aoiAreaLimitKm2)
  const concurrentWarn = isWarning(u.concurrentTasks, u.concurrentLimit)
  const seatsWarn =
    currentPlan != null && memberCount != null ? isWarning(memberCount, currentPlan.seats) : false

  return (
    <Card
      title="配额用量"
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          面积达限时新建任务将被阻断并提示升级（US-01）
        </Typography.Text>
      }
    >
      <div style={{ display: 'grid', gap: 20 }}>
        <div>
          <Typography.Text>
            AOI 监测面积{areaWarn && <WarnTag />}
          </Typography.Text>
          <Progress
            percent={Math.round(usagePercent(u.aoiAreaKm2, u.aoiAreaLimitKm2) * 10) / 10}
            strokeColor={strokeColor(areaWarn)}
            format={() => `${u.aoiAreaKm2.toLocaleString(undefined, { maximumFractionDigits: 1 })} / ${u.aoiAreaLimitKm2.toLocaleString()} km²`}
          />
        </div>
        <div>
          <Typography.Text>
            并发监测任务{concurrentWarn && <WarnTag />}
          </Typography.Text>
          <Progress
            percent={Math.round(usagePercent(u.concurrentTasks, u.concurrentLimit))}
            strokeColor={strokeColor(concurrentWarn)}
            format={() => `${u.concurrentTasks} / ${u.concurrentLimit}`}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            另有累计活跃任务（含已完成）{u.activeTaskCount} 个，不占用并发额度
          </Typography.Text>
        </div>
        <div>
          <Typography.Text>
            成员席位{seatsWarn && <WarnTag />}
          </Typography.Text>
          {currentPlan == null || memberCount == null ? (
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
              套餐或成员数据暂不可用，席位用量无法计算
            </Typography.Text>
          ) : (
            <Progress
              percent={Math.round(usagePercent(memberCount, currentPlan.seats))}
              strokeColor={strokeColor(seatsWarn)}
              format={() => `${memberCount} / ${currentPlan.seats}`}
            />
          )}
        </div>
      </div>
    </Card>
  )
}
