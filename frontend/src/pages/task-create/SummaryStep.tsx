/**
 * 向导第 3 步：摘要确认 + 配额校验 + 提交创建 + 检索预演 —— US-03。
 *
 * - 配额（AOI 面积 / 并发任务）超限则红条阻断提交并展示当前用量与上限
 *   （客户端预检 + 服务端 400 兜底，服务端拒绝时透出其 msg）
 * - 创建成功后切到 Result 成功态，并自动执行影像检索预演（EstimatePanel，
 *   三级降级在该组件内呈现）
 * - 「返回工作台」由向导底部按钮提供（见 index.tsx），不自动跳转，
 *   以便用户完整查看预演结果与降级演示
 */
import { Alert, Button, Card, Descriptions, Progress, Result, Skeleton, Typography } from 'antd'
import type { UseQueryResult } from '@tanstack/react-query'
import { MONITOR_TYPE_LABELS, type Subscription } from '../../api/types'
import type { AoiSelection, CreatedTask, TaskParams } from './types'
import EstimatePanel from './EstimatePanel'

const SOURCE_LABELS: Record<AoiSelection['source'], string> = {
  library: '组织 AOI 库',
  drawn: '地图绘制（新建）',
  upload: 'GeoJSON 上传（新建）',
}

interface SummaryStepProps {
  selection: AoiSelection
  params: TaskParams
  subscriptionQuery: UseQueryResult<Subscription, Error>
  createdTask: CreatedTask | null
  creating: boolean
  createError: string | null
  onCreate: () => void
}

export default function SummaryStep({
  selection,
  params,
  subscriptionQuery,
  createdTask,
  creating,
  createError,
  onCreate,
}: SummaryStepProps) {
  const usage = subscriptionQuery.data?.usage

  // 配额预检：新建 AOI 面积累加到已用；库选 AOI 已计入已用
  const projectedArea =
    usage && selection.source === 'library' ? usage.aoiAreaKm2 : (usage?.aoiAreaKm2 ?? 0) + selection.areaKm2
  const areaBlocked = usage !== undefined && projectedArea > usage.aoiAreaLimitKm2
  const concurrentBlocked = usage !== undefined && usage.concurrentTasks >= usage.concurrentLimit

  if (createdTask) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <Result
          status="success"
          title="任务创建成功，已进入执行队列"
          subTitle={`任务「${params.name}」状态：已排队（queued）· 调度器每 30 秒扫描推进（检索影像 → 变化检测分析）`}
        />
        <EstimatePanel
          taskId={createdTask.id}
          windowLabel={`${params.startDate} ~ ${params.endDate} · 云量 ≤ ${params.cloudMaxPct}%`}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
          预演结果仅用于评估影像可获得性；正式检索由任务调度执行，失败会按同样的一级一级降级策略处理并在工作台标注。
        </Typography.Paragraph>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <Descriptions
        bordered
        size="small"
        column={2}
        items={[
          { key: 'name', label: '任务名称', children: params.name },
          {
            key: 'type',
            label: '监测类型',
            children: params.monitorType ? MONITOR_TYPE_LABELS[params.monitorType] : '—',
          },
          {
            key: 'aoi',
            label: '监测区域（AOI）',
            children: (
              <>
                {selection.name || '（未命名）'}
                <Typography.Text type="secondary" style={{ marginInlineStart: 8, fontSize: 12 }}>
                  {SOURCE_LABELS[selection.source]} · {selection.areaKm2.toFixed(1)} km²
                </Typography.Text>
              </>
            ),
          },
          {
            key: 'window',
            label: '时间窗',
            children: `${params.startDate} ~ ${params.endDate}`,
          },
          { key: 'cloud', label: '云量上限', children: `≤ ${params.cloudMaxPct}%` },
          {
            key: 'source',
            label: '数据源',
            children: (
              <Typography.Text style={{ fontSize: 12 }}>
                Sentinel-2 L2A（Copernicus OData，10m）主源；故障自动降级 Landsat 8/9（USGS STAC，15–30m）
              </Typography.Text>
            ),
          },
        ]}
      />

      <Card size="small" title="订阅配额校验" style={{ marginTop: 16 }}>
        {subscriptionQuery.isLoading ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : subscriptionQuery.isError ? (
          <Alert
            type="error"
            showIcon
            message="订阅用量加载失败，暂无法校验配额"
            description={`${(subscriptionQuery.error as Error).message}。为避免误建超限任务，请重试后再提交。`}
            action={
              <Button size="small" onClick={() => void subscriptionQuery.refetch()}>
                重试
              </Button>
            }
          />
        ) : usage ? (
          <>
            <Typography.Paragraph style={{ marginBottom: 4 }}>
              AOI 面积：
              <Typography.Text strong style={{ marginInlineStart: 4 }}>
                {projectedArea.toFixed(1)} / {usage.aoiAreaLimitKm2} km²
              </Typography.Text>
              {selection.source !== 'library' && (
                <Typography.Text type="secondary" style={{ marginInlineStart: 8, fontSize: 12 }}>
                  （已用 {usage.aoiAreaKm2.toFixed(1)}，含本次新建 {selection.areaKm2.toFixed(1)}）
                </Typography.Text>
              )}
            </Typography.Paragraph>
            <Progress
              percent={Math.min(100, Math.round((projectedArea / usage.aoiAreaLimitKm2) * 100))}
              size="small"
              status={areaBlocked ? 'exception' : undefined}
              style={{ maxWidth: 420, marginBottom: 12 }}
            />
            <Typography.Paragraph>
              并发任务：
              <Typography.Text strong style={{ marginInlineStart: 4 }}>
                {usage.concurrentTasks} / {usage.concurrentLimit}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ marginInlineStart: 8, fontSize: 12 }}>
                （本次创建后 {Math.min(usage.concurrentTasks + 1, usage.concurrentLimit + 1)}，仅排队/检索/分析中的任务计数）
              </Typography.Text>
            </Typography.Paragraph>
            {(areaBlocked || concurrentBlocked) && (
              <Alert
                type="error"
                showIcon
                message="配额超限，提交已阻断"
                description={
                  areaBlocked
                    ? `AOI 总面积将达 ${projectedArea.toFixed(1)} km²，超出当前套餐上限 ${usage.aoiAreaLimitKm2} km²。请缩减监测范围，或在「订阅管理」升级套餐。`
                    : `并发任务数已达上限（${usage.concurrentTasks}/${usage.concurrentLimit}）。请等待任务完成或取消后再创建。`
                }
              />
            )}
          </>
        ) : null}
      </Card>

      {createError && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 16 }}
          message="服务端拒绝了本次创建请求"
          description={createError}
        />
      )}

      <div style={{ marginTop: 20, textAlign: 'center' }}>
        <Button
          type="primary"
          size="large"
          loading={creating}
          disabled={areaBlocked || concurrentBlocked || usage === undefined}
          onClick={onCreate}
        >
          创建任务并预估可用影像
        </Button>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
          提交后：新建 AOI 先落库（服务端 shapely 二次校验），随后创建任务（状态「已排队」）并自动执行检索预演。
        </Typography.Paragraph>
      </div>
    </div>
  )
}
