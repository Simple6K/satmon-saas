/**
 * 隔离验证一键自检（US-11.5，PRD 核心卖点的演示面板）：
 * 1) 拉取本租户任务清单，展示当前租户数据边界（切换账号后清单应完全不同）；
 * 2) 用当前 token 直连一个「非本租户资源 ID」（默认种子 task-b-1，可改），
 *    断言返回 404 而非 403——不泄露资源存在性（契约 §0 租户隔离）；
 * 3) 引导操作者用顶栏切换到另一租户账号回到本页对比清单（人工核验步骤）。
 * 结果以 通过/失败/提示 清单展示，可直接用于合规演示。
 * 注意：404 校验失败（即拿到了数据）才是「失败」；网络/超时等异常标记为「未完成」，如实呈现、不吞错。
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Card,
  Input,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd'
import { CheckCircleFilled, CloseCircleFilled, InfoCircleFilled, SafetyCertificateOutlined } from '@ant-design/icons'
import { ApiError, apiFetch } from '../../api/client'
import { TaskSummarySchema } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'

type CheckStatus = 'pass' | 'fail' | 'info'

interface CheckResult {
  key: string
  status: CheckStatus
  label: string
  detail: string
}

const STATUS_META: Record<CheckStatus, { icon: React.ReactNode; color: string; text: string }> = {
  pass: { icon: <CheckCircleFilled style={{ color: '#52c41a' }} />, color: 'green', text: '通过' },
  fail: { icon: <CloseCircleFilled style={{ color: '#ff4d4f' }} />, color: 'red', text: '失败' },
  info: { icon: <InfoCircleFilled style={{ color: '#1677ff' }} />, color: 'blue', text: '提示' },
}

/** 另一演示租户（沙特 MEWA·利雅得）的种子任务 ID；契约 §7 保证其存在且不属本租户（迪拜侧登录时） */
const DEFAULT_CROSS_TENANT_TASK_ID = 'task-b-1'

export default function IsolationCheckSection() {
  const { user } = useAuth()
  const [crossTaskId, setCrossTaskId] = useState(DEFAULT_CROSS_TENANT_TASK_ID)
  const [results, setResults] = useState<CheckResult[]>([])

  const runCheckMutation = useMutation({
    mutationFn: async (crossId: string): Promise<CheckResult[]> => {
      const next: CheckResult[] = []

      // 检查 1：本租户任务清单（隔离边界内的数据全集）
      let tasks
      try {
        tasks = TaskSummarySchema.array().parse(await apiFetch<unknown>('/api/tasks'))
      } catch (e) {
        // 网络层失败（ApiError 已 toast）——如实标记未完成，不吞错
        next.push({
          key: 'own-list',
          status: 'fail',
          label: '拉取本租户任务清单',
          detail: `请求失败：${e instanceof ApiError ? e.message : '响应不符合契约'}，无法验证数据边界`,
        })
        return next
      }
      next.push({
        key: 'own-list',
        status: 'pass',
        label: `拉取本租户任务清单（${user?.tenantName ?? '当前组织'}）`,
        detail:
          `共 ${tasks.length} 个任务：` +
          (tasks.length > 0
            ? tasks.slice(0, 3).map((t) => `「${t.name}」`).join('、') + (tasks.length > 3 ? ' 等' : '')
            : '（空）') +
          '；所有记录均由服务端按 token 中的 tenantId 过滤',
      })

      // 检查 2：直连非本租户资源 ID，断言 404（不泄露存在性）
      const trimmedId = crossId.trim()
      if (!trimmedId) {
        next.push({
          key: 'cross-404',
          status: 'fail',
          label: '直连非本租户资源 ID',
          detail: '未填写资源 ID，无法执行该检查',
        })
      } else {
        let gotData = false
        let err: unknown = null
        try {
          // apiFetch 仅在 HTTP 2xx 且 code=0 时返回；404 会抛 ApiError
          await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(trimmedId)}`)
          gotData = true
        } catch (e) {
          err = e
        }
        if (gotData) {
          next.push({
            key: 'cross-404',
            status: 'fail',
            label: `直连非本租户资源 ID（${trimmedId}）`,
            detail: '警告：请求返回了数据，存在跨租户泄露！请立即上报',
          })
        } else if (err instanceof ApiError && err.status === 404) {
          next.push({
            key: 'cross-404',
            status: 'pass',
            label: `直连非本租户资源 ID（${trimmedId}）`,
            detail: '返回 404「资源不存在」——平台以 404 而非 403 拒绝跨租户访问，不泄露资源存在性（契约 §0 / US-11）',
          })
        } else {
          next.push({
            key: 'cross-404',
            status: 'fail',
            label: `直连非本租户资源 ID（${trimmedId}）`,
            detail: `请求异常（${err instanceof ApiError ? err.message : '未知错误'}），本次验证未完成，请重试`,
          })
        }
      }

      // 检查 3：人工核验引导（无法自动完成，作为提示项）
      next.push({
        key: 'switch-account',
        status: 'info',
        label: '切换租户账号对比数据清单',
        detail:
          '请用页面顶栏「租户标识」切换到另一组织账号（如 沙特 MEWA · 利雅得），回到本页重新执行自检：任务清单应完全变为对方组织的数据，双方互不可见',
      })
      return next
    },
    onSuccess: (next) => {
      setResults(next)
      const failed = next.filter((r) => r.status === 'fail').length
      if (failed === 0) message.success('隔离自检完成：自动检查项全部通过')
      else message.warning(`隔离自检完成：${failed} 项未通过，请查看清单`)
    },
  })

  return (
    <Card
      title={
        <Space size={8}>
          <SafetyCertificateOutlined />
          <span>隔离验证（一键自检）</span>
          <Tag color="purple">合规演示入口 · US-11</Tag>
        </Space>
      }
      extra={
        <Button
          type="primary"
          loading={runCheckMutation.isPending}
          onClick={() => runCheckMutation.mutate(crossTaskId)}
        >
          执行自检
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="多租户数据隔离：本组织数据对其他组织不可见、不可猜测"
        description={
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            所有业务对象（任务、AOI、结果、报告、告警、通知）以组织（租户）为强制隔离边界，
            服务端按请求 token 中的 tenantId 过滤；跨组织请求返回 404「资源不存在」而非 403
            「无权限」——即使攻击者猜测到对方资源 ID，也无法判断其是否存在。
          </Typography.Text>
        }
      />
      <Space.Compact style={{ maxWidth: 480, marginBottom: 16, display: 'flex' }}>
        <Typography.Text type="secondary" style={{ alignSelf: 'center', flex: '0 0 auto', fontSize: 13 }}>
          对方组织任务 ID：
        </Typography.Text>
        <Input
          value={crossTaskId}
          onChange={(e) => setCrossTaskId(e.target.value)}
          placeholder="填入另一组织的任务 ID（默认种子 task-b-1）"
          maxLength={40}
          status={crossTaskId.trim() === '' ? 'error' : undefined}
        />
      </Space.Compact>

      {runCheckMutation.isPending ? (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin>
            <div style={{ padding: '12px 32px' }}>
              <Typography.Text type="secondary">正在执行隔离自检…</Typography.Text>
            </div>
          </Spin>
        </div>
      ) : results.length === 0 ? (
        <Typography.Text type="secondary">
          尚未执行自检。点击右上角「执行自检」，将自动拉取本租户任务清单并直连上方非本租户资源 ID 验证 404 隔离。
        </Typography.Text>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {results.map((item) => {
            const meta = STATUS_META[item.status]
            return (
              <div key={item.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 16, lineHeight: '22px' }}>{meta.icon}</span>
                <div>
                  <div>
                    {item.label} <Tag color={meta.color}>{meta.text}</Tag>
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {item.detail}
                  </Typography.Text>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
