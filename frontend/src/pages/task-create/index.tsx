/**
 * 监测任务创建页（/tasks/create）—— 三步向导：AOI → 监测类型与时间窗 → 摘要确认。
 *
 * 角色门槛：写操作要求 analyst / tenant_admin（契约 §0），approver 只读，
 * 进入本页即呈现 403 说明而非隐藏入口（体现权限差异）。
 *
 * 创建链路（对齐契约 §3/§4）：
 *   新建 AOI → POST /api/aois（服务端 shapely 校验 + 面积配额）
 *   → POST /api/tasks（并发/面积配额，超限 400 带 usage）
 *   → 自动 POST /api/tasks/{id}/estimate 检索预演（三级降级，见 EstimatePanel）
 *
 * 必填项缺失时「下一步」阻断并逐项高亮（US-03 验收）；配额超限阻断提交并显示用量。
 */
import { useState } from 'react'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Result, Steps, Typography, message } from 'antd'
import { z } from 'zod'
import { apiFetch } from '../../api/client'
import { AoiSchema, SubscriptionSchema } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import AoiStep from './AoiStep'
import ParamsStep from './ParamsStep'
import SummaryStep from './SummaryStep'
import type { AoiSelection, CreatedTask, TaskParams } from './types'

/** POST /api/tasks 响应中本页关心的最小字段（zod 默认剥离去多余字段，不锁定详情全貌） */
const CreatedTaskSchema = z.object({ id: z.string(), status: z.string() })

const STEP_ITEMS = [
  { title: '圈定监测区域', description: '绘制 / 上传 / AOI 库' },
  { title: '类型与时间窗', description: '四选一 · 云量过滤' },
  { title: '确认并创建', description: '配额校验 · 检索预演' },
]

function defaultParams(): TaskParams {
  // 默认时间窗：近 90 天（US-05 示例），云量 ≤ 20%（US-03 默认门槛）
  return {
    name: '',
    monitorType: 'urban_expansion', // PRD US-03 默认「城市扩张」
    startDate: dayjs().subtract(90, 'day').format('YYYY-MM-DD'),
    endDate: dayjs().format('YYYY-MM-DD'),
    cloudMaxPct: 20,
  }
}

export default function TaskCreatePage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [current, setCurrent] = useState(0)
  const [aoi, setAoi] = useState<AoiSelection | null>(null)
  const [params, setParams] = useState<TaskParams>(defaultParams)
  const [showErrors, setShowErrors] = useState(false)
  const [createdTask, setCreatedTask] = useState<CreatedTask | null>(null)

  // 订阅用量：AOI 面积与并发配额预检的数据来源
  const subscriptionQuery = useQuery({
    queryKey: ['subscription'],
    queryFn: async () => SubscriptionSchema.parse(await apiFetch<unknown>('/api/subscription')),
  })

  const createMutation = useMutation({
    mutationFn: async (): Promise<CreatedTask> => {
      if (!aoi) throw new Error('尚未选择监测区域')
      if (!params.monitorType) throw new Error('尚未选择监测类型')
      let aoiId = aoi.aoiId
      if (!aoiId) {
        // 新建 AOI 落库（服务端校验几何与剩余额度；400 的 msg 已含具体数值）
        const created = AoiSchema.parse(
          await apiFetch<unknown>('/api/aois', {
            method: 'POST',
            body: JSON.stringify({
              name: aoi.name.trim(),
              monitorType: params.monitorType,
              geojson: aoi.geometry,
            }),
          }),
        )
        aoiId = created.id
      }
      return CreatedTaskSchema.parse(
        await apiFetch<unknown>('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            name: params.name.trim(),
            aoiId,
            monitorType: params.monitorType,
            startDate: params.startDate,
            endDate: params.endDate,
            cloudMaxPct: params.cloudMaxPct,
          }),
        }),
      )
    },
    onSuccess: (task) => {
      setCreatedTask(task)
      message.success(`任务「${params.name}」创建成功，已排队等待调度`)
      // 任务/AOI/订阅用量/消息等缓存全部失效重建（AOI 落库与任务创建都会改变这些视图）
      void queryClient.invalidateQueries()
    },
  })

  // approver 只读（契约 §0）：明确告知无权创建，而不是空白页面
  if (user?.role === 'approver') {
    return (
      <Card>
        <Result
          status="403"
          title="审批人（只读）账号无权创建任务"
          subTitle="写操作（新建 AOI / 创建任务）需要分析师或租户管理员角色。可在顶栏切换种子账号（如 Ahmed · 分析师）体验完整流程。"
          extra={
            <Button type="primary" onClick={() => window.history.back()}>
              返回
            </Button>
          }
        />
      </Card>
    )
  }

  // 各步通过条件（未通过则「下一步」禁用；点击后置 showErrors 逐项高亮）
  const step0Ok = aoi !== null && (aoi.source === 'library' || aoi.name.trim().length > 0)
  const step1Ok =
    params.name.trim().length > 0 &&
    params.monitorType !== '' &&
    params.startDate !== '' &&
    params.endDate !== '' &&
    params.startDate < params.endDate

  function stepOk(idx: number): boolean {
    if (idx === 0) return step0Ok
    if (idx === 1) return step1Ok
    return true
  }

  function handleNext() {
    if (!stepOk(current)) {
      setShowErrors(true)
      message.warning('请先补全当前步骤的必填项')
      return
    }
    setShowErrors(false)
    setCurrent((c) => Math.min(c + 1, 2))
  }

  return (
    <Card
      title={<Typography.Title level={4} style={{ margin: 0 }}>创建监测任务</Typography.Title>}
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          一次配置，周期自动执行（US-03）
        </Typography.Text>
      }
    >
      <Steps size="small" current={current} items={STEP_ITEMS} />
      <div style={{ marginTop: 28 }}>
        {current === 0 && (
          <AoiStep
            selection={aoi}
            usage={subscriptionQuery.data?.usage}
            usageLoading={subscriptionQuery.isLoading}
            showErrors={showErrors}
            onChange={setAoi}
          />
        )}
        {current === 1 && (
          <ParamsStep params={params} showErrors={showErrors} onChange={setParams} />
        )}
        {current === 2 && aoi && (
          <SummaryStep
            selection={aoi}
            params={params}
            subscriptionQuery={subscriptionQuery}
            createdTask={createdTask}
            creating={createMutation.isPending}
            createError={createMutation.isError ? (createMutation.error as Error).message : null}
            onCreate={() => createMutation.mutate()}
          />
        )}
      </div>

      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 12 }}>
        {current > 0 && !createdTask && (
          <Button disabled={createMutation.isPending} onClick={() => setCurrent((c) => c - 1)}>
            上一步
          </Button>
        )}
        {current < 2 && (
          <Button type="primary" disabled={!stepOk(current) && showErrors} onClick={handleNext}>
            下一步
          </Button>
        )}
        {current === 2 && createdTask && (
          <Button type="primary" onClick={() => navigate('/workspace')}>
            返回工作台
          </Button>
        )}
      </div>
    </Card>
  )
}
