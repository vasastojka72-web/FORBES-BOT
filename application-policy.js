const normalize = value => String(value || '').trim().toLowerCase().replace(/[’ʼ`]/g, "'").replace(/\s+/g, ' ');
const types = new Map([
  ...["в сім'ю", "у сім'ю", 'family'].map(x => [x, 'family']),
  ...['у фарм', 'в фарм', 'фарм', 'farm'].map(x => [x, 'farm']),
  ...['у капт', 'в капт', 'капт', 'capt'].map(x => [x, 'capt']),
  ...['увал', 'на увал', 'звільнення', 'на звільнення', 'dismissal'].map(x => [x, 'dismissal']),
  ...['відпустка', 'vacation'].map(x => [x, 'vacation']),
  ...['день народження', 'birthday'].map(x => [x, 'birthday'])
]);
export const applicationKind = type => types.get(normalize(type)) || '';
export const isJoinApplication = type => ['family', 'farm', 'capt'].includes(applicationKind(type));

// Only application decisions may reach this allowlist. Never infer from a substring.
export function applicationNeedsKick(application, action) {
  return (action === 'app_reject' && isJoinApplication(application?.type)) ||
    (action === 'app_approve' && applicationKind(application?.type) === 'dismissal');
}

export async function kickApplicationAuthor(application, action, guild, moderatorId) {
  if (!applicationNeedsKick(application, action)) return {status: 'not_required'};
  if (application.kickResult?.status === 'kicked' || application.kickResult?.status === 'already_absent') return application.kickResult;
  const userId = String(application.discordUserId || application.userId || '');
  if (!/^\d{15,25}$/.test(userId)) return {status: 'failed', reason: 'У заявки немає Discord ID автора.'};
  try {
    const member = await guild.members.fetch({user: userId, force: true});
    if (!member.kickable) return {status: 'failed', reason: 'Боту потрібне право Kick Members та роль вище ролі учасника.'};
    const reason = `FORBES: ${application.type}; ${action === 'app_approve' ? 'схвалено' : 'відхилено'}; заявка ${application.id}; модератор ${moderatorId}`;
    await member.kick(reason.slice(0, 480));
    return {status: 'kicked', discordUserId: userId, at: new Date().toISOString()};
  } catch (error) {
    if (Number(error.code) === 10007) return {status: 'already_absent', discordUserId: userId};
    return {status: 'failed', reason: String(error.message || error).slice(0, 250)};
  }
}
