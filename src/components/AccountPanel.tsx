import { useState } from 'react'
import type { FormEvent } from 'react'
import { Cloud, LoaderCircle, LogIn, LogOut, RefreshCw, UserPlus } from 'lucide-react'
import type { AccountSyncController } from '../hooks/useAccountSync.ts'
import './account-panel.css'

interface AccountPanelProps {
  account: AccountSyncController
}

export function AccountPanel({ account }: AccountPanelProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const busy = account.phase === 'checking' || account.phase === 'syncing'

  if (account.user) {
    return (
      <div className="account-panel">
        <div className="account-identity">
          <span className="account-avatar" aria-hidden="true">
            {account.user.username.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{account.user.username}</strong>
            <span>游戏库已绑定到此账号</span>
          </div>
        </div>
        <div
          className={`account-sync-status ${account.phase === 'error' ? 'is-error' : ''}`}
          role="status"
        >
          {busy ? (
            <LoaderCircle size={16} className="account-spinner" aria-hidden="true" />
          ) : (
            <Cloud size={16} />
          )}
          <div>
            <strong>
              {account.phase === 'syncing'
                ? '正在同步'
                : account.phase === 'error'
                  ? '同步需要处理'
                  : '账号同步已开启'}
            </strong>
            <span>{account.message}</span>
            {account.lastSyncedAt ? (
              <small>
                上次同步 {new Date(account.lastSyncedAt).toLocaleString('zh-CN')}
                {account.revision ? ` · 版本 ${account.revision}` : ''}
              </small>
            ) : null}
          </div>
        </div>
        <div className="account-actions">
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() => void account.syncNow()}
          >
            <RefreshCw size={16} />
            立即同步
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => void account.signOut()}
          >
            <LogOut size={16} />
            退出登录
          </button>
        </div>
        <p className="small-note">退出后不会删除此浏览器中的游戏；账号快照仍保留在服务端。</p>
      </div>
    )
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (mode === 'register' && password !== confirmPassword) return
    if (mode === 'register') await account.signUp(username, password).catch(() => {})
    else await account.signIn(username, password).catch(() => {})
  }

  return (
    <div className="account-panel">
      <div className="account-tabs" role="tablist" aria-label="账号操作">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'login'}
          onClick={() => setMode('login')}
        >
          登录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'register'}
          onClick={() => setMode('register')}
        >
          注册
        </button>
      </div>
      <form className="account-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>用户名</span>
          <input
            name="username"
            autoComplete="username"
            minLength={3}
            maxLength={32}
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          <span>密码</span>
          <input
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={8}
            maxLength={128}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {mode === 'register' ? (
          <label>
            <span>确认密码</span>
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
              aria-invalid={Boolean(confirmPassword && confirmPassword !== password)}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            {confirmPassword && confirmPassword !== password ? (
              <small>两次输入的密码不一致。</small>
            ) : null}
          </label>
        ) : null}
        <button
          className="button primary account-submit"
          type="submit"
          disabled={busy || (mode === 'register' && password !== confirmPassword)}
        >
          {busy ? (
            <LoaderCircle size={16} className="account-spinner" />
          ) : mode === 'login' ? (
            <LogIn size={16} />
          ) : (
            <UserPlus size={16} />
          )}
          {mode === 'login' ? '登录并恢复' : '创建账号并同步'}
        </button>
      </form>
      <div
        className={`account-feedback ${account.phase === 'error' ? 'is-error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {account.message}
      </div>
      <p className="small-note">
        账号同步包含 ROM、游戏内存档和即时存档。未登录时仍使用当前浏览器的本地存储。
      </p>
    </div>
  )
}
