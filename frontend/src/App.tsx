/**
 * 应用根组件：Provider 栈（Query → ConfigProvider zh_CN → Auth）+ 路由。
 * 路由：/login /workspace /tasks/create /tasks/:id/results /reports /subscription；
 * 受保护路由未登录统一重定向到 /login。
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { queryClient } from './api/client'
import { AuthProvider, useAuth } from './auth/AuthContext'
import AppLayout from './layouts/AppLayout'
import LoginPage from './pages/LoginPage'
import ReportsPage from './pages/ReportsPage'
import SubscriptionPage from './pages/SubscriptionPage'
import TaskCreatePage from './pages/TaskCreatePage'
import TaskResultsPage from './pages/TaskResultsPage'
import WorkspacePage from './pages/WorkspacePage'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider locale={zhCN}>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/"
                element={
                  <RequireAuth>
                    <AppLayout />
                  </RequireAuth>
                }
              >
                <Route index element={<Navigate to="/workspace" replace />} />
                <Route path="workspace" element={<WorkspacePage />} />
                <Route path="tasks/create" element={<TaskCreatePage />} />
                <Route path="tasks/:id/results" element={<TaskResultsPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="subscription" element={<SubscriptionPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/workspace" replace />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ConfigProvider>
    </QueryClientProvider>
  )
}
