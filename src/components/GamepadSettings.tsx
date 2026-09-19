import { useEffect } from 'react'
import { Gamepad2, RotateCcw, X } from 'lucide-react'
import type { GamepadController } from '../hooks/useGamepads'
import type { GbaButton } from '../emulator'
import { bindingLabel, gbaButtons } from '../lib/gamepad'
import './gamepad.css'

export function GamepadSettings({
  controller,
  buttons = gbaButtons,
}: {
  controller: GamepadController
  buttons?: readonly GbaButton[]
}) {
  const { selectedDevice, profile, capture, cancelCapture } = controller
  useEffect(() => cancelCapture, [cancelCapture])

  return (
    <section className="gamepad-settings" aria-labelledby="gamepad-settings-title">
      <div className="gamepad-settings-heading">
        <h3 id="gamepad-settings-title">
          <Gamepad2 size={18} /> 手柄映射
        </h3>
        <span>
          {controller.devices.length ? `${controller.devices.length} 台已连接` : '未检测到手柄'}
        </span>
      </div>
      {controller.error ? (
        <p className="gamepad-notice" role="status">
          {controller.error}
        </p>
      ) : null}
      {!controller.devices.length && !controller.error ? (
        <p className="gamepad-hint">连接手柄后按一下手柄按键，让浏览器识别设备。映射按设备保存。</p>
      ) : null}
      {selectedDevice && profile ? (
        <>
          <label className="gamepad-device-label" htmlFor="gamepad-device">
            当前设备
          </label>
          <select
            id="gamepad-device"
            value={selectedDevice.index}
            onChange={(event) => controller.selectDevice(Number(event.target.value))}
          >
            {controller.devices.map((device) => (
              <option key={device.index} value={device.index}>
                {device.index + 1}. {device.id || '未命名手柄'}
              </option>
            ))}
          </select>
          <p className="gamepad-hint">
            {selectedDevice.standard
              ? '标准布局：默认支持按键、方向键和左摇杆。'
              : '非标准布局：请逐项设置按键或轴方向后使用。'}{' '}
            {selectedDevice.buttonCount} 个按键 · {selectedDevice.axisCount}{' '}
            个轴。相同设备标识和布局共用设置。
          </p>
          <div className="gamepad-binding-grid">
            {gbaButtons
              .filter((key) => buttons.includes(key))
              .map((key) => (
                <div className="gamepad-binding" key={key}>
                  <span className="gamepad-target">{key}</span>
                  <button
                    type="button"
                    className={`gamepad-bind-button ${capture === key ? 'is-capturing' : ''}`}
                    aria-label={`映射手柄 ${key}`}
                    disabled={Boolean(capture) && capture !== key}
                    onClick={() =>
                      capture === key ? cancelCapture() : controller.startCapture(key)
                    }
                  >
                    {capture === key
                      ? '等待输入…'
                      : profile.bindings[key].map(bindingLabel).join(' / ') || '未映射'}
                  </button>
                  <button
                    type="button"
                    className="gamepad-clear-button"
                    aria-label={`清除手柄 ${key} 映射`}
                    disabled={Boolean(capture) || !profile.bindings[key].length}
                    onClick={() => controller.clearBinding(key)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
          </div>
          {capture ? (
            <div className="gamepad-capture-notice" role="status">
              <p>正在设置 {capture}：松开当前输入，再按下按键或推动摇杆。Esc 可取消。</p>
              <button type="button" onClick={cancelCapture}>
                取消映射
              </button>
            </div>
          ) : null}
          <div className="gamepad-deadzone">
            <label htmlFor="gamepad-deadzone">
              摇杆死区 <strong>{Math.round(profile.deadzone * 100)}%</strong>
            </label>
            <input
              id="gamepad-deadzone"
              type="range"
              min="10"
              max="90"
              step="5"
              value={Math.round(profile.deadzone * 100)}
              disabled={Boolean(capture)}
              onChange={(event) => controller.setDeadzone(Number(event.target.value) / 100)}
            />
            <p className="gamepad-hint">增大死区可减少摇杆漂移；捕获轴方向时请充分推动摇杆。</p>
          </div>
          <button
            type="button"
            className="secondary-button gamepad-reset"
            onClick={controller.reset}
          >
            <RotateCcw size={14} /> {selectedDevice.standard ? '恢复手柄默认映射' : '重置手柄映射'}
          </button>
        </>
      ) : null}
      <div className="gamepad-feedback" aria-live="polite">
        {controller.message ? <p>{controller.message}</p> : null}
        {controller.storageError ? (
          <p className="gamepad-notice">{controller.storageError}</p>
        ) : null}
      </div>
    </section>
  )
}
