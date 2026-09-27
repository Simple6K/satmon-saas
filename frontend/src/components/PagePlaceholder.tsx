/**
 * 页面占位：地基阶段统一「建设中」空态。
 * 各页面代理接入真实功能时整文件替换页面组件即可，本组件可继续复用做空态。
 */
import { Card, Empty, Typography } from 'antd'

export default function PagePlaceholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card title={<Typography.Title level={4} style={{ margin: 0 }}>{title}</Typography.Title>}>
      <Empty description={hint ?? '建设中：本页面由页面模块接入后提供完整功能'} />
    </Card>
  )
}
