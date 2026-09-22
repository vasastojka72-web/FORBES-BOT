import {parseForbesNickname} from './nickname-parser.js';
const text = value => String(value || '').trim();
const discordId = member => text(member?.discordUserId || member?.discord_user_id || member?.discordId || member?.userId);
const memberId = member => text(member?.memberId || member?.member_id || member?.id);
const gameId = member => text(member?.gameId || member?.game_id || member?.staticId || member?.playerId);
export const isOriginalFine = fine => !!fine && !fine.fineId && !fine.paymentFor;

export function fineBelongsToMember(fine, discordMember, members = []) {
  if (!isOriginalFine(fine) || !discordMember?.id) return false;
  const actorId = text(discordMember.id);
  // Explicit Discord ownership always wins over names and game IDs.
  if (discordId(fine)) return discordId(fine) === actorId;
  if (fine.targetMemberId) {
    const target = members.find(m => memberId(m) === text(fine.targetMemberId));
    if (discordId(target)) return discordId(target) === actorId;
    // Legacy records without a Discord binding can use the current guild nickname ID.
    const verifiedId = parseForbesNickname(discordMember.displayName).staticId;
    return !!verifiedId && gameId(target || fine) === verifiedId;
  }
  const verifiedId = parseForbesNickname(discordMember.displayName).staticId;
  return !!verifiedId && gameId(fine) === verifiedId;
}

export function finePaymentState(fine, fines) {
  if (['paid', 'closed'].includes(fine.status)) return 'paid';
  if (fine.status === 'payment_pending' || fines.some(p => text(p.fineId) === text(fine.id) && ['pending', 'payment_pending'].includes(p.status))) return 'payment_pending';
  return 'unpaid';
}

export function myPayableFines(db, member) {
  const fines = Array.isArray(db.fines) ? db.fines : [];
  return fines.filter(f => fineBelongsToMember(f, member, db.members || []) && finePaymentState(f, fines) !== 'paid').map(f => ({
    id: f.id, displayNumber: f.displayNumber || f.publicNumber || f.id,
    nickname: f.nickname || f.nick || '', staticId: f.staticId || f.playerId || '',
    amount: Number(f.amount || 0), reason: f.reason || '', createdAt: f.createdAt || '',
    status: finePaymentState(f, fines)
  }));
}

export function validateFinePayment(db, fine, member) {
  if (!isOriginalFine(fine)) return {status: 404, error: 'fine_not_found', message: 'Штраф не знайдено або його вже закрито.'};
  if (!fineBelongsToMember(fine, member, db.members || [])) return {status: 403, error: 'fine_not_yours', message: 'Можна надсилати оплату лише власного штрафу.'};
  const status = finePaymentState(fine, db.fines || []);
  if (status === 'paid') return {status: 409, error: 'fine_already_paid', message: 'Цей штраф уже оплачено або закрито.'};
  if (status === 'payment_pending') return {status: 409, error: 'fine_payment_pending', message: 'Оплата цього штрафу вже на перевірці.'};
  return null;
}
