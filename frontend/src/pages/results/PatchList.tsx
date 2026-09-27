/**
 * 斑块列表：按面积降序，点击即选中并联动地图飞行（经父级 focus 状态）。
 * 列表项展示置信度进度条（颜色与地图分色一致）、告警等级、是否已触发告警。
 */
import { useMemo } from 'react'
import { Progress, Tag, Typography } from 'antd'
import type { Alert } from '../../api/types'
import {
  alertLevelTagProps,
  confidenceColor,
  fmtHa,
  shortPatchId,
  type PatchFeature,
} from './patchStyle'

interface PatchListProps {
  patches: PatchFeature[]
  selectedPatchId: string | null
  /** patchId → 告警（用于列表上标记「已触发告警」） */
  alertByPatch: Map<string, Alert>
  onSelect: (patchId: string) => void
}

export default function PatchList({ patches, selectedPatchId, alertByPatch, onSelect }: PatchListProps) {
  const sorted = useMemo(
    () => [...patches].sort((a, b) => b.properties.areaKm2 - a.properties.areaKm2),
    [patches],
  )

  return (
    <div style={{ display: 'grid', gap: 8, maxHeight: 460, overflowY: 'auto', paddingRight: 4 }}>
      {sorted.map((f) => {
        const p = f.properties
        const selected = p.patchId === selectedPatchId
        const hasAlert = alertByPatch.has(p.patchId)
        return (
          <div
            key={p.patchId}
            onClick={() => onSelect(p.patchId)}
            style={{
              border: `1px solid ${selected ? '#1677ff' : '#f0f0f0'}`,
              background: selected ? 'rgba(22,119,255,0.06)' : '#fff',
              borderRadius: 8,
              padding: '8px 10px',
              cursor: 'pointer',
              display: 'grid',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  flex: '0 0 auto',
                  background: confidenceColor(p.confidence),
                }}
              />
              <Typography.Text strong style={{ fontSize: 13 }}>
                {p.changeType}
              </Typography.Text>
              <Tag style={{ marginInlineEnd: 0 }} color={alertLevelTagProps(p.alertLevel).color}>
                {alertLevelTagProps(p.alertLevel).label}
              </Tag>
              {hasAlert && (
                <Tag color="volcano" style={{ marginInlineEnd: 0 }}>
                  已触发告警
                </Tag>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
                {fmtHa(p.areaKm2)} 公顷
              </Typography.Text>
            </div>
            <Typography.Text code style={{ fontSize: 11 }} ellipsis>
              {shortPatchId(p.patchId)}
            </Typography.Text>
            <Progress
              percent={Math.round(p.confidence * 100)}
              size="small"
              strokeColor={confidenceColor(p.confidence)}
              format={(v) => `置信度 ${v}%`}
            />
          </div>
        )
      })}
    </div>
  )
}
