// 队列推进纯逻辑（播放队列轮 §3）：洗牌与「下一有效项」计算独立成模块——零依赖零副作用，
// 引擎调度调用；单曲循环不切歌不在此列（引擎直接重置计时）。

/** Fisher-Yates 洗牌（返回新数组）；exclude 非空且洗后仍居首位时与末位对调，防连播同一首 */
export function shuffleIds(ids: string[], exclude: string | null): string[] {
  const arr = [...ids]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  if (arr.length > 1 && exclude != null && arr[0] === exclude) {
    ;[arr[0], arr[arr.length - 1]] = [arr[arr.length - 1], arr[0]]
  }
  return arr
}

/**
 * 顺序类模式的下一有效项（random 由引擎持洗牌序，不走此函数）。
 * sequence：current 之后向后找、不回绕——到末尾仍无 → null（播完即停）；
 * list-loop：同上但回绕（含 current 自身——全队列仅剩当前有效时回到它）。
 * currentId = null 表示队列启动取首个有效项。
 */
export function nextValidId(
  mode: 'sequence' | 'list-loop',
  ids: string[],
  isValid: (id: string) => boolean,
  currentId: string | null
): string | null {
  const n = ids.length
  if (n === 0) return null
  const cur = currentId == null ? -1 : ids.indexOf(currentId)
  const span = mode === 'sequence' ? n - cur - 1 : n
  for (let step = 1; step <= span; step++) {
    const idx = cur + step < n ? cur + step : cur + step - n
    if (isValid(ids[idx])) return ids[idx]
  }
  return null
}
