/**
 * 种子账号清单（契约 §7）——MVP 免密登录，用户名须在种子表内。
 * 登录页与顶栏「切换租户」共用此清单。
 */
import type { Role } from '../api/types'

export interface SeedUser {
  username: string
  name: string
  role: Role
  tenantId: string
  /** 顶栏租户标识文案 */
  tenantLabel: string
}

export const SEED_USERS: SeedUser[] = [
  {
    username: 'khalid',
    name: 'Khalid',
    role: 'tenant_admin',
    tenantId: 'dubai_municipality',
    tenantLabel: 'Dubai Municipality · 规划监察',
  },
  {
    username: 'ahmed',
    name: 'Ahmed',
    role: 'analyst',
    tenantId: 'dubai_municipality',
    tenantLabel: 'Dubai Municipality · 规划监察',
  },
  {
    username: 'fatima',
    name: 'Fatima',
    role: 'approver',
    tenantId: 'dubai_municipality',
    tenantLabel: 'Dubai Municipality · 规划监察',
  },
  {
    username: 'nora',
    name: 'Nora',
    role: 'tenant_admin',
    tenantId: 'mewa_riyadh',
    tenantLabel: '沙特 MEWA · 利雅得',
  },
  {
    username: 'sameer',
    name: 'Sameer',
    role: 'analyst',
    tenantId: 'mewa_riyadh',
    tenantLabel: '沙特 MEWA · 利雅得',
  },
]
