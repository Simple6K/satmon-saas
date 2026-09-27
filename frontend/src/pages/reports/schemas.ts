/**
 * 报告页本地 zod schema（契约 §6 只锁定顶层 {id, taskId, generatedAt, sections}，
 * sections 具体字段契约未逐字锁定，此处按后端 app/api/reports.py 的实际落库结构
 * 在页面边界校验，避免污染全局契约 types.ts）。
 */
import { z } from 'zod'
import { MonitorTypeSchema } from '../../api/types'

/** Polygon GeoJSON（AOI 边界，服务端已 shapely 校验，前端宽松透传） */
const PolygonGeojsonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.array(z.number()))),
})

/** ① 概述：任务/AOI/时间窗/数据源摘要 */
export const ReportOverviewSchema = z.object({
  taskName: z.string(),
  monitorType: MonitorTypeSchema,
  monitorTypeLabel: z.string(),
  aoiName: z.string(),
  aoiAreaKm2: z.number(),
  aoiGeojson: PolygonGeojsonSchema,
  timeWindow: z.object({ start: z.string(), end: z.string() }),
  cloudMaxPct: z.number(),
  dataSource: z.object({ sceneCount: z.number(), note: z.string() }),
})
export type ReportOverview = z.infer<typeof ReportOverviewSchema>

/** ③ 统计表：按变化类型分组 + Top10 斑块 */
export const ReportStatsSchema = z.object({
  patchCount: z.number(),
  totalAreaKm2: z.number(),
  byType: z.array(
    z.object({
      changeType: z.string(),
      count: z.number(),
      areaKm2: z.number(),
    }),
  ),
  top10Patches: z.array(
    z.object({
      patchId: z.string(),
      areaKm2: z.number(),
      changeType: z.string(),
      confidence: z.number(),
      beforeDate: z.string(),
      afterDate: z.string(),
      alertLevel: z.string(),
    }),
  ),
})
export type ReportStats = z.infer<typeof ReportStatsSchema>

/** 报告完整 sections */
export const ReportSectionsSchema = z.object({
  overview: ReportOverviewSchema,
  stats: ReportStatsSchema,
  methodology: z.object({ note: z.string() }),
})
export type ReportSections = z.infer<typeof ReportSectionsSchema>

/** 报告详情（POST /api/reports 响应 / GET /api/reports/{id} 响应） */
export const ReportDetailSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  generatedAt: z.string(),
  sections: ReportSectionsSchema,
})
export type ReportDetail = z.infer<typeof ReportDetailSchema>

/** 历史报告列表项（GET /api/reports，契约未锁定 taskName 字段名，按后端实现校验） */
export const ReportListItemSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskName: z.string(),
  generatedAt: z.string(),
})
export type ReportListItem = z.infer<typeof ReportListItemSchema>
