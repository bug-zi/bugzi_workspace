// 麻将牌面（娱乐城 specs §12）：纯 CSS 绘制——数字+汉字，主题色系衍生，无 emoji 无图片
import { isFlower, suitNum, suitOf, HONOR_TEXT, FLOWER_TEXT, type TileId } from './tiles'

export default function MahjongTile({
  face,
  back,
  small,
  selected,
  joker,
  onClick
}: {
  face?: TileId
  back?: boolean
  small?: boolean
  selected?: boolean
  joker?: boolean
  onClick?: () => void
}) {
  if (back) {
    return (
      <div className={`mj-tile mj-back${small ? ' small' : ''}`} aria-hidden>
        <span className="material-symbols-outlined">casino</span>
      </div>
    )
  }
  if (!face) return null
  const suit = suitOf(face)
  const num = suitNum(face)
  let hanzi = ''
  if (suit != null && num != null) hanzi = ['万', '筒', '索'][suit]
  else if (isFlower(face)) hanzi = FLOWER_TEXT[face] ?? ''
  else hanzi = HONOR_TEXT[face] ?? face
  const cls = [
    'mj-tile',
    small ? 'small' : '',
    selected ? ' selected' : '',
    joker ? ' joker' : '',
    onClick ? ' clickable' : ''
  ]
    .join(' ')
    .trim()
  return (
    <div className={cls} onClick={onClick} title={joker ? '财神（百搭）' : undefined}>
      {suit != null && num != null ? (
        <span className="mj-tile-suit">
          <b>{num}</b>
          <i>{hanzi}</i>
        </span>
      ) : (
        <span className="mj-tile-hanzi">{hanzi}</span>
      )}
      {joker && <em className="mj-tile-joker-tag">财</em>}
    </div>
  )
}
