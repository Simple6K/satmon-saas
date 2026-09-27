/**
 * jsPDF 导出（US-09 备选下载路径；主路径为 print-CSS + window.print）。
 *
 * 依赖策略：不新增 npm 依赖，jsPDF 在用户点击下载时按需从 CDN 加载；
 * 离线 / CDN 不可达（8s 超时）时抛错，由页面提示改走「打印 / 保存 PDF」主路径
 * （对齐工程原则 4：外部依赖失败要如实降级，不静默重试）。
 *
 * 中文字体：jsPDF 内置字体不含 CJK，逐字排版会乱码；改为用 <canvas>
 * 以系统中文字体（PingFang SC / 微软雅黑）绘制整页位图再 addImage 进 PDF，
 * 规避嵌入数 MB 字体文件（MVP 报告为纯文字排版 + 占位图，位图化可接受）。
 */
import { message } from 'antd'
import type { ReportDetail } from './schemas'
import { apiFetch } from '../../api/client'
import { bboxFromPolygonCoordinates, getPhaseImage, type BBox, type PhaseImageResult } from './gibsImage'

const JSPDF_CDN = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js'
const SCRIPT_TIMEOUT_MS = 8000

/** A4 @ 约 150 DPI（对齐 PRD US-09 分辨率要求） */
const PAGE_W = 1240
const PAGE_H = 1754
const MARGIN = 90
const FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'

/** jsPDF UMD 全局命名空间 */
interface JsPdfDoc {
  addPage(): void
  addImage(data: string, format: string, x: number, y: number, w: number, h: number): void
  save(filename: string): void
}

type JsPdfCtor = new (opts: { unit: string; format: string }) => JsPdfDoc

declare global {
  interface Window {
    jspdf?: { jsPDF: JsPdfCtor }
  }
}

let cdnPromise: Promise<JsPdfCtor> | null = null

/** 按需加载 CDN 版 jsPDF（单例，8s 超时即失败，不重试） */
function loadJsPdf(): Promise<JsPdfCtor> {
  if (cdnPromise) return cdnPromise
  cdnPromise = new Promise<JsPdfCtor>((resolve, reject) => {
    if (window.jspdf?.jsPDF) {
      resolve(window.jspdf.jsPDF)
      return
    }
    const script = document.createElement('script')
    const timer = setTimeout(() => {
      script.remove()
      reject(new Error('jsPDF 加载超时'))
    }, SCRIPT_TIMEOUT_MS)
    script.src = JSPDF_CDN
    script.onload = () => {
      clearTimeout(timer)
      if (window.jspdf?.jsPDF) resolve(window.jspdf.jsPDF)
      else reject(new Error('jsPDF 加载异常'))
    }
    script.onerror = () => {
      clearTimeout(timer)
      script.remove()
      reject(new Error('jsPDF CDN 不可达'))
    }
    document.head.appendChild(script)
  })
  // 失败后清空单例，允许用户联网后再次尝试
  cdnPromise = cdnPromise.catch((e: unknown) => {
    cdnPromise = null
    throw e
  })
  return cdnPromise
}

/** 逐页 canvas 上下文（自动换行 / 分页 / 页脚页码） */
class CanvasPager {
  readonly pages: HTMLCanvasElement[] = []
  private ctx: CanvasRenderingContext2D
  private pageNo = 1
  /** 当前页内容纵坐标（导出流程需要直接回退以实现左右并排占位图，故公开） */
  y = MARGIN

  constructor() {
    const first = this.newCanvas()
    this.ctx = first.getContext('2d') as CanvasRenderingContext2D
    this.pages.push(first)
  }

  private newCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = PAGE_W
    c.height = PAGE_H
    const ctx = c.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#000'
      ctx.strokeStyle = '#999'
      ctx.textBaseline = 'top'
    }
    return c
  }

  /** 剩余可用高度 */
  private get restH(): number {
    return PAGE_H - MARGIN - this.y
  }

  /** 内容不足时自动换页 */
  ensure(h: number): void {
    if (this.restH < h) this.nextPage()
  }

  private nextPage(): void {
    this.drawFooter()
    const c = this.newCanvas()
    this.ctx = c.getContext('2d') as CanvasRenderingContext2D
    this.pages.push(c)
    this.pageNo += 1
    this.y = MARGIN
  }

  /** 段落标题（一级） */
  heading(text: string): void {
    this.ensure(90)
    this.ctx.font = `bold 30px ${FONT_STACK}`
    this.y += 18
    this.ctx.fillText(text, MARGIN, this.y)
    this.y += 14
    this.ctx.beginPath()
    this.ctx.moveTo(MARGIN, this.y)
    this.ctx.lineTo(PAGE_W - MARGIN, this.y)
    this.ctx.stroke()
    this.y += 18
  }

  /** 正文行（自动按宽度换行并分页），返回结束 y */
  body(text: string, indent = 0): void {
    this.ctx.font = `22px ${FONT_STACK}`
    const maxW = PAGE_W - MARGIN * 2 - indent
    for (const line of wrapText(this.ctx, text, maxW)) {
      this.ensure(34)
      this.ctx.fillText(line, MARGIN + indent, this.y)
      this.y += 34
    }
  }

  /** 键值对行（标签加粗） */
  kv(label: string, value: string): void {
    this.ensure(34)
    this.ctx.font = `bold 22px ${FONT_STACK}`
    this.ctx.fillText(label, MARGIN, this.y)
    const labelW = this.ctx.measureText(label + '　').width
    this.ctx.font = `22px ${FONT_STACK}`
    this.ctx.fillText(value, MARGIN + labelW, this.y)
    this.y += 34
  }

  /** 斜纹占位图（影像不可用时的降级展示，对齐工程原则 4：如实降级） */
  placeholder(x: number, w: number, h: number, label: string): void {
    this.ensure(h + 16)
    const y0 = this.y
    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(x, y0, w, h)
    this.ctx.clip()
    this.ctx.lineWidth = 1
    for (let d = -h; d < w; d += 26) {
      this.ctx.beginPath()
      this.ctx.moveTo(x + d, y0 + h)
      this.ctx.lineTo(x + d + h, y0)
      this.ctx.stroke()
    }
    this.ctx.restore()
    this.ctx.strokeRect(x, y0, w, h)
    this.ctx.font = `20px ${FONT_STACK}`
    this.ctx.fillStyle = '#555'
    const tw = this.ctx.measureText(label).width
    this.ctx.fillText(label, x + (w - tw) / 2, y0 + h / 2 - 10)
    this.ctx.fillStyle = '#000'
    this.y = y0 + h + 16
  }

  /** 真实影像（objectURL 图像经 Image 加载后 drawImage，object-fit: cover 语义；下方一行日期标注） */
  async image(x: number, w: number, h: number, img: PhaseImageResult, caption: string): Promise<void> {
    this.ensure(h + 30)
    const y0 = this.y
    // cover：按目标宽高比裁剪绘制源图（GIBS 出图为正方形）
    const scale = Math.max(w / img.width, h / img.height)
    const sw = w / scale
    const sh = h / scale
    const sx = (img.width - sw) / 2
    const sy = (img.height - sh) / 2
    const bitmap = await loadBitmap(img.url)
    if (bitmap) {
      this.ctx.drawImage(bitmap, sx, sy, sw, sh, x, y0, w, h)
      if ('close' in bitmap) bitmap.close()
    } else {
      this.placeholder(x, w, h, '影像加载失败')
      return
    }
    this.ctx.font = `18px ${FONT_STACK}`
    this.ctx.fillStyle = '#555'
    const tw = this.ctx.measureText(caption).width
    this.ctx.fillText(caption, x + (w - tw) / 2, y0 + h + 6)
    this.ctx.fillStyle = '#000'
    this.y = y0 + h + 30
  }

  /** 横向表头行 */
  tableHeader(cells: Array<{ text: string; w: number }>): void {
    this.ensure(40)
    const y0 = this.y
    this.ctx.fillStyle = '#f0f0f0'
    this.ctx.fillRect(MARGIN, y0, cells.reduce((s, c) => s + c.w, 0), 40)
    this.ctx.fillStyle = '#000'
    this.ctx.font = `bold 22px ${FONT_STACK}`
    let x = MARGIN
    for (const c of cells) {
      this.ctx.fillText(c.text, x + 10, y0 + 9)
      x += c.w
    }
    this.y += 40
  }

  /** 表格数据行 */
  tableRow(cells: Array<{ text: string; w: number }>): void {
    this.ensure(38)
    const y0 = this.y
    this.ctx.font = `22px ${FONT_STACK}`
    let x = MARGIN
    for (const c of cells) {
      this.ctx.fillText(c.text, x + 10, y0 + 8)
      x += c.w
    }
    this.ctx.strokeStyle = '#ddd'
    this.ctx.beginPath()
    this.ctx.moveTo(MARGIN, y0 + 36)
    this.ctx.lineTo(PAGE_W - MARGIN, y0 + 36)
    this.ctx.stroke()
    this.ctx.strokeStyle = '#999'
    this.y += 38
  }

  /** 每页页脚：组织名 + 页码（PRD US-09 验收 4） */
  private drawFooter(): void {
    this.ctx.font = `18px ${FONT_STACK}`
    this.ctx.fillStyle = '#888'
    this.ctx.fillText(reportFooterOrg, MARGIN, PAGE_H - MARGIN + 30)
    const pn = `第 ${this.pageNo} 页 / 共 ${this.pages.length} 页`
    const w = this.ctx.measureText(pn).width
    this.ctx.fillText(pn, PAGE_W - MARGIN - w, PAGE_H - MARGIN + 30)
    this.ctx.fillStyle = '#000'
  }

  finish(): void {
    this.drawFooter()
  }
}

/** objectURL → ImageBitmap（失败返回 null，调用方降级占位） */
async function loadBitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const resp = await fetch(url)
    const blob = await resp.blob()
    return await createImageBitmap(blob)
  } catch {
    return null
  }
}

/** canvas 文本按像素宽度拆行 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW) {
      lines.push(line)
      line = ch
    } else {
      line += ch
    }
  }
  if (line) lines.push(line)
  return lines
}

/** 页脚组织名（模块级，导出时注入，避免 Pager 构造参数膨胀） */
let reportFooterOrg = '卫星遥感监测平台'

const ALERT_LEVEL_LABELS: Record<string, string> = { high: '高', medium: '中', low: '低' }

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 文件名：{组织简称}_{任务名}_{时间窗}_{生成日期}.pdf（PRD US-09 验收 4） */
export function buildReportFilename(
  tenantName: string,
  taskName: string,
  timeWindow: { start: string; end: string },
  generatedAt: string,
): string {
  const raw = `${tenantName}_${taskName}_${timeWindow.start}~${timeWindow.end}_${generatedAt.slice(0, 10)}.pdf`
  // 去除文件名非法字符
  return raw.replace(/[\\/:*?"<>|\s]/g, '_')
}

/**
 * 拉取任务结果并返回 patchId → bbox 映射与轻量要素（供举证图与统计矩阵；失败降级为空）。
 */
async function fetchPatchBBoxes(taskId: string): Promise<{
  byPatchId: Map<string, BBox>
  features: Array<{ patchId: string; changeType: string; alertLevel: string }>
}> {
  const byPatchId = new Map<string, BBox>()
  const features: Array<{ patchId: string; changeType: string; alertLevel: string }> = []
  try {
    const raw = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/results`)
    const fc = (raw as { geojson?: { features?: unknown[] } }).geojson
    for (const f of Array.isArray(fc?.features) ? fc.features : []) {
      const props = (f as { properties?: Record<string, unknown> }).properties
      const geom = (f as { geometry?: { coordinates?: unknown } }).geometry
      if (!props || typeof props.patchId !== 'string') continue
      features.push({
        patchId: props.patchId,
        changeType: String(props.changeType ?? '未知'),
        alertLevel: String(props.alertLevel ?? 'low'),
      })
      const bbox = bboxFromPolygonCoordinates(geom?.coordinates)
      if (bbox) byPatchId.set(props.patchId, bbox)
    }
  } catch {
    // 结果不可达：举证图降级占位、矩阵缺省，导出不中断（工程原则 4）
  }
  return { byPatchId, features }
}

/** 类型 × 告警等级计数矩阵行 */
function buildTypeLevelMatrix(features: Array<{ changeType: string; alertLevel: string }>): {
  rows: Array<{ type: string; high: number; medium: number; low: number; total: number }>
} {
  const byType = new Map<string, { high: number; medium: number; low: number }>()
  for (const f of features) {
    const row = byType.get(f.changeType) ?? { high: 0, medium: 0, low: 0 }
    if (f.alertLevel === 'high' || f.alertLevel === 'medium' || f.alertLevel === 'low') row[f.alertLevel] += 1
    byType.set(f.changeType, row)
  }
  const rows = [...byType.entries()].map(([type, r]) => ({
    type,
    high: r.high,
    medium: r.medium,
    low: r.low,
    total: r.high + r.medium + r.low,
  }))
  return { rows }
}

/**
 * 生成并下载报告 PDF（文字排版 + GIBS WMS 真实影像 + 统计矩阵）。
 * 影像与矩阵数据在导出前拉取（与预览共用 gibsImage 模块缓存与 /results 契约端点），
 * 任一外部依赖失败按占位/缺省降级，不阻断导出。
 * jsPDF 加载失败（CDN 不可达等）抛错，页面统一提示走打印主路径。
 */
export async function exportReportPdf(report: ReportDetail, tenantName: string): Promise<string> {
  const JsPdf = await loadJsPdf()
  const { overview, stats, methodology } = report.sections
  reportFooterOrg = `${tenantName} · 卫星遥感监测平台`

  // ---- 前置数据：AOI bbox、斑块 bbox、矩阵（与预览同一数据面） ----
  const aoiBBox = bboxFromPolygonCoordinates(overview.aoiGeojson?.coordinates)
  const patchData = await fetchPatchBBoxes(report.taskId)

  const pager = new CanvasPager()
  // ---- 封面 / 页眉 ----
  pager.heading(`${tenantName} · 监测报告`)
  pager.kv('任务名称', overview.taskName)
  pager.kv('监测类型', overview.monitorTypeLabel || overview.monitorType)
  pager.kv('报告期次', `${overview.timeWindow.start} ~ ${overview.timeWindow.end}`)
  pager.kv('生成时间', fmtDateTime(report.generatedAt))
  pager.kv('报告编号', report.id)

  // ---- ① 任务与 AOI 概述 ----
  pager.heading('一、任务与 AOI 概述')
  pager.kv('AOI 名称', overview.aoiName)
  pager.kv('AOI 面积', `${overview.aoiAreaKm2.toFixed(2)} km²`)
  pager.kv('时间窗', `${overview.timeWindow.start} ~ ${overview.timeWindow.end}`)
  pager.kv('云量上限', `${overview.cloudMaxPct}%`)
  pager.kv('影像景数', `${overview.dataSource.sceneCount} 景`)
  pager.body(`数据源：${overview.dataSource.note}`)
  const aoiImg = aoiBBox ? await getPhaseImage(aoiBBox, overview.timeWindow.end) : null
  if (aoiImg) {
    await pager.image(MARGIN, PAGE_W - MARGIN * 2, 320, aoiImg, `AOI 定位影像 · ${aoiImg.actualDate}`)
  } else {
    pager.placeholder(MARGIN, PAGE_W - MARGIN * 2, 320, 'AOI 定位影像（不可用）')
  }

  // ---- ② 数据源与方法说明 ----
  pager.heading('二、数据源与方法说明')
  pager.body(methodology.note)
  pager.body(
    '举证影像说明：斑块前后时相影像取自 NASA GIBS WMS（MODIS 真彩 250m），按斑块外接范围出图；' +
      '所指日期当日无覆盖时回退至邻近可用日期并在图下标注。',
  )

  // ---- ③ 变化统计：类型 × 告警等级矩阵 + byType 表 ----
  pager.heading('三、变化统计（类型 × 告警等级矩阵）')
  pager.kv('斑块总数', `${stats.patchCount} 个`)
  pager.kv('变化总面积', `${stats.totalAreaKm2.toFixed(4)} km²`)
  const matrix = buildTypeLevelMatrix(patchData.features)
  if (matrix.rows.length > 0) {
    pager.tableHeader([
      { text: '变化类型', w: 340 },
      { text: '高', w: 160 },
      { text: '中', w: 160 },
      { text: '低', w: 160 },
      { text: '合计', w: 140 },
    ])
    for (const r of matrix.rows) {
      pager.tableRow([
        { text: r.type, w: 340 },
        { text: String(r.high), w: 160 },
        { text: String(r.medium), w: 160 },
        { text: String(r.low), w: 160 },
        { text: String(r.total), w: 140 },
      ])
    }
    pager.y += 12
  }
  pager.tableHeader([
    { text: '变化类型', w: 380 },
    { text: '斑块数', w: 220 },
    { text: '面积（km²）', w: 260 },
  ])
  for (const row of stats.byType) {
    pager.tableRow([
      { text: row.changeType, w: 380 },
      { text: String(row.count), w: 220 },
      { text: row.areaKm2.toFixed(4), w: 260 },
    ])
  }

  // ---- ④ 重点斑块举证（Top10，前后时相真实影像） ----
  pager.heading('四、重点斑块举证（Top 10）')
  const imgW = (PAGE_W - MARGIN * 2 - 20) / 2
  for (const p of stats.top10Patches) {
    pager.ensure(260)
    pager.kv('斑块编号', p.patchId)
    pager.body(
      `面积 ${p.areaKm2.toFixed(4)} km² · 类型 ${p.changeType} · 置信度 ${(p.confidence * 100).toFixed(0)}%` +
        ` · 告警等级 ${ALERT_LEVEL_LABELS[p.alertLevel] ?? p.alertLevel} · 前时相 ${p.beforeDate} / 后时相 ${p.afterDate}`,
    )
    const bbox = patchData.byPatchId.get(p.patchId) ?? null
    const before = bbox ? await getPhaseImage(bbox, p.beforeDate) : null
    const after = bbox ? await getPhaseImage(bbox, p.afterDate) : null
    const startY = pager.y
    if (before) {
      await pager.image(MARGIN, imgW, 150, before, `前时相 ${before.actualDate}`)
    } else {
      pager.placeholder(MARGIN, imgW, 150, '前时相影像（不可用）')
    }
    // 右图与左图同行：回退 y 到行首，在右侧绘制
    pager.y = startY
    if (after) {
      await pager.image(MARGIN + imgW + 20, imgW, 150, after, `后时相 ${after.actualDate}`)
    } else {
      pager.placeholder(MARGIN + imgW + 20, imgW, 150, '后时相影像（不可用）')
    }
  }

  // ---- ⑤ 附录 ----
  pager.heading('五、附录')
  pager.body(
    '数据源清单：Sentinel-2 L2A 10m（Copernicus Data Space，CC-BY-4.0）；' +
      'Landsat 8/9 15-30m（USGS STAC，公共领域）；ESA WorldCover 2021 10m（CC-BY-4.0）；' +
      'NASA GIBS 影像瓦片（公共领域）。免责声明：本报告基于公开卫星数据自动生成，' +
      '变化斑块为算法初步识别结果，正式执法或对外发布前须结合现场核查确认。',
  )
  pager.finish()

  // ---- 位图合成 PDF（A4 pt：595.28 × 841.89） ----
  const doc = new JsPdf({ unit: 'pt', format: 'a4' })
  pager.pages.forEach((canvas, i) => {
    if (i > 0) doc.addPage()
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 595.28, 841.89)
  })
  const filename = buildReportFilename(tenantName, overview.taskName, overview.timeWindow, report.generatedAt)
  doc.save(filename)
  return filename
}

/** 导出失败时的统一降级提示（主路径 = 打印 / 保存 PDF） */
export function notifyPdfFallback(reason: unknown): void {
  const detail = reason instanceof Error ? reason.message : '未知错误'
  message.warning(`PDF 下载组件不可用（${detail}），已降级：请使用「打印 / 保存 PDF」导出`)
}
