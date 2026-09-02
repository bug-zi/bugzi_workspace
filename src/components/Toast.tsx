// 全局 Toast（轻提示）
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

interface ToastItem {
  id: number
  text: string
}

const ToastCtx = createContext<{ toast: (text: string) => void }>({ toast: () => {} })

export function useToast(): { toast: (text: string) => void } {
  return useContext(ToastCtx)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const toast = useCallback((text: string) => {
    const id = ++seq.current
    setItems((arr) => [...arr, { id, text }])
    setTimeout(() => {
      setItems((arr) => arr.filter((t) => t.id !== id))
    }, 2600)
  }, [])

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="toast-container">
        {items.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
