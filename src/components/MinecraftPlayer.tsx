import { useEffect, useRef, useState } from 'react'
import { ExternalLink, LoaderCircle, Play, Square, X } from 'lucide-react'
import { getMinecraftBlob, type MinecraftInstalledVersion } from '../lib/minecraft-storage.ts'

interface MinecraftPlayerProps {
  version: MinecraftInstalledVersion
  onClose: () => void
}

type PlayerPhase = 'ready' | 'loading' | 'running' | 'ended' | 'error'

export function MinecraftPlayer({ version, onClose }: MinecraftPlayerProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const frameReadyRef = useRef(false)
  const clientRef = useRef<ArrayBuffer | undefined>(undefined)
  const timerRef = useRef<number | undefined>(undefined)
  const [accepted, setAccepted] = useState(false)
  const [phase, setPhase] = useState<PlayerPhase>('ready')
  const [message, setMessage] = useState('')
  const [seconds, setSeconds] = useState(180)

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frameRef.current?.contentWindow
      )
        return
      const value = event.data as { type?: string; message?: string }
      if (value.type === 'orbitra-minecraft-running') {
        setPhase('running')
        setMessage('')
        timerRef.current = window.setInterval(() => {
          setSeconds((remaining) => {
            if (remaining <= 1) {
              if (timerRef.current) window.clearInterval(timerRef.current)
              setPhase('ended')
              return 0
            }
            return remaining - 1
          })
        }, 1000)
      } else if (value.type === 'orbitra-minecraft-status') {
        setMessage(value.message ?? '正在启动浏览器运行时…')
      } else if (value.type === 'orbitra-minecraft-error') {
        setMessage(value.message ?? '浏览器运行失败。')
        setPhase('error')
      }
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      if (timerRef.current) window.clearInterval(timerRef.current)
      document.exitPointerLock?.()
    }
  }, [])

  const postClient = () => {
    const client = clientRef.current
    const target = frameRef.current?.contentWindow
    if (!client || !target || !frameReadyRef.current) return
    target.postMessage({ type: 'orbitra-minecraft-start', client }, window.location.origin, [
      client,
    ])
    clientRef.current = undefined
  }

  const start = async () => {
    const client = version.files.find((file) => file.kind === 'client')
    if (!client) {
      setMessage('本地版本缺少客户端 JAR。')
      setPhase('error')
      return
    }
    setPhase('loading')
    setMessage('正在读取已校验的官方客户端…')
    try {
      const stored = await getMinecraftBlob(client.sha1)
      if (!stored) throw new Error('客户端 JAR 不在本地，请先校验并修复版本。')
      clientRef.current = await stored.data.arrayBuffer()
      setMessage('正在加载 CheerpJ 浏览器 Java 运行时…')
      postClient()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法读取本地客户端。')
      setPhase('error')
    }
  }

  const bootFrame = () => {
    frameReadyRef.current = true
    postClient()
  }

  const runtimeActive = phase === 'loading' || phase === 'running'
  return (
    <div
      className="minecraft-player-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Minecraft 浏览器试玩"
    >
      <div className="minecraft-player">
        <header>
          <div>
            <strong>Minecraft Java Edition 1.2.5</strong>
            <span>CheerpJ 浏览器演示 · 最长 3 分钟</span>
          </div>
          {phase === 'running' && (
            <time aria-label="剩余试玩时间">
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
            </time>
          )}
          <button className="icon-button" aria-label="退出浏览器试玩" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className={`minecraft-display ${phase}`}>
          {phase === 'ready' && (
            <div className="minecraft-player-prompt">
              <h2>在浏览器中运行</h2>
              <p>运行未修改的官方 1.2.5 客户端。此技术演示不等同于完整启动器，也不绕过游戏授权。</p>
              <label>
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                <span>
                  我已阅读并接受{' '}
                  <a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">
                    Minecraft EULA <ExternalLink size={12} />
                  </a>
                </span>
              </label>
              <button className="button primary" disabled={!accepted} onClick={() => void start()}>
                <Play size={16} fill="currentColor" />
                开始浏览器试玩
              </button>
            </div>
          )}
          {runtimeActive && (
            <iframe
              ref={frameRef}
              title="Minecraft 1.2.5 浏览器运行画面"
              src="/minecraft-player.html"
              allow="fullscreen; pointer-lock"
              onLoad={bootFrame}
            />
          )}
          {phase === 'loading' && (
            <div className="minecraft-runtime-status">
              <LoaderCircle className="spin" size={24} />
              <span>{message}</span>
            </div>
          )}
          {phase === 'ended' && (
            <div className="minecraft-player-prompt">
              <Square size={28} />
              <h2>试玩时间已结束</h2>
              <p>这是受限的浏览器技术演示。完整版请通过 Minecraft 官方渠道使用。</p>
              <button className="button secondary" onClick={onClose}>
                退出试玩
              </button>
            </div>
          )}
          {phase === 'error' && (
            <div className="minecraft-player-prompt error">
              <h2>无法启动</h2>
              <p>{message}</p>
              <button className="button secondary" onClick={onClose}>
                关闭
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
