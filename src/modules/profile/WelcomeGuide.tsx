// 首次启动引导（个人中心 specs §4）：三步，第 1、2 步可跳过
import { useState } from 'react'
import { useAppSettings } from '../../theme/ThemeProvider'
import { AI_NAME, SettingsKeys } from '../../shared/types'

export interface WelcomeGuideProps {
  open: boolean
  onDone: () => void
  onGoProfile: () => void
}

export default function WelcomeGuide(props: WelcomeGuideProps) {
  const { open, onDone, onGoProfile } = props
  const { setSetting, setTheme } = useAppSettings()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [pickedTheme, setPickedTheme] = useState<'light' | 'dark'>('light')

  if (!open) return null

  const steps = ['设置用户名', '选择主题', '配置 LLM']

  const next = async (): Promise<void> => {
    if (step === 0 && name.trim()) {
      await setSetting(SettingsKeys.UserName, name.trim())
    }
    if (step === 1) {
      setTheme(pickedTheme)
    }
    if (step < 2) {
      setStep(step + 1)
    } else {
      onDone()
    }
  }

  const skip = (): void => {
    if (step < 2) setStep(step + 1)
    else onDone()
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog" style={{ width: 480 }}>
        <div className="dialog-header">
          <span className="material-symbols-outlined">waving_hand</span>
          <span style={{ flex: 1 }}>欢迎使用 bug子的workspace</span>
          <span className="module-sub">{step + 1}/3 · {steps[step]}</span>
        </div>
        <div className="dialog-body">
          {step === 0 && (
            <div className="welcome-step">
              <div className="module-sub">怎么称呼你？</div>
              <input
                className="field"
                style={{ width: 260 }}
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void next()
                }}
                placeholder="用户名"
              />
            </div>
          )}
          {step === 1 && (
            <div className="welcome-step">
              <div className="module-sub">选择一个主题（之后可随时切换）</div>
              <div className="theme-pick">
                <div
                  className={`theme-preview tp-light${pickedTheme === 'light' ? ' picked' : ''}`}
                  onClick={() => setPickedTheme('light')}
                >
                  <div className="tp-block">浅色 · 樱花粉</div>
                  <div className="tp-block">格言库</div>
                  <div className="tp-block">万象库</div>
                </div>
                <div
                  className={`theme-preview tp-dark${pickedTheme === 'dark' ? ' picked' : ''}`}
                  onClick={() => setPickedTheme('dark')}
                >
                  <div className="tp-block">深色 · 宝蓝</div>
                  <div className="tp-block">格言库</div>
                  <div className="tp-block">万象库</div>
                </div>
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="welcome-step">
              <span className="material-symbols-outlined" style={{ fontSize: 44 }}>smart_toy</span>
              <div style={{ lineHeight: 1.8 }}>
                建议先去个人档配置 LLM，让 {AI_NAME} 上线陪你开工
                <br />
                <span className="module-sub">（格言生成、知识卡片、AI 对话、辩真验证）</span>
              </div>
            </div>
          )}
        </div>
        <div className="dialog-footer">
          {step < 2 && (
            <button className="btn btn-ghost mr-auto" onClick={skip}>
              跳过
            </button>
          )}
          {step === 2 ? (
            <>
              <button className="btn" onClick={onDone}>暂不</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  onGoProfile()
                  onDone()
                }}
              >
                去配置
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => void next()}>
              {step === 0 && !name.trim() ? '跳过' : '下一步'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
