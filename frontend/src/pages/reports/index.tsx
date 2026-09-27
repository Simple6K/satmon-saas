/**
 * 报告中心（US-09 生成与导出监测报告）：
 * - 任务选择（仅已完成任务）→「生成报告」分阶段进度（组装→渲染→导出就绪）
 * - 章节化预览（概述 / 方法说明 / byType 统计表 / Top10 举证卡 / 附录）
 * - 导出双路径：打印 / 保存 PDF（print-CSS + window.print，主路径）与
 *   「下载 PDF」（jsPDF 按需 CDN 加载，离线降级回打印路径并明确提示）
 * - 历史报告列表：重新查看 / 再次导出，无需重新生成（US-09 验收 5）
 * 数据经 apiFetch + 页面本地 zod schema 校验；加载 / 空 / 错误 / 重试态全覆盖。
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import {
  Alert,
  Button,
  Card,
  Empty,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Spin,
  Table,
  Typography,
  message,
} from 'antd'
import { FilePdfOutlined, PrinterOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { ApiError, apiFetch } from '../../api/client'
import { MONITOR_TYPE_LABELS, TaskSummarySchema } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import GenerateProgress, { type StageKey } from './GenerateProgress'
import ReportPreview from './ReportPreview'
import { ReportDetailSchema, ReportListItemSchema, type ReportListItem } from './schemas'
import { buildReportFilename, exportReportPdf, notifyPdfFallback } from './exportPdf'
import './reportPrint.css'

/** 渲染章节阶段的模拟耗时（进度演示：真实工作只有 POST 组装，排版瞬时完成） */
const RENDER_SIMULATION_MS = 900
const EXPORT_READY_MS = 400

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function ReportsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const tenantName = user?.tenantName ?? '本组织'

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  /** 历史报告查看 id：非空时预览切换为该报告详情 */
  const [viewingReportId, setViewingReportId] = useState<string | null>(null)
  const [pdfExporting, setPdfExporting] = useState(false)
  /** 当前生成阶段（进度指示） */
  const [stage, setStage] = useState<StageKey>('assemble')
  /** 打印副本宿主：挂在 <body> 下脱离应用壳，@media print 时成为唯一可见区域 */
  const [printHost, setPrintHost] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = document.createElement('div')
    el.className = 'report-print-portal'
    document.body.appendChild(el)
    setPrintHost(el)
    return () => el.remove()
  }, [])

  // ---- 任务列表（与工作台共享 ['tasks'] 缓存） ----
  const tasksQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: async () => TaskSummarySchema.array().parse(await apiFetch<unknown>('/api/tasks')),
  })
  const completedTasks = useMemo(
    () => (tasksQuery.data ?? []).filter((t) => t.status === 'completed'),
    [tasksQuery.data],
  )

  // ---- 历史报告列表 ----
  const reportsQuery = useQuery({
    queryKey: ['reports'],
    queryFn: async () => ReportListItemSchema.array().parse(await apiFetch<unknown>('/api/reports')),
  })

  // ---- 历史报告详情（查看时按需拉取） ----
  const detailQuery = useQuery({
    queryKey: ['report', viewingReportId],
    enabled: viewingReportId != null,
    queryFn: async () =>
      ReportDetailSchema.parse(await apiFetch<unknown>(`/api/reports/${viewingReportId}`)),
  })

  // ---- 生成报告（阶段推进：组装=真实 POST；渲染=排版模拟；导出=就绪提示） ----
  const generateMutation = useMutation({
    mutationFn: async (taskId: string) => {
      setStage('assemble')
      const report = ReportDetailSchema.parse(
        await apiFetch<unknown>('/api/reports', {
          method: 'POST',
          body: JSON.stringify({ taskId }),
        }),
      )
      setStage('render')
      await sleep(RENDER_SIMULATION_MS)
      setStage('export')
      await sleep(EXPORT_READY_MS)
      return report
    },
    onSuccess: (report) => {
      message.success('报告已生成，可预览并导出')
      setViewingReportId(null)
      void queryClient.invalidateQueries({ queryKey: ['reports'] })
      void queryClient.refetchQueries({ queryKey: ['report', report.id] })
    },
  })

  /** 当前预览的报告：新生成的优先，其次历史查看的详情 */
  const currentReport = viewingReportId ? (detailQuery.data ?? null) : (generateMutation.data ?? null)

  /** 生成失败时定位失败阶段与原因 */
  const genError =
    generateMutation.isError && viewingReportId == null
      ? {
          stage,
          message:
            generateMutation.error instanceof ApiError || generateMutation.error instanceof Error
              ? generateMutation.error.message
              : '未知错误',
        }
      : null

  const showProgress =
    !viewingReportId &&
    (generateMutation.isPending || generateMutation.isError || generateMutation.isSuccess)

  const selectedTask = completedTasks.find((t) => t.id === selectedTaskId)

  /** 建议文件名（PRD US-09 验收 4 命名规则，打印另存时照此输入） */
  const suggestedFilename = currentReport
    ? buildReportFilename(
        tenantName,
        currentReport.sections.overview.taskName,
        currentReport.sections.overview.timeWindow,
        currentReport.generatedAt,
      )
    : null

  const handlePrint = () => window.print()

  const handleExportPdf = async () => {
    if (!currentReport) return
    setPdfExporting(true)
    try {
      const filename = await exportReportPdf(currentReport, tenantName)
      message.success(`PDF 已下载：${filename}`)
    } catch (e) {
      notifyPdfFallback(e)
    } finally {
      setPdfExporting(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          报告中心
        </Typography.Title>
        <Typography.Text type="secondary">
          选择已完成的监测任务一键生成汇报用报告，支持打印导出与历史报告复用。
        </Typography.Text>
      </div>

      {/* ---- 生成报告 ---- */}
      <Card title="生成报告">
        {tasksQuery.isLoading ? (
          <Skeleton active paragraph={{ rows: 1 }} />
        ) : tasksQuery.isError ? (
          <Alert
            type="error"
            showIcon
            message="任务列表加载失败"
            description="服务暂不可达或请求超时，无法选择任务。"
            action={
              <Button size="small" danger onClick={() => void tasksQuery.refetch()}>
                重试
              </Button>
            }
          />
        ) : completedTasks.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已完成任务，请先在工作台等待任务执行完成" />
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            <Space wrap>
              <Select
                style={{ minWidth: 320 }}
                placeholder="选择监测任务（仅列出已完成任务）"
                value={selectedTaskId}
                onChange={(v) => setSelectedTaskId(v)}
                options={completedTasks.map((t) => ({
                  value: t.id,
                  label: `${t.name} · ${t.aoiName} · ${MONITOR_TYPE_LABELS[t.monitorType]}`,
                }))}
              />
              <Popconfirm
                title="生成报告"
                description="将为该任务聚合变化检测结果生成报告，确认继续？"
                onConfirm={() => selectedTaskId && generateMutation.mutate(selectedTaskId)}
                disabled={!selectedTaskId || generateMutation.isPending}
              >
                <Button
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  disabled={!selectedTaskId}
                  loading={generateMutation.isPending}
                >
                  生成报告
                </Button>
              </Popconfirm>
              {selectedTask?.degraded && (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  该任务结果来自降级数据源，报告将如实标注
                </Typography.Text>
              )}
            </Space>

            {showProgress && (
              <GenerateProgress
                current={stage}
                finished={generateMutation.isSuccess && viewingReportId == null}
                error={genError}
                onRetry={() => selectedTaskId && generateMutation.mutate(selectedTaskId)}
              />
            )}
          </div>
        )}
      </Card>

      {/* ---- 报告预览与导出 ---- */}
      {currentReport && (
        <Card
          title="报告预览"
          extra={
            <Space wrap>
              <Button icon={<PrinterOutlined />} onClick={handlePrint}>
                打印 / 保存 PDF
              </Button>
              <Button
                icon={<FilePdfOutlined />}
                loading={pdfExporting}
                onClick={() => void handleExportPdf()}
              >
                下载 PDF
              </Button>
            </Space>
          }
        >
          <ReportPreview report={currentReport} tenantName={tenantName} />
          {suggestedFilename && (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
              建议文件名：{suggestedFilename}（打印另存为 PDF 时请照此命名）
            </Typography.Paragraph>
          )}
        </Card>
      )}

      {/* 查看历史报告详情时的独立加载 / 错误态（列表在上、预览缺失时兜底） */}
      {viewingReportId && detailQuery.isLoading && (
        <Card>
          <div style={{ textAlign: 'center', padding: 24, display: 'grid', gap: 8, justifyItems: 'center' }}>
            <Spin />
            <Typography.Text type="secondary">加载报告中…</Typography.Text>
          </div>
        </Card>
      )}
      {viewingReportId && detailQuery.isError && (
        <Card>
          <Alert
            type="error"
            showIcon
            message="报告详情加载失败"
            description="该报告可能已被清理或服务暂不可达。"
            action={
              <Button size="small" danger onClick={() => void detailQuery.refetch()}>
                重试
              </Button>
            }
          />
        </Card>
      )}

      {/* ---- 历史报告（US-09 验收 5：可重复查看导出，无需重新生成） ---- */}
      <Card
        title="历史报告"
       
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => void reportsQuery.refetch()}
          >
            刷新
          </Button>
        }
      >
        {reportsQuery.isLoading ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : reportsQuery.isError ? (
          <Alert
            type="error"
            showIcon
            message="历史报告加载失败"
            action={
              <Button size="small" danger onClick={() => void reportsQuery.refetch()}>
                重试
              </Button>
            }
          />
        ) : (reportsQuery.data ?? []).length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史报告，生成第一份后将显示在此" />
        ) : (
          <Table<ReportListItem>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 5, hideOnSinglePage: true }}
            dataSource={reportsQuery.data ?? []}
            columns={[
              { title: '任务名称', dataIndex: 'taskName', key: 'taskName' },
              {
                title: '生成时间',
                dataIndex: 'generatedAt',
                key: 'generatedAt',
                render: (v: string) => formatDateTime(v),
                width: 180,
              },
              {
                title: '操作',
                key: 'action',
                width: 120,
                render: (_, r) => (
                  <Button
                    size="small"
                    type={viewingReportId === r.id ? 'primary' : 'default'}
                    onClick={() => {
                      setViewingReportId(r.id)
                      // 滚动到顶部便于阅读预览
                      window.scrollTo({ top: 0, behavior: 'smooth' })
                    }}
                  >
                    查看 / 导出
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      {/* 打印专用副本：屏幕上 display:none，window.print 时 #root 整体隐藏、仅此份渲染并按 A4 自然分页 */}
      {printHost && currentReport &&
        createPortal(<ReportPreview report={currentReport} tenantName={tenantName} />, printHost)}
    </div>
  )
}
