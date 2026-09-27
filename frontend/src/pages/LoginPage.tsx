/**
 * 登录页：MVP 免密，从种子账号（契约 §7）一键进入。
 * 登录成功写入会话并跳转工作台；已登录访问本页直接重定向。
 */
import { useMutation } from '@tanstack/react-query'
import { Card, Space, Tag, Typography, message } from 'antd'
import { GlobalOutlined, RocketOutlined } from '@ant-design/icons'
import { Navigate, useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { LoginRespSchema, ROLE_LABELS } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { SEED_USERS } from '../auth/seedUsers'

const ROLE_TAG_COLOR: Record<string, string> = {
  tenant_admin: 'gold',
  analyst: 'blue',
  approver: 'default',
}

export default function LoginPage() {
  const { user, signIn } = useAuth()
  const navigate = useNavigate()

  const loginMutation = useMutation({
    mutationFn: async (username: string) =>
      LoginRespSchema.parse(
        await apiFetch<unknown>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username }),
        }),
      ),
    onSuccess: (resp) => {
      signIn(resp.token, resp.user)
      message.success(`欢迎，${resp.user.name}（${resp.user.tenantName}）`)
      navigate('/workspace', { replace: true })
    },
  })

  if (user) return <Navigate to="/workspace" replace />

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
        padding: 24,
      }}
    >
      <Card style={{ width: 520 }}>
        <Space orientation="vertical" size={4} style={{ width: '100%', marginBottom: 16 }}>
          <Space>
            <RocketOutlined style={{ fontSize: 22, color: '#1677ff' }} />
            <Typography.Title level={3} style={{ margin: 0 }}>
              卫星遥感监测平台
            </Typography.Title>
          </Space>
          <Typography.Text type="secondary">
            面向政府客户的多租户区域监测 SaaS —— 选择演示账号进入对应租户
          </Typography.Text>
        </Space>
        {/* 注：antd 6.6 已弃用 List（替代品 Listy 为虚拟列表），种子账号仅 5 个，直接渲染 */}
        <div>
          {SEED_USERS.map((u) => (
            <div
              key={u.username}
              style={{
                cursor: 'pointer',
                padding: '10px 8px',
                borderRadius: 8,
                borderBottom: '1px solid #f0f0f0',
              }}
              onClick={() => loginMutation.mutate(u.username)}
            >
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Space>
                  <GlobalOutlined style={{ color: '#1677ff' }} />
                  <span>{u.tenantLabel}</span>
                </Space>
                <Space>
                  <span style={{ fontWeight: 600 }}>{u.name}</span>
                  <Tag color={ROLE_TAG_COLOR[u.role]}>{ROLE_LABELS[u.role]}</Tag>
                </Space>
              </Space>
            </div>
          ))}
        </div>
        {loginMutation.isPending && (
          <Typography.Text type="secondary">正在登录…</Typography.Text>
        )}
      </Card>
    </div>
  )
}
