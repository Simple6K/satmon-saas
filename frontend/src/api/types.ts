/**
 * API 契约 DTO（zod 定义）——逐字段对齐 API-CONTRACT.md v1.0。
 * 所有后端响应在边界处用这些 schema 校验后再进入视图层（工程原则 2）。
 * 契约改动须经前后端双方在场，前端不得自行增改语义。
 */
import { z } from 'zod'

// ---------- 通用 ----------

/** 响应信封：{code, msg, data, timestamp}，code=0 成功 */
export const EnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string(),
  data: z.unknown(),
  timestamp: z.string(),
})

export const RoleSchema = z.enum(['tenant_admin', 'analyst', 'approver'])
export type Role = z.infer<typeof RoleSchema>

export const ROLE_LABELS: Record<Role, string> = {
  tenant_admin: '租户管理员',
  analyst: '分析师',
  approver: '审批人（只读）',
}

export const MonitorTypeSchema = z.enum([
  'illegal_construction',
  'farmland_non_agri',
  'urban_expansion',
  'surface_change',
])
export type MonitorType = z.infer<typeof MonitorTypeSchema>

export const MONITOR_TYPE_LABELS: Record<MonitorType, string> = {
  illegal_construction: '违建识别',
  farmland_non_agri: '耕地非农化',
  urban_expansion: '城市扩张',
  surface_change: '地表变化',
}

export const TaskStatusSchema = z.enum([
  'queued',
  'retrieving',
  'analyzing',
  'completed',
  'failed',
  'cancelled',
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const AlertStatusSchema = z.enum(['pending', 'confirmed', 'field_check', 'dismissed'])
export type AlertStatus = z.infer<typeof AlertStatusSchema>

// ---------- 认证（契约 §1 / §7 种子账号） ----------

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleSchema,
  tenantId: z.string(),
  tenantName: z.string(),
})
export type User = z.infer<typeof UserSchema>

export const LoginRespSchema = z.object({
  token: z.string(),
  user: UserSchema,
})
export type LoginResp = z.infer<typeof LoginRespSchema>

// ---------- 订阅（契约 §2） ----------

/** 字段名以后端实际实现为准（契约 §2 未锁定字段名）：areaLimitKm2/monitorTypes/dataSourceNote */
export const PlanSchema = z.object({
  id: z.enum(['basic', 'pro', 'flagship']),
  name: z.string(),
  /** AOI 面积上限 km² */
  areaLimitKm2: z.number(),
  /** 可选监测类型数 */
  monitorTypeCount: z.number(),
  /** 监测类型描述（如「任选 1 类监测类型」） */
  monitorTypes: z.string().optional(),
  /** 重访频率（monthly/quarterly/biweekly 等） */
  revisit: z.string(),
  seats: z.number(),
  maxConcurrentTasks: z.number(),
  dataSourceNote: z.string().optional(),
})
export type Plan = z.infer<typeof PlanSchema>

export const SubscriptionUsageSchema = z.object({
  aoiAreaKm2: z.number(),
  aoiAreaLimitKm2: z.number(),
  concurrentTasks: z.number(),
  concurrentLimit: z.number(),
  activeTaskCount: z.number(),
})
export type SubscriptionUsage = z.infer<typeof SubscriptionUsageSchema>

export const SubscriptionSchema = z.object({
  planId: z.enum(['basic', 'pro', 'flagship']),
  status: z.string(),
  startedAt: z.string(),
  renewalAt: z.string(),
  usage: SubscriptionUsageSchema,
})
export type Subscription = z.infer<typeof SubscriptionSchema>

export const MemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleSchema,
  joinedAt: z.string(),
})
export type Member = z.infer<typeof MemberSchema>

export const AuditLogSchema = z.object({
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  detail: z.string(),
})
export type AuditLog = z.infer<typeof AuditLogSchema>

// ---------- AOI（契约 §3） ----------

/** Polygon GeoJSON（外部输入，服务端已用 shapely 校验；前端宽松透传几何结构） */
export const AoiGeojsonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
})

export const AoiSchema = z.object({
  id: z.string(),
  name: z.string(),
  areaKm2: z.number(),
  monitorType: MonitorTypeSchema,
  createdAt: z.string(),
  geojson: AoiGeojsonSchema,
})
export type Aoi = z.infer<typeof AoiSchema>

// ---------- 监测任务（契约 §4） ----------

export const TaskStageSchema = z.object({
  retrievalMs: z.number().nullable().optional(),
  analysisMs: z.number().nullable().optional(),
  current: z.string().optional(),
})

export const TaskSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  monitorType: MonitorTypeSchema,
  aoiName: z.string(),
  status: TaskStatusSchema,
  createdAt: z.string(),
  stage: TaskStageSchema,
  degraded: z.boolean(),
})
export type TaskSummary = z.infer<typeof TaskSummarySchema>

/** 检索预演单景 */
export const EstimateSceneSchema = z.object({
  id: z.string(),
  sensingDate: z.string(),
  cloudPct: z.number(),
  tileId: z.string(),
})
export type EstimateScene = z.infer<typeof EstimateSceneSchema>

/** 检索预演结果：双败降级时 source=null + fallbackUsed=true + reason */
export const EstimateRespSchema = z.object({
  source: z.enum(['odata', 'stac']).nullable(),
  totalScenes: z.number().optional(),
  scenes: z.array(EstimateSceneSchema).optional(),
  degraded: z.boolean(),
  fallbackUsed: z.boolean(),
  reason: z.string().optional(),
})
export type EstimateResp = z.infer<typeof EstimateRespSchema>

// ---------- 结果与告警（契约 §5） ----------

/** 变化斑块 GeoJSON 属性（挂在 FeatureCollection 的 feature.properties 上，宽松校验） */
export const PatchPropertiesSchema = z.object({
  patchId: z.string(),
  areaKm2: z.number(),
  confidence: z.number(),
  changeType: z.string(),
  beforeDate: z.string(),
  afterDate: z.string(),
  alertLevel: z.string(),
})
export type PatchProperties = z.infer<typeof PatchPropertiesSchema>

export const ResultsRespSchema = z.object({
  taskId: z.string(),
  stats: z.object({
    patchCount: z.number(),
    totalAreaKm2: z.number(),
    byType: z.record(z.string(), z.number()),
  }),
  geojson: z.object({
    type: z.literal('FeatureCollection'),
    features: z.array(
      z.object({
        type: z.literal('Feature'),
        properties: PatchPropertiesSchema,
        geometry: z.unknown(),
      }),
    ),
  }),
})
export type ResultsResp = z.infer<typeof ResultsRespSchema>

export const PatchDetailRespSchema = z.object({
  contextLayers: z.object({
    worldcover: z.string(),
    worldpop: z.string(),
    imerg: z.string(),
    poi: z.string(),
  }),
})
export type PatchDetailResp = z.infer<typeof PatchDetailRespSchema>

export const AlertSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  patchId: z.string(),
  areaKm2: z.number(),
  changeType: z.string(),
  level: z.string(),
  status: AlertStatusSchema,
  createdAt: z.string(),
})
export type Alert = z.infer<typeof AlertSchema>

export const MessageSchema = z.object({
  id: z.string(),
  type: z.enum(['alert', 'system', 'task']),
  title: z.string(),
  body: z.string(),
  read: z.boolean(),
  createdAt: z.string(),
})
export type Message = z.infer<typeof MessageSchema>

// ---------- 报告（契约 §6） ----------

export const ReportSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  generatedAt: z.string(),
  sections: z.unknown(),
})
export type Report = z.infer<typeof ReportSchema>
