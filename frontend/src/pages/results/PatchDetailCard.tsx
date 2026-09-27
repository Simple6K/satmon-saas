/**
 * 斑块详情与举证卡（US-08）：
 * - 基础举证信息：变化类型 / 面积（公顷）/ 置信度 / 前后时相 / 告警等级
 * - 上下文佐证图层（GET /api/tasks/{id}/results/{patchId}）：各层 available/unavailable
 *   状态逐层展示；POI「暂不可用」即降级演示点（Overpass 镜像超时），只隐藏该层不阻断详情
 * - 告警处置入口（PUT /api/alerts/{id}/status）：确认 / 转现场核查 / 忽略误报，
 *   成功后 message 反馈并失效 ['alerts'] 缓存与顶栏/工作台联动；approver 只读
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Descriptions, Divider, Empty, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { apiFetch } from '../../api/client'
import { PatchDetailRespSchema, type Alert as AlertDto, type PatchProperties } from '../../api/types'
import { ALERT_STATUS_META, alertLevelTagProps, fmtHa } from './patchStyle'

/** 契约 §5 contextLayers 键 → 展示名（数据源披露与 PRD 一致，勿改为未接入的商业数据） */
const CONTEXT_LAYER_LABELS: Record<string, string> = {
  worldcover: 'ESA WorldCover 2021 土地利用（10m）',
  worldpop: 'WorldPop 2020 影响人口（人/km²）',
  imerg: 'IMERG 降雨（2km）',
  poi: 'Overpass POI 兴趣点（maps.mail.ru 镜像）',
}

function contextTagProps(value: string): { label: string; color: string } {
  if (value.startsWith('available')) {
    return { label: value === 'available_2km' ? '可用（2km）' : '可用', color: 'success' }
  }
  return { label: '暂不可用', color: 'warning' }
}

interface PatchDetailCardProps {
  taskId: string
  patch: PatchProperties | null
  alerts: AlertDto[]
  /** 写操作要求 analyst / tenant_admin（契约 §0：approver 仅 GET） */
  canWrite: boolean
}

export default function PatchDetailCard({ taskId, patch, alerts, canWrite }: PatchDetailCardProps) {
  const queryClient = useQueryClient()
  const alert = patch ? alerts.find((a) => a.patchId === patch.patchId) : undefined

  const detailQuery = useQuery({
    queryKey: ['patchDetail', taskId, patch?.patchId],
    queryFn: async () =>
      PatchDetailRespSchema.parse(
        await apiFetch<unknown>(`/api/tasks/${taskId}/results/${patch!.patchId}`),
      ),
    enabled: !!patch,
  })

  const statusMutation = useMutation({
    mutationFn: (status: string) =>
      apiFetch(`/api/alerts/${alert!.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_data, status) => {
      message.success(`告警处置成功：${ALERT_STATUS_META[status]?.label ?? status}`)
      void queryClient.invalidateQueries({ queryKey: ['alerts'] })
    },
    // 失败提示由 apiFetch 统一 toast
  })

  if (!patch) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="点击地图上的变化斑块，或点击左侧列表，查看斑块详情与举证"
      />
    )
  }

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="斑块编号">
          <Typography.Text code copyable style={{ fontSize: 12 }}>
            {patch.patchId}
          </Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="变化类型">{patch.changeType}</Descriptions.Item>
        <Descriptions.Item label="变化面积">{fmtHa(patch.areaKm2)} 公顷</Descriptions.Item>
        <Descriptions.Item label="置信度">{(patch.confidence * 100).toFixed(0)}%</Descriptions.Item>
        <Descriptions.Item label="前后时相">
          {patch.beforeDate} → {patch.afterDate}（Sentinel-2 L2A）
        </Descriptions.Item>
        <Descriptions.Item label="告警等级">
          <Tag style={{ marginInlineEnd: 0 }} color={alertLevelTagProps(patch.alertLevel).color}>
            {alertLevelTagProps(patch.alertLevel).label}
          </Tag>
        </Descriptions.Item>
      </Descriptions>

      <Divider style={{ margin: '8px 0' }}>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          上下文佐证图层
        </Typography.Text>
      </Divider>

      {detailQuery.isLoading ? (
        <div style={{ padding: '12px 0', textAlign: 'center' }}>
          <Spin size="small" />
          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            正在获取佐证图层状态…
          </Typography.Text>
        </div>
      ) : detailQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="佐证图层状态获取失败"
          description="服务暂不可达或请求超时，可重试；不影响斑块基础举证信息。"
          action={
            <Button size="small" danger icon={<ReloadOutlined />} onClick={() => void detailQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {Object.entries(detailQuery.data!.contextLayers).map(([key, value]) => {
            const tag = contextTagProps(value)
            const isPoiDown = key === 'poi' && value === 'unavailable'
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Typography.Text style={{ fontSize: 13, flex: 1 }}>
                  {CONTEXT_LAYER_LABELS[key] ?? key}
                </Typography.Text>
                {isPoiDown ? (
                  <Tooltip title="POI 数据暂不可用（降级演示点）：Overpass 镜像请求超时，该图层隐藏，不阻断其他佐证图层。">
                    <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                      暂不可用
                    </Tag>
                  </Tooltip>
                ) : (
                  <Tag color={tag.color} style={{ marginInlineEnd: 0 }}>
                    {tag.label}
                  </Tag>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Divider style={{ margin: '8px 0' }}>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          告警处置
        </Typography.Text>
      </Divider>

      {alert ? (
        /* antd 6 已弃用 Space direction，纵向布局改用 grid */
        <div style={{ display: 'grid', gap: 8 }}>
          <Space size={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前状态：
            </Typography.Text>
            <Tag style={{ marginInlineEnd: 0 }} color={ALERT_STATUS_META[alert.status]?.color}>
              {ALERT_STATUS_META[alert.status]?.label ?? alert.status}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {fmtHa(alert.areaKm2)} 公顷 · {alert.changeType}
            </Typography.Text>
          </Space>
          {canWrite ? (
            <Space size={8} wrap>
              <Button
                size="small"
                type="primary"
                loading={statusMutation.isPending}
                onClick={() => statusMutation.mutate('confirmed')}
              >
                确认变化
              </Button>
              <Button size="small" loading={statusMutation.isPending} onClick={() => statusMutation.mutate('field_check')}>
                转现场核查
              </Button>
              <Button size="small" loading={statusMutation.isPending} onClick={() => statusMutation.mutate('dismissed')}>
                忽略误报
              </Button>
            </Space>
          ) : (
            <Alert
              type="info"
              showIcon
              message="当前为只读账号（审批人），处置操作仅监测分析师 / 租户管理员可用"
            />
          )}
        </div>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          该斑块未触发告警（面积 / 置信度未达到任务告警阈值）
        </Typography.Text>
      )}
    </div>
  )
}
