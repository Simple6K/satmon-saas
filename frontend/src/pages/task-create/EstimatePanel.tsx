/**
 * 影像检索预演面板 —— US-03 / US-05 / PRD 5.2 三级降级的完整呈现。
 *
 * 调 POST /api/tasks/{id}/estimate（契约 §4）：
 * 1. OData 成功：绿色/蓝色标识 + 景数列表（Sentinel-2 · 10m）
 * 2. 降级 STAC：黄色横幅（主源不可达、已降级 Landsat 15–30m，说明分辨率影响）+ 列表
 * 3. 双败兜底：红色提示条 + reason + 手动重试按钮，绝不自动循环重试
 * 另覆盖：请求级错误（如前端 8s 超时/网络异常）红色兜底条 + 重试；0 景空状态给可操作建议。
 *
 * 附「故障注入」选择器（契约 §0 X-Debug-Fail 请求头，仅演示环境生效），
 * 供现场一键演示三级降级；切换后需手动点击重新预演。
 */
import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { RedoOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Radio, Spin, Table, Tag, Typography } from 'antd'
import { apiFetch } from '../../api/client'
import { EstimateRespSchema } from '../../api/types'
import type { DebugFail } from './types'

interface EstimatePanelProps {
  taskId: string
  /** 展示用：时间窗与云量条件（空状态提示里引用） */
  windowLabel: string
}

const DEBUG_OPTIONS: { label: string; value: DebugFail }[] = [
  { label: '正常', value: '' },
  { label: '模拟 OData 超时', value: 'odata' },
  { label: '模拟双源故障', value: 'all' },
]

export default function EstimatePanel({ taskId, windowLabel }: EstimatePanelProps) {
  const [debugFail, setDebugFail] = useState<DebugFail>('')

  const estimateMutation = useMutation({
    mutationFn: async () => {
      const init: RequestInit = { method: 'POST' }
      if (debugFail) init.headers = { 'X-Debug-Fail': debugFail }
      return EstimateRespSchema.parse(
        await apiFetch<unknown>(`/api/tasks/${taskId}/estimate`, init),
      )
    },
  })

  // 任务创建成功后自动预演一次；此后仅手动重试（不做无边界自动重试）
  useEffect(() => {
    estimateMutation.mutate()
    // estimateMutation.mutate 是稳定引用，重试语义由用户触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const data = estimateMutation.data
  const scenes = data?.scenes ?? []

  const sourceTag =
    data?.source === 'odata' ? (
      <Tag color="green">Copernicus OData · Sentinel-2 10m</Tag>
    ) : data?.source === 'stac' ? (
      <Tag color="orange">USGS STAC · Landsat 15–30m</Tag>
    ) : null

  return (
    <Card
      size="small"
      title="影像检索预演（真实外部数据源）"
      extra={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Radio.Group
            size="small"
            optionType="button"
            buttonStyle="solid"
            options={DEBUG_OPTIONS}
            value={debugFail}
            onChange={(e) => setDebugFail(e.target.value as DebugFail)}
          />
          <Button
            size="small"
            icon={<RedoOutlined />}
            loading={estimateMutation.isPending}
            onClick={() => estimateMutation.mutate()}
          >
            重新预演
          </Button>
        </div>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
        预演真实调用 Copernicus OData 目录（8s 硬超时），失败自动降级 USGS Landsat STAC；
        「故障注入」仅在演示环境生效（请求头 X-Debug-Fail），用于验证三级降级行为。
      </Typography.Paragraph>

      {estimateMutation.isPending ? (
        <div style={{ padding: '32px 0', textAlign: 'center' }}>
          <Spin />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
            正在检索（OData 主源 8s 硬超时，失败将自动降级 USGS STAC）…
          </Typography.Paragraph>
        </div>
      ) : estimateMutation.isError ? (
        <Alert
          type="error"
          showIcon
          message="检索预演请求失败"
          description={`${(estimateMutation.error as Error).message}。可能原因：双源检索链总耗时超过前端 8s 超时，或网络异常。系统不会自动循环重试，请手动重试。`}
          action={
            <Button size="small" danger onClick={() => estimateMutation.mutate()}>
              重试
            </Button>
          }
        />
      ) : data?.source == null ? (
        // 双败兜底（契约 §4：source=null + fallbackUsed=true + reason）
        <Alert
          type="error"
          showIcon
          message="Copernicus 与 USGS 目录当前均不可达"
          description={`${data?.reason ?? '未知原因'}。结果区不展示缓存的旧数据；可稍后手动重试，或直接创建任务由调度器在下一周期重试检索。`}
          action={
            <Button size="small" danger onClick={() => estimateMutation.mutate()}>
              重试
            </Button>
          }
        />
      ) : (
        <>
          {data.source === 'stac' && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="主源 Copernicus OData 不可达，已自动降级 USGS Landsat STAC"
              description={`降级原因：${data.reason ?? '未知'}。Landsat 分辨率 15–30m（主源 10m），变化检测最小可识别斑块将增大；结果已如实标注 degraded。`}
            />
          )}
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            {sourceTag}
            <Typography.Text>
              预估可用影像 <Typography.Text strong>{data.totalScenes ?? 0}</Typography.Text> 景
            </Typography.Text>
            <Typography.Text type="secondary" style={{ marginInlineStart: 8, fontSize: 12 }}>
              （{windowLabel}）
            </Typography.Text>
          </Typography.Paragraph>
          {scenes.length === 0 ? (
            <Empty
              description={`该时间窗内无满足条件的低云影像（${windowLabel}）。建议：放宽云量上限（如 20% → 40%）或扩大时间窗。`}
              style={{ padding: '16px 0' }}
            />
          ) : (
            <Table
              size="small"
              rowKey="id"
              dataSource={scenes}
              pagination={{ pageSize: 10, showSizeChanger: false }}
              columns={[
                {
                  title: '传感时间',
                  dataIndex: 'sensingDate',
                  width: 120,
                  render: (v: string) => v.slice(0, 10),
                },
                {
                  title: '云量',
                  dataIndex: 'cloudPct',
                  width: 90,
                  render: (v: number) => `${v}%`,
                },
                {
                  title: 'MGRS 分幅',
                  dataIndex: 'tileId',
                  width: 120,
                  render: (v: string) => <Tag>{v}</Tag>,
                },
                {
                  title: '产品 ID',
                  dataIndex: 'id',
                  render: (v: string) => (
                    <Typography.Text
                      copyable
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                      ellipsis={{ tooltip: v }}
                    >
                      {v}
                    </Typography.Text>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
    </Card>
  )
}
