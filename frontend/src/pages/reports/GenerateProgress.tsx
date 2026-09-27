/**
 * 生成报告分阶段进度（PRD US-09 验收 1）：
 * 组装数据（POST /api/reports，真实请求）→ 渲染章节（前端排版模拟）→ 导出就绪。
 * 失败时标出具体失败环节并给出重试入口。
 */
import { Alert, Button, Steps, Typography } from 'antd'
import { RedoOutlined } from '@ant-design/icons'

export type StageKey = 'assemble' | 'render' | 'export'

export const STAGE_LABELS: Record<StageKey, string> = {
  assemble: '组装数据',
  render: '渲染章节',
  export: '导出就绪',
}

interface GenerateProgressProps {
  /** 当前到达的阶段（生成结束后为 'export'） */
  current: StageKey
  /** 是否整体完成（三阶段全部走完） */
  finished: boolean
  /** 失败的阶段与原因（生成出错时） */
  error: { stage: StageKey; message: string } | null
  onRetry: () => void
}

/** 三阶段的展示顺序 */
const ORDER: StageKey[] = ['assemble', 'render', 'export']

export default function GenerateProgress({ current, finished, error, onRetry }: GenerateProgressProps) {
  const failedIdx = error ? ORDER.indexOf(error.stage) : -1
  const currentIdx = finished ? ORDER.length : ORDER.indexOf(current)

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Steps
        size="small"
        current={error ? failedIdx : currentIdx}
        status={error ? 'error' : 'process'}
        items={ORDER.map((key, idx) => ({
          title: STAGE_LABELS[key],
          description:
            error && idx === failedIdx
              ? '失败'
              : error && idx > failedIdx
                ? '未执行'
                : idx < currentIdx || finished
                  ? '完成'
                  : idx === currentIdx && !error
                    ? '进行中…'
                    : undefined,
        }))}
      />
      {error ? (
        <Alert
          type="error"
          showIcon
          message={`报告生成失败：${STAGE_LABELS[error.stage]}环节出错`}
          description={error.message}
          action={
            <Button size="small" danger icon={<RedoOutlined />} onClick={onRetry}>
              重试
            </Button>
          }
        />
      ) : finished ? (
        <Alert
          type="success"
          showIcon
          message="报告已生成"
          description="下方为章节化预览，可使用「打印 / 保存 PDF」或「下载 PDF」导出。"
        />
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          正在 {STAGE_LABELS[current]}…（生成过程通常在数秒内完成）
        </Typography.Text>
      )}
    </div>
  )
}
