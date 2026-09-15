// 全局 Toast（轻提示）；可携带 onClick 变为可点击提示（如深挖完成后点击跳转，260915 优化区）
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

interface ToastItem {
  id: number
  text: string
  onClick?: () => void
}

const ToastCtx = createContext<{ toast: (text: string, opts?: { onClick?: () => void }) => void }>({
  toast: () => {}
})

export function useToast(): { toast: (text: string, opts?: { onClick?: () => void }) => void } {
  return useContext(ToastCtx)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const toast = useCallback((text: string, opts?: { onClick?: () => void }) => {
    const id = ++seq.current
    setItems((arr) => [...arr, { id, text, onClick: opts?.onClick }])
    setTimeout(() => {
      setItems((arr) => arr.filter((t) => t.id !== id))
    }, 2600)
  }, [])

  const dismiss = useCallback((id: number) => {
    setItems((arr) => arr.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="toast-container">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast${t.onClick ? ' toast-clickable' : ''}`}
            onClick={
              t.onClick
                ? () => {
                    t.onClick?.()
                    dismiss(t.id)
                  }
                : undefined
            }
            role={t.onClick ? 'button' : undefined}
            title={t.onClick ? '点击前往' : undefined}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
