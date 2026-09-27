/**
 * 前后时相举证图组件：按斑块范围真实拉取 GIBS WMS 影像（前/后两个日期），
 * 当天无数据自动回退邻近日期并标注实际日期；全部失败显示降级占位（工程原则 4/5）。
 */
import { useEffect, useState } from 'react'
import { Skeleton, Tag } from 'antd'
import { getPhaseImage, type BBox, type PhaseImageResult } from './gibsImage'

type Phase = 'before' | 'after'

function usePhaseImage(bbox: BBox | null, date: string): { img: PhaseImageResult | null; loading: boolean } {
  const [img, setImg] = useState<PhaseImageResult | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setImg(null)
    if (!bbox) {
      setLoading(false)
      return
    }
    setLoading(true)
    getPhaseImage(bbox, date)
      .then((r) => {
        if (!cancelled) setImg(r)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bbox?.minLng, bbox?.minLat, bbox?.maxLng, bbox?.maxLat, date])
  return { img, loading }
}

function PhaseBox({
  bbox,
  date,
  phase,
  height,
}: {
  bbox: BBox | null
  date: string
  phase: Phase
  height: number
}) {
  const { img, loading } = usePhaseImage(bbox, date)
  const label = phase === 'before' ? '前时相' : '后时相'
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <div className="report-phase-img" style={{ height, position: 'relative', overflow: 'hidden' }}>
        {loading ? (
          <Skeleton.Image active style={{ width: '100%', height }} />
        ) : img ? (
          <img
            src={img.url}
            alt={`${label}影像 ${img.actualDate}`}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div className="report-placeholder" style={{ height }}>
            {label}影像（不可用）
          </div>
        )}
      </div>
      <TypographySmall>
        {label} {img ? (
          <>
            <Tag color={phase === 'before' ? 'blue' : 'green'} style={{ marginInlineEnd: 4 }}>
              {img.actualDate}
            </Tag>
            {img.actualDate !== date && <span style={{ color: '#faad14' }}>（当日无影像，回退邻近日期）</span>}
          </>
        ) : (
          <span>{date}（无可用影像）</span>
        )}
      </TypographySmall>
    </div>
  )
}

function TypographySmall({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 12, color: '#595959', display: 'block', textAlign: 'center' }}>{children}</span>
  )
}

export default function PhaseImage({
  bbox,
  beforeDate,
  afterDate,
  height = 110,
}: {
  bbox: BBox | null
  beforeDate: string
  afterDate: string
  height?: number
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
      <PhaseBox bbox={bbox} date={beforeDate} phase="before" height={height} />
      <PhaseBox bbox={bbox} date={afterDate} phase="after" height={height} />
    </div>
  )
}

/** 单图：AOI 定位图等场景 */
export function AoiImage({ bbox, date, height = 220 }: { bbox: BBox | null; date: string; height?: number }) {
  const { img, loading } = usePhaseImage(bbox, date)
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <div style={{ height, position: 'relative', overflow: 'hidden', border: '1px solid #d9d9d9' }}>
        {loading ? (
          <Skeleton.Image active style={{ width: '100%', height }} />
        ) : img ? (
          <img
            src={img.url}
            alt={`AOI 定位影像 ${img.actualDate}`}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div className="report-placeholder" style={{ height }}>
            AOI 定位影像（不可用）
          </div>
        )}
      </div>
      <TypographySmall>
        AOI 定位影像（Sentinel 区域底图 · MODIS 真彩）·{' '}
        {img ? img.actualDate : `${date}（无可用影像）`}
        {img && img.actualDate !== date ? '（当日无影像，回退邻近日期）' : ''}
      </TypographySmall>
    </div>
  )
}
