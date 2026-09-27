/**
 * 任务创建向导（task-create）页面内共享类型。
 * 仅本页面使用，不进全局 api/types.ts（契约 DTO 已在那里，这里是视图层状态）。
 */
import type { MonitorType } from '../../api/types'
import type { Polygon } from 'geojson'

/** AOI 来源：组织库已有 / 地图绘制 / GeoJSON 上传 */
export type AoiSource = 'library' | 'drawn' | 'upload'

export interface AoiSelection {
  source: AoiSource
  /** 仅 library 来源有值；drawn/upload 在提交创建时才落库换取 id */
  aoiId?: string
  name: string
  areaKm2: number
  /** Polygon 几何（WGS84），library 来源即后端返回的 geojson 字段 */
  geometry: Polygon
}

/** 向导第 2 步收集的任务参数（即 POST /api/tasks 请求体字段 + 任务名） */
export interface TaskParams {
  name: string
  monitorType: MonitorType | ''
  /** YYYY-MM-DD */
  startDate: string
  /** YYYY-MM-DD */
  endDate: string
  cloudMaxPct: number
}

/** 检索预演的故障注入（契约 §0：X-Debug-Fail 请求头，仅演示环境生效） */
export type DebugFail = '' | 'odata' | 'all'

/** POST /api/tasks 成功响应中页面关心的最小字段（zod 默认剥离去多余字段） */
export interface CreatedTask {
  id: string
  status: string
}
