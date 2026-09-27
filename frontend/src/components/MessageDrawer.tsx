/**
 * 消息中心抽屉：展示 /api/messages 消息列表，点击已读 PUT /api/messages/{id}/read。
 * 数据轮询（30s）在 AppLayout 层做（顶栏未读徽标共享同一份数据），本组件纯展示 + 已读交互。
 * 注：MVP 消息量小（种子 5 条），直接用普通列表渲染；antd 6.6 已弃用 List，
 * 其替代品 Listy 是虚拟列表，等真实大列表用例出现再迁移。
 */
import { Drawer, Empty, Spin, Tag, Typography } from 'antd'
import type { Message } from '../api/types'

const TYPE_META: Record<Message['type'], { label: string; color: string }> = {
  alert: { label: '告警', color: 'red' },
  system: { label: '系统', color: 'blue' },
  task: { label: '任务', color: 'green' },
}

interface MessageDrawerProps {
  open: boolean
  loading: boolean
  messages: Message[]
  onClose: () => void
  /** 标记已读（调用方负责 PUT 与缓存失效） */
  onMarkRead: (id: string) => void
}

export default function MessageDrawer({
  open,
  loading,
  messages,
  onClose,
  onMarkRead,
}: MessageDrawerProps) {
  return (
    <Drawer title="消息中心" placement="right" size={420} open={open} onClose={onClose}>
      {loading && messages.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : messages.length === 0 ? (
        <Empty description="暂无消息" />
      ) : (
        <div>
          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                padding: '12px 4px',
                borderBottom: '1px solid #f0f0f0',
                cursor: msg.read ? 'default' : 'pointer',
              }}
              onClick={() => {
                if (!msg.read) onMarkRead(msg.id)
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Tag color={TYPE_META[msg.type].color}>{TYPE_META[msg.type].label}</Tag>
                <span style={{ fontWeight: msg.read ? 400 : 700 }}>{msg.title}</span>
                {!msg.read && <Tag color="processing">未读</Tag>}
              </div>
              <div style={{ color: 'rgba(0,0,0,0.65)', fontSize: 13 }}>{msg.body}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {msg.createdAt}
              </Typography.Text>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  )
}
