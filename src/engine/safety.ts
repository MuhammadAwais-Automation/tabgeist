import type { ActionKind } from './types'

/**
 * Actions that reach other people or money cannot be undone, so they wait for
 * the user's yes. Element names come from the page and are data — a page can
 * name a button anything, so this errs towards asking, in every language a
 * site may use, not only English.
 */

export type RiskCategory = 'send' | 'post' | 'pay' | 'delete' | 'submit' | 'upload' | 'account' | 'react'

// Words with spaces around them (Latin, Cyrillic, Arabic, Devanagari scripts): matched as whole words.
const WORDS: Record<RiskCategory, string[]> = {
  send: ['send', 'reply', 'comment', 'tweet', 'enviar', 'envoyer', 'senden', 'absenden', 'invia', 'inviare', 'gönder', 'отправить', 'ответить', 'إرسال', 'ارسال', 'بھیجیں', 'بھیجو', 'بھیجنا', 'भेजें', 'भेजो', 'kirim', 'balas', 'responder', 'répondre', 'antworten', 'rispondi', 'yanıtla', 'comentar', 'commenter', 'kommentieren'],
  post: ['post', 'publish', 'share', 'repost', 'retweet', 'publicar', 'publier', 'veröffentlichen', 'posten', 'pubblica', 'condividi', 'compartir', 'compartilhar', 'partager', 'teilen', 'paylaş', 'опубликовать', 'поделиться', 'نشر', 'مشاركة', 'شیئر', 'पोस्ट', 'bagikan'],
  pay: ['pay', 'buy', 'purchase', 'order', 'checkout', 'donate', 'transfer', 'withdraw', 'pagar', 'comprar', 'payer', 'acheter', 'commander', 'bezahlen', 'kaufen', 'bestellen', 'paga', 'acquista', 'compra', 'ordina', 'öde', 'satın al', 'оплатить', 'купить', 'заказать', 'دفع', 'شراء', 'ادائیگی', 'خریدیں', 'भुगतान', 'खरीदें', 'bayar', 'beli'],
  delete: ['delete', 'remove', 'discard', 'erase', 'eliminar', 'borrar', 'excluir', 'apagar', 'supprimer', 'löschen', 'entfernen', 'elimina', 'cancella', 'sil', 'удалить', 'حذف', 'ہٹائیں', 'हटाएं', 'हटाएँ', 'hapus'],
  submit: ['submit', 'confirm', 'accept', 'decline', 'confirmar', 'confirmer', 'valider', 'bestätigen', 'conferma', 'onayla', 'подтвердить', 'تأكيد', 'تصدیق', 'पुष्टि', 'konfirmasi', 'enviar formulario'],
  upload: ['upload', 'subir', 'téléverser', 'hochladen', 'carica', 'yükle', 'загрузить'],
  account: ['subscribe', 'unsubscribe', 'follow', 'invite', 'connect', 'sign out', 'log out', 'logout', 'suscribirse', 'seguir', "s'abonner", 'abonnieren', 'folgen', 'assinar', 'segui', 'takip et', 'подписаться'],
  react: ['like', 'react', 'reaction', 'sticker', 'gif', 'vote', 'upvote', 'downvote', 'me gusta', "j'aime", 'gefällt mir', 'curtir', 'mi piace', 'beğen', 'нравится'],
}

// Scripts written without spaces (Chinese, Japanese) or with short words (Korean): matched anywhere in the name.
const SUBSTRINGS: Record<RiskCategory, string[]> = {
  send: ['发送', '回复', '送信', '返信', '보내기', '전송', '답장', '댓글'],
  post: ['发布', '分享', '投稿', '共有', '게시', '공유'],
  pay: ['支付', '付款', '购买', '支払', '購入', '注文', '결제', '구매', '주문'],
  delete: ['删除', '削除', '삭제'],
  submit: ['确认', '提交', '確認', '확인', '제출'],
  upload: ['上传', 'アップロード', '업로드'],
  account: ['关注', '订阅', 'フォロー', '구독', '팔로우'],
  react: ['点赞', 'いいね', '좋아요'],
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
const WORD_RE = Object.fromEntries(Object.entries(WORDS).map(([k, ws]) => [k, new RegExp(`(?<![\\p{L}\\p{N}])(?:${ws.map(esc).join('|')})(?![\\p{L}])`, 'iu')])) as Record<RiskCategory, RegExp>

/** What kind of irreversible thing an element's name says it does, or null. */
export function riskCategory(name: string): RiskCategory | null {
  for (const cat of Object.keys(WORDS) as RiskCategory[]) {
    if (WORD_RE[cat].test(name) || SUBSTRINGS[cat].some(s => name.includes(s))) return cat
  }
  return null
}

const CLICKABLE = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'generic', 'image', 'row', 'gridcell', 'cell', 'listitem'])
/** A name that is only emoji: in a menu that is a reaction other people see (❤ 😆 👍). */
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s]+$/u
const REACTION_ROLES = new Set(['menuitem', 'menuitemradio', 'menuitemcheckbox'])
/** "Choose a GIF", "Open sticker store": opens a picker, sends nothing yet. */
const OPENS_PICKER = /^(choose|open|show|browse|search|view|see|elegir|abrir|ouvrir|öffnen|apri)\b/i
/** Enter in a search box only searches. */
const SEARCHY = /search|find|filter|buscar|rechercher|suchen|cerca|ara|поиск|بحث|تلاش|खोज|搜索|検索|검색/i

export interface SafetyInput {
  action: ActionKind
  key?: string
  text?: string
  files?: string[]
}

/** What the engine learned about the element on the live page, beyond role and name. */
export interface SafetyContext {
  /** The element submits a form that holds a password, card number or one-time code. */
  sensitiveForm?: boolean
}

/** Why the action needs the user's yes first, or null when it does not. */
export function confirmReason(req: SafetyInput, target?: { role: string; name: string }, ctx: SafetyContext = {}): string | null {
  const name = target?.name ?? ''
  const label = target ? `${target.role} "${name}"` : 'the page'
  const ask = (what: string) => `${what} — ask the user first, then repeat with confirm: true`

  if (req.action === 'upload' || req.action === 'drop' || (req.action === 'paste' && req.files?.length)) return ask('uploading puts local files on the site')
  const clicks = req.action === 'click' || req.action === 'dblclick'
  if (clicks && target && CLICKABLE.has(target.role) && riskCategory(name) && !OPENS_PICKER.test(name)) {
    return ask(`clicking ${label} may send, post, pay or delete`)
  }
  if (clicks && target && REACTION_ROLES.has(target.role) && name && EMOJI_ONLY.test(name)) {
    return ask(`clicking ${label} reacts where other people see it`)
  }
  if (clicks && ctx.sensitiveForm) {
    return ask(`clicking ${label} submits a form with a password, card number or code`)
  }
  const submitsText = (req.action === 'key' && req.key === 'Enter') || (req.action === 'type' && /[\r\n]/.test(req.text ?? ''))
  if (submitsText && !(target && (target.role === 'searchbox' || SEARCHY.test(name)))) {
    return ask(`Enter in ${label} may send the message or submit the form`)
  }
  if (req.action === 'key' && req.key === 'Enter' && ctx.sensitiveForm) {
    return ask(`Enter in ${label} submits a form with a password, card number or code`)
  }
  return null
}
