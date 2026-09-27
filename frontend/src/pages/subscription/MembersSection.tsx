/**
 * 成员管理区（US-02/US-11.4）：本租户成员表（角色 Tag）+ 邀请成员（tenant_admin 专属）。
 * POST /api/subscription/members {name, role}（契约 §2），成功后刷新成员与审计缓存。
 * 角色差异说明：租户管理员可邀成员/配订阅，分析师可写任务，审批人只读（US-02 验收 2）。
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { UserAddOutlined } from '@ant-design/icons'
import { apiFetch } from '../../api/client'
import { MemberSchema, ROLE_LABELS, type Member, type Role } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { formatLocal } from './format'

const ROLE_TAG_COLOR: Record<Role, string> = {
  tenant_admin: 'gold',
  analyst: 'blue',
  approver: 'default',
}

interface MembersSectionProps {
  members: Member[]
  loading: boolean
  error: boolean
  onRetry: () => void
}

export default function MembersSection({ members, loading, error, onRetry }: MembersSectionProps) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'tenant_admin'
  const [inviteOpen, setInviteOpen] = useState(false)
  const [form] = Form.useForm<{ name: string; role: Role }>()

  const inviteMutation = useMutation({
    mutationFn: async (values: { name: string; role: Role }) =>
      MemberSchema.parse(
        await apiFetch<unknown>('/api/subscription/members', {
          method: 'POST',
          body: JSON.stringify(values),
        }),
      ),
    onSuccess: (member) => {
      message.success(`已邀请 ${member.name}（${ROLE_LABELS[member.role]}）加入本组织`)
      setInviteOpen(false)
      form.resetFields()
      // 邀请写审计（契约 §2），同时刷新席位用量来源
      void queryClient.invalidateQueries({ queryKey: ['members'] })
      void queryClient.invalidateQueries({ queryKey: ['audit-logs'] })
    },
    // 失败（重名/角色非法等 400）由 apiFetch 统一 toast，Modal 保持打开供修改重试
  })

  const submitInvite = async () => {
    const values = await form.validateFields()
    inviteMutation.mutate(values)
  }

  return (
    <Card
      title="成员管理"
      extra={
        <Tooltip title={isAdmin ? undefined : '成员邀请仅租户管理员可操作（US-02 角色差异）'}>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<UserAddOutlined />}
            disabled={!isAdmin}
            onClick={() => setInviteOpen(true)}
          >
            邀请成员
          </Button>
        </Tooltip>
      }
    >
      {loading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message="成员列表加载失败"
          description="服务暂不可达或请求超时，请稍后重试。"
          action={
            <Button size="small" danger onClick={onRetry}>
              重试
            </Button>
          }
        />
      ) : members.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本组织暂无成员" />
      ) : (
        <>
          <Table
            size="small"
            rowKey="id"
            dataSource={members}
            pagination={false}
            columns={[
              { title: '姓名', dataIndex: 'name' },
              {
                title: '角色',
                dataIndex: 'role',
                width: 160,
                render: (role: Role) => <Tag color={ROLE_TAG_COLOR[role]}>{ROLE_LABELS[role]}</Tag>,
              },
              {
                title: '加入时间',
                dataIndex: 'joinedAt',
                width: 160,
                render: (v: string) => <Typography.Text style={{ fontSize: 12 }}>{formatLocal(v)}</Typography.Text>,
              },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            角色差异：租户管理员（管理成员与订阅）/ 监测分析师（创建任务与 AOI）/ 决策审批者（只读）；
            成员仅能查看本组织数据。
          </Typography.Text>
        </>
      )}

      {/* ---- 邀请成员 Modal（tenant_admin 专属；MVP 免密，登录用户名由后端按姓名生成并记入审计） ---- */}
      <Modal
        title="邀请新成员"
        open={inviteOpen}
        confirmLoading={inviteMutation.isPending}
        okText="邀请"
        cancelText="取消"
        onOk={() => void submitInvite()}
        onCancel={() => setInviteOpen(false)}
      >
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item
            name="name"
            label="成员姓名"
            rules={[
              { required: true, message: '请输入成员姓名' },
              { whitespace: true, message: '姓名不能为空白字符' },
            ]}
          >
            <Input placeholder="如 Omar Al Rashid" maxLength={40} />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="analyst" rules={[{ required: true }]}>
            <Select
              options={(['tenant_admin', 'analyst', 'approver'] as Role[]).map((r) => ({
                value: r,
                label: ROLE_LABELS[r],
              }))}
            />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            MVP 演示环境免密：邀请成功后按姓名生成登录用户名（见审计日志），新成员自动归属本组织，
            不产生任何跨组织数据可见性变化（US-11.4）。
          </Typography.Text>
        </Form>
      </Modal>
    </Card>
  )
}
