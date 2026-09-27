/**
 * 向导第 2 步：任务名称、监测类型（四选一）、时间窗、云量上限 —— US-03。
 *
 * - 数据源说明为固定展示（契约 §4 的 POST /api/tasks 无数据源字段，
 *   MVP 由平台统一调度主源 OData + 备源 STAC，不提供假开关）
 * - 必填项缺失时「下一步」被阻断，且尝试前进后逐项高亮（US-03 验收）
 */
import dayjs, { type Dayjs } from 'dayjs'
import { DatePicker, Input, Radio, Slider, Typography } from 'antd'
import type { RangePickerProps } from 'antd/es/date-picker'
import { MONITOR_TYPE_LABELS, type MonitorType } from '../../api/types'
import type { TaskParams } from './types'

const { RangePicker } = DatePicker

/** 四类监测（契约 §3 枚举）+ 面向分析师的一句话说明 */
const MONITOR_OPTIONS: { value: MonitorType; desc: string }[] = [
  { value: 'illegal_construction', desc: '城市边缘未报批建设、施工迹象识别' },
  { value: 'farmland_non_agri', desc: '耕地被占用、硬化等非农化行为监测' },
  { value: 'urban_expansion', desc: '建成区边界蔓延与用地扩张监测' },
  { value: 'surface_change', desc: '水体、植被、裸地等地表覆盖转换' },
]

interface ParamsStepProps {
  params: TaskParams
  showErrors: boolean
  onChange: (next: TaskParams) => void
}

function FieldError({ show, text }: { show: boolean; text: string }) {
  if (!show) return null
  return (
    <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
      {text}
    </Typography.Text>
  )
}

export default function ParamsStep({ params, showErrors, onChange }: ParamsStepProps) {
  const nameInvalid = !params.name.trim()
  const typeInvalid = !params.monitorType
  const datesInvalid = !params.startDate || !params.endDate

  const onRangeChange: RangePickerProps['onChange'] = (values) => {
    if (values && values[0] && values[1]) {
      onChange({
        ...params,
        startDate: (values[0] as Dayjs).format('YYYY-MM-DD'),
        endDate: (values[1] as Dayjs).format('YYYY-MM-DD'),
      })
    } else {
      onChange({ ...params, startDate: '', endDate: '' })
    }
  }

  const blockStyle = { marginBottom: 28 } as const

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={blockStyle}>
        <Typography.Text strong>
          任务名称 <Typography.Text type="danger">*</Typography.Text>
        </Typography.Text>
        <Input
          style={{ marginTop: 4 }}
          maxLength={50}
          placeholder="例如：迪拜城市边缘区 2026 Q3 例行监测"
          status={showErrors && nameInvalid ? 'error' : undefined}
          value={params.name}
          onChange={(e) => onChange({ ...params, name: e.target.value })}
        />
        <FieldError show={showErrors && nameInvalid} text="请输入任务名称" />
      </div>

      <div style={blockStyle}>
        <Typography.Text strong>
          监测类型（四选一） <Typography.Text type="danger">*</Typography.Text>
        </Typography.Text>
        <Radio.Group
          style={{ marginTop: 4, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}
          value={params.monitorType || undefined}
          onChange={(e) => onChange({ ...params, monitorType: e.target.value as MonitorType })}
        >
          {MONITOR_OPTIONS.map((opt) => (
            <Radio
              key={opt.value}
              value={opt.value}
              style={{ alignItems: 'flex-start', marginInlineEnd: 0, whiteSpace: 'normal' }}
            >
              <Typography.Text strong>{MONITOR_TYPE_LABELS[opt.value]}</Typography.Text>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {opt.desc}
              </Typography.Text>
            </Radio>
          ))}
        </Radio.Group>
        <FieldError show={showErrors && typeInvalid} text="请选择监测类型" />
      </div>

      <div style={blockStyle}>
        <Typography.Text strong>
          监测时间窗 <Typography.Text type="danger">*</Typography.Text>
        </Typography.Text>
        <div style={{ marginTop: 4 }}>
          <RangePicker
            style={{ width: 320 }}
            status={showErrors && datesInvalid ? 'error' : undefined}
            value={
              params.startDate && params.endDate
                ? [dayjs(params.startDate), dayjs(params.endDate)]
                : null
            }
            onChange={onRangeChange}
            disabledDate={(d) => d.isAfter(dayjs(), 'day')}
            allowEmpty={[false, false]}
          />
        </div>
        <FieldError show={showErrors && datesInvalid} text="请选择监测时间窗（开始早于结束，不可选未来日期）" />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          时间窗用于影像检索过滤（ContentDate），也作为双时相变化检测的比对范围。
        </Typography.Paragraph>
      </div>

      <div style={blockStyle}>
        <Typography.Text strong>云量上限过滤</Typography.Text>
        <Slider
          style={{ maxWidth: 420 }}
          min={0}
          max={100}
          step={1}
          marks={{ 0: '0%', 20: '20%', 50: '50%', 80: '80%', 100: '100%' }}
          value={params.cloudMaxPct}
          onChange={(v) => onChange({ ...params, cloudMaxPct: v })}
          tooltip={{ formatter: (v) => `≤ ${v}%` }}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
          默认 ≤ 20%（低云影像质量门槛）；阈值越低可用景数越少，检索预演会如实反馈。
        </Typography.Paragraph>
      </div>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        数据源（平台统一调度，无需手工选择）：主源 Sentinel-2 L2A · Copernicus OData 目录
        （10m 分辨率，影像延迟 ≤ 5 天，8s 硬超时）；主源故障自动降级 Landsat 8/9 · USGS STAC
        （15–30m，分辨率降级会使最小可识别斑块增大）。
      </Typography.Paragraph>
    </div>
  )
}
