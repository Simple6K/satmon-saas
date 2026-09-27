/**
 * 订阅管理页（路由 /subscription，US-01/02/11/12）：
 * - 套餐三档卡片（当前档高亮）+ 对比表 + 变更套餐 Modal（PlanSection）
 * - 配额用量 Progress：AOI 面积 / 并发任务 / 成员席位，≥80% 预警（UsageSection）
 * - 成员管理表 + 邀请成员（tenant_admin 专属，MembersSection）
 * - 隔离验证一键自检：本租户清单 + 直连跨租户 ID 断言 404（IsolationCheckSection，US-11.5）
 * - 审计日志只读表：仅 tenant_admin 可见，其余角色拦截提示（AuditLogsSection，US-12.3）
 * 所有数据经 apiFetch + 契约 zod 校验；各区块独立覆盖加载/错误/重试/空态（工程原则 5）。
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Col, Row } from 'antd'
import { apiFetch } from '../../api/client'
import { AuditLogSchema, MemberSchema, PlanSchema, SubscriptionSchema } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import PlanSection from './PlanSection'
import UsageSection from './UsageSection'
import MembersSection from './MembersSection'
import IsolationCheckSection from './IsolationCheckSection'
import AuditLogsSection from './AuditLogsSection'

export default function SubscriptionPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'tenant_admin'

  // ---- 数据获取（契约 §2） ----

  const plansQuery = useQuery({
    queryKey: ['plans'],
    queryFn: async () => PlanSchema.array().parse(await apiFetch<unknown>('/api/plans')),
  })

  // 与工作台共享同一缓存 key（['subscription']），套餐变更后两处同步刷新
  const subsQuery = useQuery({
    queryKey: ['subscription'],
    queryFn: async () => SubscriptionSchema.parse(await apiFetch<unknown>('/api/subscription')),
  })

  const membersQuery = useQuery({
    queryKey: ['members'],
    queryFn: async () => MemberSchema.array().parse(await apiFetch<unknown>('/api/subscription/members')),
  })

  // 审计日志仅租户管理员可见（US-12.3）：非管理员不发起请求，页面层拦截
  const auditQuery = useQuery({
    queryKey: ['audit-logs'],
    queryFn: async () => AuditLogSchema.array().parse(await apiFetch<unknown>('/api/audit-logs?limit=50')),
    enabled: isAdmin,
  })

  const currentPlan = useMemo(() => {
    if (!plansQuery.data || !subsQuery.data) return null
    return plansQuery.data.find((p) => p.id === subsQuery.data.planId) ?? null
  }, [plansQuery.data, subsQuery.data])

  return (
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <PlanSection
          plans={plansQuery.data ?? []}
          loading={plansQuery.isLoading}
          error={plansQuery.isError}
          onRetry={() => void plansQuery.refetch()}
          subscription={subsQuery.data ?? null}
          subscriptionLoading={subsQuery.isLoading}
        />
      </Col>

      <Col xs={24} lg={12}>
        <UsageSection
          subscription={subsQuery.data ?? null}
          loading={subsQuery.isLoading}
          error={subsQuery.isError}
          onRetry={() => void subsQuery.refetch()}
          currentPlan={currentPlan}
          memberCount={membersQuery.isError ? null : membersQuery.data?.length ?? null}
        />
      </Col>

      <Col xs={24} lg={12}>
        <MembersSection
          members={membersQuery.data ?? []}
          loading={membersQuery.isLoading}
          error={membersQuery.isError}
          onRetry={() => void membersQuery.refetch()}
        />
      </Col>

      <Col span={24}>
        <IsolationCheckSection />
      </Col>

      <Col span={24}>
        {isAdmin ? (
          <AuditLogsSection
            logs={auditQuery.data ?? []}
            loading={auditQuery.isLoading}
            error={auditQuery.isError}
            onRetry={() => void auditQuery.refetch()}
            tenantName={user?.tenantName ?? '本组织'}
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            message="审计日志仅租户管理员可见"
            description="当前角色为只读或分析师角色，无权查看本组织操作审计记录（US-12 权限区分）。如需审计能力，请联系组织租户管理员。"
          />
        )}
      </Col>
    </Row>
  )
}
