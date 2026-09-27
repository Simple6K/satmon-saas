/**
 * 应用壳：antd Layout。
 * - 顶栏：租户标识（切换种子用户即切换租户，演示多租户数据隔离）、当前用户/角色、
 *   消息铃铛（未读徽标，30s 轮询）、退出
 * - 侧边菜单：工作台 / 监测任务 / 结果查看 / 报告中心 / 订阅管理
 * - 内容区：路由出口
 */
import { useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BellOutlined,
  DashboardOutlined,
  EyeOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LogoutOutlined,
  PlusCircleOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { Avatar, Badge, Button, Dropdown, Layout, Menu, Space, Tag, Typography, message } from 'antd'
import type { MenuProps } from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api/client'
import { LoginRespSchema, MessageSchema, ROLE_LABELS } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { SEED_USERS } from '../auth/seedUsers'
import MessageDrawer from '../components/MessageDrawer'

const { Header, Sider, Content } = Layout

/**
 * 顶栏「结果查看」菜单暂指向占位路由（真实入口需要任务 id，
 * 由页面代理接入后改为「最近完成任务 → /tasks/:id/results」）。
 */
const RESULTS_PLACEHOLDER_KEY = '/tasks/0/results'

const MENU_ITEMS = [
  { key: '/workspace', icon: <DashboardOutlined />, label: '工作台' },
  { key: '/tasks/create', icon: <PlusCircleOutlined />, label: '监测任务' },
  { key: RESULTS_PLACEHOLDER_KEY, icon: <EyeOutlined />, label: '结果查看' },
  { key: '/reports', icon: <FileTextOutlined />, label: '报告中心' },
  { key: '/subscription', icon: <TeamOutlined />, label: '订阅管理' },
]

const ROLE_TAG_COLOR: Record<string, string> = {
  tenant_admin: 'gold',
  analyst: 'blue',
  approver: 'default',
}

export default function AppLayout() {
  const { user, signIn, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [msgDrawerOpen, setMsgDrawerOpen] = useState(false)

  // 消息中心：30s 轮询（顶栏徽标与抽屉共享同一缓存）
  const messagesQuery = useQuery({
    queryKey: ['messages'],
    queryFn: async () => MessageSchema.array().parse(await apiFetch<unknown>('/api/messages')),
    refetchInterval: 30_000,
  })

  const markReadMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/messages/${id}/read`, { method: 'PUT' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] })
    },
  })

  // 切换租户 = 切换种子用户重新登录（MVP 免密），随后清空全部查询缓存以重建租户视图
  const switchUserMutation = useMutation({
    mutationFn: async (username: string) =>
      LoginRespSchema.parse(
        await apiFetch<unknown>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username }),
        }),
      ),
    onSuccess: (resp) => {
      signIn(resp.token, resp.user)
      queryClient.clear()
      message.success(`已切换到 ${resp.user.tenantName}（${resp.user.name}）`)
    },
  })

  const unreadCount = useMemo(
    () => (messagesQuery.data ?? []).filter((m) => !m.read).length,
    [messagesQuery.data],
  )

  const selectedKeys = useMemo(() => {
    const p = location.pathname
    if (p.startsWith('/tasks/') && p.endsWith('/results')) return [RESULTS_PLACEHOLDER_KEY]
    if (p.startsWith('/tasks')) return ['/tasks/create']
    return [p]
  }, [location.pathname])

  if (!user) return null

  // 顶栏租户标识：优先用种子清单里的租户文案，后端未返回时也有稳定展示
  const tenantLabel = SEED_USERS.find((u) => u.tenantId === user.tenantId)?.tenantLabel

  const tenantMenuItems: MenuProps['items'] = SEED_USERS.map((u) => ({
    key: u.username,
    label: `${u.tenantLabel} · ${u.name}（${ROLE_LABELS[u.role]}）`,
    disabled: user.id === u.username || switchUserMutation.isPending,
  }))

  return (
    <Layout style={{ minHeight: '100%' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: '#001529',
          paddingInline: 24,
        }}
      >
        <Space size={16}>
          <Typography.Title level={5} style={{ color: '#fff', margin: 0, whiteSpace: 'nowrap' }}>
            卫星遥感监测平台
          </Typography.Title>
          <Dropdown
            menu={{
              items: tenantMenuItems,
              onClick: ({ key }) => switchUserMutation.mutate(String(key)),
            }}
          >
            <Button ghost icon={<GlobalOutlined />} style={{ color: '#fff' }}>
              {tenantLabel ?? user.tenantName} ▾
            </Button>
          </Dropdown>
        </Space>
        <Space size={16}>
          <Badge count={unreadCount} size="small">
            <Button
              type="text"
              aria-label="消息中心"
              icon={<BellOutlined style={{ color: '#fff', fontSize: 18 }} />}
              onClick={() => setMsgDrawerOpen(true)}
            />
          </Badge>
          <Space size={8} style={{ color: '#fff' }}>
            <Avatar size="small" style={{ backgroundColor: '#1677ff' }}>
              {user.name.slice(0, 1)}
            </Avatar>
            <span>{user.name}</span>
            <Tag color={ROLE_TAG_COLOR[user.role]}>{ROLE_LABELS[user.role]}</Tag>
          </Space>
          <Button
            type="text"
            icon={<LogoutOutlined style={{ color: '#fff' }} />}
            onClick={() => {
              signOut()
              navigate('/login', { replace: true })
            }}
          >
            <span style={{ color: '#fff' }}>退出</span>
          </Button>
        </Space>
      </Header>
      <Layout>
        <Sider width={200} theme="dark">
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={selectedKeys}
            items={MENU_ITEMS}
            onClick={({ key }) => navigate(key)}
            style={{ height: '100%', borderRight: 0, paddingTop: 8 }}
          />
        </Sider>
        <Content style={{ padding: 16, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
      <MessageDrawer
        open={msgDrawerOpen}
        loading={messagesQuery.isLoading}
        messages={messagesQuery.data ?? []}
        onClose={() => setMsgDrawerOpen(false)}
        onMarkRead={(id) => markReadMutation.mutate(id)}
      />
    </Layout>
  )
}
