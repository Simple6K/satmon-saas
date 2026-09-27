/**
 * 前后时相举证图组件：按斑块范围真实拉取 GIBS WMS 影像（前/后两个日期），
 * 当天无数据自动回退邻近日期并标注实际日期；全部失败显示降级占位（工程原则 4/5）。
 * 点击任意图打开详情弹窗：1024px 大图（前/后时相）+ Esri 高清现状参考图。
 */
import { useEffect, useState } from 'react'
import { Modal, Skeleton, Tag } from 'antd'
import { ZoomInOutlined } from '@ant-design/icons'
import { getEsriCurrentImage, getPhaseImage, type BBox, type PhaseImageResult } from './gibsImage'
import { getWaybackImage, waybackProbeState } from './wayback'

/** 预览缩略图 / 详情大图的出图边长 */
const THUMB_SIZE = 384
const DETAIL_SIZE = 1024

type Phase = 'before' | 'after'

/**
 * 带日期影像（详情弹窗用）：Esri Wayback 高清档案优先，不可达/无图降级 GIBS MODIS。
 * 返回 viaWayback 供 UI 标注来源。
 */
function useDatedImage(
  bbox: BBox | null,
  date: string,
): { img: PhaseImageResult | null; loading: boolean; viaWayback: boolean } {
  const [state, setState] = useState<{ img: PhaseImageResult | null; viaWayback: boolean }>({
    img: null,
    viaWayback: false,
  })
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setState({ img: null, viaWayback: false })
    if (!bbox) {
      setLoading(false)
      return
    }
    setLoading(true)
    void (async () => {
      let img = await getWaybackImage(bbox, date)
      let viaWayback = true
      if (!img) {
        img = await getPhaseImage(bbox, date, DETAIL_SIZE)
        viaWayback = false
      }
      if (!cancelled) {
        setState({ img, viaWayback })
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bbox?.minLng, bbox?.minLat, bbox?.maxLng, bbox?.maxLat, date])
  return { ...state, loading }
}

function usePhaseImage(bbox: BBox | null, date: string, size: number): { img: PhaseImageResult | null; loading: boolean } {
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
    getPhaseImage(bbox, date, size)
      .then((r) => {
        if (!cancelled) setImg(r)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bbox?.minLng, bbox?.minLat, bbox?.maxLng, bbox?.maxLat, date, size])
  return { img, loading }
}

function useEsriImage(bbox: BBox | null): { img: PhaseImageResult | null; loading: boolean } {
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
    getEsriCurrentImage(bbox, DETAIL_SIZE)
      .then((r) => {
        if (!cancelled) setImg(r)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bbox?.minLng, bbox?.minLat, bbox?.maxLng, bbox?.maxLat])
  return { img, loading }
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 12, color: '#595959', display: 'block', textAlign: 'center' }}>{children}</span>
  )
}

/** 详情弹窗：前/后高清时相（Wayback 优先 / GIBS 降级）+ Esri 高清现状参考 */
function PhaseDetailModal({
  open,
  onClose,
  bbox,
  beforeDate,
  afterDate,
  patchId,
}: {
  open: boolean
  onClose: () => void
  bbox: BBox | null
  beforeDate: string
  afterDate: string
  patchId?: string
}) {
  const before = useDatedImage(bbox, beforeDate)
  const after = useDatedImage(bbox, afterDate)
  const esri = useEsriImage(bbox)
  const [waybackOk, setWaybackOk] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void waybackProbeState().then((ok) => {
      if (!cancelled) setWaybackOk(ok)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const big = (
    state: { img: PhaseImageResult | null; loading: boolean; viaWayback: boolean },
    label: string,
    date: string,
    tagColor: string,
  ) => (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ width: '100%', aspectRatio: '1 / 1', overflow: 'hidden', border: '1px solid #d9d9d9', background: '#fafafa' }}>
        {state.loading ? (
          <Skeleton.Image active style={{ width: '100%', height: '100%' }} />
        ) : state.img ? (
          <img src={state.img.url} alt={`${label}大图`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <div className="report-placeholder" style={{ height: '100%' }}>{label}影像（不可用）</div>
        )}
      </div>
      <Caption>
        {label}{' '}
        {state.img ? (
          <>
            <Tag color={tagColor} style={{ marginInlineEnd: 4 }}>{state.img.actualDate}</Tag>
            {state.viaWayback ? (
              <Tag color="purple" style={{ marginInlineEnd: 4 }}>Esri Wayback 高清</Tag>
            ) : (
              <Tag style={{ marginInlineEnd: 4 }}>MODIS 250m</Tag>
            )}
            {state.img.actualDate !== date && (
              <span style={{ color: '#faad14' }}>
                （{state.viaWayback ? '按就近版本匹配' : '当日无影像，回退邻近日期'}）
              </span>
            )}
          </>
        ) : (
          <span>{date}（无可用影像）</span>
        )}
      </Caption>
    </div>
  )

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1080}
      title={
        <span>
          斑块影像详情{patchId ? ` · ${patchId}` : ''}
          <span style={{ fontSize: 12, fontWeight: 400, color: '#999', marginLeft: 10 }}>
            前后时相：Esri Wayback 高清档案（自动降级 GIBS MODIS 250m）· 现状参考：Esri 高清镶嵌
          </span>
        </span>
      }
    >
      {waybackOk === false && (
        <div style={{ marginBottom: 10 }}>
          <Tag color="orange">降级</Tag>
          <span style={{ fontSize: 12, color: '#8c8c8c' }}>
            Esri Wayback 高清档案当前网络不可达，前后时相已降级为 GIBS MODIS 250m（有日期、分辨率受限）；
            网络恢复或部署于可达环境后自动使用高清版本。
          </span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {big(before, '前时相', beforeDate, 'blue')}
        {big(after, '后时相', afterDate, 'green')}
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ width: '100%', aspectRatio: '2 / 1', overflow: 'hidden', border: '1px solid #d9d9d9', background: '#fafafa' }}>
            {esri.loading ? (
              <Skeleton.Image active style={{ width: '100%', height: '100%' }} />
            ) : esri.img ? (
              <img src={esri.img.url} alt="Esri 高清现状参考" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : (
              <div className="report-placeholder" style={{ height: '100%' }}>Esri 高清现状图（不可用）</div>
            )}
          </div>
          <Caption>
            现状高清参考（Esri World Imagery，最新合成镶嵌、非当日）· 用于斑块细节核验；时相对比以上方 GIBS 影像为准
          </Caption>
        </div>
      </div>
    </Modal>
  )
}

function PhaseBox({
  bbox,
  date,
  phase,
  height,
  onOpenDetail,
}: {
  bbox: BBox | null
  date: string
  phase: Phase
  height: number
  onOpenDetail: () => void
}) {
  const { img, loading } = usePhaseImage(bbox, date, THUMB_SIZE)
  const label = phase === 'before' ? '前时相' : '后时相'
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <div
        className="report-phase-img"
        style={{
          height,
          position: 'relative',
          overflow: 'hidden',
          cursor: img ? 'zoom-in' : 'default',
          border: '1px solid #eee',
        }}
        onClick={img ? onOpenDetail : undefined}
        title={img ? '点击查看大图（1024px 前后对比 + 高清现状参考）' : undefined}
      >
        {loading ? (
          <Skeleton.Image active style={{ width: '100%', height }} />
        ) : img ? (
          <>
            <img
              src={img.url}
              alt={`${label}影像 ${img.actualDate}`}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            <ZoomInOutlined
              style={{
                position: 'absolute',
                right: 6,
                bottom: 4,
                color: '#fff',
                fontSize: 14,
                textShadow: '0 0 3px rgba(0,0,0,0.6)',
              }}
            />
          </>
        ) : (
          <div className="report-placeholder" style={{ height }}>
            {label}影像（不可用）
          </div>
        )}
      </div>
      <Caption>
        {label}{' '}
        {img ? (
          <>
            <Tag color={phase === 'before' ? 'blue' : 'green'} style={{ marginInlineEnd: 4 }}>
              {img.actualDate}
            </Tag>
            {img.actualDate !== date && <span style={{ color: '#faad14' }}>（当日无影像，回退邻近日期）</span>}
          </>
        ) : (
          <span>{date}（无可用影像）</span>
        )}
      </Caption>
    </div>
  )
}

export default function PhaseImage({
  bbox,
  beforeDate,
  afterDate,
  height = 110,
  patchId,
}: {
  bbox: BBox | null
  beforeDate: string
  afterDate: string
  height?: number
  patchId?: string
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
        <PhaseBox bbox={bbox} date={beforeDate} phase="before" height={height} onOpenDetail={() => setDetailOpen(true)} />
        <PhaseBox bbox={bbox} date={afterDate} phase="after" height={height} onOpenDetail={() => setDetailOpen(true)} />
      </div>
      <PhaseDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        bbox={bbox}
        beforeDate={beforeDate}
        afterDate={afterDate}
        patchId={patchId}
      />
    </>
  )
}

/** 单图：AOI 定位图等场景（同样支持点击放大） */
export function AoiImage({ bbox, date, height = 220 }: { bbox: BBox | null; date: string; height?: number }) {
  const { img, loading } = usePhaseImage(bbox, date, THUMB_SIZE)
  const [detailOpen, setDetailOpen] = useState(false)
  const detail = usePhaseImage(detailOpen ? bbox : null, date, DETAIL_SIZE)
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <div
        style={{
          height,
          position: 'relative',
          overflow: 'hidden',
          border: '1px solid #d9d9d9',
          cursor: img ? 'zoom-in' : 'default',
        }}
        onClick={img ? () => setDetailOpen(true) : undefined}
        title={img ? '点击查看大图' : undefined}
      >
        {loading ? (
          <Skeleton.Image active style={{ width: '100%', height }} />
        ) : img ? (
          <>
            <img
              src={img.url}
              alt={`AOI 定位影像 ${img.actualDate}`}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            <ZoomInOutlined style={{ position: 'absolute', right: 6, bottom: 4, color: '#fff', fontSize: 14, textShadow: '0 0 3px rgba(0,0,0,0.6)' }} />
          </>
        ) : (
          <div className="report-placeholder" style={{ height }}>
            AOI 定位影像（不可用）
          </div>
        )}
      </div>
      <Caption>
        AOI 定位影像（MODIS 真彩）·{' '}
        {img ? img.actualDate : `${date}（无可用影像）`}
        {img && img.actualDate !== date ? '（当日无影像，回退邻近日期）' : ''}
      </Caption>
      <Modal open={detailOpen} onCancel={() => setDetailOpen(false)} footer={null} width={1080} title="AOI 定位影像（大图）">
        {detail.loading ? (
          <Skeleton.Image active style={{ width: '100%', height: 480 }} />
        ) : detail.img ? (
          <img src={detail.img.url} alt="AOI 大图" style={{ width: '100%', display: 'block' }} />
        ) : (
          <div className="report-placeholder" style={{ height: 480 }}>大图不可用</div>
        )}
      </Modal>
    </div>
  )
}
